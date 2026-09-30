'use strict';

/**
 * Caracterización: mantenimiento (orden + sweeper), interfaz de Sheets y estructura del proyecto.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createEnvironment,
  listSourceFiles,
  resolveSourceDir,
  SCHEMA,
} = require('../harness/load-gas');

const PENDING = SCHEMA.PENDING_CATEGORY;

/**
 * Agrega una fila a Transacciones.
 * @param {ReturnType<typeof createEnvironment>} env
 * @param {string} id
 * @param {string} fecha
 * @param {string} hora
 * @param {string} comercio
 * @param {string} categoria
 * @param {number} [monto]
 */
function addTx(env, id, fecha, hora, comercio, categoria, monto = 1000) {
  env.tx.appendRow([id, fecha, hora, comercio, comercio, categoria, '', monto, 1, 'Débito', 'BCI']);
}

describe('mantenimiento: ordenamiento nocturno', () => {
  test('ordena por fecha y luego hora, descendente', () => {
    const env = createEnvironment();
    addTx(env, 'a', '2026-09-01', '10:00', 'A', 'Cat');
    addTx(env, 'b', '2026-09-03', '09:00', 'B', 'Cat');
    addTx(env, 'c', '2026-09-03', '11:00', 'C', 'Cat');
    addTx(env, 'd', '2026-09-02', '12:00', 'D', 'Cat');
    env.gas.call('cleanAndSortData');
    assert.deepEqual(
      env.tx.toObjects().map(r => r.ID_Unico),
      ['c', 'b', 'd', 'a']
    );
    env.LockService.assertNoneHeld();
  });

  test('sin datos no falla y libera el lock', () => {
    const env = createEnvironment();
    assert.doesNotThrow(() => env.gas.call('cleanAndSortData'));
    env.LockService.assertNoneHeld();
  });

  test('uiRunMaintenance avisa al usuario al terminar', () => {
    const env = createEnvironment();
    env.gas.call('uiRunMaintenance');
    assert.equal(env.SpreadsheetApp._ui.alerts.length, 1);
  });
});

describe('mantenimiento: sweeper de transacciones sin clasificar', () => {
  /** @param {ReturnType<typeof createEnvironment>} env */
  function seedPending(env) {
    addTx(env, 'a', '2026-09-01', '10:00', 'JUMBO', PENDING);
    addTx(env, 'b', '2026-09-02', '10:00', 'JUMBO', PENDING);
    addTx(env, 'c', '2026-09-03', '10:00', 'RAPPI', PENDING);
    addTx(env, 'd', '2026-09-04', '10:00', 'UBER', 'Transporte');
  }

  test('reclasifica los pendientes con Gemini y actualiza el diccionario (lock reentrante)', () => {
    // El sweeper toma el lock y luego saveToDatabase lo vuelve a pedir: solo funciona si el lock es
    // reentrante. Ver tests/known-bugs para el comportamiento con lock NO reentrante.
    const env = createEnvironment({ lockReentrant: true });
    seedPending(env);
    const msg = env.gas.call('retryUnclassifiedTransactions');
    assert.equal(msg, '✅ Éxito: Se reclasificaron 3 transacciones históricas.');
    const cats = env.tx.toObjects().map(r => [r.ID_Unico, r['Categoría']]);
    assert.deepEqual(cats, [
      ['a', 'CategoriaIA'],
      ['b', 'CategoriaIA'],
      ['c', 'CategoriaIA'],
      ['d', 'Transporte'],
    ]);
    assert.deepEqual(
      env.dict
        .toObjects()
        .map(r => r['Comercio Banco'])
        .sort(),
      ['JUMBO', 'RAPPI']
    );
    env.LockService.assertNoneHeld();
  });

  test('sin pendientes informa y no llama a Gemini', () => {
    const env = createEnvironment();
    addTx(env, 'd', '2026-09-04', '10:00', 'UBER', 'Transporte');
    assert.equal(
      env.gas.call('retryUnclassifiedTransactions'),
      '✅ No se encontraron transacciones pendientes.'
    );
    assert.equal(env.UrlFetchApp.callsTo(':generateContent').length, 0);
  });

  test('si Gemini no responde deja las filas intactas y lo informa', () => {
    const outage = Object.fromEntries(
      require('../harness/load-gas').REALISTIC_MODELS.map(m => [
        m,
        { code: 503, body: { error: { code: 503, message: 'high demand' } } },
      ])
    );
    const env = createEnvironment({ gemini: { behaviors: outage } });
    seedPending(env);
    const msg = env.gas.call('retryUnclassifiedTransactions');
    assert.equal(msg, '⚠️ Gemini falló nuevamente o los servidores están saturados.');
    assert.equal(env.tx.toObjects().filter(r => r['Categoría'] === PENDING).length, 3);
  });

  test('el job nocturno reclasifica y ordena cuando el lock es reentrante', () => {
    const env = createEnvironment({ lockReentrant: true });
    seedPending(env);
    env.gas.call('cleanAndSortData');
    assert.equal(env.tx.toObjects().filter(r => r['Categoría'] === PENDING).length, 0);
    assert.deepEqual(
      env.tx.toObjects().map(r => r.ID_Unico),
      ['d', 'c', 'b', 'a']
    );
  });

  test('uiRunSweeper muestra el resultado al usuario', () => {
    const env = createEnvironment();
    env.gas.call('uiRunSweeper');
    assert.match(
      env.SpreadsheetApp._ui.alerts[0].message,
      /No se encontraron transacciones pendientes/
    );
  });
});

describe('interfaz de Sheets (ui)', () => {
  test('onOpen construye el menú principal y todos sus handlers existen', () => {
    const env = createEnvironment();
    env.gas.call('onOpen');
    const [menu] = env.SpreadsheetApp._ui.menus;
    assert.equal(menu.name, '🤖 Asistente bancario');
    const handlers = [
      ...menu.items,
      ...menu.submenus.flatMap(/** @param {any} s */ s => s.items),
    ].map(i => i.handler);
    assert.ok(handlers.length >= 9);
    handlers.forEach(h =>
      assert.equal(env.gas.has(h), true, `El handler del menú no existe: ${h}`)
    );
  });

  test('uiSetupTriggers deja exactamente un trigger horario y uno nocturno (idempotente)', () => {
    const env = createEnvironment();
    env.gas.call('uiSetupTriggers');
    env.gas.call('uiSetupTriggers');
    assert.deepEqual(env.ScriptApp.activeHandlers().sort(), ['cleanAndSortData', 'processEmails']);
    const spec = /** @param {string} h */ h =>
      env.ScriptApp._triggers.filter(t => !t.deleted && t.handler === h)[0].spec;
    assert.equal(spec('processEmails').everyHours, 1);
    assert.equal(spec('cleanAndSortData').atHour, 2);
  });

  test('uiConfigWizard guarda solo lo que el usuario confirma', () => {
    const env = createEnvironment({ props: { GEMINI_API_KEY: 'vieja' } });
    const ui = env.SpreadsheetApp._ui;
    ui.queuePrompt('OK', 'nueva-gemini');
    ui.queuePrompt('CANCEL', 'no-guardar');
    ui.queuePrompt('OK', '555');
    ui.queuePrompt('OK', 'clave');
    ui.queuePrompt('OK', 'https://script.google.com/x');
    env.gas.call('uiConfigWizard');
    assert.equal(env.props.getProperty('GEMINI_API_KEY'), 'nueva-gemini');
    assert.equal(env.props.getProperty('TELEGRAM_BOT_TOKEN'), '123456:TEST-TOKEN'); // sin cambios
    assert.equal(env.props.getProperty('TELEGRAM_CHAT_ID'), '555');
    assert.equal(env.props.getProperty('TELEGRAM_SECRET_TOKEN'), 'clave');
    assert.equal(env.props.getProperty('WEB_APP_URL'), 'https://script.google.com/x');
  });

  test('uiToggleNotion activa (avisando si faltan credenciales) y desactiva', () => {
    const env = createEnvironment();
    const ui = env.SpreadsheetApp._ui;
    ui.queueAlert('YES');
    env.gas.call('uiToggleNotion');
    assert.equal(env.props.getProperty('NOTION_ENABLED'), 'true');
    assert.match(ui.alerts.at(-1).title, /Casi listo/);
    ui.queueAlert('NO');
    env.gas.call('uiToggleNotion');
    assert.equal(env.props.getProperty('NOTION_ENABLED'), 'false');
  });

  test('uiToggleTransferIA alterna el consentimiento de privacidad', () => {
    const env = createEnvironment();
    const ui = env.SpreadsheetApp._ui;
    ui.queueAlert('YES');
    env.gas.call('uiToggleTransferIA');
    assert.equal(env.props.getProperty('GEMINI_ANALYZE_TRANSFERS'), 'true');
    ui.queueAlert('NO');
    env.gas.call('uiToggleTransferIA');
    assert.equal(env.props.getProperty('GEMINI_ANALYZE_TRANSFERS'), 'false');
  });

  test('uiDeleteSelectedTransaction valida hoja y selección antes de borrar', () => {
    const env = createEnvironment();
    const ui = env.SpreadsheetApp._ui;
    addTx(env, 'a', '2026-09-01', '10:00', 'A', 'Cat');
    addTx(env, 'b', '2026-09-02', '10:00', 'B', 'Cat');

    env.SpreadsheetApp.setActiveSheet(SCHEMA.SHEETS.DICTIONARY);
    env.gas.call('uiDeleteSelectedTransaction');
    assert.match(ui.alerts.at(-1).title, /Acción no permitida/);

    env.SpreadsheetApp.setActiveSheet(SCHEMA.SHEETS.TRANSACTIONS);
    env.tx.select(1, 1);
    env.gas.call('uiDeleteSelectedTransaction');
    assert.match(ui.alerts.at(-1).title, /Selección inválida/);
    assert.equal(env.tx.toObjects().length, 2);

    env.tx.select(2, 1, 1, 1);
    ui.queueAlert('YES');
    env.gas.call('uiDeleteSelectedTransaction');
    assert.deepEqual(
      env.tx.toObjects().map(r => r.ID_Unico),
      ['b']
    );
    assert.match(ui.alerts.at(-1).message, /Borrado Exitoso/);
  });

  test('uiRescueNotionSync empuja las filas seleccionadas a Notion tras confirmar', () => {
    const env = createEnvironment({
      notion: true,
      props: { NOTION_ENABLED: 'true', NOTION_API_TOKEN: 'ntn_x', NOTION_DATABASE_ID: 'db1' },
    });
    addTx(env, 'a', '2026-09-01', '10:00', 'Jumbo', 'Supermercado', 12000);
    addTx(env, 'b', '2026-09-02', '10:00', 'Uber', 'Transporte', 5000);
    env.tx.select(2, 1, 2, 11);
    env.SpreadsheetApp._ui.queueAlert('YES');
    env.gas.call('uiRescueNotionSync');
    const pages = env.notion.active();
    assert.equal(pages.length, 2);
    assert.deepEqual(
      pages.map(p => p.properties.ID_Unico.rich_text[0].text.content),
      ['a', 'b']
    );
    assert.deepEqual(
      pages.map(p => p.properties.Monto.number),
      [12000, 5000]
    );
  });
});

describe('estructura del proyecto (namespace global compartido)', () => {
  test('los handlers públicos requeridos por triggers y web app existen', () => {
    const env = createEnvironment();
    [
      'processEmails',
      'continueProcessEmails',
      'cleanAndSortData',
      'doPost',
      'onOpen',
      'installApp',
    ].forEach(fn => assert.equal(env.gas.has(fn), true, `Falta la función ${fn}`));
  });

  test('cada archivo carga por sí solo: el orden de carga no importa', () => {
    const files = listSourceFiles(resolveSourceDir());
    assert.ok(files.length >= 10);
    files.forEach(file => {
      assert.doesNotThrow(
        () => createEnvironment({ files: [file] }),
        `Falló al cargar ${file} de forma aislada`
      );
    });
  });
});
