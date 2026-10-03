'use strict';

/**
 * Criterios de aceptación: parser, configuración, UI y estructura (hallazgos P2/P3).
 * Cada prueba lleva `todo` mientras el defecto exista; se quita al corregirlo.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createEnvironment,
  plain,
  listSourceFiles,
  resolveSourceDir,
} = require('../harness/load-gas');
const { bciEmail, tenpoEmail, asMessage } = require('../harness/builders');
const { findDuplicateDeclarations } = require('../harness/declarations');
const { addTxRow } = require('../harness/scenarios');

const notionProps = {
  NOTION_ENABLED: 'true',
  NOTION_API_TOKEN: 'ntn_x',
  NOTION_DATABASE_ID: 'db1',
};

describe('estructura: namespace global compartido', () => {
  test('ningún nombre global está declarado en más de un archivo (F-STR-1)', () => {
    const dups = findDuplicateDeclarations(listSourceFiles(resolveSourceDir()));
    assert.deepEqual(dups, []);
  });

  test('no quedan funciones de prueba en el código desplegado (F-STR-2)', () => {
    const env = createEnvironment();
    assert.equal(env.gas.has('testGeminiIntegration'), false);
  });

  test('no quedan trazas de depuración [FLAG …] en el código (F-STR-3)', () => {
    const fs = require('node:fs');
    const offenders = listSourceFiles(resolveSourceDir()).filter(f =>
      /\[FLAG/.test(fs.readFileSync(f, 'utf8'))
    );
    assert.deepEqual(offenders, []);
  });
});

describe('parser: detección acotada (falsos positivos)', () => {
  test('la palabra "USD" en el pie de página no convierte una compra en CLP (F-PAR-1)', () => {
    const env = createEnvironment();
    const email = bciEmail({
      monto: '24.590',
      comercio: 'JUMBO',
      extraHtml: '<p>Tipo de cambio referencial USD/CLP disponible en bci.cl</p>',
    });
    const dto = plain(env.gas.call('parseBciEmail', asMessage(email)));
    assert.equal(dto.Monto, 24590);
    assert.doesNotMatch(dto.Comercio_Original, /USD/);
  });

  test('la palabra "anulación" en un pie de página no invierte el signo (F-PAR-2)', () => {
    const env = createEnvironment();
    const email = bciEmail({
      monto: '12.000',
      comercio: 'FARMACIA',
      extraHtml: '<p>Para solicitar la anulación de un cargo contacta a tu ejecutivo.</p>',
    });
    const dto = plain(env.gas.call('parseBciEmail', asMessage(email)));
    assert.equal(dto.Monto, 12000);
  });

  test('el remitente se valida estrictamente por dominio (F-PAR-3)', () => {
    const env = createEnvironment();
    const spoof = {
      ...tenpoEmail({ monto: '1.000', comercio: 'X' }),
      from: 'Tenpo Promos <ofertas@tenpo-promos.xyz>',
    };
    assert.equal(env.gas.call('parseBankEmail', asMessage(spoof)), null);
  });

  test('el fallback cambiario (950) deja una advertencia explícita (F-PAR-4)', () => {
    const env = createEnvironment();
    env.UrlFetchApp.addRoute({
      name: 'mindicador-caido',
      test: req => req.url.startsWith('https://mindicador.cl/'),
      handle: () => ({ code: 500, body: {} }),
    });
    env.gas.call('getUsdToClpRate', '2026-09-27');
    assert.ok(env.logsAt('WARN').some(r => /950/.test(r.message + r.detail)));
  });
});

describe('aliases de comercios', () => {
  /** @param {string} raw */
  function alias(raw) {
    const env = createEnvironment();
    return plain(
      env.gas.call('parseBankEmail', asMessage(tenpoEmail({ monto: '1.000', comercio: raw })))
    );
  }

  test('"CRUZ VERDE" se normaliza a Farmacias Cruz Verde (F-CFG-1)', () => {
    assert.equal(alias('FARMACIAS CRUZ VERDE 123').Comercio_Limpio, 'Farmacias Cruz Verde');
  });

  test('"UBER EATS" no se confunde con Uber (transporte) (F-CFG-2)', () => {
    assert.notEqual(alias('UBER EATS HELP.UBER.C').Comercio_Limpio, 'Uber');
  });

  // F-CFG-3 (conservar el texto bruto del banco) se DIFIERE al roadmap: hoy `Comercio_Original` es la
  // clave del Diccionario y sobrescribirlo con el alias evita miles de variantes. Conservar la
  // trazabilidad exige una columna nueva (esquema), fuera del alcance de esta iteración.
  test('el alias fija Comercio_Original y Comercio_Limpio (clave estable del diccionario)', () => {
    const result = alias('UBER TRIP HELP.UBER.C');
    assert.equal(result.Comercio_Original, 'Uber');
    assert.equal(result.Comercio_Limpio, 'Uber');
  });

  test('alias amplios no capturan palabras ajenas ("LIDERAZGO", "MELIA") (F-CFG-4)', () => {
    assert.notEqual(alias('CURSO LIDERAZGO SPA').Comercio_Limpio, 'Lider');
    assert.notEqual(alias('HOTEL MELIA SANTIAGO').Comercio_Limpio, 'Mercado Libre');
  });
});

describe('interfaz y formato', () => {
  test('uiRescueNotionSync envía a Notion el comercio y la categoría reales de la fila (F-UI-1)', () => {
    const env = createEnvironment({ notion: true, props: notionProps });
    addTxRow(env, 'a', 'Jumbo', 'Supermercado', { monto: 12000 });
    env.tx.select(2, 1, 1, 11);
    env.SpreadsheetApp._ui.queueAlert('YES');
    env.gas.call('uiRescueNotionSync');
    const [page] = env.notion.active();
    assert.equal(page.properties.Comercio.title[0].text.content, 'Jumbo');
    assert.equal(page.properties['Categoría'].select.name, 'Supermercado');
  });

  test('el mensaje del cronómetro coincide con el límite real de 3,5 minutos (F-UI-2)', () => {
    const { envWithLabel, addBciThread } = require('../harness/scenarios');
    const env = envWithLabel();
    for (let i = 1; i <= 25; i++) addBciThread(env, { id: `m${i}`, comercio: `C${i}` });
    let slowOnce = true;
    env.UrlFetchApp.onRequest = req => {
      if (req.url.includes(':generateContent') && slowOnce) {
        slowOnce = false;
        env.advance(4 * 60 * 1000);
      }
    };
    env.gas.call('processEmails');
    const msg = env.logRows().find(r => r.message === 'Paginación Activa');
    assert.ok(msg);
    assert.match(msg.detail, /3[.,]5 min/);
  });

  test('el asistente de credenciales genera un secreto aleatorio en vez de sugerir una clave débil (F-UI-3)', () => {
    const env = createEnvironment();
    const ui = env.SpreadsheetApp._ui;
    ['OK', 'OK', 'OK', 'OK', 'OK'].forEach(b => ui.queuePrompt(b, ''));
    env.gas.call('uiConfigWizard');
    assert.ok(ui.prompts.every(p => !/MiClave123/.test(p.message)));
  });

  test('los montos de las alertas usan un formato CLP determinista (F-UI-4)', () => {
    const env = createEnvironment();
    assert.equal(env.gas.has('formatClp'), true);
    assert.equal(env.gas.call('formatClp', 1500000), '1.500.000');
  });
});
