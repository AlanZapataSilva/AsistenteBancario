'use strict';

/**
 * Caracterización: motor de extracción `processEmails` (flujo de punta a punta con Gmail,
 * Gemini, Sheets y Telegram falsos).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createEnvironment, SCHEMA } = require('../harness/load-gas');
const { bciEmail, tenpoEmail } = require('../harness/builders');

/**
 * Entorno con la etiqueta de Gmail ya creada (lo que hace `installApp`).
 * @param {Parameters<typeof createEnvironment>[0]} [opts]
 */
function envWithLabel(opts) {
  const env = createEnvironment(opts);
  env.GmailApp.createLabel(SCHEMA.LABEL_PROCESSED);
  return env;
}

describe('processEmails: flujo normal', () => {
  test('extrae, clasifica, guarda, etiqueta y actualiza el diccionario', () => {
    const env = envWithLabel();
    const t1 = env.GmailApp.addThread([
      { ...bciEmail({ monto: '24.590', comercio: 'JUMBO COSTANERA' }), id: 'm1' },
    ]);
    const t2 = env.GmailApp.addThread([
      { ...tenpoEmail({ monto: '5.000', comercio: 'UBER TRIP' }), id: 'm2' },
    ]);

    env.gas.call('processEmails');

    const rows = env.tx.toObjects();
    assert.deepEqual(
      rows.map(r => [
        r.ID_Unico,
        r['Comercio Original'],
        r['Comercio Limpio'],
        r['Categoría'],
        r.Monto,
        r.Origen,
      ]),
      [
        ['m1', 'Jumbo', 'Jumbo', 'CategoriaIA', 24590, 'BCI'],
        ['m2', 'Uber', 'Uber', 'CategoriaIA', 5000, 'TENPO'],
      ]
    );
    assert.deepEqual(
      env.dict
        .toObjects()
        .map(r => r['Comercio Banco'])
        .sort(),
      ['Jumbo', 'Uber']
    );
    assert.deepEqual(env.GmailApp.labelsOf(t1), [SCHEMA.LABEL_PROCESSED]);
    assert.deepEqual(env.GmailApp.labelsOf(t2), [SCHEMA.LABEL_PROCESSED]);
    env.LockService.assertNoneHeld();
  });

  test('una segunda corrida no duplica nada (hilos ya etiquetados)', () => {
    const env = envWithLabel();
    env.GmailApp.addThread([{ ...bciEmail({ monto: '24.590', comercio: 'JUMBO' }), id: 'm1' }]);
    env.gas.call('processEmails');
    env.gas.call('processEmails');
    assert.equal(env.tx.toObjects().length, 1);
    assert.ok(env.logRows().some(r => r.message === 'Fin Extracción'));
  });

  test('un comercio ya presente en el diccionario no llama a Gemini y usa sus valores', () => {
    const env = envWithLabel();
    env.dict.appendRow(['Jumbo', 'Jumbo (dic)', 'Supermercado', 'Despensa', false]);
    env.GmailApp.addThread([{ ...bciEmail({ monto: '24.590', comercio: 'JUMBO' }), id: 'm1' }]);
    env.gas.call('processEmails');
    assert.equal(env.UrlFetchApp.callsTo(':generateContent').length, 0);
    const [row] = env.tx.toObjects();
    assert.equal(row['Comercio Limpio'], 'Jumbo (dic)');
    assert.equal(row['Categoría'], 'Supermercado');
    assert.equal(row['Subcategoría'], 'Despensa');
  });

  test('un mensaje cuyo ID ya está en la hoja no se duplica', () => {
    const env = envWithLabel();
    env.tx.appendRow([
      'm1',
      '2026-09-27',
      '10:00',
      'Jumbo',
      'Jumbo',
      'X',
      '',
      1,
      1,
      'Débito',
      'BCI',
    ]);
    env.GmailApp.addThread([{ ...bciEmail({ monto: '24.590', comercio: 'JUMBO' }), id: 'm1' }]);
    env.gas.call('processEmails');
    assert.equal(env.tx.toObjects().length, 1);
  });

  test('las transferencias disparan la alerta educativa de Telegram', () => {
    const env = envWithLabel();
    env.GmailApp.addThread([
      {
        ...bciEmail({
          subject: 'Aviso de Transferencia de Fondos',
          monto: '150.000',
          comercio: 'Juan Perez',
          mensaje: 'Pago arriendo',
        }),
        id: 'm1',
      },
    ]);
    env.gas.call('processEmails');
    assert.ok(env.telegram.texts().some(t => t.includes('¡Atención con tus Transferencias!')));
  });
});

describe('processEmails: privacidad de comentarios de transferencia', () => {
  /** @param {ReturnType<typeof createEnvironment>} env */
  function promptSent(env) {
    return env.UrlFetchApp.callsTo(':generateContent')[0].req.json.contents[0].parts[0].text;
  }
  const email = () => ({
    ...bciEmail({
      subject: 'Aviso de Transferencia de Fondos',
      monto: '150.000',
      comercio: 'Juan Perez',
      mensaje: 'Pago arriendo depto',
    }),
    id: 'm1',
  });

  test('por defecto el comentario NO se envía a Gemini', () => {
    const env = envWithLabel();
    env.GmailApp.addThread([email()]);
    env.gas.call('processEmails');
    assert.doesNotMatch(promptSent(env), /Pago arriendo depto/);
  });

  test('con GEMINI_ANALYZE_TRANSFERS=true el comentario sí se envía', () => {
    const env = envWithLabel({ props: { GEMINI_ANALYZE_TRANSFERS: 'true' } });
    env.GmailApp.addThread([email()]);
    env.gas.call('processEmails');
    assert.match(promptSent(env), /Pago arriendo depto/);
  });
});

describe('processEmails: ventana de búsqueda y backfill', () => {
  test('en producción busca 5 días excluyendo lo ya etiquetado', () => {
    const env = envWithLabel();
    env.gas.call('processEmails');
    const [query] = env.GmailApp._searches;
    assert.match(query, /^newer_than:5d /);
    assert.match(query, /-label:SaaS_Finanzas\/Procesado$/);
  });

  test('durante el backfill busca 365 días y, al agotarse, pasa a modo producción', () => {
    const env = envWithLabel({ props: { INITIAL_BACKFILL_COMPLETED: 'false' } });
    env.gas.call('processEmails');
    assert.match(env.GmailApp._searches[0], /^newer_than:365d /);
    assert.equal(env.props.getProperty('INITIAL_BACKFILL_COMPLETED'), 'true');
    assert.ok(
      env
        .logRows()
        .some(r => r.message === 'Sistema' && /Carga histórica completada/.test(r.detail))
    );
  });
});

describe('processEmails: presupuesto de tiempo y relevo', () => {
  test('si se agota el tiempo agenda continueProcessEmails; la continuación retoma el resto', () => {
    const env = envWithLabel();
    for (let i = 1; i <= 25; i++) {
      env.GmailApp.addThread([
        { ...bciEmail({ monto: '1.000', comercio: `COMERCIO ${i}` }), id: `m${i}` },
      ]);
    }
    // La primera llamada a Gemini "tarda" 4 minutos (más que el presupuesto de 3,5).
    let slowOnce = true;
    env.UrlFetchApp.onRequest = req => {
      if (req.url.includes(':generateContent') && slowOnce) {
        slowOnce = false;
        env.advance(4 * 60 * 1000);
      }
    };

    env.gas.call('processEmails');
    assert.equal(env.tx.toObjects().length, 20);
    assert.deepEqual(env.ScriptApp.activeHandlers(), ['continueProcessEmails']);

    env.gas.call('continueProcessEmails');
    assert.equal(env.tx.toObjects().length, 25);
    assert.equal(env.ScriptApp.activeHandlers().includes('continueProcessEmails'), false);
  });
});

describe('processEmails: errores', () => {
  test('si Gmail falla, registra el ERROR y termina sin lanzar', () => {
    const env = envWithLabel();
    env.GmailApp.failNextSearch(new Error('Gmail caído'));
    assert.doesNotThrow(() => env.gas.call('processEmails'));
    assert.equal(env.logsAt('ERROR')[0].message, 'Error crítico en bucle de extracción');
  });
});
