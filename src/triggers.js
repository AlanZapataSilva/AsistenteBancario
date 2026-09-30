/**
 * Archivo: triggers.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Gestión de automatizaciones (Time-driven Triggers / Cron Jobs).
 */

/** Handlers que administra `uiSetupTriggers` (los relevos temporales también se limpian). */
const MANAGED_TRIGGER_HANDLERS = Object.freeze([
  'processEmails',
  'cleanAndSortData',
  'continueProcessEmails',
]);

/**
 * Crea los gatillos automáticos: extracción de correos cada hora y mantenimiento nocturno a las 2 AM.
 * Es idempotente: borra los triggers propios antes de crear los nuevos para evitar colisiones.
 */
function uiSetupTriggers() {
  const ui = SpreadsheetApp.getUi();

  try {
    // 1. Limpieza total de triggers anteriores (idempotencia fuerte)
    ScriptApp.getProjectTriggers().forEach(trigger => {
      if (MANAGED_TRIGGER_HANDLERS.includes(trigger.getHandlerFunction())) {
        ScriptApp.deleteTrigger(trigger);
      }
    });

    // 2. Extracción de correos (cada 1 hora)
    ScriptApp.newTrigger('processEmails').timeBased().everyHours(1).create();

    // 3. Mantenimiento diario para Looker Studio y reclasificación de pendientes (2 AM)
    ScriptApp.newTrigger('cleanAndSortData').timeBased().everyDays(1).atHour(2).create();

    ui.alert(
      'Automatización Activa',
      '✅ El motor leerá correos cada 1 hora y el mantenimiento correrá a las 2 AM.',
      ui.ButtonSet.OK
    );
    logSystemEvent('INFO', 'Triggers automáticos configurados por el usuario.');
  } catch (error) {
    ui.alert(
      'Error',
      '❌ No se pudieron crear los Triggers: ' + getErrorMessage(error),
      ui.ButtonSet.OK
    );
    logSystemEvent('ERROR', 'Fallo al configurar triggers', getErrorStack(error));
  }
}
