/**
 * Archivo: telegram.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Bot de Telegram: webhook (`doPost`), menú interactivo, registro manual de gastos,
 * borrado en lote (`/borrar`), notificaciones y cliente de la Bot API.
 * Seguridad: el webhook exige el token secreto en la URL y TODA interacción (comandos, botones y
 * mensajes) se acepta únicamente del chat autorizado (`TELEGRAM_CHAT_ID`); el resto se descarta.
 */

const TELEGRAM_SETTINGS = Object.freeze({
  DEDUP_TTL_SECONDS: 21600,
  MANUAL_CLASSIFY_DEADLINE_MS: 25000,
});

/**
 * Punto de entrada del webhook de Telegram. Responde siempre con un ACK vacío (HTTP 200 limpio)
 * para que Telegram no reintente ni intente parsear la respuesta.
 * @param {GoogleAppsScript.Events.DoPost} e
 * @returns {GoogleAppsScript.HTML.HtmlOutput}
 */
function doPost(e) {
  const ACK = HtmlService.createHtmlOutput();

  try {
    // Sin secreto configurado o con secreto distinto: se rechaza (fail-closed).
    const secret = getEnv('TELEGRAM_SECRET_TOKEN');
    const tokenInUrl = e.parameter ? e.parameter.token : null;
    if (!secret || tokenInUrl !== secret) return ACK;

    /** @type {TelegramUpdate} */
    const update = JSON.parse(e.postData.contents);
    const callback = update.callback_query;
    const message = update.message || update.edited_message;

    // --- AUTORIZACIÓN: solo el chat del administrador puede usar el bot ---
    const chat = callback ? callback.message && callback.message.chat : message && message.chat;
    if (!chat) return ACK;
    const chatId = String(chat.id);
    if (chatId !== getEnv('TELEGRAM_CHAT_ID')) {
      logSystemEvent('WARN', 'Intento no autorizado', `Chat ID: ${chatId}`);
      return ACK;
    }

    // --- BOTONES (CALLBACK QUERIES) ---
    if (callback) {
      const cache = CacheService.getScriptCache();
      const callbackKey = 'CB_' + callback.id; // ID único del clic
      if (cache.get(callbackKey)) return ACK; // Evita el doble clic rápido
      cache.put(callbackKey, 'procesado', TELEGRAM_SETTINGS.DEDUP_TTL_SECONDS);
      handleCallbackQuery(callback);
      return ACK;
    }

    if (!message) return ACK;

    // --- ESCUDO ANTI-RETRANSMISIÓN ---
    const msgId = 'TG_' + message.message_id;
    const cache = CacheService.getScriptCache();
    if (cache.get(msgId)) {
      logSystemEvent('INFO', 'Retransmisión bloqueada', msgId);
      return ACK;
    }
    cache.put(msgId, 'procesado', TELEGRAM_SETTINGS.DEDUP_TTL_SECONDS);

    const text = message.text ? message.text.trim() : '';
    const textLower = text.toLowerCase();

    // Menú y bienvenida
    if (textLower === '/start' || textLower === 'hola') {
      sendTelegramMessage(chatId, '🤖 ¡Hola! Asistente bancario listo y en línea.');
      sendInteractiveMenu(chatId);
      return ACK;
    }

    // Borrado múltiple: /borrar ID1 ID2, ID3
    if (textLower.startsWith('/borrar ') || textLower.startsWith('/delete ')) {
      const rawIds = text.substring(text.indexOf(' ')).trim();
      const idsToDelete = rawIds.split(/[\s,]+/).filter(id => id.length > 0);
      if (idsToDelete.length > 0) {
        sendTelegramMessage(chatId, deleteTransactionsByIds(idsToDelete));
      } else {
        sendTelegramMessage(
          chatId,
          '⚠️ Formato incorrecto.\nUsa: <code>/borrar ID_1 ID_2 ID_3</code>\no separalos por comas.'
        );
      }
      return ACK;
    }

    // Registro manual de gastos
    _processTelegramMessage(message, chatId, msgId);
    return ACK;
  } catch (error) {
    const err = /** @type {Error} */ (error);
    logSystemEvent('ERROR', 'Caída en doPost', err.stack || err.message);
    try {
      sendTelegramMessage(
        getEnv('TELEGRAM_CHAT_ID'),
        '🚨 <b>Error:</b> ' + escapeTelegramHtml(err.message)
      );
    } catch (_) {
      // Si Telegram tampoco responde no hay nada más que hacer: el error ya quedó en Logs.
    }
    return ACK;
  }
}

/**
 * Registra un gasto manual escrito como "<monto> <comercio>" y lo clasifica con el mismo
 * clasificador que los correos (si la IA falla, queda pendiente y el sweeper lo reintenta).
 * @private
 * @param {TelegramMessage} message
 * @param {string} chatId - Chat ya autorizado.
 * @param {string} msgId - ID único (`TG_<message_id>`).
 */
function _processTelegramMessage(message, chatId, msgId) {
  const text = message.text ? message.text.trim() : '';

  try {
    if (getExistingTransactionIds().has(msgId)) {
      logSystemEvent('INFO', 'Duplicado en DB profunda', msgId);
      return;
    }
  } catch (_) {
    // Continuamos si la DB falla momentáneamente: saveToDatabase vuelve a verificar bajo lock.
  }

  const match = text.match(/^\s*\$?\s*([\d.]+)\s+(.+)$/);
  if (!match) {
    sendTelegramMessage(
      chatId,
      '⚠️ Formato incorrecto. Usa: Monto Comercio (Ej: 15000 Panaderia o $15.000 Uber)'
    );
    return;
  }

  const monto = parseInt(match[1].replace(/\./g, ''), 10);
  const comercioOriginal = match[2].trim();
  const now = new Date();

  /** @type {Transaction} */
  const transaction = {
    ID_Unico: msgId,
    Fecha: Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
    Hora: Utilities.formatDate(now, Session.getScriptTimeZone(), 'HH:mm'),
    Comercio_Original: comercioOriginal,
    Comercio_Limpio: comercioOriginal,
    Categoria: CONFIG.PENDING_CATEGORY,
    Subcategoria: '',
    Monto: monto,
    Cuotas: 1,
    Tipo: 'Efectivo/Manual',
    Origen: 'Telegram',
  };

  try {
    /** @type {DictionaryEntry[]} */
    let dictionaryEntries = [];
    try {
      dictionaryEntries = classifyTransactions([transaction], {
        deadlineMs: TELEGRAM_SETTINGS.MANUAL_CLASSIFY_DEADLINE_MS,
      }).newDictionaryEntries;
    } catch (classifyError) {
      logSystemEvent(
        'WARN',
        'Clasificación del gasto manual omitida',
        /** @type {Error} */ (classifyError).message
      );
    }
    saveToDatabase([transaction], dictionaryEntries);
    sendTelegramMessage(
      chatId,
      `✅ Gasto registrado:\n💰 $${monto}\n🛒 ${escapeTelegramHtml(comercioOriginal)}`
    );
  } catch (error) {
    const err = /** @type {Error} */ (error);
    logSystemEvent('ERROR', 'Fallo al guardar en BD', err.stack || err.message);
    sendTelegramMessage(chatId, '🚨 Error interno al guardar: ' + escapeTelegramHtml(err.message));
  }
}

/**
 * Registra el webhook de Telegram apuntando a la Web App con el token secreto en la URL.
 */
function setupWebhook() {
  const botToken = getEnv('TELEGRAM_BOT_TOKEN');
  const webAppUrl = getEnv('WEB_APP_URL');
  const secretToken = getEnv('TELEGRAM_SECRET_TOKEN');

  const secureUrl = webAppUrl + '?token=' + secretToken;
  const telegramUrl = `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(secureUrl)}&drop_pending_updates=true`;

  UrlFetchApp.fetch(telegramUrl);
}

/**
 * Envía un mensaje de texto (HTML) al usuario a través de la API de Telegram.
 * @param {string|number|null} chatId - ID del chat de destino (si es null no se envía nada).
 * @param {string} text - Mensaje a enviar (HTML de Telegram; escapar con `escapeTelegramHtml` el texto libre).
 * @param {object} [keyboard] - Opcional. Estructura del Inline Keyboard.
 */
function sendTelegramMessage(chatId, text, keyboard) {
  const botToken = getEnv('TELEGRAM_BOT_TOKEN');
  if (!botToken || !chatId) return;

  /** @type {Record<string, any>} */
  const payload = {
    chat_id: chatId.toString(),
    text: text,
    parse_mode: 'HTML',
  };
  if (keyboard) payload.reply_markup = keyboard;

  /** @type {GoogleAppsScript.URL_Fetch.URLFetchRequestOptions} */
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  UrlFetchApp.fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, options);
}

/**
 * Escapa texto para mensajes con `parse_mode: 'HTML'` de Telegram (solo `&`, `<` y `>`).
 * Sin esto, un `<` en un mensaje de error hace que Telegram rechace el mensaje completo.
 * @param {any} text
 * @returns {string}
 */
function escapeTelegramHtml(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Envía una alerta de sistema al administrador vía Telegram.
 * Utilizada por el logger y el mantenimiento para notificar errores críticos o resúmenes.
 * @param {string} text - Alerta (HTML de Telegram ya escapado).
 */
function sendTelegramAlert(text) {
  const adminChatId = getEnv('TELEGRAM_CHAT_ID');
  if (!adminChatId) {
    console.warn('TELEGRAM_CHAT_ID no está configurado. No se pudo enviar la alerta.');
    return;
  }
  sendTelegramMessage(adminChatId, text);
}

/**
 * Alerta educativa por transferencias: agrupa las transferencias de un lote y avisa al usuario.
 * @param {Pick<Transaction, 'Tipo'|'Comercio_Limpio'|'Monto'>[]} transacciones
 */
function notifyTransferRules(transacciones) {
  const chatId = getEnv('TELEGRAM_CHAT_ID');
  if (!chatId) return; // Sin chat configurado no hay a quién avisar

  const transferencias = transacciones.filter(t => t.Tipo === 'Transferencia');
  if (transferencias.length === 0) return;

  let mensaje = `<ins>💸 <b>¡Atención con tus Transferencias!</b></ins>\n`;
  mensaje += `El motor automático acaba de registrar ${transferencias.length} transferencia(s):\n\n`;
  transferencias.forEach(t => {
    mensaje += `🔸 <b>${escapeTelegramHtml(t.Comercio_Limpio)}</b>: $${formatClp(t.Monto)}\n`;
  });
  mensaje += `\n<ins>💡 Recordatorio del Sistema:</ins>\n`;
  mensaje += `Si transferiste a otro banco para hacer una compra por ese medio, recuerda categorizar este movimiento o eliminarlo en Notion/Sheets para no alterar tu presupuesto real.\n\n`;
  mensaje += `<i>(Si fue un pago o deuda real, puedes ignorar este mensaje).</i>`;

  try {
    sendTelegramMessage(chatId, mensaje);
    logSystemEvent('INFO', 'Notificación TG', `Alerta de transferencia enviada por Telegram.`);
  } catch (error) {
    logSystemEvent(
      'WARN',
      'Fallo Notificación',
      'No se pudo enviar la alerta a Telegram: ' + /** @type {Error} */ (error).message
    );
  }
}

/**
 * Dibuja el menú principal interactivo con botones (Inline Keyboard).
 * Escalable: se pueden agregar más filas al `inline_keyboard`.
 * @param {string|number} chatId
 */
function sendInteractiveMenu(chatId) {
  const text =
    '🤖 <b>Menú Principal de tu asistente bancario</b>\n\n¿Qué acción deseas realizar? Selecciona una opción abajo:';

  const keyboard = {
    inline_keyboard: [
      [{ text: '💵 Registrar gasto en efectivo', callback_data: 'btn_cash' }],
      [{ text: '🗑️ Borrar registro de transacción', callback_data: 'btn_delete' }],
    ],
  };

  sendTelegramMessage(chatId, text, keyboard);
}

/**
 * Enrutador de callbacks: responde cuando el usuario pulsa un botón del menú.
 * @param {TelegramCallbackQuery} callbackQuery
 */
function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (data === 'btn_cash') {
    const msg =
      '📝 <ins><b>Registrar gasto manual / Efectivo</b></ins>\n\nPara ingresar un gasto, simplemente escríbeme un mensaje con este formato:\n\n<code>&lt;Monto&gt; &lt;Comercio&gt;</code>\n\n💡<ins>Ejemplos:</ins>\n<code>15000 Entrada a la disco</code>\n<code>900 Colectivo de mi casa al metro</code>\n\nEl sistema lo detectará automáticamente y lo clasificará.';
    sendTelegramMessage(chatId, msg);
  } else if (data === 'btn_delete') {
    const msg =
      '🗑️<b>Borrar registro de transacción (Sheets & Notion)</b>\n\nPara eliminar una transacción de tu base de datos, envíame el siguiente comando seguido del ID de la transacción <i>(Puedes encontrar el ID_Unico en la primera columna de tu base de datos).</i>:\n\n<code>/borrar &lt;ID_Unico&gt;</code>\n\n<b>Ejemplo:</b>\n<code>/borrar GM_123456789</code>\n\n';
    sendTelegramMessage(chatId, msg);
  }

  // Telegram exige responder al callback_query para quitar el icono de "Cargando" del botón
  const token = getEnv('TELEGRAM_BOT_TOKEN');
  UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'post',
    payload: { callback_query_id: callbackQuery.id },
    muteHttpExceptions: true,
  });
}
