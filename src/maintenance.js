/**
 * Archivo: maintenance.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Mantenimiento de la base de datos:
 * - Sweeper: reclasifica con IA las transacciones que quedaron como "Por Clasificar Automáticamente".
 * - Ordenamiento cronológico para Looker Studio.
 *
 * Diseño del sweeper: lee sin lock → clasifica sin lock (las llamadas a IA son lentas) → escribe con un
 * lock corto ubicando las filas por ID_Unico (no por índices obsoletos) y en bloque → sincroniza con
 * Notion fuera del lock. Nunca anida locks: no depende de que el LockService sea reentrante.
 */

const MAINTENANCE_SETTINGS = Object.freeze({
  SORT_LOCK_TIMEOUT_MS: 30000,
  WRITE_LOCK_TIMEOUT_MS: 15000,
  DEFAULT_SWEEP_DEADLINE_MS: 120000,
  NOTION_SYNC_RESERVE_MS: 20000,
  LOGS_MAX_ROWS: 3000,
  LOGS_PRUNE_SLACK: 500,
  DIGEST_KEY: 'PENDING_DIGEST_SENT',
  DIGEST_TTL_SECONDS: 21600,
});

/**
 * Fila pendiente de clasificar, tal como está en la hoja.
 * @typedef {object} PendingRow
 * @property {string} id
 * @property {string} comercio
 * @property {string} tipo
 */

/**
 * Lee las transacciones sin clasificar de la hoja (sin lock: solo lectura).
 * @returns {PendingRow[]}
 */
function _collectPendingTransactions() {
  const sheet = getSheetOrThrow(CONFIG.SHEETS.TRANSACTIONS);
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const cols = getTransactionColumns(data[0]);

  /** @type {PendingRow[]} */
  const pending = [];
  for (let i = 1; i < data.length; i++) {
    if (data[i][cols.Categoria] === CONFIG.PENDING_CATEGORY) {
      pending.push({
        id: String(data[i][cols.ID_Unico]),
        comercio: String(data[i][cols.Comercio_Original]),
        tipo: String(data[i][cols.Tipo] || 'Desconocido'),
      });
    }
  }
  return pending;
}

/**
 * Cuenta las transacciones pendientes de clasificar (lee solo la columna de categoría).
 * @returns {number}
 */
function countPendingTransactions() {
  const sheet = getSheetOrThrow(CONFIG.SHEETS.TRANSACTIONS);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;
  const cols = getTransactionColumns(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
  return sheet
    .getRange(2, cols.Categoria + 1, lastRow - 1, 1)
    .getValues()
    .filter(row => row[0] === CONFIG.PENDING_CATEGORY).length;
}

/**
 * Escribe la reclasificación en la hoja bajo un lock corto, ubicando las filas por ID_Unico en el
 * estado ACTUAL de la hoja y solo si siguen pendientes (no pisa ediciones ni filas nuevas).
 * @param {Map<string, {Comercio_Limpio: string, Categoria: string, Subcategoria: string}>} resolvedByKey
 * @returns {{acquired: boolean, updated: {id: string, Comercio_Limpio: string, Categoria: string}[]}}
 */
function _applyReclassification(resolvedByKey) {
  const outcome = withScriptLock(MAINTENANCE_SETTINGS.WRITE_LOCK_TIMEOUT_MS, () => {
    const sheet = getSheetOrThrow(CONFIG.SHEETS.TRANSACTIONS);
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow < 2) return [];

    const cols = getTransactionColumns(sheet.getRange(1, 1, 1, lastCol).getValues()[0]);
    const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

    /** @type {{id: string, Comercio_Limpio: string, Categoria: string}[]} */
    const updated = [];
    data.forEach(row => {
      if (row[cols.Categoria] !== CONFIG.PENDING_CATEGORY) return;
      const resolution = resolvedByKey.get(normalizeMerchantKey(row[cols.Comercio_Original]));
      if (!resolution) return;
      row[cols.Comercio_Limpio] = resolution.Comercio_Limpio;
      row[cols.Categoria] = resolution.Categoria;
      row[cols.Subcategoria] = resolution.Subcategoria;
      updated.push({
        id: String(row[cols.ID_Unico]),
        Comercio_Limpio: resolution.Comercio_Limpio,
        Categoria: resolution.Categoria,
      });
    });

    if (updated.length > 0) {
      // Escritura en bloque: una llamada por columna, nunca celda por celda.
      [cols.Comercio_Limpio, cols.Categoria, cols.Subcategoria].forEach(col => {
        sheet.getRange(2, col + 1, data.length, 1).setValues(data.map(row => [row[col]]));
      });
      SpreadsheetApp.flush();
    }
    return updated;
  });
  return { acquired: outcome.acquired, updated: outcome.value || [] };
}

/**
 * Sincroniza con Notion las filas reclasificadas, dentro del tiempo disponible.
 * @param {{id: string, Comercio_Limpio: string, Categoria: string}[]} updatedRows
 * @param {number} deadline - Instante (ms) límite absoluto.
 */
function _syncReclassifiedToNotion(updatedRows, deadline) {
  if (getEnv('NOTION_ENABLED') !== 'true' || updatedRows.length === 0) return;
  let synced = 0;
  for (let i = 0; i < updatedRows.length; i++) {
    if (Date.now() >= deadline) break;
    const row = updatedRows[i];
    if (
      updateTransactionInNotion(row.id, {
        Comercio_Limpio: row.Comercio_Limpio,
        Categoria: row.Categoria,
      })
    ) {
      synced++;
    }
  }
  if (synced < updatedRows.length) {
    logSystemEvent(
      'WARN',
      'Sweeper: Notion sin sincronizar del todo',
      `${synced}/${updatedRows.length} fila(s) actualizadas en Notion. Usa "Rescatar a Notion" para el resto.`
    );
  }
}

/**
 * Motor "Sweeper": busca transacciones pendientes en Sheets y las reclasifica con IA (por lotes).
 * @param {{deadlineMs?: number, ignoreCooldown?: boolean, quiet?: boolean}} [options]
 * @returns {string} Mensaje de resultado para la interfaz.
 */
function retryUnclassifiedTransactions(options) {
  const opts = options || {};
  const startedAt = Date.now();
  const deadline = startedAt + (opts.deadlineMs || MAINTENANCE_SETTINGS.DEFAULT_SWEEP_DEADLINE_MS);

  try {
    const pending = _collectPendingTransactions();
    if (pending.length === 0) {
      if (!opts.quiet) {
        logSystemEvent(
          'INFO',
          'Reprocesamiento Sweeper',
          'No hay transacciones pendientes de clasificar.'
        );
      }
      return '✅ No se encontraron transacciones pendientes.';
    }

    // Un elemento por comercio: evita enviar el mismo comercio decenas de veces.
    /** @type {Map<string, ClassifiableItem>} */
    const itemsByKey = new Map();
    pending.forEach(row => {
      const key = normalizeMerchantKey(row.comercio);
      if (!itemsByKey.has(key)) {
        // El comentario de la transferencia no se guarda en la BD: el sweeper clasifica por nombre.
        itemsByKey.set(key, { Comercio_Original: row.comercio, Tipo: row.tipo, Comentario: 'N/A' });
      }
    });

    const items = Array.from(itemsByKey.values());
    const aiDeadline = deadline - MAINTENANCE_SETTINGS.NOTION_SYNC_RESERVE_MS;
    const classification = classifyTransactions(items, {
      deadlineMs: Math.max(aiDeadline - Date.now(), 1000),
      ignoreCooldown: opts.ignoreCooldown,
    });

    /** @type {Map<string, {Comercio_Limpio: string, Categoria: string, Subcategoria: string}>} */
    const resolvedByKey = new Map();
    items.forEach(item => {
      if (item.Categoria && item.Categoria !== CONFIG.PENDING_CATEGORY) {
        resolvedByKey.set(normalizeMerchantKey(item.Comercio_Original), {
          Comercio_Limpio: item.Comercio_Limpio || item.Comercio_Original,
          Categoria: item.Categoria,
          Subcategoria: item.Subcategoria || '',
        });
      }
    });

    if (resolvedByKey.size === 0) {
      return classification.failure
        ? '⚠️ Gemini falló nuevamente o los servidores están saturados.'
        : '⚠️ No se pudo clasificar ninguna de las transacciones pendientes.';
    }

    // Reglas nuevas del diccionario (lock propio y corto), y luego las filas de la hoja.
    saveToDatabase([], classification.newDictionaryEntries);
    const applied = _applyReclassification(resolvedByKey);
    if (!applied.acquired) return '⏳ El sistema está ocupado. Intenta de nuevo más tarde.';

    _syncReclassifiedToNotion(applied.updated, deadline);

    const remaining = pending.length - applied.updated.length;
    logSystemEvent(
      'INFO',
      'Reprocesamiento Sweeper',
      `Éxito. ${applied.updated.length} filas actualizadas en Sheets` +
        (remaining > 0 ? `; ${remaining} siguen pendientes.` : '.')
    );
    let message = `✅ Éxito: Se reclasificaron ${applied.updated.length} transacciones históricas.`;
    if (remaining > 0)
      message += `\n⏳ Quedan ${remaining} pendientes; se reintentarán automáticamente.`;
    return message;
  } catch (error) {
    const detail = /** @type {Error} */ (error).message;
    logSystemEvent('ERROR', 'Fallo en Reprocesamiento Sweeper', detail);
    return `❌ Error: ${detail}`;
  }
}

/**
 * Avisa por Telegram (como máximo cada 6 horas) cuántas transacciones siguen sin clasificar.
 * Reemplaza a una alerta por cada error: un solo resumen entendible.
 */
function _notifyPendingDigest() {
  const cache = CacheService.getScriptCache();
  if (cache.get(MAINTENANCE_SETTINGS.DIGEST_KEY)) return;
  const pending = countPendingTransactions();
  if (pending === 0) return;
  cache.put(MAINTENANCE_SETTINGS.DIGEST_KEY, '1', MAINTENANCE_SETTINGS.DIGEST_TTL_SECONDS);
  sendTelegramAlert(
    `⏳ <b>${pending}</b> transacción(es) siguen sin clasificar. ` +
      `El sistema las reintentará automáticamente; también puedes usar «Re-procesar huérfanos» del menú.`
  );
}

/**
 * Ordena la hoja de transacciones por fecha y hora descendentes. Debe llamarse con el lock tomado.
 * @private
 * @returns {boolean} true si había datos que ordenar.
 */
function _sortTransactionsSheet() {
  const sheet = getSheetOrThrow(CONFIG.SHEETS.TRANSACTIONS);
  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow <= 1) return false;

  const cols = getTransactionColumns(sheet.getRange(1, 1, 1, lastCol).getValues()[0]);
  // Fecha y Hora descendentes: Looker Studio procesa mejor las series de tiempo así.
  sheet.getRange(2, 1, lastRow - 1, lastCol).sort([
    { column: cols.Fecha + 1, ascending: false },
    { column: cols.Hora + 1, ascending: false },
  ]);
  SpreadsheetApp.flush();
  return true;
}

/**
 * Mantenimiento nocturno: reclasifica pendientes y ordena la hoja cronológicamente.
 * El sweeper corre ANTES y FUERA del lock del ordenamiento.
 */
function cleanAndSortData() {
  try {
    logSystemEvent('INFO', 'Mantenimiento nocturno', 'Iniciando Sweeper y ordenamiento de BD...');

    retryUnclassifiedTransactions({ quiet: true });
    _notifyPendingDigest();

    const outcome = withScriptLock(
      MAINTENANCE_SETTINGS.SORT_LOCK_TIMEOUT_MS,
      _sortTransactionsSheet
    );
    if (!outcome.acquired) {
      logSystemEvent(
        'WARN',
        'Mantenimiento nocturno',
        'Sistema ocupado: el ordenamiento se reintentará mañana.'
      );
      return;
    }
    logSystemEvent('INFO', 'Mantenimiento nocturno', 'Base de datos ordenada correctamente.');
    _pruneLogsSheet();
  } catch (error) {
    logSystemEvent('ERROR', 'Fallo en cleanAndSortData', getErrorStack(error));
  }
}

/**
 * Poda la hoja `Logs` conservando solo los eventos más recientes (crece sin límite y
 * `appendRow` se vuelve más lento con los años). Los logs se agregan en orden cronológico.
 * @private
 */
function _pruneLogsSheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.LOGS);
  if (!sheet) return;
  const lastRow = sheet.getLastRow();
  const limit = MAINTENANCE_SETTINGS.LOGS_MAX_ROWS;
  // Se poda con holgura para no borrar filas en cada corrida.
  if (lastRow - 1 <= limit + MAINTENANCE_SETTINGS.LOGS_PRUNE_SLACK) return;
  const excess = lastRow - 1 - limit;
  sheet.deleteRows(2, excess);
}

/**
 * Envoltorio para ejecución manual desde la UI.
 */
function uiRunMaintenance() {
  cleanAndSortData();
  SpreadsheetApp.getUi().alert('✅ Base de datos ordenada cronológicamente.');
}
