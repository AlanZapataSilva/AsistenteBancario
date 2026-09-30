'use strict';

const fs = require('node:fs');
const path = require('node:path');
const js = require('@eslint/js');
const globals = require('globals');
const jsdoc = require('eslint-plugin-jsdoc');

const { topLevelDeclarations } = require('./tests/harness/declarations');

const srcDir = path.join(__dirname, 'src');

/**
 * Globales de Apps Script (servicios avanzados y clásicos).
 * @type {Record<string, 'readonly'>}
 */
const gasServices = Object.fromEntries(
  [
    'SpreadsheetApp',
    'GmailApp',
    'UrlFetchApp',
    'PropertiesService',
    'CacheService',
    'LockService',
    'ScriptApp',
    'Utilities',
    'Session',
    'HtmlService',
    'ContentService',
    'DriveApp',
    'MailApp',
    'Logger',
    'console',
  ].map(name => [name, 'readonly'])
);

/**
 * En Apps Script todos los archivos comparten un único namespace global. Para que `no-undef`
 * siga detectando errores de tipeo, los nombres declarados en cualquier archivo de `src/` se
 * registran como globales conocidos.
 * @type {Record<string, 'writable'>}
 */
const projectGlobals = Object.fromEntries(
  fs
    .readdirSync(srcDir)
    .filter(file => file.endsWith('.js'))
    .flatMap(file => topLevelDeclarations(path.join(srcDir, file)))
    .map(name => [name, 'writable'])
);

module.exports = [
  { ignores: ['node_modules/**', 'scratch/**', 'coverage/**'] },
  js.configs.recommended,

  // Código que se despliega a Google Apps Script (V8, sin módulos).
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'script',
      globals: { ...gasServices, ...projectGlobals },
    },
    rules: {
      // Los handlers de triggers, menús y web app se invocan desde fuera del código: no son "sin uso".
      'no-unused-vars': ['error', { vars: 'local', args: 'after-used', caughtErrors: 'none' }],
      // Cada función global figura como global conocida; redeclararla entre archivos lo detecta la prueba de estructura.
      'no-redeclare': ['error', { builtinGlobals: false }],
    },
  },

  // Estilo y documentación del código desplegado.
  {
    files: ['src/**/*.js'],
    plugins: { jsdoc },
    rules: {
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
      'no-var': 'error',
      // Sintaxis reciente cuyo soporte en Apps Script V8 no está garantizado: se evita.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ChainExpression',
          message:
            'Evita el encadenamiento opcional (?.) en Apps Script: usa comprobaciones explícitas.',
        },
        {
          selector: "LogicalExpression[operator='??']",
          message: 'Evita el operador ?? en Apps Script: usa comprobaciones explícitas.',
        },
      ],
      // Toda función documentada, con tipos en parámetros y retorno (los tipos los valida tsc).
      'jsdoc/require-jsdoc': [
        'error',
        { publicOnly: false, require: { FunctionDeclaration: true } },
      ],
      'jsdoc/require-param': 'error',
      'jsdoc/require-param-type': 'error',
      'jsdoc/require-param-name': 'error',
      'jsdoc/check-param-names': 'error',
      'jsdoc/require-returns-type': 'error',
      'jsdoc/check-types': 'error',
      'jsdoc/no-multi-asterisks': 'error',
    },
  },

  // Herramientas y pruebas locales (Node, CommonJS). Nunca se despliegan.
  {
    files: ['tests/**/*.js', 'scripts/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { args: 'after-used', caughtErrors: 'none' }],
    },
  },
];
