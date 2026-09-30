'use strict';

/**
 * Diagnóstico del sistema (`runDiagnostics`): informe de configuración y llamada real mínima a Gemini.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { geminiErrors } = require('./harness/http-services');
const { envWithLabel, failAll, REALISTIC_MODELS } = require('./harness/scenarios');

describe('runDiagnostics', () => {
  test('con todo en orden informa ✅ y no revela ninguna credencial', () => {
    const env = envWithLabel();
    env.gas.call('uiSetupTriggers');
    const report = env.gas.call('runDiagnostics');
    assert.match(report, /✅ Propiedad GEMINI_API_KEY/);
    assert.match(report, /✅ Gemini respondió con gemini-3\.8-flash/);
    assert.match(report, /✅ Trigger horario de processEmails/);
    assert.match(report, /Transacciones pendientes de clasificar: 0/);
    assert.doesNotMatch(report, /test-gemini-key|123456:TEST-TOKEN|s3cret/);
  });

  test('señala lo que falta: propiedad, etiqueta y triggers', () => {
    const env = envWithLabel();
    env.props.deleteProperty('TELEGRAM_BOT_TOKEN');
    const report = env.gas.call('runDiagnostics');
    assert.match(report, /❌ Propiedad TELEGRAM_BOT_TOKEN/);
    assert.match(report, /❌ Trigger horario de processEmails/);
  });

  test('si Gemini no responde lo indica con el detalle por modelo', () => {
    const env = envWithLabel({
      gemini: { behaviors: failAll(REALISTIC_MODELS, geminiErrors.highDemand()) },
    });
    const report = env.gas.call('runDiagnostics');
    assert.match(report, /❌ Gemini no respondió/);
    assert.match(report, /gemini-3\.8-flash: 503/);
  });

  test('informa si el LockService es reentrante en ambos modos y no deja locks tomados', () => {
    const strict = envWithLabel({ lockReentrant: false });
    assert.match(strict.gas.call('runDiagnostics'), /LockService reentrante: no/);
    strict.LockService.assertNoneHeld();

    const reentrant = envWithLabel({ lockReentrant: true });
    assert.match(reentrant.gas.call('runDiagnostics'), /LockService reentrante: sí/);
    reentrant.LockService.assertNoneHeld();
  });

  test('el diagnóstico no ensucia la base: no agrega filas ni reglas al diccionario', () => {
    const env = envWithLabel();
    env.gas.call('runDiagnostics');
    assert.equal(env.tx.getLastRow(), 1);
    assert.equal(env.dict.getLastRow(), 1);
  });

  test('uiRunDiagnostics muestra el informe en un cuadro de diálogo', () => {
    const env = envWithLabel();
    env.gas.call('uiRunDiagnostics');
    assert.match(env.SpreadsheetApp._ui.alerts[0].title, /Diagnóstico/);
  });
});
