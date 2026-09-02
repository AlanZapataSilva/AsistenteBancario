/**
 * Archivo: dao.gs
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.gs para conocer los terminos vinculantes.
 * * VERSIÓN ACTUAL: Estable + Case-Insensitive Gemini JSON + Flags de Trazabilidad
 */

/**
 * @fileoverview Data Access Object (DAO). Maneja la lectura y escritura en Google Sheets.
 * Implementa LockService estricto para proteger la integridad de los datos.
 */

/**
 * Utilidad privada para extraer valores de un objeto JSON ignorando las mayúsculas/minúsculas de las llaves.
 * Previene celdas vacías si Gemini cambia "Categoria" por "categoria".
 * @private
 */
function _getValueIgnoreCase(obj, searchKey) {
  if (!obj) return "";
  const lowerSearchKey = searchKey.toLowerCase();
  const foundKey = Object.keys(obj).find(k => k.toLowerCase() === lowerSearchKey);
  return foundKey ? obj[foundKey] : "";
}

/**
 * Obtiene todos los IDs de transacciones existentes para evitar duplicados (Idempotencia).
 * @returns {Set<string>} Conjunto (Set) con los IDs únicos.
 */
function getExistingTransactionIds() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
  const data = sheet.getRange("A2:A").getValues();
  const ids = new Set();
  
  data.forEach(row => {
    if (row[0]) ids.add(row[0].toString());
  });
  
  return ids;
}

/**
 * Obtiene el Diccionario actual en memoria para optimizar la cuota de la IA.
 * Extrae todas las columnas para reconstruir el DTO completo sin llamar a Gemini.
 * @returns {Map<string, Object>} Mapa de { "comercio banco" => { Comercio_Limpio, Categoria, Subcategoria } }.
 */
function getDictionaryMap() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.DICTIONARY);
  const data = sheet.getRange("A2:D").getValues();
  const cache = new Map();
  
  data.forEach(row => {
    if (row[0]) {
      const comercioBancoKey = row[0].toString().trim().toLowerCase();
      cache.set(comercioBancoKey, {
        Comercio_Limpio: row[1] ? row[1].toString().trim() : row[0].toString().trim(),
        Categoria: row[2] ? row[2].toString().trim() : 'Sin Categoría',
        Subcategoria: row[3] ? row[3].toString().trim() : ''
      });
    }
  });
  
  return cache;
}

/**
 * Guarda las nuevas transacciones y actualiza el diccionario de forma segura.
 * @param {Array<Object>} transactions - Arreglo de transacciones a guardar.
 * @param {Array<Object>} newDictionaryEntries - Arreglo de objetos JSON provenientes de Gemini.
 */
function saveToDatabase(transactions, newDictionaryEntries) {
  if (transactions.length === 0 && newDictionaryEntries.length === 0) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    throw new Error('Timeout esperando el bloqueo para escribir en Sheets.');
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    
    // 1. Guardar Transacciones
    if (transactions.length > 0) {
      const sheetTx = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
      const rowsToInsert = transactions.map(tx => [
        tx.ID_Unico, tx.Fecha, tx.Hora, tx.Comercio_Original, tx.Comercio_Limpio, 
        tx.Categoria, tx.Subcategoria, tx.Monto, tx.Cuotas, tx.Tipo, tx.Origen
      ]);
      
      const lastRow = Math.max(sheetTx.getLastRow(), 1);
      sheetTx.getRange(lastRow + 1, 1, rowsToInsert.length, rowsToInsert[0].length).setValues(rowsToInsert);
    }

    // 2. Guardar Nuevos Comercios en Diccionario
    if (newDictionaryEntries.length > 0) {
      const sheetDict = ss.getSheetByName(CONFIG.SHEETS.DICTIONARY);
      
      //logSystemEvent('INFO', '[FLAG DICT 1] JSON Crudo de Gemini', JSON.stringify(newDictionaryEntries).substring(0, 300) + '...');
      
      // Transformamos los objetos JSON de Gemini a las 5 columnas de Sheets (Case-Insensitive)
      const dictRows = newDictionaryEntries.map(entry => {
        const original = _getValueIgnoreCase(entry, 'Comercio_Original');
        const limpio = _getValueIgnoreCase(entry, 'Comercio_Limpio');
        const cat = _getValueIgnoreCase(entry, 'Categoria');
        const subcat = _getValueIgnoreCase(entry, 'Subcategoria');
        
        return [original, limpio, cat, subcat, false]; // El false es el Checkbox
      });
      
      //logSystemEvent('INFO', '[FLAG DICT 2] Filas Mapeadas para Sheets', JSON.stringify(dictRows).substring(0, 300));
      
      const lastRowDict = Math.max(sheetDict.getLastRow(), 1);
      sheetDict.getRange(lastRowDict + 1, 1, dictRows.length, dictRows[0].length).setValues(dictRows);
      
      // Insertar checkboxes dinámicamente en la columna correcta
      const auditColIndex = CONFIG.HEADERS.DICTIONARY.indexOf('Auditoría Manual (Check)') + 1;
      if (auditColIndex > 0) {
        sheetDict.getRange(lastRowDict + 1, auditColIndex, dictRows.length, 1).insertCheckboxes();
      }

      //logSystemEvent('INFO', '[FLAG DICT 3] Diccionario Actualizado', `Se insertaron ${dictRows.length} nuevas reglas.`);
    }
    
    SpreadsheetApp.flush(); // Fuerza la escritura inmediata en Sheets

    // 3. --- FEATURE TOGGLE PARA NOTION ---
    const isNotionEnabled = getEnv('NOTION_ENABLED') === 'true';
    if (isNotionEnabled && transactions.length > 0) {
      if (typeof pushToNotion === "function") {
        pushToNotion(transactions);
      } else {
        logSystemEvent('WARN', 'Notion Toggle', 'Notion está activado pero la función pushToNotion no existe.');
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Busca y elimina una o múltiples transacciones por sus ID_Unico. 
 * Diseñado para borrado en lote (Batch Delete). Borra en orden descendente 
 * para evitar el desplazamiento de índices en Google Sheets.
 * @param {Array<string>} idsToDelete - Arreglo de IDs a borrar.
 * @returns {string} Mensaje de texto formateado (HTML) con el resultado.
 */
function deleteTransactionsByIds(idsToDelete) {
  if (!idsToDelete || idsToDelete.length === 0) return "⚠️ No se proporcionaron IDs.";

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) {
    return "⏳ El sistema está ocupado. Intenta de nuevo en unos segundos.";
  }

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(CONFIG.SHEETS.TRANSACTIONS);
    const data = sheet.getDataRange().getValues();
    
    let rowsToDelete = [];
    
    // 1. Mapear todas las filas que coincidan con los IDs solicitados
    for (let i = 1; i < data.length; i++) {
      const currentId = data[i][0].toString().trim();
      if (idsToDelete.includes(currentId)) {
        rowsToDelete.push({
          rowIndex: i + 1, // +1 porque Sheets empieza en 1
          id: currentId,
          comercio: data[i][3],
          monto: data[i][7]
        });
      }
    }
    
    if (rowsToDelete.length === 0) {
      return `❌ <b>No encontrados</b>\nNinguno de los IDs enviados existe en la base de datos.`;
    }

    // 2. ORDENAR DESCENDENTE (Crucial para no alterar las posiciones al borrar)
    rowsToDelete.sort((a, b) => b.rowIndex - a.rowIndex);

    let borradosCount = 0;
    let notionFails = 0;
    const isNotionEnabled = getEnv('NOTION_ENABLED') === 'true';

    // 3. Ejecutar la destrucción dual
    for (let target of rowsToDelete) {
      // Notion primero
      if (isNotionEnabled && typeof deleteTransactionInNotion === "function") {
        try {
          const notionDeleted = deleteTransactionInNotion(target.id);
          if (!notionDeleted) notionFails++;
        } catch (e) {
          logSystemEvent('ERROR', 'Fallo Notion Borrado Lote', e.message);
          notionFails++;
        }
      }
      
      // Sheets después
      sheet.deleteRow(target.rowIndex);
      borradosCount++;
      logSystemEvent('INFO', 'Borrado Remoto', `Eliminado: ${target.id} (${target.comercio})`);
    }
    
    SpreadsheetApp.flush();
    
    // 4. Construir mensaje de respuesta
    let resultMsg = `✅ <b>Borrado Exitoso</b>\n\nSe eliminaron <b>${borradosCount}</b> transacciones de tu base de datos.`;
    if (isNotionEnabled) {
      resultMsg += notionFails > 0 
        ? `\n\n<i>⚠️ Advertencia: ${notionFails} registro(s) no se encontraron en Notion, pero sí se borraron de Sheets.</i>` 
        : `\n<i>(Eliminadas simultáneamente en Notion).</i>`;
    }
    
    return resultMsg;
    
  } catch (error) {
    logSystemEvent('ERROR', 'Fallo crítico en borrado batch', error.message);
    return `🚨 <b>Error interno</b>\nOcurrió un fallo al borrar: ${error.message}`;
  } finally {
    lock.releaseLock();
  }
}