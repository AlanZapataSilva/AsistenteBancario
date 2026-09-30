/**
 * Archivo: notion.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Cliente de integración con la API de Notion.
 * Documentación oficial: https://developers.notion.com/
 * Toda petición respeta el límite de velocidad (500 ms de pausa) y reintenta ante un 429
 * usando el encabezado Retry-After.
 */

const NOTION_SETTINGS = Object.freeze({
  API_BASE: 'https://api.notion.com/v1',
  VERSION: '2022-06-28',
  THROTTLE_MS: 500,
  MAX_RETRIES: 2,
  DEFAULT_RETRY_MS: 2000,
  MAX_RETRY_MS: 10000,
});

/**
 * Credenciales de Notion desde las propiedades del script.
 * @returns {{token: string, databaseId: string}|null} null si falta alguna.
 */
function _getNotionCredentials() {
  const token = getEnv('NOTION_API_TOKEN');
  const databaseId = getEnv('NOTION_DATABASE_ID');
  return token && databaseId ? { token, databaseId } : null;
}

/**
 * Ejecuta una petición a Notion con pausa de seguridad y reintento ante 429. No lanza excepciones.
 * @param {'get'|'post'|'patch'} method
 * @param {string} path - Ruta relativa a `API_BASE` (ej. `/pages`).
 * @param {object | null} body
 * @param {string} token
 * @returns {{code: number, text: string}} `code` 0 indica error de red.
 */
function _notionRequest(method, path, body, token) {
  /** @type {GoogleAppsScript.URL_Fetch.URLFetchRequestOptions} */
  const options = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_SETTINGS.VERSION,
    },
    muteHttpExceptions: true,
  };
  if (body) options.payload = JSON.stringify(body);

  for (let attempt = 0; attempt <= NOTION_SETTINGS.MAX_RETRIES; attempt++) {
    try {
      const response = UrlFetchApp.fetch(`${NOTION_SETTINGS.API_BASE}${path}`, options);
      const code = response.getResponseCode();
      if (code === 429 && attempt < NOTION_SETTINGS.MAX_RETRIES) {
        const headers = /** @type {Record<string, string>} */ (response.getHeaders());
        const retryAfter = Number(headers['Retry-After'] || headers['retry-after']);
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : NOTION_SETTINGS.DEFAULT_RETRY_MS;
        Utilities.sleep(Math.min(waitMs, NOTION_SETTINGS.MAX_RETRY_MS));
        continue;
      }
      Utilities.sleep(NOTION_SETTINGS.THROTTLE_MS);
      return { code, text: response.getContentText() };
    } catch (error) {
      Utilities.sleep(NOTION_SETTINGS.THROTTLE_MS);
      return { code: 0, text: /** @type {Error} */ (error).message };
    }
  }
  return { code: 429, text: 'Límite de peticiones de Notion excedido tras reintentos.' };
}

/**
 * Envía un lote de transacciones a una base de datos de Notion.
 * @param {NotionTransaction[]} transactions - Transacciones a crear como páginas.
 */
function pushToNotion(transactions) {
  if (!transactions || transactions.length === 0) return;

  const credentials = _getNotionCredentials();
  if (!credentials) {
    logSystemEvent('WARN', 'Intento de envío a Notion abortado: Faltan credenciales.');
    return;
  }

  let exitos = 0;
  transactions.forEach(tx => {
    // Mapeo estricto al schema de Notion
    const payload = {
      parent: { database_id: credentials.databaseId },
      properties: {
        Comercio: { title: [{ text: { content: tx.Comercio_Limpio } }] },
        Monto: { number: tx.Monto },
        Fecha: { date: { start: tx.Fecha } },
        Categoría: { select: { name: tx.Categoria } },
        Tipo: { select: { name: tx.Tipo } },
        ID_Unico: { rich_text: [{ text: { content: tx.ID_Unico } }] },
        Origen: { select: { name: tx.Origen } },
      },
    };

    const response = _notionRequest('post', '/pages', payload, credentials.token);
    if (response.code === 200) {
      exitos++;
    } else if (response.code === 0) {
      logSystemEvent('ERROR', 'Fallo de red en API de Notion', response.text);
    } else {
      logSystemEvent(
        'ERROR',
        `Fallo al escribir en Notion (Código ${response.code})`,
        response.text
      );
    }
  });

  console.log(
    `Sincronización con Notion finalizada: ${exitos}/${transactions.length} transacciones guardadas.`
  );
}

/**
 * Busca en Notion la página de una transacción por su ID_Unico.
 * @param {string} idUnico
 * @param {{token: string, databaseId: string}} credentials
 * @returns {{pageId: string|null, error: string|null}} `error` describe un fallo de la consulta (no "no encontrada").
 */
function _findNotionPageId(idUnico, credentials) {
  const query = {
    filter: {
      property: 'ID_Unico', // Debe llamarse EXACTAMENTE así en tu base de Notion
      rich_text: { equals: idUnico },
    },
  };
  const response = _notionRequest(
    'post',
    `/databases/${credentials.databaseId}/query`,
    query,
    credentials.token
  );
  if (response.code !== 200) {
    return { pageId: null, error: `Http ${response.code}: ${response.text}` };
  }
  const json = JSON.parse(response.text);
  const results = Array.isArray(json.results) ? json.results : [];
  return { pageId: results.length > 0 ? results[0].id : null, error: null };
}

/**
 * Busca y archiva (elimina) una transacción en Notion usando su ID_Unico.
 * @param {string} idUnico - El ID_Unico de la transacción.
 * @returns {boolean} True si se archivó correctamente, False si falló.
 */
function deleteTransactionInNotion(idUnico) {
  const credentials = _getNotionCredentials();
  if (!credentials) {
    logSystemEvent('ERROR', 'Notion Delete', 'Faltan credenciales.');
    return false;
  }

  const found = _findNotionPageId(idUnico, credentials);
  if (found.error) {
    logSystemEvent('ERROR', 'Notion Query Error', found.error);
    return false;
  }
  if (!found.pageId) {
    logSystemEvent(
      'WARN',
      'Notion Delete',
      `La búsqueda fue exitosa, pero Notion no encontró el ID: ${idUnico}. Revisa el nombre de la columna.`
    );
    return false;
  }

  const archived = _notionRequest(
    'patch',
    `/pages/${found.pageId}`,
    { archived: true },
    credentials.token
  );
  if (archived.code !== 200) {
    logSystemEvent('ERROR', 'Notion Archive Error', archived.text);
    return false;
  }

  logSystemEvent(
    'INFO',
    'Notion Delete Exitoso',
    `La fila con ID ${idUnico} fue borrada de Notion.`
  );
  return true;
}

/**
 * Actualiza en Notion el comercio y la categoría de una transacción ya sincronizada
 * (por ejemplo, tras reclasificarla con IA).
 * @param {string} idUnico
 * @param {{Comercio_Limpio?: string, Categoria?: string}} fields
 * @returns {boolean} True si la página se actualizó.
 */
function updateTransactionInNotion(idUnico, fields) {
  const credentials = _getNotionCredentials();
  if (!credentials) return false;

  const found = _findNotionPageId(idUnico, credentials);
  if (found.error) {
    logSystemEvent('ERROR', 'Notion Query Error', found.error);
    return false;
  }
  if (!found.pageId) return false;

  /** @type {Record<string, any>} */
  const properties = {};
  if (fields.Comercio_Limpio) {
    properties.Comercio = { title: [{ text: { content: fields.Comercio_Limpio } }] };
  }
  if (fields.Categoria) properties['Categoría'] = { select: { name: fields.Categoria } };
  if (Object.keys(properties).length === 0) return true;

  const updated = _notionRequest(
    'patch',
    `/pages/${found.pageId}`,
    { properties },
    credentials.token
  );
  if (updated.code !== 200) {
    logSystemEvent('ERROR', `Fallo al actualizar Notion (Código ${updated.code})`, updated.text);
    return false;
  }
  return true;
}
