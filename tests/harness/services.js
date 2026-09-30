'use strict';

const crypto = require('node:crypto');

/**
 * Fakes en memoria de los servicios "simples" de Apps Script:
 * PropertiesService, CacheService, LockService, ScriptApp, Utilities, Session, HtmlService.
 */

/**
 * @param {Record<string, string>} [initial]
 */
function createPropertiesService(initial = {}) {
  /** @type {Map<string, string>} */
  const store = new Map(Object.entries(initial));

  const props = {
    getProperty: (/** @type {string} */ key) => (store.has(key) ? store.get(key) : null),
    setProperty: (/** @type {string} */ key, /** @type {string} */ value) => {
      store.set(key, String(value));
      return props;
    },
    deleteProperty: (/** @type {string} */ key) => {
      store.delete(key);
      return props;
    },
    getProperties: () => Object.fromEntries(store),
    setProperties: (/** @type {Record<string,string>} */ obj) => {
      Object.entries(obj).forEach(([k, v]) => store.set(k, String(v)));
      return props;
    },
    getKeys: () => [...store.keys()],
  };

  return {
    getScriptProperties: () => props,
    getUserProperties: () => props,
    getDocumentProperties: () => props,
    /** Acceso directo para aserciones. */
    _store: store,
  };
}

/**
 * CacheService con TTL basado en el reloj inyectado (máximo 6 h, como en Apps Script).
 * @param {{now: () => number}} clock
 */
function createCacheService(clock) {
  /** @type {Map<string, {value: string, expiresAt: number}>} */
  const store = new Map();

  const cache = {
    get: (/** @type {string} */ key) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= clock.now()) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    put: (/** @type {string} */ key, /** @type {string} */ value, ttlSeconds = 600) => {
      if (typeof value !== 'string') {
        throw new Error('CacheService.put solo acepta strings');
      }
      if (value.length > 100 * 1024) {
        throw new Error('Argument too large: value');
      }
      const ttl = Math.min(ttlSeconds, 21600);
      store.set(key, { value, expiresAt: clock.now() + ttl * 1000 });
    },
    remove: (/** @type {string} */ key) => {
      store.delete(key);
    },
    getAll: (/** @type {string[]} */ keys) => {
      /** @type {Record<string, string>} */
      const out = {};
      keys.forEach(k => {
        const v = cache.get(k);
        if (v !== null) out[k] = v;
      });
      return out;
    },
  };

  return {
    getScriptCache: () => cache,
    getUserCache: () => cache,
    getDocumentCache: () => cache,
    _store: store,
  };
}

/**
 * LockService con un estado independiente por tipo de lock (script / usuario / documento), como en
 * Apps Script, y dos modos de reentrancia, porque el comportamiento real no está documentado:
 *  - `reentrant: false` (por defecto): un segundo `Lock` del MISMO tipo pedido por la misma ejecución
 *    espera hasta agotar el timeout y devuelve false (peor caso).
 *  - `reentrant: true`: el segundo `Lock` se concede de inmediato.
 * @param {{now: () => number, advance: (ms: number) => void}} clock
 * @param {{reentrant?: boolean}} [options]
 */
function createLockService(clock, options = {}) {
  const makeState = () => ({
    reentrant: Boolean(options.reentrant),
    /** @type {object|null} */
    holder: null,
    /** Simula que OTRA ejecución tiene el lock. */
    externalHolder: false,
    acquisitions: 0,
    timeouts: 0,
  });
  const states = { script: makeState(), user: makeState(), document: makeState() };

  /** @param {'script'|'user'|'document'} type */
  const lockFactory = type => () => {
    const state = states[type];
    const lock = {
      tryLock: (/** @type {number} */ timeoutMs) => {
        if (state.holder === lock) return true;
        const heldByOther = state.externalHolder || (state.holder !== null && !state.reentrant);
        if (heldByOther) {
          clock.advance(timeoutMs);
          state.timeouts += 1;
          return false;
        }
        state.holder = state.holder ?? lock;
        state.acquisitions += 1;
        return true;
      },
      waitLock: (/** @type {number} */ timeoutMs) => {
        if (!lock.tryLock(timeoutMs)) {
          throw new Error(
            'Exception: Lock timeout: another process was holding the lock for too long.'
          );
        }
      },
      hasLock: () => state.holder === lock,
      releaseLock: () => {
        if (state.holder === lock) state.holder = null;
      },
    };
    return lock;
  };

  return {
    getScriptLock: lockFactory('script'),
    getUserLock: lockFactory('user'),
    getDocumentLock: lockFactory('document'),
    /** Estado del lock de script (el que protege Sheets). */
    _state: states.script,
    _states: states,
    /**
     * @param {boolean} value
     * @param {'script'|'user'|'document'} [type]
     */
    setExternalHolder(value, type = 'script') {
      states[type].externalHolder = value;
    },
    /** @param {boolean} value */
    setReentrant(value) {
      Object.values(states).forEach(st => {
        st.reentrant = value;
      });
    },
    /** Falla si alguna prueba dejó un lock tomado (fuga). */
    assertNoneHeld() {
      Object.entries(states).forEach(([type, st]) => {
        if (st.holder !== null)
          throw new Error(`El lock de tipo "${type}" quedó tomado (fuga de lock).`);
      });
    },
  };
}

/**
 * ScriptApp que registra los triggers creados y eliminados.
 */
function createScriptApp() {
  /** @type {{handler: string, spec: Record<string, unknown>, deleted?: boolean}[]} */
  const triggers = [];

  const newTrigger = (/** @type {string} */ handler) => {
    /** @type {Record<string, unknown>} */
    const spec = { handler };
    /** @type {any} */
    const builder = {
      timeBased: () => {
        spec.type = 'timeBased';
        return builder;
      },
      after: (/** @type {number} */ ms) => {
        spec.after = ms;
        return builder;
      },
      everyHours: (/** @type {number} */ n) => {
        spec.everyHours = n;
        return builder;
      },
      everyDays: (/** @type {number} */ n) => {
        spec.everyDays = n;
        return builder;
      },
      atHour: (/** @type {number} */ h) => {
        spec.atHour = h;
        return builder;
      },
      create: () => {
        const trigger = { handler, spec, deleted: false };
        triggers.push(trigger);
        return {
          getHandlerFunction: () => handler,
          getUniqueId: () => `trg_${triggers.length}`,
        };
      },
    };
    return builder;
  };

  return {
    newTrigger,
    getProjectTriggers: () =>
      triggers.filter(t => !t.deleted).map(t => ({ getHandlerFunction: () => t.handler, _ref: t })),
    deleteTrigger: (/** @type {{_ref: {deleted: boolean}}} */ trigger) => {
      trigger._ref.deleted = true;
    },
    _triggers: triggers,
    /** Handlers de los triggers vivos. */
    activeHandlers: () => triggers.filter(t => !t.deleted).map(t => t.handler),
  };
}

/**
 * Formatea una fecha en una zona horaria usando los patrones que usa el proyecto.
 * @param {Date} date
 * @param {string} timeZone
 * @param {string} pattern - Soporta yyyy, MM, dd, HH, mm, ss.
 * @returns {string}
 */
function formatDate(date, timeZone, pattern) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  /** @type {Record<string, string>} */
  const map = {};
  parts.forEach(p => {
    map[p.type] = p.value;
  });
  return pattern
    .replace('yyyy', map.year)
    .replace('MM', map.month)
    .replace('dd', map.day)
    .replace('HH', map.hour)
    .replace('mm', map.minute)
    .replace('ss', map.second);
}

/**
 * @param {{advance: (ms: number) => void}} clock
 */
function createUtilities(clock) {
  /** @type {number[]} */
  const sleeps = [];
  return {
    sleep: (/** @type {number} */ ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
    formatDate,
    getUuid: () => crypto.randomUUID(),
    _sleeps: sleeps,
  };
}

/**
 * @param {string} [timeZone]
 */
function createSession(timeZone = 'America/Santiago') {
  return {
    getScriptTimeZone: () => timeZone,
    getActiveUser: () => ({ getEmail: () => 'usuario@example.com' }),
  };
}

function createHtmlService() {
  return {
    createHtmlOutput: (/** @type {string} */ content = '') => ({
      _isHtmlOutput: true,
      getContent: () => content,
    }),
  };
}

module.exports = {
  createPropertiesService,
  createCacheService,
  createLockService,
  createScriptApp,
  createUtilities,
  createSession,
  createHtmlService,
  formatDate,
};
