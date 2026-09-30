/**
 * Archivo: logger.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Sistema centralizado de Logs para auditoría y monitoreo de errores.
 * Escribe en la hoja `Logs` y avisa por Telegram de los errores críticos, con el detalle del
 * error, el HTML escapado y un límite de una alerta por mensaje cada 30 minutos.
 */

const LOGGER_SETTINGS = Object.freeze({
  ALERT_THROTTLE_SECONDS: 1800,
  ALERT_DETAIL_MAX_LENGTH: 700,
  ALERT_KEY_PREFIX: 'ALERT_',
  MIN_SECRET_LENGTH: 8,
  SECRET_PROPERTIES: Object.freeze([
    'GEMINI_API_KEY',
    'TELEGRAM_BOT_TOKEN',
    'NOTION_API_TOKEN',
    'TELEGRAM_SECRET_TOKEN',
  ]),
});

/**
 * Oculta credenciales conocidas y patrones típicos (`key=...`, tokens de bot en URLs) de un texto.
 * @param {any} text
 * @returns {string}
 */
function _redactSecrets(text) {
  let out = String(text === null || text === undefined ? '' : text);
  LOGGER_SETTINGS.SECRET_PROPERTIES.forEach(name => {
    const secret = getEnv(name);
    if (secret && secret.length >= LOGGER_SETTINGS.MIN_SECRET_LENGTH) {
      out = out.split(secret).join('***');
    }
  });
  return out.replace(/([?&]key=)[^&\s"')]+/gi, '$1***').replace(/AIza[0-9A-Za-z_-]{20,}/g, '***');
}

/**
 * Hash sencillo (djb2) para agrupar alertas idénticas.
 * @param {string} text
 * @returns {string}
 */
function _hashText(text) {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Indica si corresponde enviar la alerta (una por mensaje cada 30 min) y reserva la ventana.
 * @param {string} message
 * @returns {boolean}
 */
function _reserveAlertSlot(message) {
  const cache = CacheService.getScriptCache();
  const key = LOGGER_SETTINGS.ALERT_KEY_PREFIX + _hashText(message.slice(0, 200));
  if (cache.get(key)) return false;
  cache.put(key, '1', LOGGER_SETTINGS.ALERT_THROTTLE_SECONDS);
  return true;
}

/**
 * Arma el texto HTML de la alerta de Telegram: mensaje + detalle truncado, todo escapado.
 * @param {string} message
 * @param {string} detail
 * @returns {string}
 */
function _buildAlertText(message, detail) {
  let text = `🚨 <b>Error Crítico en SaaS:</b>\n${escapeTelegramHtml(message)}`;
  if (detail) {
    const max = LOGGER_SETTINGS.ALERT_DETAIL_MAX_LENGTH;
    const shown = detail.length > max ? `${detail.slice(0, max)}…` : detail;
    text += `\n<pre>${escapeTelegramHtml(shown)}</pre>`;
  }
  return text;
}

/**
 * Registra un evento en la hoja de Logs de forma segura.
 * @param {string} level - Nivel del log ('INFO', 'WARN', 'ERROR').
 * @param {string} message - Mensaje descriptivo.
 * @param {string} [stackTrace=""] - Detalle o traza del error (opcional).
 */
function logSystemEvent(level, message, stackTrace = '') {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.SHEETS.LOGS);
    if (!sheet) return;

    const safeMessage = _redactSecrets(message);
    const safeDetail = _redactSecrets(stackTrace);

    // Formato: ['Timestamp', 'Nivel', 'Mensaje', 'Stack Trace']
    const timestamp = Utilities.formatDate(
      new Date(),
      Session.getScriptTimeZone(),
      'yyyy-MM-dd HH:mm:ss'
    );
    sheet.appendRow([timestamp, level, safeMessage, safeDetail]);

    if (level === 'ERROR' && _reserveAlertSlot(safeMessage)) {
      sendTelegramAlert(_buildAlertText(safeMessage, safeDetail));
    }
  } catch (e) {
    // Si el logger falla, caemos al log nativo de Google como último recurso
    console.error('Fallo catastrófico en el Logger: ' + getErrorMessage(e));
  }
}
