/**
 * Archivo: telegram.gs
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.gs para conocer los terminos vinculantes.
 * * VERSIÓN ACTUAL: Estable + Documentación Oficial Telegram Bot API
 */

function doPost(e) {
  // 🌟 LA BALA DE PLATA: Un HTML vacío genera un HTTP 200 limpio que Telegram no intenta parsear
  const ACK = HtmlService.createHtmlOutput();

  try {
    logSystemEvent('INFO', '[FLAG 1] Webhook Invocado', 'Iniciando doPost'); 

    const tokenEnUrl = e.parameter ? e.parameter.token : null;
    if (tokenEnUrl !== getEnv('TELEGRAM_SECRET_TOKEN')) {
      // Incluso si falla la autenticación, devolvemos ACK para no crear bucles
      return ACK; 
    }

    const data = JSON.parse(e.postData.contents);
    
    // --- ESCUDO Y MANEJO DE BOTONES (CALLBACK QUERIES) ---
    if (data.callback_query) {
      const cbQuery = data.callback_query;
      const cbId = 'CB_' + cbQuery.id; // ID único del clic
      
      const cache = CacheService.getScriptCache();
      if (cache.get(cbId)) return ACK; // Evita doble-clic rápido
      cache.put(cbId, 'procesado', 21600);
      
      handleCallbackQuery(cbQuery);
      return ACK;
    }
    const message = data.message || data.edited_message;
    
    if (!message) return ACK;

    const msgId = 'TG_' + message.message_id;

    // --- 🛡️ ESCUDO GLOBAL ---
    const cache = CacheService.getScriptCache();
    if (cache.get(msgId)) {
      logSystemEvent('INFO', '[FLAG ESCUDO GLOBAL] Retransmisión bloqueada', msgId);
      return ACK; // Retornamos el HTML vacío para calmar a Telegram
    }
    cache.put(msgId, 'procesado', 21600); // Tiempo de cache

    const text = message.text ? message.text.trim() : '';
    const chatId = message.chat.id.toString();
    const textLower = text.toLowerCase();

    // 2. MANEJO DE MENÚS Y BIENVENIDA
    if (textLower === '/start' || textLower === 'hola') {
      logSystemEvent('INFO', '[FLAG] Comando de Menú', 'Enviando interfaz');
      sendTelegramMessage(chatId, '🤖 ¡Hola! Asistente bancario listo y en línea.');
      sendInteractiveMenu(chatId); // Desplegamos los botones
      return ACK;
    }
    
    // 3. MANEJO DE COMANDO DE BORRADO MULTIPLE
    if (textLower.startsWith('/borrar ') || textLower.startsWith('/delete ')) {
      // Extraemos todo lo que viene después de la palabra /borrar
      const rawIds = text.substring(text.indexOf(' ')).trim();
      
      // Separamos los IDs usando espacios o comas mediante Regex
      const idsToDelete = rawIds.split(/[\s,]+/).filter(id => id.length > 0);
      
      if (idsToDelete.length > 0) {
        const resultMessage = deleteTransactionsByIds(idsToDelete); // Llamamos al motor batch
        sendTelegramMessage(chatId, resultMessage);
      } else {
        sendTelegramMessage(chatId, "⚠️ Formato incorrecto.\nUsa: <code>/borrar ID_1 ID_2 ID_3</code>\no separalos por comas.");
      }
      return ACK;
    }

    // 4. PROCESAMIENTO DE GASTOS (Lógica que ya tienes)
    _processTelegramMessage(message, chatId, msgId);

    // 5. ACUSE DE RECIBO FINAL
    return ACK;

  } catch (error) {
    logSystemEvent('ERROR', '[FLAG ERROR] Caída en doPost', error.stack || error.message);
    try { sendTelegramMessage(getEnv('TELEGRAM_CHAT_ID'), '🚨 <b>Error:</b> ' + error.message); } catch (err) {}
    return ACK;
  }
}

function _processTelegramMessage(message, chatId, msgId) {
  const text = message.text ? message.text.trim() : "";

  const adminChatId = getEnv('TELEGRAM_CHAT_ID');
  if (chatId !== adminChatId) {
    logSystemEvent('WARN', 'Intento no autorizado', `Chat ID: ${chatId}`);
    return;
  }

  try {
    const existingIds = getExistingTransactionIds(); 
    if (existingIds && existingIds.has(msgId)) {
      logSystemEvent('INFO', 'Duplicado en DB profunda', msgId);
      return; 
    }
  } catch (e) {
    // Continuamos si la DB falla momentáneamente
  }

  const match = text.match(/^\s*\$?\s*([\d\.]+)\s+(.+)$/);
  
  if (!match) {
    sendTelegramMessage(chatId, "⚠️ Formato incorrecto. Usa: Monto Comercio (Ej: 15000 Panaderia o $15.000 Uber)");
    return;
  }

  const montoRaw = match[1].replace(/\./g, '');
  const monto = parseInt(montoRaw, 10);
  const comercioOriginal = match[2].trim();

  const now = new Date();
  const fecha = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd");
  const hora = Utilities.formatDate(now, Session.getScriptTimeZone(), "HH:mm");

  const transaction = {
    ID_Unico: msgId,
    Fecha: fecha,
    Hora: hora,
    Comercio_Original: comercioOriginal,
    Comercio_Limpio: comercioOriginal,
    Categoria: "Ingreso Manual", 
    Subcategoria: "",
    Monto: monto,
    Cuotas: 1,
    Tipo: "Efectivo/Manual",
    Origen: "Telegram"
  };

  try {
    saveToDatabase([transaction], []);
    sendTelegramMessage(chatId, `✅ Gasto registrado:\n💰 $${monto}\n🛒 ${comercioOriginal}`);
  } catch (error) {
    logSystemEvent('ERROR', 'Fallo al guardar en BD', error.stack || error.message);
    sendTelegramMessage(chatId, '🚨 Error interno al guardar: ' + error.message);
  }
}

function setupWebhook() {
  const botToken = getEnv('TELEGRAM_BOT_TOKEN');
  const webAppUrl = getEnv('WEB_APP_URL');
  const secretToken = getEnv('TELEGRAM_SECRET_TOKEN');

  const secureUrl = webAppUrl + '?token=' + secretToken;
  const telegramUrl = `https://api.telegram.org/bot${botToken}/setWebhook?url=${encodeURIComponent(secureUrl)}&drop_pending_updates=true`;

  UrlFetchApp.fetch(telegramUrl);
}
/**
 * Envía un mensaje de texto al usuario a través de la API de Telegram.
 * @param {string} chatId - ID del chat de destino.
 * @param {string} text - Mensaje a enviar.
 * @param {Object} [keyboard=null] - Opcional. Objeto JSON con la estructura del Inline Keyboard.
 */
function sendTelegramMessage(chatId, text, keyboard = null) {
  const botToken = getEnv('TELEGRAM_BOT_TOKEN');
  if (!botToken || !chatId) return;

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const payload = {
    chat_id: chatId.toString(),
    text: text,
    parse_mode: 'HTML'
  };
  
  // Si le pasamos un teclado, lo inyectamos en el payload
  if (keyboard) {
    payload.reply_markup = keyboard;
  }

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  UrlFetchApp.fetch(url, options);
}
/**
 * Envía una alerta de sistema al administrador vía Telegram.
 * Utilizada principalmente por logger.gs para notificar errores críticos o resúmenes.
 * @param {string} text - El mensaje de alerta a enviar.
 */
function sendTelegramAlert(text) {
  const adminChatId = getEnv('TELEGRAM_CHAT_ID');
  if (!adminChatId) {
    console.warn("TELEGRAM_CHAT_ID no está configurado. No se pudo enviar la alerta.");
    return;
  }
  // Reutiliza la función base que ya estabilizamos y documentamos
  sendTelegramMessage(adminChatId, text);
}

/**
 * Lógica de Negocio Proactiva: Alertas de Transferencia.
 * Analiza un lote de transacciones procesadas. Si hay transferencias, 
 * envía una alerta educativa agrupada por Telegram al usuario.
 * @param {Array<Object>} transacciones - Arreglo de DTOs de transacciones.
 */
function notifyTransferRules(transacciones) {
  const chatId = getEnv('TELEGRAM_CHAT_ID');
  if (!chatId) return; // Si no hay chat ID, abortamos silenciosamente

  // Filtramos solo las que el Parser o la IA marcaron como "Transferencia"
  const transferencias = transacciones.filter(t => t.Tipo === 'Transferencia');
  
  if (transferencias.length > 0) {
    // Inicializamos el formateador de moneda estilo chileno (Ej: 1.500.000)
    const formatter = new Intl.NumberFormat('es-CL');
    let mensaje = `<ins>💸 <b>¡Atención con tus Transferencias!</b></ins>\n`;
    mensaje += `El motor automático acaba de registrar ${transferencias.length} transferencia(s):\n\n`;
    
    // Listamos las transferencias del lote
    transferencias.forEach(t => {
      const montoFormateado = formatter.format(t.Monto);
      mensaje += `🔸 <b>${t.Comercio_Limpio}</b>: $${montoFormateado}\n`;
    });

    mensaje += `\n<ins>💡 Recordatorio del Sistema:</ins>\n`;
    mensaje += `Si transferiste a otro banco para hacer una compra por ese medio, recuerda categorizar este movimiento o eliminarlo en Notion/Sheets para no alterar tu presupuesto real.\n\n`;
    mensaje += `<i>(Si fue un pago o deuda real, puedes ignorar este mensaje).</i>`;

    try {
      sendTelegramMessage(chatId, mensaje);
      logSystemEvent('INFO', 'Notificación TG', `Alerta de transferencia enviada por Telegram.`);
    } catch (error) {
      logSystemEvent('WARN', 'Fallo Notificación', 'No se pudo enviar la alerta a Telegram: ' + error.message);
    }
  }
}

/**
 * Dibuja el menú principal interactivo con botones (Inline Keyboard).
 * Escalable: Puedes agregar más arreglos al 'inline_keyboard' para nuevas filas de botones.
 */
function sendInteractiveMenu(chatId) {
  const text = "🤖 <b>Menú Principal de tu asistente bancario</b>\n\n¿Qué acción deseas realizar? Selecciona una opción abajo:";
  
  const keyboard = {
    inline_keyboard: [
      [{ text: "💵 Registrar gasto en efectivo", callback_data: "btn_cash" }],
      [{ text: "🗑️ Borrar registro de transacción", callback_data: "btn_delete" }]
    ]
  };
  
  sendTelegramMessage(chatId, text, keyboard);
}

/**
 * Enrutador de Callbacks: Responde cuando el usuario hace clic en un botón.
 */
function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;

  if (data === "btn_cash") {
    const msg = "📝 <ins><b>Registrar gasto manual / Efectivo</b></ins>\n\nPara ingresar un gasto, simplemente escríbeme un mensaje con este formato:\n\n<code>&lt;Monto&gt; &lt;Comercio&gt;</code>\n\n💡<ins>Ejemplos:</ins>\n<code>15000 Entrada a la disco</code>\n<code>900 Colectivo de mi casa al metro</code>\n\nEl sistema lo detectará automáticamente y lo clasificará.";
    sendTelegramMessage(chatId, msg);
  }
  else if (data === "btn_delete") {
    const msg = "🗑️<b>Borrar registro de transacción (Sheets & Notion)</b>\n\nPara eliminar una transacción de tu base de datos, envíame el siguiente comando seguido del ID de la transacción <i>(Puedes encontrar el ID_Unico en la última columna de tu base de datos).</i>:\n\n<code>/borrar &lt;ID_Unico&gt;</code>\n\n<b>Ejemplo:</b>\n<code>/borrar GM_123456789</code>\n\n";
    sendTelegramMessage(chatId, msg);
  }

  // Telegram exige responder al callback_query para quitar el icono de "Cargando" del botón
  const token = getEnv('TELEGRAM_BOT_TOKEN');
  UrlFetchApp.fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'post',
    payload: { callback_query_id: callbackQuery.id },
    muteHttpExceptions: true
  });
}