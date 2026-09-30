/**
 * Archivo: diagnostics.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Diagnóstico del sistema (función operativa, no una prueba): revisa la configuración
 * y hace una llamada real y mínima a Gemini. Sirve para comprobar en vivo, tras un despliegue, que
 * todo está en orden. Nunca muestra valores de credenciales, solo si existen.
 */

/**
 * Propiedades de script que el sistema necesita (`required`) o admite (`optional`).
 */
const DIAGNOSTIC_PROPERTIES = Object.freeze({
  required: Object.freeze([
    'GEMINI_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'TELEGRAM_CHAT_ID',
    'TELEGRAM_SECRET_TOKEN',
    'WEB_APP_URL',
  ]),
  optional: Object.freeze(['NOTION_API_TOKEN', 'NOTION_DATABASE_ID']),
});

/**
 * Comprueba si el LockService concede un segundo lock de script a la misma ejecución (reentrancia).
 * @private
 * @returns {boolean}
 */
function _probeLockReentrancy() {
  const first = LockService.getScriptLock();
  const second = LockService.getScriptLock();
  let reentrant = false;
  if (first.tryLock(1000)) {
    try {
      reentrant = second.tryLock(500);
    } finally {
      second.releaseLock();
      first.releaseLock();
    }
  }
  return reentrant;
}

/**
 * Ejecuta el diagnóstico y devuelve un informe de texto.
 * @returns {string}
 */
function runDiagnostics() {
  /** @type {string[]} */
  const lines = [];
  /**
   * Agrega una línea de resultado con ✅ o ❌.
   * @param {boolean} ok
   * @param {string} text
   */
  const check = (ok, text) => lines.push(`${ok ? '✅' : '❌'} ${text}`);

  // 1. Propiedades de script (solo presencia)
  DIAGNOSTIC_PROPERTIES.required.forEach(name => check(Boolean(getEnv(name)), `Propiedad ${name}`));
  DIAGNOSTIC_PROPERTIES.optional.forEach(name =>
    lines.push(`${getEnv(name) ? '✅' : '➖'} Propiedad ${name} (opcional)`)
  );
  lines.push(`ℹ️ Notion: ${getEnv('NOTION_ENABLED') === 'true' ? 'activado' : 'desactivado'}`);
  lines.push(
    `ℹ️ Pro en la cascada: ${getEnv('GEMINI_ALLOW_PRO') === 'true' ? 'permitido' : 'no (por defecto)'}`
  );

  // 2. Hojas y encabezados
  try {
    const sheet = getSheetOrThrow(CONFIG.SHEETS.TRANSACTIONS);
    getTransactionColumns(sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]);
    check(true, `Hoja ${CONFIG.SHEETS.TRANSACTIONS} y sus encabezados`);
    getSheetOrThrow(CONFIG.SHEETS.DICTIONARY);
    getSheetOrThrow(CONFIG.SHEETS.LOGS);
    check(true, `Hojas ${CONFIG.SHEETS.DICTIONARY} y ${CONFIG.SHEETS.LOGS}`);
    lines.push(`ℹ️ Transacciones pendientes de clasificar: ${countPendingTransactions()}`);
  } catch (error) {
    check(false, getErrorMessage(error));
  }

  // 3. Etiquetas de Gmail y triggers
  check(
    Boolean(GmailApp.getUserLabelByName(CONFIG.GMAIL.LABEL_PROCESSED)),
    `Etiqueta de Gmail ${CONFIG.GMAIL.LABEL_PROCESSED}`
  );
  const handlers = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
  check(handlers.includes('processEmails'), 'Trigger horario de processEmails');
  check(handlers.includes('cleanAndSortData'), 'Trigger nocturno de cleanAndSortData');

  // 4. Gemini: cascada y llamada real mínima
  if (getEnv('GEMINI_API_KEY')) {
    const cascade = getGeminiModelCascade({ ignoreCooldown: true });
    lines.push(`ℹ️ Modelos (${cascade.source}): ${cascade.models.join(', ') || 'ninguno'}`);
    const skipped = getGeminiModelCascade().skipped;
    if (skipped.length > 0) {
      lines.push(`⏸️ En enfriamiento: ${skipped.map(s => s.model).join(', ')}`);
    }
    /** @type {ClassifiableItem[]} */
    const sample = [{ Comercio_Original: 'DIAGNOSTICO STARBUCKS', Tipo: 'Débito' }];
    const result = classifyTransactions(sample, { deadlineMs: 45000, ignoreCooldown: true });
    if (result.resolvedByAI > 0) {
      check(true, `Gemini respondió con ${result.model} (${sample[0].Categoria})`);
    } else {
      check(
        false,
        `Gemini no respondió: ${result.failure ? result.failure.message : 'sin detalle'} | ${summarizeGeminiAttempts(result.attempts)}`
      );
    }
  }

  // 5. Reentrancia del lock (informativo: el sistema funciona en ambos casos)
  lines.push(`ℹ️ LockService reentrante: ${_probeLockReentrancy() ? 'sí' : 'no'}`);

  return lines.join('\n');
}

/**
 * UI Handler: muestra el diagnóstico del sistema.
 */
function uiRunDiagnostics() {
  const ui = SpreadsheetApp.getUi();
  ui.alert('🩺 Diagnóstico del sistema', runDiagnostics(), ui.ButtonSet.OK);
}
