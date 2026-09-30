'use strict';

/**
 * Criterios de aceptación de integridad y seguridad (hallazgos P1 de docs/AUDITORIA.md).
 * Cada prueba lleva `todo` mientras el defecto exista; se quita al corregirlo.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createEnvironment } = require('../harness/load-gas');
const { geminiErrors } = require('../harness/http-services');
const {
  envWithLabel,
  addBciThread,
  addTxRow,
  failAll,
  SCHEMA,
  REALISTIC_MODELS,
} = require('../harness/scenarios');

const PENDING = SCHEMA.PENDING_CATEGORY;
const notionProps = {
  NOTION_ENABLED: 'true',
  NOTION_API_TOKEN: 'ntn_x',
  NOTION_DATABASE_ID: 'db1',
};

/**
 * @param {ReturnType<typeof createEnvironment>} env
 * @param {any} body
 * @param {string|null} [token]
 */
function post(env, body, token = 's3cret') {
  return env.gas.call('doPost', {
    parameter: token === null ? {} : { token },
    postData: { contents: JSON.stringify(body) },
  });
}

describe('extractor: integridad de la ingesta', () => {
  test('si el guardado falla, el hilo NO se etiqueta y se reintenta en la siguiente corrida (F-EXT-1)', () => {
    const env = envWithLabel();
    const thread = addBciThread(env);
    env.LockService.setExternalHolder(true); // otra ejecución tiene el lock: saveToDatabase falla
    env.gas.call('processEmails');
    assert.deepEqual(
      env.GmailApp.labelsOf(thread),
      [],
      'El hilo no debe quedar etiquetado si no se guardó'
    );
    env.LockService.setExternalHolder(false);
    env.gas.call('processEmails');
    assert.equal(env.tx.toObjects().length, 1);
  });

  test('si la etiqueta de Gmail no existe, se crea y no se reprocesa en bucle (F-EXT-2)', () => {
    const env = createEnvironment(); // sin installApp: la etiqueta no existe
    const thread = addBciThread(env);
    env.gas.call('processEmails');
    assert.deepEqual(env.GmailApp.labelsOf(thread), [SCHEMA.LABEL_PROCESSED]);
    assert.ok(
      env.GmailApp._searches.length <= 2,
      `Demasiadas búsquedas: ${env.GmailApp._searches.length}`
    );
    assert.equal(env.ScriptApp.activeHandlers().includes('continueProcessEmails'), false);
  });

  test('una ejecución solapada (otra tiene el lock de extracción) se omite sin duplicar (F-EXT-3)', () => {
    const env = envWithLabel();
    addBciThread(env);
    env.LockService.setExternalHolder(true, 'user'); // lock de proceso de la extracción
    env.gas.call('processEmails');
    assert.equal(env.tx.getLastRow(), 1);
    assert.ok(env.logRows().some(r => /omit|solap|ocupad/i.test(r.message + r.detail)));
  });

  test('saveToDatabase es idempotente: el mismo ID no se inserta dos veces (F-EXT-3)', () => {
    const env = createEnvironment();
    const t = {
      ID_Unico: 'dup1',
      Fecha: '2026-09-27',
      Hora: '10:00',
      Comercio_Original: 'X',
      Comercio_Limpio: 'X',
      Categoria: 'C',
      Subcategoria: '',
      Monto: 1,
      Cuotas: 1,
      Tipo: 'Débito',
      Origen: 'BCI',
    };
    env.gas.call('saveToDatabase', [t], []);
    env.gas.call('saveToDatabase', [t], []);
    assert.equal(env.tx.toObjects().length, 1);
  });

  test('el diccionario no acumula duplicados del mismo comercio (F-DAO-1)', () => {
    const env = createEnvironment();
    const entry = {
      Comercio_Original: 'JUMBO',
      Comercio_Limpio: 'Jumbo',
      Categoria: 'Super',
      Subcategoria: 'Despensa',
    };
    env.gas.call('saveToDatabase', [], [entry]);
    env.gas.call('saveToDatabase', [], [{ ...entry, Comercio_Original: 'jumbo' }]);
    assert.equal(env.dict.toObjects().length, 1);
  });

  test('un correo que el parser no entiende no se pierde en silencio (F-EXT-4)', () => {
    const env = envWithLabel();
    const thread = env.GmailApp.addThread([
      {
        id: 'raro',
        from: 'Bci <n@bci.cl>',
        subject: 'Notificación de uso de tu tarjeta de crédito',
        body: '<p>formato nuevo</p>',
      },
    ]);
    env.gas.call('processEmails');
    const labels = env.GmailApp.labelsOf(thread);
    assert.ok(
      !labels.includes(SCHEMA.LABEL_PROCESSED) || labels.includes('SaaS_Finanzas/Error_Parseo')
    );
  });
});

describe('sweeper: reclasificación de pendientes', () => {
  /** @param {ReturnType<typeof createEnvironment>} env */
  function seedPending(env) {
    addTxRow(env, 'a', 'JUMBO', PENDING);
    addTxRow(env, 'b', 'RAPPI', PENDING, { fecha: '2026-09-28' });
  }

  test('funciona aunque el lock NO sea reentrante (menú / trigger) (F-SWP-1)', () => {
    const env = createEnvironment({ lockReentrant: false });
    seedPending(env);
    const msg = env.gas.call('retryUnclassifiedTransactions');
    assert.match(msg, /Éxito/);
    assert.equal(env.tx.toObjects().filter(r => r['Categoría'] === PENDING).length, 0);
  });

  test('el job nocturno reclasifica y ordena aunque el lock NO sea reentrante (F-SWP-1)', () => {
    const env = createEnvironment({ lockReentrant: false });
    seedPending(env);
    env.gas.call('cleanAndSortData');
    assert.equal(env.tx.toObjects().filter(r => r['Categoría'] === PENDING).length, 0);
    assert.deepEqual(
      env.tx.toObjects().map(r => r.ID_Unico),
      ['b', 'a']
    );
  });

  test('no mantiene el lock durante las llamadas a Gemini (F-SWP-2)', () => {
    const env = createEnvironment({ lockReentrant: true });
    seedPending(env);
    let lockHeldDuringGemini = false;
    env.UrlFetchApp.onRequest = req => {
      if (req.url.includes(':generateContent') && env.LockService._state.holder !== null)
        lockHeldDuringGemini = true;
    };
    env.gas.call('retryUnclassifiedTransactions');
    assert.equal(lockHeldDuringGemini, false);
  });

  test('aplica lo que ya está en el diccionario aunque Gemini esté caído (F-SWP-3)', () => {
    const env = createEnvironment({
      lockReentrant: true,
      gemini: { behaviors: failAll(REALISTIC_MODELS, geminiErrors.highDemand()) },
    });
    seedPending(env);
    env.dict.appendRow(['JUMBO', 'Jumbo', 'Supermercado', 'Despensa', false]);
    env.dict.appendRow(['RAPPI', 'Rappi', 'Delivery', 'Comida', false]);
    const msg = env.gas.call('retryUnclassifiedTransactions');
    assert.match(msg, /Éxito/);
    assert.deepEqual(
      env.tx.toObjects().map(r => r['Categoría']),
      ['Supermercado', 'Delivery']
    );
  });

  test('escribe en bloque, no celda por celda (F-SWP-4)', () => {
    const env = createEnvironment({ lockReentrant: true });
    for (let i = 0; i < 10; i++) addTxRow(env, `id${i}`, `COMERCIO ${i}`, PENDING);
    env.gas.call('retryUnclassifiedTransactions');
    assert.ok(env.tx.stats.setValue <= 1, `setValue se llamó ${env.tx.stats.setValue} veces`);
  });

  test('ubica las filas por ID_Unico aunque la hoja cambie durante la clasificación (F-SWP-5)', () => {
    const env = createEnvironment({ lockReentrant: true });
    seedPending(env);
    let shifted = false;
    env.UrlFetchApp.onRequest = req => {
      if (req.url.includes(':generateContent') && !shifted) {
        shifted = true;
        // Otra ejecución inserta una fila arriba y desplaza todo mientras Gemini responde.
        env.tx.data.splice(1, 0, [
          'zzz',
          '2026-09-29',
          '08:00',
          'NUEVO',
          'NUEVO',
          'Ya clasificada',
          '',
          1,
          1,
          'Débito',
          'BCI',
        ]);
      }
    };
    env.gas.call('retryUnclassifiedTransactions');
    const byId = Object.fromEntries(env.tx.toObjects().map(r => [r.ID_Unico, r['Categoría']]));
    assert.equal(
      byId.zzz,
      'Ya clasificada',
      'La fila insertada durante el proceso no debe ser pisada'
    );
    assert.equal(byId.a, 'CategoriaIA');
    assert.equal(byId.b, 'CategoriaIA');
  });

  test('sincroniza la reclasificación con Notion (F-SWP-6)', () => {
    const env = createEnvironment({ lockReentrant: true, notion: true, props: notionProps });
    addTxRow(env, 'a', 'JUMBO', PENDING);
    env.gas.call('pushToNotion', [
      {
        ID_Unico: 'a',
        Fecha: '2026-09-27',
        Comercio_Limpio: 'JUMBO',
        Categoria: PENDING,
        Monto: 1000,
        Tipo: 'Débito',
        Origen: 'BCI',
      },
    ]);
    env.gas.call('retryUnclassifiedTransactions');
    const [page] = env.notion.active();
    assert.equal(page.properties['Categoría'].select.name, 'CategoriaIA');
  });
});

describe('telegram: autorización', () => {
  const foreign = 999;

  test('/borrar desde un chat no autorizado no borra nada (F-TG-1)', () => {
    const env = createEnvironment();
    addTxRow(env, 'TG_1', 'X', 'C');
    post(env, { message: { message_id: 50, text: '/borrar TG_1', chat: { id: foreign } } });
    assert.equal(env.tx.toObjects().length, 1);
  });

  test('un callback de un chat no autorizado se ignora (F-TG-1)', () => {
    const env = createEnvironment();
    post(env, {
      callback_query: { id: 'cbX', data: 'btn_cash', message: { chat: { id: foreign } } },
    });
    assert.equal(env.telegram.texts().length, 0);
  });

  test('/start desde un chat no autorizado no expone el menú (F-TG-1)', () => {
    const env = createEnvironment();
    post(env, { message: { message_id: 51, text: '/start', chat: { id: foreign } } });
    assert.equal(env.telegram.texts().length, 0);
  });

  // Hallazgo corregido durante la auditoría: en GAS `e.parameter` siempre es un objeto, así que la
  // comparación `undefined !== null` rechaza. Es fail-closed "por accidente"; esta prueba lo fija.
  test('si TELEGRAM_SECRET_TOKEN no está configurado, se rechaza todo (fail-closed) (F-TG-2)', () => {
    const env = createEnvironment();
    env.props.deleteProperty('TELEGRAM_SECRET_TOKEN');
    addTxRow(env, 'TG_1', 'X', 'C');
    post(env, { message: { message_id: 52, text: '/borrar TG_1', chat: { id: 1001 } } }, null);
    assert.equal(env.tx.toObjects().length, 1);
  });

  test('los mensajes de error se envían con el HTML escapado (F-TG-3)', () => {
    const env = createEnvironment();
    env.gas.call('doPost', {
      parameter: { token: 's3cret' },
      postData: { contents: '<html>no es json' },
    });
    const alert = env.telegram.texts().find(t => t.startsWith('🚨 <b>Error:</b>'));
    assert.ok(alert);
    assert.doesNotMatch(alert.replace('<b>Error:</b>', ''), /<html>/);
  });

  test('los gastos manuales pasan por el clasificador en vez de quedar como "Ingreso Manual" (F-TG-4)', () => {
    const env = createEnvironment();
    post(env, { message: { message_id: 53, text: '15000 Panaderia', chat: { id: 1001 } } });
    const [row] = env.tx.toObjects();
    assert.notEqual(row['Categoría'], 'Ingreso Manual');
  });
});

describe('notion: límites y consistencia', () => {
  test('pushToNotion se ejecuta FUERA del script lock (F-NOT-1)', () => {
    const env = createEnvironment({ notion: true, props: notionProps });
    let lockHeld = false;
    env.UrlFetchApp.onRequest = req => {
      if (req.url.includes('api.notion.com') && env.LockService._state.holder !== null)
        lockHeld = true;
    };
    env.gas.call(
      'saveToDatabase',
      [
        {
          ID_Unico: 'a',
          Fecha: '2026-09-27',
          Hora: '10:00',
          Comercio_Original: 'X',
          Comercio_Limpio: 'X',
          Categoria: 'C',
          Subcategoria: '',
          Monto: 1,
          Cuotas: 1,
          Tipo: 'Débito',
          Origen: 'BCI',
        },
      ],
      []
    );
    assert.equal(lockHeld, false);
  });

  test('el borrado en Notion respeta el freno de velocidad (F-NOT-2)', () => {
    const env = createEnvironment({ notion: true, props: notionProps });
    env.gas.call('pushToNotion', [
      {
        ID_Unico: 'a',
        Fecha: '2026-09-27',
        Comercio_Limpio: 'X',
        Categoria: 'C',
        Monto: 1,
        Tipo: 'Débito',
        Origen: 'BCI',
      },
    ]);
    const before = env.Utilities._sleeps.length;
    env.gas.call('deleteTransactionInNotion', 'a');
    assert.ok(
      env.Utilities._sleeps.length > before,
      'deleteTransactionInNotion debe dormir entre llamadas'
    );
  });

  test('ante un 429 de Notion reintenta respetando Retry-After (F-NOT-3)', () => {
    const env = createEnvironment({ notion: true, props: notionProps });
    let first = true;
    env.UrlFetchApp.addRoute({
      name: 'notion-429-una-vez',
      test: req => req.url === 'https://api.notion.com/v1/pages',
      handle: () => {
        if (first) {
          first = false;
          return {
            code: 429,
            body: { message: 'rate limited' },
            headers: { 'Retry-After': '2' },
          };
        }
        return { code: 200, body: { id: 'p1' } };
      },
    });
    env.gas.call('pushToNotion', [
      {
        ID_Unico: 'a',
        Fecha: '2026-09-27',
        Comercio_Limpio: 'X',
        Categoria: 'C',
        Monto: 1,
        Tipo: 'Débito',
        Origen: 'BCI',
      },
    ]);
    assert.equal(env.UrlFetchApp.callsTo('/v1/pages').length, 2);
  });
});
