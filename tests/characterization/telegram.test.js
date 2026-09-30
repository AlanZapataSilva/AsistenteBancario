'use strict';

/**
 * Caracterización: webhook de Telegram, comandos, notificaciones y cliente.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createEnvironment } = require('../harness/load-gas');

/**
 * Simula la llamada de Telegram al webhook.
 * @param {ReturnType<typeof createEnvironment>} env
 * @param {any} body
 * @param {string|null} [token]
 */
function post(env, body, token = 's3cret') {
  return env.gas.call('doPost', {
    parameter: token === null ? {} : { token },
    postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) },
  });
}

/**
 * @param {string} text
 * @param {number} [id]
 * @param {number|string} [chat]
 */
function update(text, id = 10, chat = 1001) {
  return { message: { message_id: id, text, chat: { id: chat } } };
}

describe('doPost: autenticación y respuesta', () => {
  test('siempre responde un ACK HTML vacío (HTTP 200 limpio para Telegram)', () => {
    const env = createEnvironment();
    const res = post(env, update('hola'));
    assert.equal(res._isHtmlOutput, true);
  });

  test('con token incorrecto no procesa nada', () => {
    const env = createEnvironment();
    const res = post(env, update('15000 Panaderia'), 'incorrecto');
    assert.equal(res._isHtmlOutput, true);
    assert.equal(env.tx.getLastRow(), 1);
    assert.equal(env.telegram.texts().length, 0);
  });

  test('un cuerpo inválido responde ACK, registra ERROR y avisa al administrador', () => {
    const env = createEnvironment();
    const res = post(env, '{no es json');
    assert.equal(res._isHtmlOutput, true);
    assert.equal(env.logsAt('ERROR').length, 1);
    assert.ok(env.telegram.texts().some(t => t.startsWith('🚨 <b>Error:</b> ')));
  });
});

describe('doPost: menú y comandos', () => {
  test('/start envía saludo y menú interactivo', () => {
    const env = createEnvironment();
    post(env, update('/start'));
    const messages = env.telegram.messages();
    assert.equal(messages.length, 2);
    assert.match(messages[0].text, /Asistente bancario listo/);
    assert.equal(messages[1].reply_markup.inline_keyboard.length, 2);
    assert.equal(messages[1].reply_markup.inline_keyboard[0][0].callback_data, 'btn_cash');
    assert.equal(messages[1].reply_markup.inline_keyboard[1][0].callback_data, 'btn_delete');
  });

  test('"hola" también abre el menú', () => {
    const env = createEnvironment();
    post(env, update('Hola'));
    assert.equal(env.telegram.messages().length, 2);
  });

  test('/borrar elimina transacciones por ID (separadas por espacio o coma)', () => {
    const env = createEnvironment();
    ['TG_1', 'TG_2', 'TG_3'].forEach(id =>
      env.tx.appendRow([id, '2026-09-01', '10:00', 'X', 'X', 'C', '', 100, 1, 'Débito', 'Telegram'])
    );
    post(env, update('/borrar TG_1, TG_3'));
    assert.deepEqual(
      env.tx.toObjects().map(r => r.ID_Unico),
      ['TG_2']
    );
    assert.match(env.telegram.texts().at(-1), /Borrado Exitoso/);
  });

  test('/borrar sin IDs válidos no borra y explica el formato', () => {
    const env = createEnvironment();
    post(env, update('/borrar  ,  '));
    assert.match(env.telegram.texts().at(-1), /Formato incorrecto/);
  });

  test('botón "btn_cash" responde instrucciones y confirma el callback; el doble clic se ignora', () => {
    const env = createEnvironment();
    const cb = { callback_query: { id: 'cb1', data: 'btn_cash', message: { chat: { id: 1001 } } } };
    post(env, cb);
    assert.match(env.telegram.texts().at(-1), /Registrar gasto manual/);
    assert.ok(env.telegram.requests.some(r => r.method === 'answerCallbackQuery'));
    const before = env.telegram.requests.length;
    post(env, cb);
    assert.equal(env.telegram.requests.length, before);
  });

  test('botón "btn_delete" explica el uso de /borrar', () => {
    const env = createEnvironment();
    post(env, {
      callback_query: { id: 'cb2', data: 'btn_delete', message: { chat: { id: 1001 } } },
    });
    assert.match(env.telegram.texts().at(-1), /Borrar registro de transacción/);
  });
});

describe('doPost: registro manual de gastos', () => {
  test('"15000 Panaderia" guarda la fila y confirma', () => {
    const env = createEnvironment();
    post(env, update('15000 Panaderia', 10));
    assert.deepEqual(
      env.tx.toObjects().map(r => ({ ...r })),
      [
        {
          ID_Unico: 'TG_10',
          Fecha: '2026-09-30',
          Hora: '09:00',
          'Comercio Original': 'Panaderia',
          'Comercio Limpio': 'Panaderia',
          // Cambio intencional (Fase 4): el gasto manual ahora pasa por el clasificador.
          Categoría: 'CategoriaIA',
          Subcategoría: 'SubcategoriaIA',
          Monto: 15000,
          Cuotas: 1,
          Tipo: 'Efectivo/Manual',
          Origen: 'Telegram',
        },
      ]
    );
    assert.equal(env.telegram.texts().at(-1), '✅ Gasto registrado:\n💰 $15000\n🛒 Panaderia');
  });

  test('acepta "$15.000 Uber" con separador de miles', () => {
    const env = createEnvironment();
    post(env, update('$15.000 Uber', 11));
    assert.equal(env.tx.toObjects()[0].Monto, 15000);
    assert.equal(env.tx.toObjects()[0]['Comercio Original'], 'Uber');
  });

  test('formato inválido → advertencia y no guarda', () => {
    const env = createEnvironment();
    post(env, update('gasté plata en algo', 12));
    assert.match(env.telegram.texts().at(-1), /Formato incorrecto/);
    assert.equal(env.tx.getLastRow(), 1);
  });

  test('reenvío del mismo update (reintento de Telegram) se guarda una sola vez', () => {
    const env = createEnvironment();
    post(env, update('15000 Panaderia', 13));
    post(env, update('15000 Panaderia', 13));
    assert.equal(env.tx.toObjects().length, 1);
  });

  test('un chat no autorizado no puede registrar gastos y queda un WARN', () => {
    const env = createEnvironment();
    post(env, update('15000 Panaderia', 14, 999));
    assert.equal(env.tx.getLastRow(), 1);
    assert.equal(env.logsAt('WARN')[0].message, 'Intento no autorizado');
  });
});

describe('notifyTransferRules', () => {
  test('agrupa solo las transferencias y formatea los montos al estilo chileno', () => {
    const env = createEnvironment();
    env.gas.call('notifyTransferRules', [
      { Tipo: 'Transferencia', Comercio_Limpio: 'Juan Perez', Monto: 1500000 },
      { Tipo: 'Débito', Comercio_Limpio: 'Jumbo', Monto: 9990 },
    ]);
    const [text] = env.telegram.texts();
    assert.match(text, /registrar 1 transferencia\(s\)/);
    assert.match(text, /🔸 <b>Juan Perez<\/b>: \$1\.500\.000/);
    assert.doesNotMatch(text, /Jumbo/);
  });

  test('sin transferencias no envía nada', () => {
    const env = createEnvironment();
    env.gas.call('notifyTransferRules', [{ Tipo: 'Débito', Comercio_Limpio: 'Jumbo', Monto: 1 }]);
    assert.equal(env.telegram.texts().length, 0);
  });
});

describe('cliente de Telegram', () => {
  test('sendTelegramMessage usa parse_mode HTML y adjunta el teclado', () => {
    const env = createEnvironment();
    env.gas.call('sendTelegramMessage', 1001, 'hola', { inline_keyboard: [] });
    const [m] = env.telegram.messages();
    assert.equal(m.chat_id, '1001');
    assert.equal(m.parse_mode, 'HTML');
    assert.deepEqual(m.reply_markup, { inline_keyboard: [] });
  });

  test('sin token de bot no hace llamadas', () => {
    const env = createEnvironment({ props: { TELEGRAM_BOT_TOKEN: '' } });
    env.props.deleteProperty('TELEGRAM_BOT_TOKEN');
    env.gas.call('sendTelegramMessage', 1001, 'hola');
    assert.equal(env.telegram.requests.length, 0);
  });

  test('setupWebhook registra la URL de la Web App con el token secreto', () => {
    const env = createEnvironment();
    env.gas.call('setupWebhook');
    const call = env.UrlFetchApp.callsTo('/setWebhook')[0];
    assert.equal(
      call.req.parsed.searchParams.get('url'),
      'https://script.google.com/macros/s/TEST/exec?token=s3cret'
    );
    assert.equal(call.req.parsed.searchParams.get('drop_pending_updates'), 'true');
  });
});
