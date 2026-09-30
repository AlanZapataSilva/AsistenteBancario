/**
 * Archivo: gemini_client.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Cliente REST de Google Gemini.
 * - Descubre los modelos disponibles (ListModels paginado) y los ordena por versión numérica.
 * - Recuerda la salud de cada modelo en CacheService (circuit breaker): un modelo inexistente, sin
 *   cuota o saturado no se vuelve a golpear hasta que expire su enfriamiento.
 * - Recorre una cascada de modelos con reintento ante saturación y degradación progresiva de los
 *   parámetros opcionales (thinking, esquema de salida) si la API los rechaza.
 * No conoce transacciones: recibe un prompt y devuelve texto. Nunca lanza excepciones por fallos de la API.
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

const GEMINI_SETTINGS = Object.freeze({
  MODEL_LIST_CACHE_KEY: 'GEMINI_MODEL_NAMES_V2',
  MODEL_LIST_FAILED_KEY: 'GEMINI_MODEL_LIST_FAILED',
  HEALTH_KEY_PREFIX: 'GEMINI_HEALTH_',
  // CacheService admite como máximo 6 h (21600 s) de vida por valor.
  MODEL_LIST_TTL_S: 21600,
  MODEL_LIST_FAILED_TTL_S: 120,
  COOLDOWN_NOT_FOUND_S: 21600,
  COOLDOWN_ZERO_QUOTA_S: 21600,
  COOLDOWN_OVERLOADED_S: 300,
  COOLDOWN_RATE_LIMITED_MIN_S: 30,
  COOLDOWN_RATE_LIMITED_MAX_S: 900,
  COOLDOWN_RATE_LIMITED_DEFAULT_S: 60,
  AUTH_FAILURE_KEY_PREFIX: 'GEMINI_AUTH_FAIL_',
  COOLDOWN_AUTH_S: 600,
  RETRY_BACKOFF_MS: 1500,
  RETRY_JITTER_MS: 500,
  MAX_LIST_PAGES: 10,
  DEFAULT_DEADLINE_MS: 90000,
  MAX_MESSAGE_LENGTH: 200,
  /**
   * Red de seguridad si ListModels no responde. Verificada contra la documentación oficial
   * (septiembre 2026); editable sin tocar código con la propiedad de script `GEMINI_MODELS` (CSV).
   */
  DEFAULT_MODELS: Object.freeze([
    'gemini-3.8-flash',
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
  ]),
});

/**
 * Información derivada del nombre de un modelo.
 * @typedef {object} GeminiModelInfo
 * @property {string} name - Nombre sin el prefijo `models/`.
 * @property {number} major
 * @property {number} minor
 * @property {'flash'|'flash-lite'|'pro'} tier
 * @property {boolean} preview
 */

/**
 * Interpreta un nombre de modelo de texto (`gemini-3.8-flash`, `models/gemini-3-flash-preview`…).
 * Descarta los modelos que no sirven para clasificar texto (imagen, voz, embeddings, alias `-latest`…).
 * @param {string} rawName
 * @returns {GeminiModelInfo|null}
 */
function _parseGeminiModelName(rawName) {
  const match = String(rawName)
    .trim()
    .match(
      /^(?:models\/)?(gemini-(\d+)(?:\.(\d+))?-(flash-lite|flash|pro)(-preview(?:-[\d-]+)?)?)$/i
    );
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    major: parseInt(match[2], 10),
    minor: match[3] ? parseInt(match[3], 10) : 0,
    tier: /** @type {'flash'|'flash-lite'|'pro'} */ (match[4].toLowerCase()),
    preview: Boolean(match[5]),
  };
}

/**
 * Grupo de prioridad de un modelo para clasificar: flash estable → flash-lite estable → preview → pro.
 * @param {GeminiModelInfo} info
 * @returns {number}
 */
function _geminiModelGroup(info) {
  if (info.tier === 'pro') return 3;
  if (info.preview) return 2;
  return info.tier === 'flash' ? 0 : 1;
}

/**
 * Comparador de modelos: primero por grupo y luego por versión NUMÉRICA descendente (3.10 > 3.8).
 * @param {GeminiModelInfo} a
 * @param {GeminiModelInfo} b
 * @returns {number}
 */
function _compareGeminiModels(a, b) {
  const byGroup = _geminiModelGroup(a) - _geminiModelGroup(b);
  if (byGroup !== 0) return byGroup;
  if (a.major !== b.major) return b.major - a.major;
  if (a.minor !== b.minor) return b.minor - a.minor;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Elimina secretos de un texto antes de registrarlo (API key en query, en headers o embebida).
 * @param {any} text
 * @returns {string}
 */
function _scrubGeminiSecrets(text) {
  let out = String(text === null || text === undefined ? '' : text);
  const apiKey = getEnv('GEMINI_API_KEY');
  if (apiKey) out = out.split(apiKey).join('***');
  out = out.replace(/([?&]key=)[^&\s"')]+/gi, '$1***');
  out = out.replace(/AIza[0-9A-Za-z_-]{20,}/g, '***');
  return out;
}

/**
 * Recorta un mensaje a un largo razonable para logs.
 * @param {string} text
 * @returns {string}
 */
function _truncateGeminiMessage(text) {
  const clean = _scrubGeminiSecrets(text).replace(/\s+/g, ' ').trim();
  const max = GEMINI_SETTINGS.MAX_MESSAGE_LENGTH;
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// ---------------------------------------------------------------------------
// Descubrimiento de modelos
// ---------------------------------------------------------------------------

/**
 * Lista TODOS los modelos que soportan `generateContent`, recorriendo las páginas de ListModels.
 * @param {string} apiKey
 * @returns {string[]|null} Nombres (`models/...`) o null si la consulta falla desde la primera página.
 */
function listGeminiModelNames(apiKey) {
  /** @type {string[]} */
  const names = [];
  let pageToken = '';
  for (let page = 0; page < GEMINI_SETTINGS.MAX_LIST_PAGES; page++) {
    const url =
      `${GEMINI_API_BASE}/models?pageSize=1000` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');
    try {
      const res = UrlFetchApp.fetch(url, {
        method: 'get',
        headers: { 'x-goog-api-key': apiKey },
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() !== 200) {
        logSystemEvent(
          'WARN',
          'Gemini: ListModels falló',
          `HTTP ${res.getResponseCode()}: ${_truncateGeminiMessage(res.getContentText())}`
        );
        return page === 0 ? null : names;
      }
      const json = JSON.parse(res.getContentText());
      (json.models || []).forEach(
        /** @param {{name?: string, supportedGenerationMethods?: string[]}} m */ m => {
          if (
            m.name &&
            Array.isArray(m.supportedGenerationMethods) &&
            m.supportedGenerationMethods.indexOf('generateContent') !== -1
          ) {
            names.push(m.name);
          }
        }
      );
      pageToken = json.nextPageToken || '';
      if (!pageToken) break;
    } catch (err) {
      logSystemEvent(
        'WARN',
        'Gemini: error de red en ListModels',
        _truncateGeminiMessage(/** @type {Error} */ (err).message)
      );
      return page === 0 ? null : names;
    }
  }
  return names;
}

/**
 * Nombres de modelos disponibles, desde CacheService o consultando la API.
 * @param {string} apiKey
 * @returns {string[]|null}
 */
function _getGeminiModelNames(apiKey) {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(GEMINI_SETTINGS.MODEL_LIST_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (_) {
      // caché corrupta: se vuelve a consultar
    }
  }
  if (cache.get(GEMINI_SETTINGS.MODEL_LIST_FAILED_KEY)) return null;

  const names = listGeminiModelNames(apiKey);
  if (names && names.length > 0) {
    cache.put(
      GEMINI_SETTINGS.MODEL_LIST_CACHE_KEY,
      JSON.stringify(names),
      GEMINI_SETTINGS.MODEL_LIST_TTL_S
    );
    return names;
  }
  cache.put(GEMINI_SETTINGS.MODEL_LIST_FAILED_KEY, '1', GEMINI_SETTINGS.MODEL_LIST_FAILED_TTL_S);
  return null;
}

// ---------------------------------------------------------------------------
// Salud por modelo (circuit breaker)
// ---------------------------------------------------------------------------

/**
 * @param {string} model
 * @returns {{until: number, kind: string, code: number}|null} Estado si el modelo sigue en enfriamiento.
 */
function _getGeminiModelHealth(model) {
  const raw = CacheService.getScriptCache().get(GEMINI_SETTINGS.HEALTH_KEY_PREFIX + model);
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    return state.until > Date.now() ? state : null;
  } catch (_) {
    return null;
  }
}

/**
 * Deja un modelo en enfriamiento.
 * @param {string} model
 * @param {number} seconds
 * @param {string} kind
 * @param {number} code
 */
function _markGeminiModelUnhealthy(model, seconds, kind, code) {
  const ttl = Math.min(Math.max(Math.round(seconds), 1), 21600);
  CacheService.getScriptCache().put(
    GEMINI_SETTINGS.HEALTH_KEY_PREFIX + model,
    JSON.stringify({ until: Date.now() + ttl * 1000, kind, code }),
    ttl
  );
}

/**
 * Borra la marca de enfriamiento de un modelo.
 * @param {string} model
 */
function _clearGeminiModelHealth(model) {
  CacheService.getScriptCache().remove(GEMINI_SETTINGS.HEALTH_KEY_PREFIX + model);
}

/**
 * Quita el enfriamiento de todos los modelos conocidos (útil tras activar la facturación o
 * desde el diagnóstico del menú).
 */
function clearGeminiHealth() {
  const apiKey = getEnv('GEMINI_API_KEY');
  const names = (apiKey && _getGeminiModelNames(apiKey)) || [];
  names
    .map(_parseGeminiModelName)
    .concat(GEMINI_SETTINGS.DEFAULT_MODELS.map(_parseGeminiModelName))
    .forEach(info => {
      if (info) _clearGeminiModelHealth(info.name);
    });
  CacheService.getScriptCache().remove(GEMINI_SETTINGS.MODEL_LIST_CACHE_KEY);
  CacheService.getScriptCache().remove(GEMINI_SETTINGS.MODEL_LIST_FAILED_KEY);
}

// ---------------------------------------------------------------------------
// Cascada
// ---------------------------------------------------------------------------

/**
 * Construye la lista ordenada de modelos a intentar para clasificar.
 * Pro solo participa con la propiedad `GEMINI_ALLOW_PRO=true` (no tiene cuota en el tier gratuito).
 * @param {{ignoreCooldown?: boolean}} [options]
 * @returns {{models: string[], skipped: {model: string, until: number}[], source: 'discovery'|'fallback'}}
 */
function getGeminiModelCascade(options) {
  const opts = options || {};
  const apiKey = getEnv('GEMINI_API_KEY');
  const allowPro = getEnv('GEMINI_ALLOW_PRO') === 'true';

  const discovered = apiKey ? _getGeminiModelNames(apiKey) : null;
  const infos = (discovered || [])
    .map(_parseGeminiModelName)
    .filter(/** @param {GeminiModelInfo|null} i */ i => i !== null);

  /** @type {string[]} */
  let ordered;
  /** @type {'discovery'|'fallback'} */
  let source = 'discovery';
  if (infos.length > 0) {
    ordered = /** @type {GeminiModelInfo[]} */ (infos)
      .filter(i => allowPro || i.tier !== 'pro')
      .sort(_compareGeminiModels)
      .map(i => i.name);
  } else {
    source = 'fallback';
    const custom = (getEnv('GEMINI_MODELS') || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const list = custom.length > 0 ? custom : GEMINI_SETTINGS.DEFAULT_MODELS.slice();
    ordered = list.filter(name => allowPro || !/-pro(-|$)/i.test(name));
  }

  const unique = ordered.filter((name, index) => ordered.indexOf(name) === index);
  /** @type {string[]} */
  const models = [];
  /** @type {{model: string, until: number}[]} */
  const skipped = [];
  unique.forEach(name => {
    const health = opts.ignoreCooldown ? null : _getGeminiModelHealth(name);
    if (health) skipped.push({ model: name, until: health.until });
    else models.push(name);
  });
  return { models, skipped, source };
}

/**
 * Interpreta una respuesta de error de la API.
 * @param {number} code - Código HTTP (0 = error de red).
 * @param {any} body - JSON parseado (o null).
 * @param {string} rawText
 * @returns {{kind: GeminiFailureKind, message: string, retryAfterS: number}}
 */
function _describeGeminiFailure(code, body, rawText) {
  const err = body && body.error ? body.error : null;
  const message = _truncateGeminiMessage(
    (err && err.message) || rawText || (code === 0 ? 'Error de red' : `HTTP ${code}`)
  );
  const status = err && err.status ? String(err.status) : '';

  /** @type {number} */
  let retryAfterS = 0;
  const details = err && Array.isArray(err.details) ? err.details : [];
  details.forEach(
    /** @param {{retryDelay?: string}} d */ d => {
      if (d && typeof d.retryDelay === 'string') retryAfterS = Math.ceil(parseFloat(d.retryDelay));
    }
  );
  if (!retryAfterS) {
    const m = /retry in ([\d.]+)\s*s/i.exec((err && err.message) || '');
    if (m) retryAfterS = Math.ceil(parseFloat(m[1]));
  }

  /** @type {GeminiFailureKind} */
  let kind = 'unknown';
  if (
    code === 401 ||
    code === 403 ||
    status === 'PERMISSION_DENIED' ||
    status === 'UNAUTHENTICATED' ||
    /API key not valid|API_KEY_INVALID/i.test(message)
  ) {
    kind = 'auth';
  } else if (code === 404) {
    kind = 'not_found';
  } else if (code === 429) {
    kind = /limit:\s*0\b/.test(message) ? 'quota_zero' : 'rate_limited';
  } else if (code === 400) {
    kind = 'bad_request';
  } else if (code === 0 || code === 408 || code >= 500) {
    kind = 'overloaded';
  }
  return { kind, message, retryAfterS };
}

/**
 * Cuerpo de la petición `generateContent`.
 * @param {string} model
 * @param {GeminiRequest} request
 * @param {'full'|'noThinking'|'noSchema'} variant - `full` incluye thinking y esquema; las otras degradan.
 * @returns {object}
 */
function _buildGeminiPayload(model, request, variant) {
  /** @type {Record<string, any>} */
  const generationConfig = {
    temperature: 0,
    responseMimeType: 'application/json',
    maxOutputTokens: request.maxOutputTokens || 8192,
  };
  if (request.schema && variant !== 'noSchema') generationConfig.responseSchema = request.schema;
  if (variant === 'full') {
    const info = _parseGeminiModelName(model);
    // Para clasificar no hace falta razonar: menos latencia y menos tokens.
    // El nombre exacto de este parámetro se confirma en vivo; si la API lo rechaza (400) se descarta solo.
    generationConfig.thinkingConfig = {
      thinkingLevel: info && info.tier === 'flash-lite' ? 'minimal' : 'low',
    };
  }
  return { contents: [{ role: 'user', parts: [{ text: request.prompt }] }], generationConfig };
}

/**
 * Ejecuta una llamada HTTP a `generateContent`. Nunca lanza.
 * @param {string} apiKey
 * @param {string} model
 * @param {object} payload
 * @returns {{code: number, body: any, text: string}}
 */
function _callGeminiGenerate(apiKey, model, payload) {
  try {
    /** @type {GoogleAppsScript.URL_Fetch.URLFetchRequestOptions} */
    const options = {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    };
    const res = UrlFetchApp.fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, options);
    const text = res.getContentText();
    /** @type {any} */
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (_) {
      body = null;
    }
    return { code: res.getResponseCode(), body, text };
  } catch (err) {
    return { code: 0, body: null, text: _scrubGeminiSecrets(/** @type {Error} */ (err).message) };
  }
}

/**
 * Extrae el texto de una respuesta 200.
 * @param {any} body
 * @returns {{ok: boolean, text: string, kind: GeminiFailureKind, message: string}} `kind`/`message` solo tienen significado si `ok` es false.
 */
function _extractGeminiText(body) {
  const candidate = body && Array.isArray(body.candidates) ? body.candidates[0] : null;
  if (!candidate) {
    const block = body && body.promptFeedback && body.promptFeedback.blockReason;
    return {
      ok: false,
      text: '',
      kind: 'empty',
      message: block ? `Bloqueado: ${block}` : 'Sin candidatos',
    };
  }
  const parts =
    candidate.content && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const text = parts
    .filter(
      /** @param {{text?: string, thought?: boolean}} p */ p =>
        typeof p.text === 'string' && !p.thought
    )
    .map(/** @param {{text: string}} p */ p => p.text)
    .join('');
  if (candidate.finishReason === 'MAX_TOKENS') {
    return { ok: false, text: '', kind: 'truncated', message: 'Respuesta truncada (MAX_TOKENS)' };
  }
  if (!text.trim()) {
    return {
      ok: false,
      text: '',
      kind: 'empty',
      message: `Respuesta vacía (${candidate.finishReason || 'sin motivo'})`,
    };
  }
  return { ok: true, text, kind: 'unknown', message: '' };
}

/**
 * Intenta un modelo: degrada parámetros opcionales ante un 400 y reintenta una vez ante saturación.
 * @param {string} model
 * @param {GeminiRequest} request
 * @param {string} apiKey
 * @param {number} deadline - Instante (ms) límite absoluto.
 * @param {GeminiAttempt[]} attempts - Se agregan aquí los intentos realizados.
 * @returns {{ok: boolean, text?: string, kind?: GeminiFailureKind, retryAfterS?: number, message?: string}}
 */
function _tryGeminiModel(model, request, apiKey, deadline, attempts) {
  /** @type {'full'|'noThinking'|'noSchema'} */
  let variant = 'full';
  let overloadedRetried = false;

  for (let i = 0; i < 6; i++) {
    const startedAt = Date.now();
    const res = _callGeminiGenerate(apiKey, model, _buildGeminiPayload(model, request, variant));
    const ms = Date.now() - startedAt;

    if (res.code === 200) {
      const extracted = _extractGeminiText(res.body);
      if (!extracted.ok) {
        attempts.push({
          model,
          code: 200,
          kind: extracted.kind,
          message: extracted.message,
          ms,
          variant,
        });
        return { ok: false, kind: extracted.kind, message: extracted.message };
      }
      const problem = request.validate ? request.validate(extracted.text) : null;
      if (problem) {
        attempts.push({
          model,
          code: 200,
          kind: 'invalid_response',
          message: problem,
          ms,
          variant,
        });
        return { ok: false, kind: 'invalid_response', message: problem };
      }
      attempts.push({ model, code: 200, kind: 'ok', ms, variant });
      _clearGeminiModelHealth(model);
      return { ok: true, text: extracted.text };
    }

    const failure = _describeGeminiFailure(res.code, res.body, res.text);
    attempts.push({
      model,
      code: res.code,
      kind: failure.kind,
      message: failure.message,
      ms,
      variant,
    });

    if (failure.kind === 'bad_request' && variant !== 'noSchema') {
      variant = variant === 'full' ? 'noThinking' : 'noSchema';
      continue;
    }
    const backoff =
      GEMINI_SETTINGS.RETRY_BACKOFF_MS +
      Math.floor(Math.random() * GEMINI_SETTINGS.RETRY_JITTER_MS);
    if (failure.kind === 'overloaded' && !overloadedRetried && Date.now() + backoff < deadline) {
      overloadedRetried = true;
      Utilities.sleep(backoff);
      continue;
    }

    // Fallo definitivo para este modelo: se recuerda para no volver a golpearlo.
    if (failure.kind === 'not_found') {
      _markGeminiModelUnhealthy(
        model,
        GEMINI_SETTINGS.COOLDOWN_NOT_FOUND_S,
        failure.kind,
        res.code
      );
    } else if (failure.kind === 'quota_zero') {
      _markGeminiModelUnhealthy(
        model,
        GEMINI_SETTINGS.COOLDOWN_ZERO_QUOTA_S,
        failure.kind,
        res.code
      );
    } else if (failure.kind === 'overloaded') {
      _markGeminiModelUnhealthy(
        model,
        GEMINI_SETTINGS.COOLDOWN_OVERLOADED_S,
        failure.kind,
        res.code
      );
    } else if (failure.kind === 'rate_limited') {
      const wait = failure.retryAfterS || GEMINI_SETTINGS.COOLDOWN_RATE_LIMITED_DEFAULT_S;
      const bounded = Math.min(
        Math.max(wait, GEMINI_SETTINGS.COOLDOWN_RATE_LIMITED_MIN_S),
        GEMINI_SETTINGS.COOLDOWN_RATE_LIMITED_MAX_S
      );
      _markGeminiModelUnhealthy(model, bounded, failure.kind, res.code);
    }
    return {
      ok: false,
      kind: failure.kind,
      retryAfterS: failure.retryAfterS,
      message: failure.message,
    };
  }
  return { ok: false, kind: 'unknown', message: 'Demasiados reintentos' };
}

/**
 * Resume los intentos en una sola línea legible (para logs y alertas).
 * @param {GeminiAttempt[]} attempts
 * @returns {string}
 */
function summarizeGeminiAttempts(attempts) {
  if (attempts.length === 0) return 'sin intentos';
  /** @type {Map<string, GeminiAttempt[]>} */
  const byModel = new Map();
  attempts.forEach(a => {
    const list = byModel.get(a.model) || [];
    list.push(a);
    byModel.set(a.model, list);
  });
  return Array.from(byModel.entries())
    .map(([model, list]) => {
      const last = list[list.length - 1];
      const times = list.length > 1 ? ` x${list.length}` : '';
      const reason = last.kind === 'ok' ? 'OK' : `${last.code || 'red'} ${last.kind}`;
      return `${model}: ${reason}${times}`;
    })
    .join(' | ');
}

/**
 * Llama a Gemini recorriendo la cascada de modelos. No lanza excepciones por fallos de la API.
 * @param {GeminiRequest} request
 * @param {GeminiCallOptions} [options]
 * @returns {GeminiCallResult}
 */
function callGemini(request, options) {
  const opts = options || {};
  const deadline = Date.now() + (opts.deadlineMs || GEMINI_SETTINGS.DEFAULT_DEADLINE_MS);
  /** @type {GeminiAttempt[]} */
  const attempts = [];
  /** @param {GeminiFailure} failure @returns {GeminiCallResult} */
  const fail = failure => ({ ok: false, text: '', model: null, attempts, failure });

  const apiKey = getEnv('GEMINI_API_KEY');
  if (!apiKey) return fail({ kind: 'auth', message: 'GEMINI_API_KEY no está configurada.' });

  // Tras un rechazo de credenciales no se insiste durante unos minutos (la clave va en el hash:
  // si el usuario la cambia, el bloqueo deja de aplicar de inmediato).
  const authKey = GEMINI_SETTINGS.AUTH_FAILURE_KEY_PREFIX + _hashText(apiKey);
  if (!opts.ignoreCooldown && CacheService.getScriptCache().get(authKey)) {
    return fail({
      kind: 'cooldown',
      message: 'Las credenciales de Gemini fueron rechazadas hace poco; se reintentará más tarde.',
    });
  }

  const cascade = getGeminiModelCascade({ ignoreCooldown: opts.ignoreCooldown });
  if (cascade.models.length === 0) {
    return fail({
      kind: 'cooldown',
      message: `Todos los modelos están en enfriamiento (${cascade.skipped.length}); se reintentará más tarde.`,
    });
  }

  let pending = cascade.models;
  for (let pass = 1; pass <= 2; pass++) {
    /** @type {{model: string, retryAfterS: number}[]} */
    const rateLimited = [];
    for (let i = 0; i < pending.length; i++) {
      if (Date.now() >= deadline) {
        return fail({ kind: 'deadline', message: 'Se agotó el tiempo asignado a la IA.' });
      }
      const model = pending[i];
      const outcome = _tryGeminiModel(model, request, apiKey, deadline, attempts);
      if (outcome.ok) {
        return { ok: true, text: outcome.text || '', model, attempts, failure: null };
      }
      if (outcome.kind === 'auth') {
        CacheService.getScriptCache().put(authKey, '1', GEMINI_SETTINGS.COOLDOWN_AUTH_S);
      }
      if (outcome.kind === 'auth' || outcome.kind === 'bad_request') {
        return fail({
          kind: outcome.kind,
          message:
            outcome.kind === 'auth'
              ? `Credenciales o permisos inválidos: ${outcome.message}`
              : `La API rechazó la petición: ${outcome.message}`,
        });
      }
      if (outcome.kind === 'rate_limited') {
        rateLimited.push({
          model,
          retryAfterS: outcome.retryAfterS || GEMINI_SETTINGS.COOLDOWN_RATE_LIMITED_DEFAULT_S,
        });
      }
    }
    if (rateLimited.length === 0 || pass === 2) break;
    const waitS = Math.min.apply(
      null,
      rateLimited.map(r => r.retryAfterS)
    );
    if (Date.now() + waitS * 1000 + 2000 >= deadline) break;
    Utilities.sleep(waitS * 1000);
    pending = rateLimited.map(r => r.model);
  }

  return fail({
    kind: 'unknown',
    message: `Ningún modelo respondió: ${summarizeGeminiAttempts(attempts)}`,
  });
}
