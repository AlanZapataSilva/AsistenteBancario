'use strict';

/**
 * Caracterización: capa de datos (dao), logger y cliente de Notion.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createEnvironment, plain, SCHEMA } = require('../harness/load-gas');

/** @param {Partial<Record<string, any>>} [over] */
function tx(over = {}) {
  return {
    ID_Unico: 'msg_1',
    Fecha: '2026-09-27',
    Hora: '10:00',
    Comercio_Original: 'JUMBO',
    Comercio_Limpio: 'Jumbo',
    Categoria: 'Supermercado',
    Subcategoria: 'Despensa',
    Monto: 12000,
    Cuotas: 1,
    Tipo: 'Débito',
    Origen: 'BCI',
    ...over,
  };
}

describe('dao', () => {
  test('getExistingTransactionIds devuelve los IDs como strings', () => {
    const env = createEnvironment();
    env.tx.appendRow(['a1', '2026-09-01']);
    env.tx.appendRow([42, '2026-09-02']);
    const ids = env.gas.call('getExistingTransactionIds');
    assert.deepEqual([...ids].sort(), ['42', 'a1']);
  });

  test('getDictionaryMap normaliza la clave y aplica valores por defecto', () => {
    const env = createEnvironment();
    env.dict.appendRow(['  JUMBO Costanera ', 'Jumbo', 'Supermercado', 'Despensa', false]);
    env.dict.appendRow(['Rappi', '', '', '', false]);
    const map = env.gas.call('getDictionaryMap');
    assert.deepEqual(plain(map.get('jumbo costanera')), {
      Comercio_Limpio: 'Jumbo',
      Categoria: 'Supermercado',
      Subcategoria: 'Despensa',
    });
    assert.deepEqual(plain(map.get('rappi')), {
      Comercio_Limpio: 'Rappi',
      Categoria: 'Sin Categoría',
      Subcategoria: '',
    });
  });

  test('saveToDatabase escribe las transacciones en el orden de columnas del esquema', () => {
    const env = createEnvironment();
    env.gas.call('saveToDatabase', [tx()], []);
    assert.deepEqual(env.tx.toObjects(), [
      {
        ID_Unico: 'msg_1',
        Fecha: '2026-09-27',
        Hora: '10:00',
        'Comercio Original': 'JUMBO',
        'Comercio Limpio': 'Jumbo',
        Categoría: 'Supermercado',
        Subcategoría: 'Despensa',
        Monto: 12000,
        Cuotas: 1,
        Tipo: 'Débito',
        Origen: 'BCI',
      },
    ]);
    env.LockService.assertNoneHeld();
  });

  test('saveToDatabase agrega al diccionario (claves sin distinguir mayúsculas) con casilla de auditoría', () => {
    const env = createEnvironment();
    env.gas.call(
      'saveToDatabase',
      [],
      [
        {
          Comercio_Original: 'JUMBO',
          Comercio_Limpio: 'Jumbo',
          Categoria: 'Supermercado',
          Subcategoria: 'Despensa',
        },
        {
          comercio_original: 'RAPPI',
          comercio_limpio: 'Rappi',
          categoria: 'Delivery',
          subcategoria: 'Comida',
        },
      ]
    );
    assert.deepEqual(
      env.dict
        .toObjects()
        .map(r => [
          r['Comercio Banco'],
          r['Comercio Limpio'],
          r['Categoría Gemini'],
          r['Subcategoría'],
          r['Auditoría Manual (Check)'],
        ]),
      [
        ['JUMBO', 'Jumbo', 'Supermercado', 'Despensa', false],
        ['RAPPI', 'Rappi', 'Delivery', 'Comida', false],
      ]
    );
    assert.equal(env.dict.checkboxRanges.length, 1);
    assert.equal(env.dict.checkboxRanges[0].col, 5);
  });

  test('saveToDatabase sin nada que guardar no toma el lock', () => {
    const env = createEnvironment();
    env.gas.call('saveToDatabase', [], []);
    assert.equal(env.LockService._state.acquisitions, 0);
  });

  test('saveToDatabase falla con un mensaje claro si no consigue el lock', () => {
    const env = createEnvironment();
    env.LockService.setExternalHolder(true);
    assert.throws(
      () => env.gas.call('saveToDatabase', [tx()], []),
      /Timeout esperando el bloqueo para escribir en Sheets/
    );
    assert.equal(env.tx.getLastRow(), 1); // nada escrito
  });

  test('saveToDatabase envía a Notion solo si está activado y hay transacciones', () => {
    const env = createEnvironment({
      notion: true,
      props: { NOTION_ENABLED: 'true', NOTION_API_TOKEN: 'ntn_x', NOTION_DATABASE_ID: 'db1' },
    });
    env.gas.call('saveToDatabase', [tx()], []);
    assert.equal(env.notion.active().length, 1);
    assert.equal(env.notion.active()[0].properties.Comercio.title[0].text.content, 'Jumbo');
  });

  test('saveToDatabase no toca Notion si NOTION_ENABLED no es true', () => {
    const env = createEnvironment({
      notion: true,
      props: { NOTION_API_TOKEN: 'ntn_x', NOTION_DATABASE_ID: 'db1' },
    });
    env.gas.call('saveToDatabase', [tx()], []);
    assert.equal(env.notion.active().length, 0);
  });
});

describe('deleteTransactionsByIds', () => {
  /** @param {ReturnType<typeof createEnvironment>} env */
  function seed(env) {
    ['a', 'b', 'c', 'd'].forEach((id, i) =>
      env.tx.appendRow([
        id,
        '2026-09-0' + (i + 1),
        '10:00',
        'M' + id,
        'M' + id,
        'Cat',
        '',
        1000 * (i + 1),
        1,
        'Débito',
        'BCI',
      ])
    );
  }

  test('borra varias filas sin desalinear los índices', () => {
    const env = createEnvironment();
    seed(env);
    const msg = env.gas.call('deleteTransactionsByIds', ['b', 'd']);
    assert.match(msg, /Borrado Exitoso/);
    assert.match(msg, /<b>2<\/b>/);
    assert.deepEqual(
      env.tx.toObjects().map(r => r.ID_Unico),
      ['a', 'c']
    );
    env.LockService.assertNoneHeld();
  });

  test('IDs inexistentes → mensaje de no encontrados', () => {
    const env = createEnvironment();
    seed(env);
    assert.match(env.gas.call('deleteTransactionsByIds', ['zzz']), /No encontrados/);
    assert.equal(env.tx.toObjects().length, 4);
  });

  test('sin IDs → advertencia', () => {
    const env = createEnvironment();
    assert.match(env.gas.call('deleteTransactionsByIds', []), /No se proporcionaron IDs/);
  });

  test('sistema ocupado → mensaje de reintento', () => {
    const env = createEnvironment();
    seed(env);
    env.LockService.setExternalHolder(true);
    assert.match(env.gas.call('deleteTransactionsByIds', ['a']), /ocupado/);
  });

  test('con Notion activado borra en ambos lados e informa', () => {
    const env = createEnvironment({
      notion: true,
      props: { NOTION_ENABLED: 'true', NOTION_API_TOKEN: 'ntn_x', NOTION_DATABASE_ID: 'db1' },
    });
    seed(env);
    env.gas.call('pushToNotion', [tx({ ID_Unico: 'a' }), tx({ ID_Unico: 'b' })]);
    const msg = env.gas.call('deleteTransactionsByIds', ['a', 'zzz-no-existe-en-sheets']);
    assert.match(msg, /Eliminadas simultáneamente en Notion/);
    assert.equal(env.notion.active().length, 1);
  });

  test('con Notion activado y ID ausente en Notion advierte que solo se borró de Sheets', () => {
    const env = createEnvironment({
      notion: true,
      props: { NOTION_ENABLED: 'true', NOTION_API_TOKEN: 'ntn_x', NOTION_DATABASE_ID: 'db1' },
    });
    seed(env);
    const msg = env.gas.call('deleteTransactionsByIds', ['a']);
    assert.match(msg, /1 registro\(s\) no se encontraron en Notion/);
    assert.deepEqual(
      env.tx.toObjects().map(r => r.ID_Unico),
      ['b', 'c', 'd']
    );
  });
});

describe('logger', () => {
  test('agrega una fila [timestamp, nivel, mensaje, detalle] con hora de Santiago', () => {
    const env = createEnvironment();
    env.gas.call('logSystemEvent', 'INFO', 'Hola', 'detalle');
    const [row] = env.logs.toObjects();
    assert.equal(row.Timestamp, '2026-09-30 09:00:00');
    assert.equal(row.Nivel, 'INFO');
    assert.equal(row.Mensaje, 'Hola');
    assert.equal(row['Stack Trace'], 'detalle');
  });

  test('un ERROR dispara una alerta a Telegram; INFO y WARN no', () => {
    const env = createEnvironment();
    env.gas.call('logSystemEvent', 'INFO', 'a');
    env.gas.call('logSystemEvent', 'WARN', 'b');
    assert.equal(env.telegram.texts().length, 0);
    env.gas.call('logSystemEvent', 'ERROR', 'Se cayó todo', 'detalle');
    // Cambio intencional (Fase 1): la alerta ahora incluye el detalle del error, escapado.
    assert.deepEqual(env.telegram.texts(), [
      '🚨 <b>Error Crítico en SaaS:</b>\nSe cayó todo\n<pre>detalle</pre>',
    ]);
  });

  test('si no existe la hoja Logs no lanza ni alerta', () => {
    const env = createEnvironment({ createSheets: false });
    assert.doesNotThrow(() => env.gas.call('logSystemEvent', 'ERROR', 'x'));
  });

  test('si Telegram falla, el logger no propaga la excepción', () => {
    const env = createEnvironment();
    env.UrlFetchApp.addRoute({
      name: 'telegram-caido',
      test: req => req.url.startsWith('https://api.telegram.org/'),
      handle: () => {
        throw new Error('Telegram caído');
      },
    });
    assert.doesNotThrow(() => env.gas.call('logSystemEvent', 'ERROR', 'x'));
    assert.equal(env.logs.toObjects().length, 1);
  });
});

describe('notion', () => {
  const props = { NOTION_ENABLED: 'true', NOTION_API_TOKEN: 'ntn_x', NOTION_DATABASE_ID: 'db1' };

  test('pushToNotion mapea el esquema y respeta el freno de 500 ms por transacción', () => {
    const env = createEnvironment({ notion: true, props });
    env.gas.call('pushToNotion', [tx({ ID_Unico: 'a' }), tx({ ID_Unico: 'b', Monto: 5000 })]);
    const pages = env.notion.active();
    assert.equal(pages.length, 2);
    assert.deepEqual(plain(pages[0].properties), {
      Comercio: { title: [{ text: { content: 'Jumbo' } }] },
      Monto: { number: 12000 },
      Fecha: { date: { start: '2026-09-27' } },
      Categoría: { select: { name: 'Supermercado' } },
      Tipo: { select: { name: 'Débito' } },
      ID_Unico: { rich_text: [{ text: { content: 'a' } }] },
      Origen: { select: { name: 'BCI' } },
    });
    assert.deepEqual(env.Utilities._sleeps, [500, 500]);
    const create = env.UrlFetchApp.calls.find(c => c.req.url === 'https://api.notion.com/v1/pages');
    assert.equal(create.req.headers['Notion-Version'], '2022-06-28');
    assert.equal(create.req.headers.Authorization, 'Bearer ntn_x');
  });

  test('pushToNotion continúa tras un error, lo registra y espera igualmente', () => {
    const env = createEnvironment({
      notion: { failCreateWith: { code: 400, body: { message: 'bad' } } },
      props,
    });
    env.gas.call('pushToNotion', [tx({ ID_Unico: 'a' }), tx({ ID_Unico: 'b' })]);
    assert.equal(env.logsAt('ERROR').length, 2);
    assert.deepEqual(env.Utilities._sleeps, [500, 500]);
  });

  test('pushToNotion sin credenciales no hace llamadas', () => {
    const env = createEnvironment({ notion: true, props: { NOTION_ENABLED: 'true' } });
    env.gas.call('pushToNotion', [tx()]);
    assert.equal(env.UrlFetchApp.callsTo('notion.com').length, 0);
    assert.equal(env.logsAt('WARN').length, 1);
  });

  test('deleteTransactionInNotion archiva la página encontrada', () => {
    const env = createEnvironment({ notion: true, props });
    env.gas.call('pushToNotion', [tx({ ID_Unico: 'a' })]);
    assert.equal(env.gas.call('deleteTransactionInNotion', 'a'), true);
    assert.equal(env.notion.active().length, 0);
  });

  test('deleteTransactionInNotion devuelve false si la página no existe', () => {
    const env = createEnvironment({ notion: true, props });
    assert.equal(env.gas.call('deleteTransactionInNotion', 'nope'), false);
    assert.equal(env.logsAt('WARN').length, 1);
  });

  test('deleteTransactionInNotion devuelve false si falla la búsqueda', () => {
    const env = createEnvironment({ notion: true, props });
    env.UrlFetchApp.addRoute({
      name: 'notion-500',
      test: req => req.url.includes('/query'),
      handle: () => ({ code: 500, body: { message: 'boom' } }),
    });
    assert.equal(env.gas.call('deleteTransactionInNotion', 'a'), false);
    assert.equal(env.logsAt('ERROR').length, 1);
  });
});

describe('constantes de esquema usadas por el DAO', () => {
  test('PENDING_CATEGORY sigue siendo el literal histórico', () => {
    const env = createEnvironment();
    const dto = plain(
      env.gas.call(
        'parseTenpoEmail',
        require('../harness/builders').asMessage(
          require('../harness/builders').tenpoEmail({ monto: '1.000', comercio: 'X' })
        )
      )
    );
    assert.equal(dto.Categoria, SCHEMA.PENDING_CATEGORY);
  });
});
