/**

Archivo: maitenance.gs

Autor: Alan Zapata Silva

Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.

Este codigo es Source-Available. NO es Open Source.

Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.

Revise el archivo LICENSE.gs para conocer los terminos vinculantes.
*/
/**
 * @fileoverview Limpieza y preparación de datos para consumo en herramientas BI (Looker Studio).
 */

/**
 * Ordena la hoja de transacciones cronológicamente y asegura formato estricto.
 * Diseñado para ejecutarse automáticamente de madrugada.
 */
function cleanAndSortData() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return; // Si hay concurrencia, abortamos el mantenimiento

  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    
    if (lastRow <= 1) return; // No hay datos que ordenar

    // Rango total de datos (excluyendo encabezados)
    const dataRange = sheet.getRange(2, 1, lastRow - 1, lastCol);
    
    // ORDENAMIENTO: Por Fecha (Columna B / Índice 2) Descendente, luego por Hora (Columna C / Índice 3) Descendente.
    // Esto asegura que Looker Studio procese las series de tiempo correctamente.
    dataRange.sort([
      { column: 2, ascending: false }, 
      { column: 3, ascending: false }
    ]);

    SpreadsheetApp.flush();
    logSystemEvent('INFO', 'Mantenimiento nocturno: Base de datos ordenada correctamente.');
  } catch (error) {
    logSystemEvent('ERROR', 'Fallo en cleanAndSortData', error.stack);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Envoltorio para ejecución manual desde la UI.
 */
function uiRunMaintenance() {
  cleanAndSortData();
  SpreadsheetApp.getUi().alert('✅ Base de datos ordenada cronológicamente.');
}