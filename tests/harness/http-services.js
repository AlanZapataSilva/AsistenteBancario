'use strict';

/**
 * Servidores HTTP falsos (Gemini, Telegram, Notion, mindicador.cl) instalables sobre el
 * fake de UrlFetchApp. Reproducen las respuestas reales, incluidos los errores del incidente.
 */

const GEMINI_HOST = 'https://generativelanguage.googleapis.com';

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/**
 * Cuerpos de error idénticos a los que devolvió la API en los logs del incidente.
 */
const geminiErrors = {
  /** @param {string} model @param {number} [retrySeconds] */
  quotaExceededFreeTier(model, retrySeconds = 37) {
    return {
      code: 429,
      body: {
        error: {
          code: 429,
          message:
            'You exceeded your current quota, please check your plan and billing details. ' +
            `* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: ${model} ` +
            `Please retry in ${retrySeconds}.462511626s.`,
          status: 'RESOURCE_EXHAUSTED',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${retrySeconds}s` },
          ],
        },
      },
    };
  },
  /** @param {number} [retrySeconds] */
  rateLimited(retrySeconds = 12) {
    return {
      code: 429,
      body: {
        error: {
          code: 429,
          message: `Resource has been exhausted (e.g. check quota). Please retry in ${retrySeconds}s.`,
          status: 'RESOURCE_EXHAUSTED',
          details: [
            { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${retrySeconds}s` },
          ],
        },
      },
    };
  },
  highDemand() {
    return {
      code: 503,
      body: {
        error: {
          code: 503,
          message:
            'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
          status: 'UNAVAILABLE',
        },
      },
    };
  },
  /** @param {string} model */
  notFound(model) {
    return {
      code: 404,
      body: {
        error: {
          code: 404,
          message: `models/${model} is not found for API version v1beta, or is not supported for generateContent. Call ModelService.ListModels to see the list of available models and their supported methods.`,
          status: 'NOT_FOUND',
        },
      },
    };
  },
  invalidKey() {
    return {
      code: 400,
      body: {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
        },
      },
    };
  },
  permissionDenied() {
    return {
      code: 403,
      body: {
        error: {
          code: 403,
          message:
            'Generative Language API has not been used in project 123 before or it is disabled.',
          status: 'PERMISSION_DENIED',
        },
      },
    };
  },
};

/**
 * Extrae la última lista JSON de un prompt (las transacciones que el código envía a Gemini).
 * @param {string} text
 * @returns {any[]}
 */
function extractLastJsonArray(text) {
  const start = text.lastIndexOf('[\n');
  const candidates = start >= 0 ? [text.slice(start)] : [];
  candidates.push(text.slice(text.lastIndexOf('[')));
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c.trim());
      if (Array.isArray(parsed)) return parsed;
    } catch (_) {
      // probar el siguiente candidato
    }
  }
  throw new Error('El fake de Gemini no encontró una lista JSON en el prompt.');
}

/**
 * @typedef {object} GeminiModelSpec
 * @property {string} name - Ej. "gemini-3.8-flash".
 * @property {string[]} [methods] - Por defecto ["generateContent"].
 */

/**
 * Instala las rutas de Gemini.
 * @param {ReturnType<import('./urlfetch').createUrlFetchApp>} urlfetch
 * @param {object} [config]
 * @param {(string|GeminiModelSpec)[]} [config.models] - Modelos que "existen".
 * @param {Record<string, any>} [config.behaviors] - Por modelo: `null` (sano), una respuesta `{code, body}`,
 *   una función `(req, callNumber) => respuesta|null`, o un arreglo (se consume en orden y repite el último).
 * @param {(item: any) => Record<string, string>} [config.classify] - Clasificador por elemento.
 * @param {string} [config.apiKey] - Si se define, exige esta llave (header o query).
 * @param {number} [config.pageSize] - Tamaño de página de ListModels si el cliente no lo pide (real: 50).
 * @param {number} [config.maxPageSize] - Tope del tamaño de página que el servidor concede (real: 1000).
 * @param {boolean} [config.listFails] - Si true, ListModels responde 500.
 */
function installGemini(urlfetch, config = {}) {
  const models = (config.models ?? ['gemini-3.8-flash']).map(m =>
    typeof m === 'string' ? { name: m } : m
  );
  const behaviors = config.behaviors ?? {};
  const pageSize = config.pageSize ?? 50;
  /** @type {Record<string, number>} */
  const callCount = {};
  /** @type {{model: string, ok: boolean, code: number}[]} */
  const generateLog = [];

  const classify =
    config.classify ??
    /** @param {any} item */ (item => ({
      Comercio_Limpio: String(item.Comercio_Original).replace(/\*.*$/, '').trim(),
      Categoria: 'CategoriaIA',
      Subcategoria: 'SubcategoriaIA',
    }));

  /** @param {import('./urlfetch').FakeRequest} req */
  const keyOk = req => {
    if (!config.apiKey) return true;
    const headerKey = req.headers['x-goog-api-key'] || req.headers['X-Goog-Api-Key'];
    return headerKey === config.apiKey || req.parsed.searchParams.get('key') === config.apiKey;
  };

  urlfetch.addRoute({
    name: 'gemini-list-models',
    test: req =>
      req.method === 'get' &&
      req.url.startsWith(`${GEMINI_HOST}/v1beta/models`) &&
      !req.parsed.pathname.includes(':'),
    handle: req => {
      if (!keyOk(req)) return geminiErrors.invalidKey();
      if (config.listFails)
        return { code: 500, body: { error: { code: 500, message: 'Internal error' } } };
      const size = Math.min(
        Number(req.parsed.searchParams.get('pageSize')) || pageSize,
        config.maxPageSize ?? 1000
      );
      const start = Number(req.parsed.searchParams.get('pageToken')) || 0;
      const slice = models.slice(start, start + Math.min(size, 1000));
      const next = start + slice.length < models.length ? String(start + slice.length) : undefined;
      return {
        code: 200,
        body: {
          models: slice.map(m => ({
            name: `models/${m.name}`,
            supportedGenerationMethods: m.methods ?? ['generateContent', 'countTokens'],
          })),
          ...(next ? { nextPageToken: next } : {}),
        },
      };
    },
  });

  urlfetch.addRoute({
    name: 'gemini-generate',
    test: req =>
      req.method === 'post' && /\/v1beta\/models\/[^/:]+:generateContent/.test(req.parsed.pathname),
    handle: req => {
      const model = /** @type {string} */ (req.parsed.pathname.match(/models\/([^/:]+):/)?.[1]);
      callCount[model] = (callCount[model] ?? 0) + 1;

      /** @param {{code: number, body: any}} reply */
      const finish = reply => {
        generateLog.push({ model, ok: reply.code === 200, code: reply.code });
        return reply;
      };

      if (!keyOk(req)) return finish(geminiErrors.invalidKey());
      if (!models.some(m => m.name === model)) return finish(geminiErrors.notFound(model));

      let behavior = behaviors[model];
      if (Array.isArray(behavior))
        behavior = behavior[Math.min(callCount[model] - 1, behavior.length - 1)];
      if (typeof behavior === 'function') behavior = behavior(req, callCount[model]);
      if (behavior) return finish(behavior);

      const text = req.json?.contents?.[0]?.parts?.[0]?.text ?? '';
      const items = extractLastJsonArray(text);
      const answer = items.map((/** @type {any} */ item) => ({
        id: item.id,
        Comercio_Original: item.Comercio_Original,
        ...classify(item),
      }));
      return finish({
        code: 200,
        body: {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] },
              finishReason: 'STOP',
            },
          ],
        },
      });
    },
  });

  return {
    /** Cantidad de llamadas generateContent por modelo. */
    callCount,
    generateLog,
    /** Modelos intentados, en orden. */
    attemptedModels: () => generateLog.map(g => g.model),
  };
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<import('./urlfetch').createUrlFetchApp>} urlfetch
 */
function installTelegram(urlfetch) {
  /** @type {{method: string, payload: any}[]} */
  const requests = [];
  urlfetch.addRoute({
    name: 'telegram',
    test: req => req.url.startsWith('https://api.telegram.org/bot'),
    handle: req => {
      const method = req.parsed.pathname.split('/').pop() ?? '';
      requests.push({ method, payload: req.json ?? req.payload });
      return { code: 200, body: { ok: true, result: {} } };
    },
  });
  return {
    requests,
    /** Mensajes enviados con sendMessage. */
    messages: () => requests.filter(r => r.method === 'sendMessage').map(r => r.payload),
    /** Textos de los mensajes enviados. */
    texts: () => requests.filter(r => r.method === 'sendMessage').map(r => String(r.payload.text)),
    clear: () => {
      requests.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

/**
 * Notion en memoria: crear página, consultar por ID_Unico, archivar y actualizar propiedades.
 * @param {ReturnType<import('./urlfetch').createUrlFetchApp>} urlfetch
 * @param {{failCreateWith?: {code: number, body?: any, headers?: Record<string,string>}}} [config]
 */
function installNotion(urlfetch, config = {}) {
  /** @type {Map<string, {id: string, properties: any, archived: boolean}>} */
  const pages = new Map();
  let seq = 0;
  const state = { failCreateWith: config.failCreateWith };

  urlfetch.addRoute({
    name: 'notion',
    test: req => req.url.startsWith('https://api.notion.com/v1/'),
    handle: req => {
      const path = req.parsed.pathname;
      if (req.method === 'post' && path === '/v1/pages') {
        if (state.failCreateWith) {
          return {
            code: state.failCreateWith.code,
            body: state.failCreateWith.body ?? {},
            headers: state.failCreateWith.headers,
          };
        }
        const id = `notion_page_${++seq}`;
        pages.set(id, { id, properties: req.json.properties, archived: false });
        return { code: 200, body: { id, object: 'page' } };
      }
      const query = path.match(/^\/v1\/databases\/[^/]+\/query$/);
      if (req.method === 'post' && query) {
        const wanted = req.json?.filter?.rich_text?.equals;
        const results = [...pages.values()].filter(
          p => !p.archived && p.properties?.ID_Unico?.rich_text?.[0]?.text?.content === wanted
        );
        return { code: 200, body: { results: results.map(p => ({ id: p.id })) } };
      }
      const patch = path.match(/^\/v1\/pages\/([^/]+)$/);
      if (req.method === 'patch' && patch) {
        const page = pages.get(patch[1]);
        if (!page) return { code: 404, body: { message: 'not found' } };
        if (req.json.archived === true) page.archived = true;
        if (req.json.properties) Object.assign(page.properties, req.json.properties);
        return { code: 200, body: { id: page.id } };
      }
      return {
        code: 400,
        body: { message: `Ruta Notion no soportada por el fake: ${req.method} ${path}` },
      };
    },
  });

  return {
    pages,
    state,
    /** Páginas no archivadas. */
    active: () => [...pages.values()].filter(p => !p.archived),
  };
}

// ---------------------------------------------------------------------------
// mindicador.cl
// ---------------------------------------------------------------------------

/**
 * @param {ReturnType<import('./urlfetch').createUrlFetchApp>} urlfetch
 * @param {{rate?: number, emptyForDates?: string[], failing?: boolean}} [config]
 */
function installMindicador(urlfetch, config = {}) {
  const rate = config.rate ?? 900;
  urlfetch.addRoute({
    name: 'mindicador',
    test: req => req.url.startsWith('https://mindicador.cl/api/dolar'),
    handle: req => {
      if (config.failing) return { code: 500, body: {} };
      const datePart = req.parsed.pathname.split('/')[3];
      if (datePart && (config.emptyForDates ?? []).includes(datePart)) {
        return { code: 200, body: { serie: [] } };
      }
      return { code: 200, body: { serie: [{ fecha: '2026-09-30T04:00:00.000Z', valor: rate }] } };
    },
  });
}

module.exports = {
  GEMINI_HOST,
  extractLastJsonArray,
  geminiErrors,
  installGemini,
  installTelegram,
  installNotion,
  installMindicador,
};
