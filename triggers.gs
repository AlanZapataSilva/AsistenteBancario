/**

Archivo: triggers.gs

Autor: Alan Zapata Silva

Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.

Este codigo es Source-Available. NO es Open Source.

Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.

Revise el archivo LICENSE.gs para conocer los terminos vinculantes.
*/
/**
 * @fileoverview Gestión de automatizaciones (Time-driven Triggers / Cron Jobs).
 */

/**
 * Crea el gatillo automático para que el motor de extracción corra cada hora.
 * Es idempotente: borra triggers antiguos antes de crear uno nuevo para evitar colisiones.
 */
function uiSetupTriggers() {
  const ui = SpreadsheetApp.getUi();
  const functionName = 'processEmails';

  try {
    // 1. Limpieza Total de Triggers anteriores (Idempotencia Fuerte)
    const existingTriggers = ScriptApp.getProjectTriggers();
    existingTriggers.forEach(trigger => {
      const handlerName = trigger.getHandlerFunction();
      // Borramos CUALQUIERA de nuestros dos triggers si ya existen
      if (handlerName === 'processEmails' || handlerName === 'cleanAndSortData') {
        ScriptApp.deleteTrigger(trigger);
      }
    });

    // 2. Creación del nuevo Trigger (Ejecución cada 1 hora)
    ScriptApp.newTrigger(functionName)
      .timeBased()
      .everyHours(1)
      .create();

    // 3. Trigger diario para mantenimiento de Looker Studio (2 AM)
    ScriptApp.newTrigger('cleanAndSortData')
      .timeBased()
      .everyDays(1)
      .atHour(2)
      .create();

    ui.alert('Automatización Activa', '✅ El motor leerá correos cada 1 hora y el mantenimiento correrá a las 2 AM.', ui.ButtonSet.OK);
    logSystemEvent('INFO', 'Triggers automáticos configurados por el usuario.');
  } catch (error) {
    ui.alert('Error', '❌ No se pudieron crear los Triggers: ' + error.message, ui.ButtonSet.OK);
    logSystemEvent('ERROR', 'Fallo al configurar triggers', error.stack);
  }
}