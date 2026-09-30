/**
 * Archivo: extractor.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Motor de extracción (ETL - Extract).
 * Consulta Gmail, recupera los correos bancarios no procesados, los deriva al parser, clasifica,
 * guarda y solo entonces marca los hilos como procesados. Idempotencia de doble capa:
 * etiqueta de Gmail + ID único del mensaje (verificado dentro del lock al guardar).
 */

const EXTRACTOR_SETTINGS = Object.freeze({
  MAX_EXECUTION_TIME_MS: 3.5 * 60 * 1000,
  BATCH_SIZE: 20,
  RELAY_DELAY_MS: 10 * 1000,
  /** Tiempo mínimo restante para intentar el sweeper al final de una corrida. */
  MIN_SWEEP_REMAINING_MS: 45 * 1000,
  /** Reserva para terminar limpiamente después de clasificar. */
  CLASSIFY_RESERVE_MS: 20 * 1000,
  BASE_QUERY:
    '((from:bci.cl (subject:"Aviso de Transferencia" OR subject:"Notificación de uso de tu tarjeta de crédito")) OR (from:tenpo.cl subject:"Compra") OR (from:machbank.cl subject:"compra") OR (from:bancochile.cl (subject:"Cargo en Cuenta" OR subject:"Compra con Tarjeta" OR subject:"Cobro de cheque"))) -subject:dcto -subject:descuento -subject:promoción -subject:Ahorra -subject:Tienes ',
});

/**
 * Obtiene una etiqueta de Gmail; la crea si no existe (p. ej. si nunca se ejecutó `installApp`).
 * @param {string} labelName
 * @returns {GoogleAppsScript.Gmail.GmailLabel}
 */
function _getOrCreateLabel(labelName) {
  return GmailApp.getUserLabelByName(labelName) || GmailApp.createLabel(labelName);
}

/**
 * Función principal que orquesta la extracción de correos.
 * Debe ser llamada por un Trigger temporal (ej. cada 1 hora). Si otra ejecución sigue en curso
 * (p. ej. el trigger horario y el relevo se solapan) esta se omite sin tocar nada.
 */
function processEmails() {
  const startTime = Date.now();
  // Lock de USUARIO, distinto del lock de script que usa Sheets: así no se anida el mismo lock.
  const processLock = LockService.getUserLock();
  if (!processLock.tryLock(0)) {
    logSystemEvent(
      'INFO',
      'Extracción omitida',
      'Otra ejecución de la extracción sigue en curso (bloqueo ocupado).'
    );
    return;
  }
  try {
    _runExtraction(startTime);
  } finally {
    processLock.releaseLock();
  }
}

/**
 * Cuerpo de la extracción (se ejecuta con el lock de proceso tomado).
 * @private
 * @param {number} startTime - Instante de inicio (ms), para el cronómetro de seguridad.
 */
function _runExtraction(startTime) {
  const maxTime = EXTRACTOR_SETTINGS.MAX_EXECUTION_TIME_MS;

  logSystemEvent('INFO', 'Inicio Extracción', 'Buscando nuevos correos bancarios...');

  const isBackfillCompleted = getEnv('INITIAL_BACKFILL_COMPLETED') === 'true';
  const windowQuery = isBackfillCompleted ? 'newer_than:5d' : 'newer_than:365d';
  const labelName = CONFIG.GMAIL.LABEL_PROCESSED;
  const finalQuery = `${windowQuery} ${EXTRACTOR_SETTINGS.BASE_QUERY} -label:${labelName}`;

  // === BUCLE DE PAGINACIÓN CONTINUA ===
  while (true) {
    // 1. CONTROL DE TIEMPO: si queda poco, delega el resto a una ejecución encadenada.
    if (Date.now() - startTime > maxTime) {
      logSystemEvent(
        'INFO',
        'Paginación Activa',
        '⏳ Tiempo máximo alcanzado (3.5 min). Programando relevo en 10 segundos...'
      );
      ScriptApp.newTrigger('continueProcessEmails')
        .timeBased()
        .after(EXTRACTOR_SETTINGS.RELAY_DELAY_MS)
        .create();
      return;
    }

    try {
      // 2. Siguiente lote (pequeño = más rápido)
      const threads = GmailApp.search(finalQuery, 0, EXTRACTOR_SETTINGS.BATCH_SIZE);

      // 3. CONDICIÓN DE TÉRMINO
      if (threads.length === 0) {
        if (!isBackfillCompleted) {
          setEnv('INITIAL_BACKFILL_COMPLETED', 'true');
          logSystemEvent(
            'INFO',
            'Sistema',
            '✅ Carga histórica completada al 100%. Pasando a Modo Producción (5 días).'
          );
        } else {
          logSystemEvent(
            'INFO',
            'Fin Extracción',
            'No hay más transacciones pendientes en este lote.'
          );
        }
        break;
      }

      // 4. EXTRACCIÓN
      /** @type {Transaction[]} */
      const extracted = [];
      /** @type {{thread: GoogleAppsScript.Gmail.GmailThread, message: GoogleAppsScript.Gmail.GmailMessage}[]} */
      const unreadable = [];
      const existingIds = getExistingTransactionIds();
      threads.forEach(thread => {
        thread.getMessages().forEach(message => {
          const msgId = message.getId();
          if (existingIds.has(msgId)) return;
          const data = parseBankEmail(message);
          if (!data) {
            unreadable.push({ thread, message });
            return;
          }
          if (data.Monto !== 0) {
            // Aceptamos positivos y negativos
            data.ID_Unico = msgId;
            extracted.push(data);
          }
        });
      });

      // 5. CLASIFICAR → GUARDAR → (solo entonces) ETIQUETAR
      if (extracted.length > 0) {
        logSystemEvent(
          'INFO',
          'Lote procesado',
          `Se extrajeron ${extracted.length} transacciones. Enviando a IA/BD...`
        );
        const dictionaryEntries = _classifySafely(extracted, startTime);
        // Si guardar falla, lanza: los hilos siguen sin etiqueta y se reintentan en la próxima corrida.
        saveToDatabase(extracted, dictionaryEntries);
        notifyTransferRules(extracted);
      }

      const label = _getOrCreateLabel(labelName);
      threads.forEach(thread => thread.addLabel(label));
      if (unreadable.length > 0) _quarantineUnreadable(unreadable);
    } catch (error) {
      logSystemEvent(
        'ERROR',
        'Error crítico en bucle de extracción',
        /** @type {Error} */ (error).stack || /** @type {Error} */ (error).message
      );
      return;
    }
  }

  _sweepPendingIfTimeAllows(startTime);
}

/**
 * Marca con una etiqueta de cuarentena los correos que el parser no supo interpretar (formato nuevo
 * del banco, remitente no soportado…) y avisa. Así no se pierden en silencio: quedan a la vista en
 * Gmail para revisarlos y, si se quiere reprocesarlos, basta quitarles la etiqueta de "Procesado".
 * @private
 * @param {{thread: GoogleAppsScript.Gmail.GmailThread, message: GoogleAppsScript.Gmail.GmailMessage}[]} unreadable
 */
function _quarantineUnreadable(unreadable) {
  const errorLabelName = CONFIG.GMAIL.LABEL_PARSE_ERROR;
  const errorLabel = _getOrCreateLabel(errorLabelName);
  unreadable.forEach(item => item.thread.addLabel(errorLabel));

  const sample = unreadable[0].message;
  logSystemEvent(
    'ERROR',
    'Correo bancario no interpretado',
    `${unreadable.length} correo(s) no se pudieron leer y quedaron con la etiqueta "${errorLabelName}". ` +
      `Ejemplo: "${sample.getSubject()}" de ${sample.getFrom()}. Probablemente el banco cambió el formato del correo.`
  );
}

/**
 * Clasifica el lote sin permitir que un fallo de la IA impida guardar: si falla, las transacciones
 * quedan como pendientes y el sweeper las reintenta.
 * @private
 * @param {Transaction[]} transactions
 * @param {number} startTime
 * @returns {DictionaryEntry[]} Reglas nuevas para el diccionario (vacío si la IA no respondió).
 */
function _classifySafely(transactions, startTime) {
  try {
    const remaining =
      EXTRACTOR_SETTINGS.MAX_EXECUTION_TIME_MS -
      (Date.now() - startTime) -
      EXTRACTOR_SETTINGS.CLASSIFY_RESERVE_MS;
    const result = classifyTransactions(transactions, {
      deadlineMs: Math.max(Math.min(remaining, GEMINI_SETTINGS.DEFAULT_DEADLINE_MS), 5000),
    });
    return result.newDictionaryEntries;
  } catch (error) {
    logSystemEvent(
      'ERROR',
      'Fallo inesperado al clasificar',
      /** @type {Error} */ (error).stack || ''
    );
    return [];
  }
}

/**
 * Al terminar la extracción, reintenta las transacciones que quedaron sin clasificar (por una caída
 * anterior de la IA) si queda tiempo. Si los modelos siguen en enfriamiento es casi inmediato.
 * @private
 * @param {number} startTime
 */
function _sweepPendingIfTimeAllows(startTime) {
  const remaining = EXTRACTOR_SETTINGS.MAX_EXECUTION_TIME_MS - (Date.now() - startTime);
  if (remaining < EXTRACTOR_SETTINGS.MIN_SWEEP_REMAINING_MS) return;
  try {
    if (countPendingTransactions() > 0) {
      retryUnclassifiedTransactions({ quiet: true, deadlineMs: remaining - 15000 });
    }
  } catch (error) {
    logSystemEvent('WARN', 'Sweeper post-extracción', /** @type {Error} */ (error).message);
  }
}

/**
 * Función puente para la Ejecución Encadenada.
 * Se invoca automáticamente si la extracción se queda sin tiempo.
 */
function continueProcessEmails() {
  // 1. Limpiamos el gatillo temporal que nos invocó para no dejar basura
  ScriptApp.getProjectTriggers().forEach(trigger => {
    if (trigger.getHandlerFunction() === 'continueProcessEmails') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  logSystemEvent('INFO', 'Sistema', '🔄 Reanudando ejecución encadenada...');

  // 2. Volvemos a llamar al motor principal
  processEmails();
}
