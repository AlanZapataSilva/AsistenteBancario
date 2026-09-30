'use strict';

/**
 * Criterios de aceptación del incidente de Gemini (Objetivo 4).
 *
 * Cada prueba lleva `todo` mientras el defecto exista en el código: se ejecutan y fallan sin romper
 * la suite. Al corregirse (Fase 1) se quita el `todo` y pasan a formar parte de la suite normal.
 * Los cuerpos de error replican EXACTAMENTE los de los logs del 27-sep-2026.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { geminiErrors } = require('../harness/http-services');
const {
  envWithLabel,
  addBciThread,
  failAll,
  SCHEMA,
  REALISTIC_MODELS,
} = require('../harness/scenarios');

const PENDING = SCHEMA.PENDING_CATEGORY;

/** @param {ReturnType<typeof envWithLabel>} env */
const categories = env => env.tx.toObjects().map(r => r['Categoría']);

describe('incidente 27-sep: la cascada debe encontrar un modelo que funcione', () => {
  const incident = () => ({
    'gemini-3.1-pro-preview': geminiErrors.quotaExceededFreeTier('gemini-3.1-pro'),
    'gemini-3.8-flash': geminiErrors.highDemand(),
  });

  test('con Pro sin cuota (tier gratuito) y 3.8-flash saturado, clasifica con otro modelo estable', () => {
    const env = envWithLabel({ gemini: { behaviors: incident() } });
    addBciThread(env, { id: 'm1', comercio: 'PANADERIA DEMO' });
    env.gas.call('processEmails');
    assert.deepEqual(categories(env), ['CategoriaIA']);
    assert.equal(
      env.logsAt('ERROR').length,
      0,
      'No debe haber alertas críticas si algún modelo respondió'
    );
  });

  test('Pro no se intenta por defecto (no hay cuota gratuita)', () => {
    const env = envWithLabel({ gemini: { behaviors: incident() } });
    addBciThread(env);
    env.gas.call('processEmails');
    assert.equal(env.gemini.attemptedModels().includes('gemini-3.1-pro-preview'), false);
  });

  test('Pro se usa solo si GEMINI_ALLOW_PRO=true y como último recurso', () => {
    const outageFlash = failAll(
      REALISTIC_MODELS.filter(m => !m.includes('pro')),
      geminiErrors.highDemand()
    );
    const env = envWithLabel({
      props: { GEMINI_ALLOW_PRO: 'true' },
      gemini: { behaviors: outageFlash },
    });
    addBciThread(env);
    env.gas.call('processEmails');
    const attempted = env.gemini.attemptedModels();
    const proIndex = attempted.indexOf('gemini-3.1-pro-preview');
    assert.ok(proIndex > 0, 'Pro no debe ser el primer modelo intentado');
    assert.equal(proIndex, attempted.length - 1, 'Pro debe ser el último recurso');
    assert.deepEqual(categories(env), ['CategoriaIA']);
  });

  test('un 503 transitorio se reintenta en el mismo modelo antes de descartarlo', () => {
    const env = envWithLabel({
      gemini: {
        models: ['gemini-3.8-flash'],
        behaviors: { 'gemini-3.8-flash': [geminiErrors.highDemand(), null] },
      },
    });
    addBciThread(env);
    env.gas.call('processEmails');
    assert.deepEqual(categories(env), ['CategoriaIA']);
    assert.equal(env.gemini.callCount['gemini-3.8-flash'], 2);
  });

  test('un modelo que dio 404 queda en cuarentena y no se vuelve a golpear en la siguiente corrida', () => {
    const env = envWithLabel({
      gemini: {
        models: ['gemini-3.8-flash', 'gemini-3.7-flash'],
        behaviors: { 'gemini-3.8-flash': geminiErrors.notFound('gemini-3.8-flash') },
      },
    });
    addBciThread(env, { id: 'm1' });
    env.gas.call('processEmails');
    addBciThread(env, { id: 'm2', comercio: 'OTRO COMERCIO' });
    env.gas.call('processEmails');
    assert.equal(env.gemini.callCount['gemini-3.8-flash'], 1);
    assert.deepEqual(categories(env), ['CategoriaIA', 'CategoriaIA']);
  });

  test('ListModels se recorre completo: un modelo en la segunda página también se encuentra', () => {
    const filler = Array.from({ length: 55 }, (_, i) => ({
      name: `text-embedding-${i}`,
      methods: ['embedContent'],
    }));
    const env = envWithLabel({
      gemini: { models: [...filler, 'gemini-3.8-flash'], pageSize: 50, maxPageSize: 50 },
    });
    addBciThread(env);
    env.gas.call('processEmails');
    assert.deepEqual(categories(env), ['CategoriaIA']);
  });

  test('las versiones se ordenan numéricamente (3.10 > 3.8)', () => {
    const env = envWithLabel({ gemini: { models: ['gemini-3.8-flash', 'gemini-3.10-flash'] } });
    addBciThread(env);
    env.gas.call('processEmails');
    assert.equal(env.gemini.attemptedModels()[0], 'gemini-3.10-flash');
  });

  test('un modelo estable se prefiere al preview de la misma versión', () => {
    const env = envWithLabel({
      gemini: { models: ['gemini-3.5-flash-preview', 'gemini-3.5-flash'] },
    });
    addBciThread(env);
    env.gas.call('processEmails');
    assert.equal(env.gemini.attemptedModels()[0], 'gemini-3.5-flash');
  });

  test('los modelos flash-lite forman parte de la cascada', () => {
    const env = envWithLabel({ gemini: { models: ['gemini-3.5-flash-lite'] } });
    addBciThread(env);
    env.gas.call('processEmails');
    assert.deepEqual(categories(env), ['CategoriaIA']);
  });

  test('si ListModels falla, usa la lista de respaldo (GEMINI_MODELS)', () => {
    const env = envWithLabel({
      props: { GEMINI_MODELS: 'gemini-3.7-flash,gemini-3.5-flash-lite' },
      gemini: { listFails: true },
    });
    addBciThread(env);
    env.gas.call('processEmails');
    assert.deepEqual(categories(env), ['CategoriaIA']);
    assert.equal(env.gemini.attemptedModels()[0], 'gemini-3.7-flash');
  });

  test('la API key viaja en el header x-goog-api-key y nunca en la URL', () => {
    const env = envWithLabel({ gemini: { apiKey: 'test-gemini-key' } });
    addBciThread(env);
    env.gas.call('processEmails');
    const calls = env.UrlFetchApp.callsTo('generativelanguage.googleapis.com');
    assert.ok(calls.length >= 2, 'Debe haber al menos ListModels y generateContent');
    calls.forEach(c => {
      assert.doesNotMatch(c.req.url, /[?&]key=/);
      assert.equal(c.req.headers['x-goog-api-key'], 'test-gemini-key');
    });
    assert.deepEqual(categories(env), ['CategoriaIA']);
  });

  test('una excepción de red que incluye la URL no filtra la API key a Logs ni a Telegram', () => {
    const env = envWithLabel({ gemini: false });
    env.UrlFetchApp.addRoute({
      name: 'gemini-red-caida',
      test: req => req.url.includes('generativelanguage.googleapis.com'),
      handle: req => {
        throw new Error(
          `DNS error: ${req.url} (header x-goog-api-key: ${req.headers['x-goog-api-key'] ?? 'n/a'})`
        );
      },
    });
    addBciThread(env);
    env.gas.call('processEmails');
    const everything = env.allLogText() + env.telegram.texts().join('\n');
    assert.doesNotMatch(everything, /test-gemini-key/);
  });
});

describe('caída total de Gemini: nada se pierde y se recupera solo', () => {
  const outage = () => failAll(REALISTIC_MODELS, geminiErrors.highDemand());

  test('las transacciones se guardan como pendientes y el hilo se etiqueta', () => {
    const env = envWithLabel({ gemini: { behaviors: outage() } });
    const thread = addBciThread(env);
    env.gas.call('processEmails');
    assert.deepEqual(categories(env), [PENDING]);
    assert.deepEqual(env.GmailApp.labelsOf(thread), [SCHEMA.LABEL_PROCESSED]);
  });

  test('deja UN solo registro consolidado con el motivo por modelo y UNA alerta de Telegram con detalle', () => {
    const env = envWithLabel({ gemini: { behaviors: outage() } });
    addBciThread(env);
    env.gas.call('processEmails');
    const errors = env.logsAt('ERROR');
    assert.equal(errors.length, 1);
    assert.match(errors[0].detail, /gemini-3\.8-flash/);
    assert.match(errors[0].detail, /503/);
    const alerts = env.telegram.texts().filter(t => t.includes('🚨'));
    assert.equal(alerts.length, 1);
    assert.match(alerts[0], /503|gemini-3\.8-flash/);
  });

  test('no inunda la hoja Logs: una fila por intento ya no es aceptable', () => {
    const env = envWithLabel({ gemini: { behaviors: outage() } });
    addBciThread(env);
    env.gas.call('processEmails');
    assert.ok(env.logRows().length <= 8, `Demasiadas filas de log (${env.logRows().length})`);
  });

  test('errores idénticos repetidos dentro de 30 min generan una sola alerta', () => {
    const env = envWithLabel();
    for (let i = 0; i < 5; i++)
      env.gas.call('logSystemEvent', 'ERROR', 'Colapso total de Gemini API', 'detalle');
    assert.equal(env.telegram.texts().filter(t => t.includes('🚨')).length, 1);
    env.advance(31 * 60 * 1000);
    env.gas.call('logSystemEvent', 'ERROR', 'Colapso total de Gemini API', 'detalle');
    assert.equal(env.telegram.texts().filter(t => t.includes('🚨')).length, 2);
  });

  test('el detalle de la alerta se trunca y se escapa (HTML de Telegram)', () => {
    const env = envWithLabel();
    env.gas.call('logSystemEvent', 'ERROR', 'Falla <script>', 'a'.repeat(5000) + ' <b>&');
    const [alert] = env.telegram.texts();
    assert.ok(alert.length < 1200, `Alerta demasiado larga (${alert.length})`);
    assert.doesNotMatch(alert, /<script>/);
    assert.match(alert, /&lt;script&gt;/);
  });

  test('cuando Gemini vuelve, la siguiente corrida reclasifica los pendientes sin intervención', () => {
    const behaviors = outage();
    const env = envWithLabel({ gemini: { behaviors } });
    addBciThread(env);
    env.gas.call('processEmails');
    assert.deepEqual(categories(env), [PENDING]);

    Object.keys(behaviors).forEach(k => delete behaviors[k]); // Gemini se recupera
    env.advance(10 * 60 * 1000); // vence el enfriamiento de los modelos
    env.gas.call('processEmails'); // no hay correos nuevos
    assert.deepEqual(categories(env), ['CategoriaIA']);
  });
});

describe('robustez de la respuesta de Gemini', () => {
  test('mapea por id aunque Gemini altere el nombre del comercio (mayúsculas, tildes)', () => {
    const env = envWithLabel({
      gemini: {
        classify: (/** @type {any} */ item) => ({
          Comercio_Original: String(item.Comercio_Original).toLowerCase(),
          Comercio_Limpio: 'Panadería',
          Categoria: 'Alimentación',
          Subcategoria: 'Panadería',
        }),
      },
    });
    addBciThread(env, { comercio: 'PANADERIA DEMO' });
    env.gas.call('processEmails');
    assert.deepEqual(categories(env), ['Alimentación']);
  });

  test('éxito parcial: clasifica lo que vino y deja pendiente el resto sin ensuciar el diccionario', () => {
    const env = envWithLabel();
    let partialCalls = 0;
    env.UrlFetchApp.addRoute({
      name: 'gemini-parcial',
      test: req => req.url.includes(':generateContent'),
      handle: req => {
        // Solo la primera llamada responde (parcialmente); luego Gemini cae, para que el reintento
        // automático del final de la corrida no complete lo que este test quiere ver pendiente.
        partialCalls += 1;
        if (partialCalls > 1) return geminiErrors.highDemand();
        const text = req.json.contents[0].parts[0].text;
        const items = JSON.parse(text.slice(text.lastIndexOf('[\n')));
        const first = items[0];
        return {
          code: 200,
          body: {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify([
                        {
                          id: first.id,
                          Comercio_Original: first.Comercio_Original,
                          Comercio_Limpio: 'Uno',
                          Categoria: 'Cat1',
                          Subcategoria: 'S1',
                        },
                        // Un elemento que nadie pidió: no debe llegar al diccionario.
                        {
                          id: 999,
                          Comercio_Original: 'FANTASMA',
                          Comercio_Limpio: 'Fantasma',
                          Categoria: 'X',
                          Subcategoria: 'Y',
                        },
                      ]),
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          },
        };
      },
    });
    addBciThread(env, { id: 'm1', comercio: 'PRIMERO SPA' });
    addBciThread(env, { id: 'm2', comercio: 'SEGUNDO SPA' });
    env.gas.call('processEmails');
    const byId = Object.fromEntries(env.tx.toObjects().map(r => [r.ID_Unico, r['Categoría']]));
    assert.equal(byId.m1, 'Cat1');
    assert.equal(byId.m2, PENDING);
    assert.deepEqual(
      env.dict.toObjects().map(r => r['Comercio Banco']),
      ['PRIMERO SPA']
    );
  });
});
