'use strict';

/**
 * Fake de UrlFetchApp con tabla de rutas. Toda llamada sin ruta lanza un error explícito,
 * de modo que una prueba nunca toca la red por accidente.
 */

/**
 * @typedef {object} FakeRequest
 * @property {string} url
 * @property {string} method - En minúsculas.
 * @property {Record<string, string>} headers
 * @property {any} payload - Tal como lo envió el código (string u objeto de formulario).
 * @property {any} json - `payload` parseado si era JSON, o null.
 * @property {URL} parsed
 */

/**
 * @typedef {object} FakeReply
 * @property {number} code
 * @property {any} [body] - Objeto (se serializa a JSON) o string.
 * @property {Record<string, string>} [headers]
 */

/**
 * @typedef {object} Route
 * @property {string} name
 * @property {(req: FakeRequest) => boolean} test
 * @property {(req: FakeRequest) => FakeReply} handle
 */

/**
 */
function createUrlFetchApp() {
  /** @type {Route[]} */
  const routes = [];
  /** @type {{req: FakeRequest, reply: FakeReply|null, error: string|null}[]} */
  const calls = [];

  /**
   * @param {string} url
   * @param {any} [opts]
   */
  function fetch(url, opts = {}) {
    const method = String(opts.method || 'get').toLowerCase();
    let json = null;
    if (typeof opts.payload === 'string') {
      try {
        json = JSON.parse(opts.payload);
      } catch (_) {
        json = null;
      }
    }
    /** @type {FakeRequest} */
    const req = {
      url,
      method,
      headers: opts.headers || {},
      payload: opts.payload,
      json,
      parsed: new URL(url),
    };

    // Gancho para pruebas: permite inspeccionar/mutar el estado en pleno vuelo (ej. ver si hay un lock tomado).
    if (typeof api.onRequest === 'function') api.onRequest(req);

    // Las rutas agregadas más tarde tienen prioridad (permite sobrescribir valores por defecto).
    const route = [...routes].reverse().find(r => r.test(req));
    if (!route) {
      const error = `Sin ruta en el fake para ${method.toUpperCase()} ${url}`;
      calls.push({ req, reply: null, error });
      throw new Error(error);
    }

    /** @type {FakeReply} */
    let reply;
    try {
      reply = route.handle(req);
    } catch (err) {
      calls.push({ req, reply: null, error: /** @type {Error} */ (err).message });
      throw err;
    }
    calls.push({ req, reply, error: null });

    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {});
    if (!opts.muteHttpExceptions && reply.code >= 400) {
      // Igual que Apps Script: el mensaje incluye la URL completa (con la API key si va en la URL).
      throw new Error(
        `Request failed for ${req.parsed.origin} returned code ${reply.code}. Truncated server response: ${text.slice(0, 200)} (use muteHttpExceptions option to examine full response). URL: ${url}`
      );
    }
    return {
      getResponseCode: () => reply.code,
      getContentText: () => text,
      getHeaders: () => reply.headers || {},
      getAllHeaders: () => reply.headers || {},
    };
  }

  const api = {
    fetch,
    addRoute: (/** @type {Route} */ route) => {
      routes.push(route);
    },
    calls,
    callsTo: (/** @type {RegExp|string} */ matcher) =>
      calls.filter(c =>
        matcher instanceof RegExp ? matcher.test(c.req.url) : c.req.url.includes(matcher)
      ),
    reset: () => {
      routes.length = 0;
      calls.length = 0;
    },
    /** @type {((req: FakeRequest) => void)|null} */
    onRequest: null,
  };
  return api;
}

/**
 * Devuelve un handler que entrega las respuestas en orden y repite la última.
 * @param {FakeReply[]} replies
 * @returns {(req: FakeRequest) => FakeReply}
 */
function sequence(replies) {
  let i = 0;
  return () => replies[Math.min(i++, replies.length - 1)];
}

module.exports = { createUrlFetchApp, sequence };
