/**

Archivo: logger.gs

Autor: Alan Zapata Silva

Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.

Este codigo es Source-Available. NO es Open Source.

Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.

Revise el archivo LICENSE.gs para conocer los terminos vinculantes.
*/
/**
 * @fileoverview Sistema centralizado de Logs para auditoría y monitoreo de errores.
 */

/**
 * Registra un evento en la hoja de Logs de forma segura.
 * @param {string} level - Nivel del log ('INFO', 'WARN', 'ERROR').
 * @param {string} message - Mensaje descriptivo.
 * @param {string} [stackTrace=""] - Traza del error (opcional).
 */
function logSystemEvent(level, message, stackTrace = "") {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.LOGS);
    if (!sheet) return;

    // Formato: ['Timestamp', 'Nivel', 'Mensaje', 'Stack Trace']
    const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM-dd HH:mm:ss");
    sheet.appendRow([timestamp, level, message, stackTrace]);
    
    // Si es un error crítico, opcionalmente podríamos alertar por Telegram aquí mismo.
    if (level === 'ERROR') {
      sendTelegramAlert(`🚨 <b>Error Crítico en SaaS:</b>\n${message}`);
    }
  } catch (e) {
    // Si el logger falla, caemos al log nativo de Google como último recurso
    console.error("Fallo catastrófico en el Logger: " + e.message);
  }
}