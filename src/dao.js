/**
 * Archivo: dao.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Data Access Object (DAO). Maneja la lectura y escritura en Google Sheets.
 * Toda escritura ocurre bajo el lock de script y de forma idempotente (por ID_Unico y por
 * comercio del diccionario). Las llamadas a Notion se hacen FUERA del lock: son lentas
 * (500 ms por petición) y bloquearían al resto de las ejecuciones.
 */

/**
 * Obtiene una hoja del libro activo o falla con un mensaje claro si no existe
 * (por ejemplo, si nunca se ejecutó `installApp`).
 * @param {string} sheetName
 * @returns {GoogleAppsScript.Spreadsheet.Sheet}
 * @throws {Error} Si la hoja no existe.
 */
function getSheetOrThrow(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) throw new Error(`No existe la hoja "${sheetName}". Ejecuta installApp() primero.`);
  return sheet;
}

/**
 * Ejecuta `fn` con el lock de script tomado y lo libera siempre.
 * @template T
 * @param {number} timeoutMs - Tiempo máximo de espera del lock.
 * @param {() => T} fn
 * @returns {{acquired: boolean, value: T|undefined}} `acquired=false` si no se obtuvo el lock (fn no se ejecutó).
 */
function withScriptLock(timeoutMs, fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(timeoutMs)) return { acquired: false, value: undefined };
  try {
    return { acquired: true, value: fn() };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Última fila (base 1) con contenido en una columna; 1 si solo existe el encabezado.
 * @private
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} column - Columna base 1.
 * @returns {number}
 */
function _lastRowWithData(sheet, column) {
  const values = sheet.getRange(1, column, sheet.getMaxRows(), 1).getValues();
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i][0] !== '' && values[i][0] !== null) return i + 1;
  }
  return 1;
}

/**
 * Utilidad privada para extraer valores de un objeto JSON ignorando las mayúsculas/minúsculas de las llaves.
 * @private
 * @param {object | null | undefined} obj
 * @param {string} searchKey
 * @returns {string}
 */
function _getValueIgnoreCase(obj, searchKey) {
  if (!obj) return '';
  const lowerSearchKey = searchKey.toLowerCase();
  const record = /** @type {Record<string, any>} */ (obj);
  const foundKey = Object.keys(record).find(k => k.toLowerCase() === lowerSearchKey);
  return foundKey ? record[foundKey] : '';
}

/**
 * Obtiene todos los IDs de transacciones existentes para evitar duplicados (Idempotencia).
 * @returns {Set<string>} Conjunto (Set) con los IDs únicos.
 */
function getExistingTransactionIds() {
  const sheet = getSheetOrThrow(CONFIG.SHEETS.TRANSACTIONS);
  const data = sheet.getRange('A2:A').getValues();
  /** @type {Set<string>} */
  const ids = new Set();

  data.forEach(row => {
    if (row[0]) ids.add(row[0].toString());
  });

  return ids;
}

/**
 * Obtiene el Diccionario actual en memoria para optimizar la cuota de la IA.
 * @returns {Map<string, DictionaryValue>} Mapa de { "comercio banco" => { Comercio_Limpio, Categoria, Subcategoria } }.
 */
function getDictionaryMap() {
  const sheet = getSheetOrThrow(CONFIG.SHEETS.DICTIONARY);
  const data = sheet.getRange('A2:D').getValues();
  /** @type {Map<string, DictionaryValue>} */
  const cache = new Map();

  data.forEach(row => {
    if (row[0]) {
      const comercioBancoKey = normalizeMerchantKey(row[0]);
      cache.set(comercioBancoKey, {
        Comercio_Limpio: row[1] ? row[1].toString().trim() : row[0].toString().trim(),
        Categoria: row[2] ? row[2].toString().trim() : 'Sin Categoría',
        Subcategoria: row[3] ? row[3].toString().trim() : '',
      });
    }
  });

  return cache;
}

/**
 * Inserta transacciones nuevas (omitiendo IDs ya existentes) y reglas nuevas del diccionario
 * (omitiendo comercios ya registrados). Debe llamarse con el lock tomado.
 * @private
 * @param {Transaction[]} transactions
 * @param {DictionaryEntry[]} newDictionaryEntries
 * @returns {{inserted: Transaction[], duplicates: number, dictionaryAdded: number}}
 */
function _writeBatch(transactions, newDictionaryEntries) {
  // 1. Transacciones (idempotente por ID_Unico, también dentro del mismo lote)
  /** @type {Transaction[]} */
  const inserted = [];
  if (transactions.length > 0) {
    const sheetTx = getSheetOrThrow(CONFIG.SHEETS.TRANSACTIONS);
    const knownIds = getExistingTransactionIds();
    transactions.forEach(tx => {
      const id = tx.ID_Unico ? String(tx.ID_Unico) : '';
      if (id && knownIds.has(id)) return;
      if (id) knownIds.add(id);
      inserted.push(tx);
    });

    if (inserted.length > 0) {
      const rowsToInsert = inserted.map(transactionToRow);
      const lastRow = Math.max(sheetTx.getLastRow(), 1);
      sheetTx
        .getRange(lastRow + 1, 1, rowsToInsert.length, rowsToInsert[0].length)
        .setValues(rowsToInsert);
    }
  }

  // 2. Diccionario (upsert por comercio, sin distinguir mayúsculas)
  let dictionaryAdded = 0;
  if (newDictionaryEntries.length > 0) {
    const sheetDict = getSheetOrThrow(CONFIG.SHEETS.DICTIONARY);
    const knownKeys = getDictionaryMap();
    /** @type {any[][]} */
    const dictRows = [];
    newDictionaryEntries.forEach(entry => {
      // Tolera que la IA cambie "Categoria" por "categoria".
      const original = _getValueIgnoreCase(entry, 'Comercio_Original');
      const key = normalizeMerchantKey(original);
      if (!key || knownKeys.has(key)) return;
      knownKeys.set(key, { Comercio_Limpio: '', Categoria: '', Subcategoria: '' });
      dictRows.push([
        original,
        _getValueIgnoreCase(entry, 'Comercio_Limpio'),
        _getValueIgnoreCase(entry, 'Categoria'),
        _getValueIgnoreCase(entry, 'Subcategoria'),
        false, // Casilla de auditoría manual
      ]);
    });

    if (dictRows.length > 0) {
      // Se usa la columna A y no getLastRow(): las casillas de auditoría (columna E) ya ocupan las
      // ~1000 filas de la hoja y desplazarían las reglas nuevas muy por debajo de las existentes.
      const lastRowDict = _lastRowWithData(sheetDict, 1);
      sheetDict
        .getRange(lastRowDict + 1, 1, dictRows.length, dictRows[0].length)
        .setValues(dictRows);
      const auditColIndex = CONFIG.HEADERS.DICTIONARY.indexOf('Auditoría Manual (Check)') + 1;
      if (auditColIndex > 0) {
        sheetDict.getRange(lastRowDict + 1, auditColIndex, dictRows.length, 1).insertCheckboxes();
      }
      dictionaryAdded = dictRows.length;
    }
  }

  SpreadsheetApp.flush();
  return { inserted, duplicates: transactions.length - inserted.length, dictionaryAdded };
}

/**
 * Guarda las nuevas transacciones y actualiza el diccionario de forma segura e idempotente.
 * Si Notion está activado, sincroniza las transacciones nuevas una vez liberado el lock.
 * @param {Transaction[]} transactions - Transacciones a guardar.
 * @param {DictionaryEntry[]} newDictionaryEntries - Reglas nuevas del diccionario.
 * @returns {{inserted: number, duplicates: number, dictionaryAdded: number}}
 * @throws {Error} Si no se obtiene el lock de escritura a tiempo.
 */
function saveToDatabase(transactions, newDictionaryEntries) {
  if (transactions.length === 0 && newDictionaryEntries.length === 0) {
    return { inserted: 0, duplicates: 0, dictionaryAdded: 0 };
  }

  const outcome = withScriptLock(15000, () => _writeBatch(transactions, newDictionaryEntries));
  if (!outcome.acquired || !outcome.value) {
    throw new Error('Timeout esperando el bloqueo para escribir en Sheets.');
  }
  const written = outcome.value;

  // Notion va fuera del lock: es lento (500 ms por petición) y no debe bloquear a otras ejecuciones.
  if (getEnv('NOTION_ENABLED') === 'true' && written.inserted.length > 0) {
    try {
      pushToNotion(written.inserted);
    } catch (error) {
      logSystemEvent('ERROR', 'Fallo al sincronizar con Notion', getErrorMessage(error));
    }
  }

  return {
    inserted: written.inserted.length,
    duplicates: written.duplicates,
    dictionaryAdded: written.dictionaryAdded,
  };
}

/**
 * Busca y elimina una o múltiples transacciones por sus ID_Unico.
 * Diseñado para borrado en lote. Borra en orden descendente para evitar el desplazamiento de
 * índices. Las filas se eliminan de Sheets bajo el lock; el borrado en Notion se hace después,
 * fuera del lock.
 * @param {string[]} idsToDelete - IDs a borrar.
 * @returns {string} Mensaje de texto formateado (HTML) con el resultado.
 */
function deleteTransactionsByIds(idsToDelete) {
  if (!idsToDelete || idsToDelete.length === 0) return '⚠️ No se proporcionaron IDs.';

  try {
    const outcome = withScriptLock(15000, () => {
      const sheet = getSheetOrThrow(CONFIG.SHEETS.TRANSACTIONS);
      const data = sheet.getDataRange().getValues();
      const cols = getTransactionColumns(data[0]);

      /** @type {{rowIndex: number, id: string, comercio: any}[]} */
      const rowsToDelete = [];
      for (let i = 1; i < data.length; i++) {
        const currentId = data[i][cols.ID_Unico].toString().trim();
        if (idsToDelete.includes(currentId)) {
          rowsToDelete.push({
            rowIndex: i + 1, // +1 porque Sheets empieza en 1
            id: currentId,
            comercio: data[i][cols.Comercio_Original],
          });
        }
      }

      // Orden DESCENDENTE: crucial para no alterar las posiciones al borrar.
      rowsToDelete.sort((a, b) => b.rowIndex - a.rowIndex);
      rowsToDelete.forEach(target => {
        sheet.deleteRow(target.rowIndex);
        logSystemEvent('INFO', 'Borrado Remoto', `Eliminado: ${target.id} (${target.comercio})`);
      });
      SpreadsheetApp.flush();
      return rowsToDelete;
    });

    if (!outcome.acquired) return '⏳ El sistema está ocupado. Intenta de nuevo en unos segundos.';
    const deleted = outcome.value || [];
    if (deleted.length === 0) {
      return `❌ <b>No encontrados</b>\nNinguno de los IDs enviados existe en la base de datos.`;
    }

    // Notion, fuera del lock
    const isNotionEnabled = getEnv('NOTION_ENABLED') === 'true';
    let notionFails = 0;
    if (isNotionEnabled) {
      deleted.forEach(target => {
        try {
          if (!deleteTransactionInNotion(target.id)) notionFails++;
        } catch (e) {
          logSystemEvent('ERROR', 'Fallo Notion Borrado Lote', /** @type {Error} */ (e).message);
          notionFails++;
        }
      });
    }

    let resultMsg = `✅ <b>Borrado Exitoso</b>\n\nSe eliminaron <b>${deleted.length}</b> transacciones de tu base de datos.`;
    if (isNotionEnabled) {
      resultMsg +=
        notionFails > 0
          ? `\n\n<i>⚠️ Advertencia: ${notionFails} registro(s) no se encontraron en Notion, pero sí se borraron de Sheets.</i>`
          : `\n<i>(Eliminadas simultáneamente en Notion).</i>`;
    }
    return resultMsg;
  } catch (error) {
    const message = /** @type {Error} */ (error).message;
    logSystemEvent('ERROR', 'Fallo crítico en borrado batch', message);
    return `🚨 <b>Error interno</b>\nOcurrió un fallo al borrar: ${message}`;
  }
}
