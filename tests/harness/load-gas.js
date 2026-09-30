'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createClock } = require('./clock');
const { createSpreadsheetApp } = require('./spreadsheet');
const { createGmailApp } = require('./gmail');
const { createUrlFetchApp } = require('./urlfetch');
const {
  createPropertiesService,
  createCacheService,
  createLockService,
  createScriptApp,
  createUtilities,
  createSession,
  createHtmlService,
} = require('./services');
const {
  installGemini,
  installTelegram,
  installNotion,
  installMindicador,
} = require('./http-services');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Encabezados del esquema de Sheets, escritos a propósito de forma literal e independiente del
 * código: un cambio accidental en CONFIG.HEADERS rompe `schema.test.js` (regla "sin cambios de esquema").
 */
const SCHEMA = Object.freeze({
  SHEETS: { TRANSACTIONS: 'Transacciones', DICTIONARY: 'Diccionario', LOGS: 'Logs' },
  HEADERS: {
    TRANSACTIONS: [
      'ID_Unico',
      'Fecha',
      'Hora',
      'Comercio Original',
      'Comercio Limpio',
      'Categoría',
      'Subcategoría',
      'Monto',
      'Cuotas',
      'Tipo',
      'Origen',
    ],
    DICTIONARY: [
      'Comercio Banco',
      'Comercio Limpio',
      'Categoría Gemini',
      'Subcategoría',
      'Auditoría Manual (Check)',
    ],
    LOGS: ['Timestamp', 'Nivel', 'Mensaje', 'Stack Trace'],
  },
  LABEL_PROCESSED: 'SaaS_Finanzas/Procesado',
  PENDING_CATEGORY: 'Por Clasificar Automáticamente',
});

/** Modelos que, según la documentación oficial (2026-09), existen y sirven generateContent. */
const REALISTIC_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
];

/**
 * Directorio con el código GAS a cargar: `GAS_SRC_DIR`, o `src/` si existe, o la raíz del repo.
 * @returns {string}
 */
function resolveSourceDir() {
  if (process.env.GAS_SRC_DIR) return path.resolve(process.env.GAS_SRC_DIR);
  const src = path.join(REPO_ROOT, 'src');
  return fs.existsSync(src) ? src : REPO_ROOT;
}

/**
 * Lista los archivos de código GAS de un directorio en orden alfabético (como clasp).
 * @param {string} dir
 * @returns {string[]} Rutas absolutas.
 */
function listSourceFiles(dir) {
  const inSrc = path.basename(dir) === 'src';
  const allowed = inSrc ? ['.gs', '.js'] : ['.gs'];
  return fs
    .readdirSync(dir)
    .filter(f => allowed.includes(path.extname(f)))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map(f => path.join(dir, f));
}

/**
 * Normaliza un valor creado dentro del contexto `vm` a objetos del realm principal, para poder
 * compararlo con `assert.deepStrictEqual`.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function plain(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * @typedef {object} EnvOptions
 * @property {string} [dir] - Directorio de código a cargar.
 * @property {string[]} [files] - Lista explícita de archivos (para controlar el orden de carga).
 * @property {Record<string, string>} [props] - Script Properties adicionales/sobrescritas.
 * @property {boolean} [createSheets] - Crea las 3 hojas con sus encabezados (por defecto true).
 * @property {boolean} [load] - Carga el código (por defecto true).
 * @property {null|false|object} [gemini] - false para no instalar Gemini; objeto = config de installGemini.
 * @property {boolean|object} [notion] - true/objeto para instalar Notion en memoria.
 * @property {boolean} [lockReentrant] - Modo de reentrancia del LockService.
 * @property {boolean} [verboseConsole] - Imprime console.* del código bajo prueba.
 */

/**
 * Crea un entorno completo: fakes de GAS + código cargado en un contexto `vm` compartido.
 * @param {EnvOptions} [options]
 */
function createEnvironment(options = {}) {
  const clock = createClock();
  const SpreadsheetApp = createSpreadsheetApp();
  const GmailApp = createGmailApp(clock);
  const UrlFetchApp = createUrlFetchApp();
  const PropertiesService = createPropertiesService({
    GEMINI_API_KEY: 'test-gemini-key',
    TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN',
    TELEGRAM_CHAT_ID: '1001',
    TELEGRAM_SECRET_TOKEN: 's3cret',
    WEB_APP_URL: 'https://script.google.com/macros/s/TEST/exec',
    INITIAL_BACKFILL_COMPLETED: 'true',
    ...(options.props ?? {}),
  });
  const CacheService = createCacheService(clock);
  const LockService = createLockService(clock, { reentrant: options.lockReentrant });
  const ScriptApp = createScriptApp();
  const Utilities = createUtilities(clock);
  const Session = createSession();
  const HtmlService = createHtmlService();

  /** @type {{level: string, args: any[]}[]} */
  const consoleLog = [];
  const makeLogger =
    (/** @type {string} */ level) =>
    (/** @type {any[]} */ ...args) => {
      consoleLog.push({ level, args });
      if (options.verboseConsole) console.log(`[gas:${level}]`, ...args);
    };

  const sandbox = {
    console: {
      log: makeLogger('log'),
      info: makeLogger('info'),
      warn: makeLogger('warn'),
      error: makeLogger('error'),
    },
    Logger: { log: makeLogger('Logger.log') },
    SpreadsheetApp,
    GmailApp,
    UrlFetchApp,
    PropertiesService,
    CacheService,
    LockService,
    ScriptApp,
    Utilities,
    Session,
    HtmlService,
    Date: clock.Date,
  };

  // HTTP falsos
  const telegram = installTelegram(UrlFetchApp);
  installMindicador(UrlFetchApp);
  const gemini =
    options.gemini === false
      ? null
      : installGemini(UrlFetchApp, { models: REALISTIC_MODELS, ...(options.gemini || {}) });
  const notion = options.notion
    ? installNotion(UrlFetchApp, typeof options.notion === 'object' ? options.notion : {})
    : null;

  if (options.createSheets !== false) {
    SpreadsheetApp.addSheet(SCHEMA.SHEETS.TRANSACTIONS, SCHEMA.HEADERS.TRANSACTIONS);
    SpreadsheetApp.addSheet(SCHEMA.SHEETS.DICTIONARY, SCHEMA.HEADERS.DICTIONARY);
    SpreadsheetApp.addSheet(SCHEMA.SHEETS.LOGS, SCHEMA.HEADERS.LOGS);
    SpreadsheetApp.setActiveSheet(SCHEMA.SHEETS.TRANSACTIONS);
  }

  const context = vm.createContext(sandbox);

  /** @type {string[]} */
  let loadedFiles = [];
  if (options.load !== false) {
    const dir = options.dir ? path.resolve(options.dir) : resolveSourceDir();
    loadedFiles = options.files ?? listSourceFiles(dir);
    for (const file of loadedFiles) {
      const source = fs.readFileSync(file, 'utf8');
      try {
        new vm.Script(source, { filename: file }).runInContext(context);
      } catch (err) {
        /** @type {Error} */ (err).message =
          `[${path.basename(file)}] ${/** @type {Error} */ (err).message}`;
        throw err;
      }
    }
  }

  const gas = {
    /** Evalúa una expresión en el contexto GAS (sirve para leer `const` globales). */
    eval: (/** @type {string} */ code) => vm.runInContext(code, context),
    get: (/** @type {string} */ name) => vm.runInContext(name, context),
    has: (/** @type {string} */ name) => vm.runInContext(`typeof ${name} !== 'undefined'`, context),
    call: (/** @type {string} */ name, /** @type {any[]} */ ...args) => {
      const fn = vm.runInContext(name, context);
      if (typeof fn !== 'function')
        throw new Error(`${name} no es una función en el código cargado`);
      return fn(...args);
    },
    context,
  };

  const env = {
    clock,
    gas,
    files: loadedFiles,
    SpreadsheetApp,
    GmailApp,
    UrlFetchApp,
    PropertiesService,
    CacheService,
    LockService,
    ScriptApp,
    Utilities,
    telegram,
    gemini,
    notion,
    console: consoleLog,
    props: PropertiesService.getScriptProperties(),

    /** @param {string} name */
    sheet: name => SpreadsheetApp.sheet(name),
    get tx() {
      return SpreadsheetApp.sheet(SCHEMA.SHEETS.TRANSACTIONS);
    },
    get dict() {
      return SpreadsheetApp.sheet(SCHEMA.SHEETS.DICTIONARY);
    },
    get logs() {
      return SpreadsheetApp.sheet(SCHEMA.SHEETS.LOGS);
    },

    /** Filas de la hoja Logs como objetos simples. */
    logRows() {
      return this.logs.toObjects().map(r => ({
        level: String(r.Nivel),
        message: String(r.Mensaje),
        detail: String(r['Stack Trace']),
      }));
    },
    /** @param {string} level */
    logsAt(level) {
      return this.logRows().filter(r => r.level === level);
    },
    /** Texto completo de los logs (mensaje + detalle), útil para buscar filtraciones. */
    allLogText() {
      return this.logRows()
        .map(r => `${r.level} ${r.message} ${r.detail}`)
        .join('\n');
    },

    /** Simula el tiempo que pasa. */
    /** @param {number} ms */
    advance(ms) {
      clock.advance(ms);
    },
  };

  return env;
}

module.exports = {
  createEnvironment,
  listSourceFiles,
  resolveSourceDir,
  plain,
  SCHEMA,
  REALISTIC_MODELS,
  REPO_ROOT,
};
