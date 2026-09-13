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
    logSystemEvent('INFO', 'Mantenimiento nocturno', 'Iniciando Sweeper y ordenamiento de BD...');
    
    // === NUEVO: Reprocesar transacciones huérfanas antes de leer y ordenar ===
    retryUnclassifiedTransactions();
    
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
    logSystemEvent('INFO', 'Mantenimiento nocturno', 'Base de datos ordenada correctamente.');
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

/**
 * Motor "Sweeper": Busca transacciones huérfanas en Sheets y las re-procesa con IA.
 * Utiliza Batch Processing para minimizar llamadas a la API.
 * @returns {string} Mensaje de resultado para la interfaz.
 */
function retryUnclassifiedTransactions() {
  logSystemEvent('INFO', 'Reprocesamiento Sweeper', 'Buscando transacciones sin clasificar...');
  
  // Regla 5: Concurrencia Estricta
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return "⏳ El sistema está ocupado. Intenta de nuevo más tarde.";
  }

  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
    const data = sheet.getDataRange().getValues();
    const headers = data[0];

    // Mapeo dinámico de columnas (Zero Hardcoding de índices)
    const idxComercioOrig = headers.indexOf('Comercio Original');
    const idxCategoria = headers.indexOf('Categoría');
    const idxSubcategoria = headers.indexOf('Subcategoría');
    const idxComercioLimpio = headers.indexOf('Comercio Limpio');
    const idxTipo = headers.indexOf('Tipo');

    let comerciosUnicosMap = new Map();

    // 1. Identificar transacciones huérfanas
    for (let i = 1; i < data.length; i++) {
      if (data[i][idxCategoria] === 'Por Clasificar Automáticamente') {
        const comercioOriginal = data[i][idxComercioOrig];
        const tipo = data[i][idxTipo] || "Desconocido";
        
        // Evitamos enviar el mismo comercio 10 veces en el mismo Batch
        if (!comerciosUnicosMap.has(comercioOriginal)) {
          comerciosUnicosMap.set(comercioOriginal, {
            Comercio_Original: comercioOriginal,
            Tipo: tipo,
            Comentario: "N/A" // No guardamos el comentario en la DB, asumimos N/A para el sweeper
          });
        }
      }
    }

    if (comerciosUnicosMap.size === 0) {
      logSystemEvent('INFO', 'Reprocesamiento Sweeper', 'No hay transacciones pendientes de clasificar.');
      return "✅ No se encontraron transacciones pendientes.";
    }

    // 2. Ejecutar la llamada a la IA (Batch)
    const transaccionesAReprocesar = Array.from(comerciosUnicosMap.values());
    const resultadosGemini = categorizeWithGemini(transaccionesAReprocesar);

    if (!resultadosGemini || resultadosGemini.length === 0) {
      return "⚠️ Gemini falló nuevamente o los servidores están saturados.";
    }

    // 3. Actualizar el Diccionario (Invocamos al DAO)
    saveToDatabase([], resultadosGemini);

    // 4. Actualizar las filas afectadas directamente en la hoja de Transacciones
    const resultMap = new Map();
    resultadosGemini.forEach(r => resultMap.set(r.Comercio_Original, r));

    let filasActualizadas = 0;
    for (let i = 1; i < data.length; i++) {
      if (data[i][idxCategoria] === 'Por Clasificar Automáticamente') {
        const comercio = data[i][idxComercioOrig];
        if (resultMap.has(comercio)) {
          const clasif = resultMap.get(comercio);
          // Las filas de Sheets empiezan en 1, y nos saltamos el header (i+1)
          sheet.getRange(i + 1, idxCategoria + 1).setValue(clasif.Categoria);
          sheet.getRange(i + 1, idxSubcategoria + 1).setValue(clasif.Subcategoria);
          sheet.getRange(i + 1, idxComercioLimpio + 1).setValue(clasif.Comercio_Limpio);
          filasActualizadas++;
        }
      }
    }

    logSystemEvent('INFO', 'Reprocesamiento Sweeper', `Éxito. ${filasActualizadas} filas actualizadas en Sheets.`);
    return `✅ Éxito: Se reclasificaron ${filasActualizadas} transacciones históricas.`;

  } catch (error) {
    logSystemEvent('ERROR', 'Fallo en Reprocesamiento Sweeper', error.message);
    return `❌ Error: ${error.message}`;
  } finally {
    lock.releaseLock();
  }
}