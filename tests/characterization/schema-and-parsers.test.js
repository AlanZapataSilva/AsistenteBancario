'use strict';

/**
 * Caracterización: esquema de Sheets y parsers de bancos.
 * Estas pruebas describen el comportamiento ACTUAL que debe conservarse tras cualquier refactor.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createEnvironment, plain, SCHEMA } = require('../harness/load-gas');
const {
  bciEmail,
  tenpoEmail,
  machEmail,
  bancoChileEmail,
  asMessage,
} = require('../harness/builders');

describe('esquema (no debe cambiar: Looker Studio y Notion dependen de él)', () => {
  test('CONFIG conserva hojas, encabezados y etiqueta de Gmail', () => {
    const env = createEnvironment();
    const CONFIG = plain(env.gas.get('CONFIG'));
    assert.deepEqual(CONFIG.SHEETS, SCHEMA.SHEETS);
    assert.deepEqual(CONFIG.HEADERS, SCHEMA.HEADERS);
    assert.equal(CONFIG.GMAIL.LABEL_PROCESSED, SCHEMA.LABEL_PROCESSED);
  });
});

describe('parseBciEmail', () => {
  test('compra con tarjeta de crédito en CLP', () => {
    const env = createEnvironment();
    const dto = plain(
      env.gas.call(
        'parseBciEmail',
        asMessage(bciEmail({ monto: '24.590', comercio: 'JUMBO COSTANERA', cuotas: '3' }))
      )
    );
    assert.deepEqual(dto, {
      Fecha: '2026-09-27',
      Hora: '23:41',
      Comercio_Original: 'JUMBO COSTANERA',
      Comercio_Limpio: 'JUMBO COSTANERA',
      Categoria: SCHEMA.PENDING_CATEGORY,
      Subcategoria: '',
      Monto: 24590,
      Cuotas: 3,
      Tipo: 'Crédito',
      Comentario: '',
      Origen: 'BCI',
    });
  });

  test('transferencia conserva el mensaje como comentario', () => {
    const env = createEnvironment();
    const dto = plain(
      env.gas.call(
        'parseBciEmail',
        asMessage(
          bciEmail({
            subject: 'Aviso de Transferencia de Fondos',
            monto: '150.000',
            comercio: 'Juan Perez',
            mensaje: 'Pago arriendo',
          })
        )
      )
    );
    assert.equal(dto.Tipo, 'Transferencia');
    assert.equal(dto.Monto, 150000);
    assert.equal(dto.Comentario, 'Pago arriendo');
    assert.equal(dto.Comercio_Original, 'Juan Perez');
  });

  test('comercio solo numérico se etiqueta como "Cuenta Propia"', () => {
    const env = createEnvironment();
    const dto = plain(
      env.gas.call(
        'parseBciEmail',
        asMessage(
          bciEmail({
            subject: 'Aviso de Transferencia de Fondos',
            monto: '5.000',
            comercio: '12345678',
          })
        )
      )
    );
    assert.equal(dto.Comercio_Original, 'Cuenta Propia 12345678');
  });

  test('compra internacional convierte USD a CLP con el dólar del día', () => {
    const env = createEnvironment();
    // Cambio intencional: el USD se detecta en la celda del monto ("USD 10,50"), como en el correo
    // real de BCI, y no por la palabra "USD" en cualquier parte del HTML.
    const html = bciEmail({ monto: '10,50', moneda: 'USD', comercio: 'AMZN MKTP US' });
    const dto = plain(env.gas.call('parseBciEmail', asMessage(html)));
    // mindicador falso devuelve 900 CLP/USD → 10,5 * 900 = 9450
    assert.equal(dto.Monto, 9450);
    assert.equal(dto.Comercio_Original, 'AMZN MKTP US (USD 10.5)');
  });

  test('una anulación se registra con monto negativo', () => {
    const env = createEnvironment();
    const email = bciEmail({
      monto: '12.000',
      comercio: 'FARMACIA X',
      // Cambio intencional: se reconoce el titular real de BCI, no la palabra suelta.
      extraHtml: '<p>Realizaste una<br><b>anulación nacional </b><br>con tu tarjeta</p>',
    });
    const dto = plain(env.gas.call('parseBciEmail', asMessage(email)));
    assert.equal(dto.Monto, -12000);
  });

  test('sin monto o sin comercio devuelve null y deja un WARN', () => {
    const env = createEnvironment();
    const msg = asMessage({
      from: 'Bci <n@bci.cl>',
      subject: 'Notificación de uso de tu tarjeta de crédito',
      body: '<html><body><p>Sin tabla</p></body></html>',
    });
    assert.equal(env.gas.call('parseBciEmail', msg), null);
    assert.equal(env.logsAt('WARN').length, 1);
    assert.match(env.logsAt('WARN')[0].message, /Fallo de Parseo BCI/);
  });
});

describe('parseTenpoEmail', () => {
  test('compra Tenpo (débito prepago, 1 cuota)', () => {
    const env = createEnvironment();
    const dto = plain(
      env.gas.call(
        'parseTenpoEmail',
        asMessage(tenpoEmail({ monto: '24.590', comercio: 'UBER TRIP' }))
      )
    );
    assert.deepEqual(dto, {
      Fecha: '2026-09-27',
      Hora: '19:05:33',
      Comercio_Original: 'UBER TRIP',
      Comercio_Limpio: 'UBER TRIP',
      Categoria: SCHEMA.PENDING_CATEGORY,
      Subcategoria: '',
      Monto: 24590,
      Cuotas: 1,
      Tipo: 'Débito',
      Origen: 'TENPO',
    });
  });
});

describe('parseMachEmail', () => {
  test('crédito (formato horizontal) con cuotas', () => {
    const env = createEnvironment();
    const dto = plain(
      env.gas.call(
        'parseMachEmail',
        asMessage(
          machEmail({ kind: 'credito', monto: '39.990', comercio: 'FALABELLA', cuotas: '6' })
        )
      )
    );
    assert.equal(dto.Tipo, 'Crédito');
    assert.equal(dto.Monto, 39990);
    assert.equal(dto.Cuotas, 6);
    assert.equal(dto.Comercio_Original, 'FALABELLA');
    assert.equal(dto.Fecha, '2026-09-27');
    assert.equal(dto.Hora, '18:20');
    assert.equal(dto.Origen, 'MACH');
  });

  test('débito (formato vertical); cuotas 0 o ausentes se fuerzan a 1', () => {
    const env = createEnvironment();
    const dto = plain(
      env.gas.call(
        'parseMachEmail',
        asMessage(machEmail({ kind: 'debito', monto: '3.500', comercio: 'PANADERIA' }))
      )
    );
    assert.equal(dto.Tipo, 'Débito');
    assert.equal(dto.Cuotas, 1);
    assert.equal(dto.Monto, 3500);
  });
});

describe('parseBancoChileEmail', () => {
  test('compra con tarjeta de crédito', () => {
    const env = createEnvironment();
    const dto = plain(
      env.gas.call(
        'parseBancoChileEmail',
        asMessage(bancoChileEmail({ kind: 'compra', monto: '15.990', comercio: 'FLOW   *MIA SPA' }))
      )
    );
    assert.equal(dto.Tipo, 'Crédito');
    assert.equal(dto.Monto, 15990);
    assert.equal(dto.Comercio_Original, 'FLOW *MIA SPA');
    assert.equal(dto.Fecha, '2026-09-27');
    assert.equal(dto.Hora, '20:15');
    assert.equal(dto.Origen, 'BANCO_DE_CHILE');
  });

  test('cobro de cheque usa el número de cheque como comercio', () => {
    const env = createEnvironment();
    const dto = plain(
      env.gas.call(
        'parseBancoChileEmail',
        asMessage(bancoChileEmail({ kind: 'cheque', monto: '300.000', cheque: '778' }))
      )
    );
    assert.equal(dto.Tipo, 'Cheque');
    assert.equal(dto.Comercio_Original, 'Cobro Cheque N° 778');
    assert.equal(dto.Monto, 300000);
  });
});

describe('parseBankEmail (router + resolución de entidades)', () => {
  test('enruta por remitente', () => {
    const env = createEnvironment();
    assert.equal(
      plain(env.gas.call('parseBankEmail', asMessage(bciEmail({ monto: '1.000', comercio: 'X' }))))
        .Origen,
      'BCI'
    );
    assert.equal(
      plain(
        env.gas.call('parseBankEmail', asMessage(tenpoEmail({ monto: '1.000', comercio: 'X' })))
      ).Origen,
      'TENPO'
    );
    assert.equal(
      plain(
        env.gas.call(
          'parseBankEmail',
          asMessage(machEmail({ kind: 'debito', monto: '1.000', comercio: 'X' }))
        )
      ).Origen,
      'MACH'
    );
    assert.equal(
      plain(
        env.gas.call(
          'parseBankEmail',
          asMessage(bancoChileEmail({ kind: 'compra', monto: '1.000', comercio: 'X' }))
        )
      ).Origen,
      'BANCO_DE_CHILE'
    );
  });

  test('banco no soportado devuelve null y registra un WARN', () => {
    const env = createEnvironment();
    const msg = asMessage({ from: 'Otro <a@otrobanco.cl>', subject: 'Compra', body: '' });
    assert.equal(env.gas.call('parseBankEmail', msg), null);
    assert.equal(env.logsAt('WARN')[0].message, 'Router');
    assert.match(env.logsAt('WARN')[0].detail, /Banco no soportado/);
  });

  test('alias: UBER TRIP se normaliza a "Uber" (Comercio_Original y Limpio)', () => {
    const env = createEnvironment();
    const dto = plain(
      env.gas.call(
        'parseBankEmail',
        asMessage(tenpoEmail({ monto: '5.000', comercio: 'UBER TRIP HELP.UBER.C' }))
      )
    );
    assert.equal(dto.Comercio_Original, 'Uber');
    assert.equal(dto.Comercio_Limpio, 'Uber');
  });

  test('alias con sufijo USD conserva el rastro de USD', () => {
    const env = createEnvironment();
    const email = bciEmail({ monto: '20,00', moneda: 'USD', comercio: 'UBER *TRIP' });
    const dto = plain(env.gas.call('parseBankEmail', asMessage(email)));
    assert.equal(dto.Comercio_Original, 'Uber (USD 20)');
    assert.equal(dto.Comercio_Limpio, 'Uber');
  });
});

describe('getUsdToClpRate', () => {
  test('usa el valor del día', () => {
    const env = createEnvironment();
    assert.equal(env.gas.call('getUsdToClpRate', '2026-09-27'), 900);
  });

  test('cae al dólar actual si la serie del día viene vacía (fin de semana)', () => {
    const env = createEnvironment();
    env.UrlFetchApp.addRoute({
      name: 'mindicador-vacio',
      test: req => req.url === 'https://mindicador.cl/api/dolar/27-09-2026',
      handle: () => ({ code: 200, body: { serie: [] } }),
    });
    assert.equal(env.gas.call('getUsdToClpRate', '2026-09-27'), 900);
  });

  test('cae a 950 si la API falla por completo', () => {
    const env = createEnvironment();
    env.UrlFetchApp.addRoute({
      name: 'mindicador-caido',
      test: req => req.url.startsWith('https://mindicador.cl/'),
      handle: () => ({ code: 500, body: {} }),
    });
    assert.equal(env.gas.call('getUsdToClpRate', '2026-09-27'), 950);
  });
});
