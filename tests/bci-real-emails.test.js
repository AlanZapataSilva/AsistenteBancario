'use strict';

/**
 * Correos REALES de BCI (anonimizados, en `tests/fixtures/`): anulación con tarjeta de crédito y
 * compra en dólares. Fijan el formato real del banco y los criterios de F-PAR-1 y F-PAR-2.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { createEnvironment, plain } = require('./harness/load-gas');
const { realBciEmail, asMessage } = require('./harness/builders');
const { envWithLabel } = require('./harness/scenarios');

const ANULACION = 'bci-anulacion-tdc.qp.html';
const COMPRA_USD = 'bci-compra-usd-tdc.html';

/**
 * @param {ReturnType<typeof createEnvironment>} env
 * @param {string} fixture
 * @param {Parameters<typeof realBciEmail>[1]} [opts]
 */
function parse(env, fixture, opts) {
  return plain(env.gas.call('parseBankEmail', asMessage(realBciEmail(fixture, opts))));
}

describe('anulación real de BCI (tarjeta de crédito)', () => {
  test('se registra con monto negativo y los datos de la tabla', () => {
    const env = createEnvironment();
    const dto = parse(env, ANULACION);
    assert.equal(dto.Monto, -2193);
    assert.equal(dto.Fecha, '2026-08-16');
    assert.equal(dto.Hora, '22:50');
    assert.equal(dto.Tipo, 'Crédito');
    assert.equal(dto.Origen, 'BCI');
    // "PAYU   *UBER TRIP        SANTIAGO     CL" → alias Uber
    assert.equal(dto.Comercio_Original, 'Uber');
    assert.ok(env.logRows().some(r => r.message === 'Anulación BCI'));
  });

  test('sin el titular de anulación, la misma tabla es una compra positiva', () => {
    const env = createEnvironment();
    const dto = parse(env, ANULACION, {
      transform: html => html.replace('anulación nacional', 'compra nacional'),
    });
    assert.equal(dto.Monto, 2193);
  });

  test('una mención a "anulación" fuera del titular no invierte el signo, pero avisa', () => {
    const env = createEnvironment();
    const dto = parse(env, ANULACION, {
      transform: html =>
        html
          .replace('anulación nacional', 'compra nacional')
          .replace(
            'Si no quieres recibir notificaciones',
            'Puedes solicitar la anulación de un cargo en Bci.cl. Si no quieres recibir notificaciones'
          ),
    });
    assert.equal(dto.Monto, 2193);
    assert.ok(env.logsAt('WARN').some(r => r.message === 'Posible anulación BCI no reconocida'));
  });

  test('el párrafo comentado del correo (<!-- -->) no se considera texto visible', () => {
    const env = createEnvironment();
    const dto = parse(env, ANULACION, {
      transform: html =>
        html
          .replace('anulación nacional', 'compra nacional')
          .replace('Si no reconoces este movimiento', 'Si no reconoces esta anulación'),
    });
    assert.equal(dto.Monto, 2193);
    assert.equal(env.logsAt('WARN').length, 0);
  });

  test('de punta a punta: processEmails guarda la anulación en negativo', () => {
    const env = envWithLabel();
    env.GmailApp.addThread([{ ...realBciEmail(ANULACION), id: 'anul1' }]);
    env.gas.call('processEmails');
    const [row] = env.tx.toObjects();
    assert.equal(row.ID_Unico, 'anul1');
    assert.equal(row.Monto, -2193);
    assert.equal(row['Comercio Original'], 'Uber');
  });
});

describe('compra real de BCI en dólares', () => {
  test('convierte USD 23,80 a CLP con el dólar del día y conserva el rastro', () => {
    const env = createEnvironment();
    const dto = parse(env, COMPRA_USD);
    // mindicador falso: 900 CLP/USD → 23,80 × 900 = 21.420
    assert.equal(dto.Monto, 21420);
    assert.equal(dto.Fecha, '2026-09-14');
    assert.equal(dto.Hora, '01:13');
    assert.equal(dto.Tipo, 'Crédito');
    // Los espacios de relleno del banco se colapsan
    assert.equal(dto.Comercio_Original, 'ANTHROPIC* CLAUDE SUB +14152360599 US (USD 23.8)');
  });

  test('con separador de miles chileno (USD 1.234,56) convierte bien', () => {
    const env = createEnvironment();
    const dto = parse(env, COMPRA_USD, {
      transform: html => html.replace('USD 23,80', 'USD 1.234,56'),
    });
    assert.equal(dto.Monto, Math.round(1234.56 * 900));
    assert.match(dto.Comercio_Original, /\(USD 1234\.56\)$/);
  });

  test('un comercio internacional cobrado en pesos ($) no se convierte', () => {
    const env = createEnvironment();
    const dto = parse(env, COMPRA_USD, {
      transform: html => html.replace('USD 23,80', '$23.800'),
    });
    assert.equal(dto.Monto, 23800);
    assert.doesNotMatch(dto.Comercio_Original, /USD/);
  });

  test('si la celda no trae moneda, el titular "comercio internacional" indica dólares', () => {
    const env = createEnvironment();
    const dto = parse(env, COMPRA_USD, { transform: html => html.replace('USD 23,80', '23,80') });
    assert.equal(dto.Monto, 21420);
  });

  test('una regla antigua del diccionario con espacios de relleno sigue coincidiendo', () => {
    const env = envWithLabel();
    env.dict.appendRow([
      'ANTHROPIC* CLAUDE SUB    +14152360599 US (USD 23.8)',
      'Anthropic',
      'Suscripciones',
      'Software',
      false,
    ]);
    env.GmailApp.addThread([{ ...realBciEmail(COMPRA_USD), id: 'usd1' }]);
    env.gas.call('processEmails');
    const [row] = env.tx.toObjects();
    assert.equal(row['Categoría'], 'Suscripciones');
    assert.equal(env.UrlFetchApp.callsTo(':generateContent').length, 0);
  });
});
