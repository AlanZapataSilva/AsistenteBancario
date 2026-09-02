/**
 * @fileoverview Motor de mantenimiento y optimización de base de datos.
 */

/**
 * Ordena la base de datos cronológicamente, elimina filas vacías y optimiza la hoja.
 * Diseñado para ejecutarse vía Trigger automático a las 2:00 AM.
 */
function cleanAndSortData() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    logSystemEvent('WARN', 'Mantenimiento', 'Sistema ocupado. Se reintentará mañana.');
    return;
  }

  try {
    logSystemEvent('INFO', 'Mantenimiento', 'Iniciando limpieza y ordenamiento nocturno...');
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
    
    // 1. Eliminar filas vacías al final de la hoja para optimizar caché de Looker Studio
    const maxRows = sheet.getMaxRows();
    const lastRow = sheet.getLastRow();
    if (maxRows > lastRow) {
      sheet.deleteRows(lastRow + 1, maxRows - lastRow);
    }

    // 2. Ordenar datos (Ignorando la fila 1 de encabezados)
    // Columna B (Fecha, índice 2) Descendente, Columna C (Hora, índice 3) Descendente
    // Así siempre ves las transacciones más recientes en la parte superior.
    if (lastRow > 1) {
      const range = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn());
      range.sort([
        { column: 2, ascending: false }, 
        { column: 3, ascending: false }  
      ]);
    }
    
    SpreadsheetApp.flush();
    logSystemEvent('INFO', 'Mantenimiento', 'Base de datos ordenada y optimizada con éxito.');

  } catch (error) {
    logSystemEvent('ERROR', 'Fallo en Mantenimiento', error.message);
  } finally {
    lock.releaseLock();
  }
}

/**
 * UI Handler: Permite al usuario ejecutar el mantenimiento manualmente desde el menú.
 * Ya tienes el botón "🧹 Ordenar Base de Datos" apuntando a esta función en ui.gs.
 */
function uiRunMaintenance() {
  const ui = SpreadsheetApp.getUi();
  cleanAndSortData();
  ui.alert('Mantenimiento Completado', '✅ Base de datos ordenada cronológicamente y filas vacías eliminadas. Lista para Looker Studio.', ui.ButtonSet.OK);
}