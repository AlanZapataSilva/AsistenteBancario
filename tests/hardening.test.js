'use strict';

/**
 * Endurecimiento: casos extra sobre el DAO, la instalación y las credenciales de Gemini.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createEnvironment } = require('./harness/load-gas');
const { geminiErrors } = require('./harness/http-services');
const {
  envWithLabel,
  addBciThread,
  failAll,
  SCHEMA,
  REALISTIC_MODELS,
} = require('./harness/scenarios');

describe('instalación y diccionario', () => {
  test('las reglas nuevas se anexan tras la última regla aunque la columna de casillas ocupe toda la hoja', () => {
    const env = createEnvironment({ createSheets: false });
    env.gas.call('_setupSheets'); // marca con casillas las ~1000 filas de la columna E
    env.gas.call(
      'saveToDatabase',
      [],
      [
        {
          Comercio_Original: 'JUMBO',
          Comercio_Limpio: 'Jumbo',
          Categoria: 'Super',
          Subcategoria: 'Despensa',
        },
      ]
    );
    env.gas.call(
      'saveToDatabase',
      [],
      [
        {
          Comercio_Original: 'RAPPI',
          Comercio_Limpio: 'Rappi',
          Categoria: 'Delivery',
          Subcategoria: 'Comida',
        },
      ]
    );
    assert.equal(env.dict.cell(2, 1), 'JUMBO');
    assert.equal(env.dict.cell(3, 1), 'RAPPI');
  });

  test('installApp es idempotente y deja hojas, encabezados y etiqueta listos', () => {
    const env = createEnvironment({ createSheets: false });
    env.gas.call('installApp');
    env.gas.call('installApp');
    assert.deepEqual(env.SpreadsheetApp.sheet(SCHEMA.SHEETS.TRANSACTIONS).toObjects(), []);
    assert.equal(env.SpreadsheetApp.sheet(SCHEMA.SHEETS.TRANSACTIONS).cell(1, 1), 'ID_Unico');
    assert.ok(env.GmailApp.getUserLabelByName(SCHEMA.LABEL_PROCESSED));
  });

  test('getTransactionColumns resuelve por encabezado y falla con un mensaje claro si falta uno', () => {
    const env = createEnvironment();
    const cols = env.gas.call('getTransactionColumns', SCHEMA.HEADERS.TRANSACTIONS);
    assert.equal(cols.ID_Unico, 0);
    assert.equal(cols.Categoria, 5);
    assert.throws(
      () => env.gas.call('getTransactionColumns', ['ID_Unico', 'Fecha']),
      /Falta la columna "Hora"/
    );
  });
});

describe('credenciales de Gemini', () => {
  test('tras un rechazo de credenciales no se insiste, y cambiar la clave levanta el bloqueo', () => {
    const behaviors = failAll(REALISTIC_MODELS, geminiErrors.invalidKey());
    const env = envWithLabel({ gemini: { behaviors } });
    addBciThread(env, { id: 'm1' });
    env.gas.call('processEmails');
    const callsAfterFirstRun = env.gemini.generateLog.length;
    assert.equal(callsAfterFirstRun, 1);

    // Un segundo intento inmediato no llega a la red.
    addBciThread(env, { id: 'm2', comercio: 'OTRO' });
    env.gas.call('processEmails');
    assert.equal(env.gemini.generateLog.length, callsAfterFirstRun);

    // El usuario corrige la clave: Gemini vuelve a funcionar y el bloqueo ya no aplica.
    Object.keys(behaviors).forEach(k => delete behaviors[k]);
    env.props.setProperty('GEMINI_API_KEY', 'clave-nueva-y-valida');
    env.gas.call('processEmails');
    assert.equal(
      env.tx.toObjects().filter(r => r['Categoría'] === SCHEMA.PENDING_CATEGORY).length,
      0
    );
  });
});

describe('retención de la hoja Logs', () => {
  test('el mantenimiento nocturno poda los logs más antiguos y conserva los recientes', () => {
    const env = createEnvironment();
    for (let i = 1; i <= 4000; i++)
      env.logs.appendRow(['2026-01-01 00:00:00', 'INFO', `evento ${i}`, '']);
    env.gas.call('cleanAndSortData');
    const rows = env.logs.toObjects();
    assert.ok(rows.length <= 3100, `Quedaron ${rows.length} filas`);
    assert.ok(rows.length >= 3000);
    assert.ok(
      rows.some(r => r.Mensaje === 'evento 4000'),
      'Debe conservar lo más reciente'
    );
    assert.ok(!rows.some(r => r.Mensaje === 'evento 1'), 'Debe eliminar lo más antiguo');
  });

  test('con pocos logs no borra nada', () => {
    const env = createEnvironment();
    for (let i = 1; i <= 100; i++)
      env.logs.appendRow(['2026-01-01 00:00:00', 'INFO', `evento ${i}`, '']);
    env.gas.call('cleanAndSortData');
    assert.ok(env.logs.toObjects().some(r => r.Mensaje === 'evento 1'));
  });
});

describe('manifiesto de Apps Script', () => {
  const manifest = JSON.parse(
    require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'src', 'appsscript.json'),
      'utf8'
    )
  );

  test('mantiene el runtime, la zona horaria y el acceso anónimo que exige el webhook de Telegram', () => {
    assert.equal(manifest.runtimeVersion, 'V8');
    assert.equal(manifest.timeZone, 'America/Santiago');
    assert.equal(manifest.webapp.access, 'ANYONE_ANONYMOUS');
    assert.equal(manifest.webapp.executeAs, 'USER_DEPLOYING');
  });

  test('declara los permisos mínimos necesarios y ninguno más amplio', () => {
    const scopes = new Set(manifest.oauthScopes);
    [
      'https://www.googleapis.com/auth/spreadsheets.currentonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/script.external_request',
      'https://www.googleapis.com/auth/script.scriptapp',
      'https://www.googleapis.com/auth/script.container.ui',
    ].forEach(scope => assert.ok(scopes.has(scope), `Falta el permiso ${scope}`));
    assert.ok(!scopes.has('https://mail.google.com/'), 'No debe pedir acceso total a Gmail');
    assert.ok(!scopes.has('https://www.googleapis.com/auth/spreadsheets'));
  });
});

describe('formato de montos', () => {
  test('formatClp usa punto de miles y maneja negativos y ceros', () => {
    const env = createEnvironment();
    assert.equal(env.gas.call('formatClp', 1500000), '1.500.000');
    assert.equal(env.gas.call('formatClp', 999), '999');
    assert.equal(env.gas.call('formatClp', -12000), '-12.000');
    assert.equal(env.gas.call('formatClp', 0), '0');
    assert.equal(env.gas.call('formatClp', 'x'), '0');
  });
});
