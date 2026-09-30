/**
 * Archivo: ui.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Interfaz de Usuario (UI) embebida en Google Sheets.
 * Módulo central de interacción humana. Contiene los menús desplegables y
 * los cuadros de diálogo (Wizards) para facilitar la configuración del SaaS
 * sin necesidad de modificar el código fuente.
 * (El resto de las funciones invocadas están en sus módulos respectivos).
 */

/**
 * Hook nativo de Google Apps Script.
 * Se ejecuta automáticamente cada vez que el usuario abre o recarga el Google Sheet.
 * Construye el menú principal '🤖 Asistente bancario' en la barra superior.
 */
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🤖 Asistente bancario')
    .addItem('1️⃣ Configurar Credenciales', 'uiConfigWizard')
    .addItem('2️⃣ Conectar Telegram', 'uiSetupWebhook')
    .addItem('3️⃣ Activar Automatización (Cada 1 hora)', 'uiSetupTriggers')
    .addItem('🧠 Activar análisis Mensajes de Transferencias (IA)', 'uiToggleTransferIA')
    .addSeparator()
    .addSubMenu(
      ui
        .createMenu('📓 Integración Notion')
        .addItem('Configurar Token y DB', 'uiConfigNotion')
        .addItem('Activar/Desactivar Sincronización', 'uiToggleNotion')
    )
    .addSeparator()
    .addItem('🧹 Ordenar Base de Datos', 'uiRunMaintenance')
    .addItem('🔄 Re-procesar huérfanos (IA)', 'uiRunSweeper')
    .addItem('🩺 Diagnóstico del sistema', 'uiRunDiagnostics')
    .addSeparator()
    .addItem(
      '🗑️ Eliminar Transacción SELECCIONADA (⚠️ Antes selecciona ID de transacción a borrar)',
      'uiDeleteSelectedTransaction'
    )
    .addItem('🚑 Rescatar a Notion (Filas Seleccionadas)', 'uiRescueNotionSync')
    .addToUi();
}

/**
 * Pide un valor al usuario y lo guarda en las propiedades del script si lo confirma.
 * @private
 * @param {string} title - Título del cuadro de diálogo.
 * @param {string} promptText - Texto de la pregunta.
 * @param {string} envKey - Propiedad del script donde se guarda.
 * @returns {string} Valor ingresado ('' si canceló o lo dejó vacío).
 */
function _askAndSaveEnv(title, promptText, envKey) {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(title, promptText, ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return '';
  const value = response.getResponseText().trim();
  if (value) setEnv(envKey, value);
  return value;
}

/**
 * Wizard interactivo para configurar las credenciales base del sistema (Core).
 * Pide las claves de Gemini y Telegram y las guarda en las Propiedades del Script.
 * Si el usuario no escribe un secreto para el webhook, se genera uno aleatorio.
 */
function uiConfigWizard() {
  const ui = SpreadsheetApp.getUi();

  _askAndSaveEnv('Seguridad', 'Pega tu API Key de GEMINI:', 'GEMINI_API_KEY');
  _askAndSaveEnv('Seguridad', 'Pega el Token de tu Bot de TELEGRAM:', 'TELEGRAM_BOT_TOKEN');
  _askAndSaveEnv('Seguridad', 'Pega tu Chat ID de Telegram:', 'TELEGRAM_CHAT_ID');
  const secret = _askAndSaveEnv(
    'Seguridad',
    'Clave secreta para el Webhook (déjala vacía para generar una aleatoria y segura):',
    'TELEGRAM_SECRET_TOKEN'
  );
  if (!secret && !getEnv('TELEGRAM_SECRET_TOKEN')) {
    setEnv('TELEGRAM_SECRET_TOKEN', Utilities.getUuid());
  }
  _askAndSaveEnv('Seguridad', 'Pega la URL de tu Web App:', 'WEB_APP_URL');

  ui.alert('✅ Éxito', 'Credenciales Core guardadas en la bóveda del script.', ui.ButtonSet.OK);
}

/**
 * Wizard interactivo específico para la conexión con la API de Notion.
 * Pide el Token y el ID de la base de datos de destino.
 */
function uiConfigNotion() {
  const ui = SpreadsheetApp.getUi();

  _askAndSaveEnv(
    'Configuración Notion',
    'Token Secreto de Notion (Empieza con secret_ o ntn_...):',
    'NOTION_API_TOKEN'
  );
  _askAndSaveEnv(
    'Configuración Notion',
    'ID de la Base de Datos (32 caracteres de la URL):',
    'NOTION_DATABASE_ID'
  );

  ui.alert('✅ Éxito', 'Credenciales de Notion guardadas en la bóveda.', ui.ButtonSet.OK);
}

/**
 * Interfaz para habilitar o deshabilitar la sincronización Dual-Write con Notion.
 * Verifica si las credenciales existen antes de confirmar la activación.
 */
function uiToggleNotion() {
  const ui = SpreadsheetApp.getUi();
  const currentState = getEnv('NOTION_ENABLED') === 'true' ? 'ACTIVADA 🟢' : 'DESACTIVADA 🔴';

  // Se pregunta explícitamente al usuario qué desea hacer, en lugar de un toggle ciego
  const response = ui.alert(
    'Toggle de Sincronización Notion',
    `Estado actual: ${currentState}\n\n¿Deseas habilitar la sincronización automática de tus gastos hacia tu base de datos de Notion?`,
    ui.ButtonSet.YES_NO_CANCEL
  );

  if (response === ui.Button.YES) {
    setEnv('NOTION_ENABLED', 'true');

    if (!getEnv('NOTION_API_TOKEN') || !getEnv('NOTION_DATABASE_ID')) {
      ui.alert(
        '⚠️ Casi listo',
        'Notion ha sido ACTIVADO.\n\nSin embargo, el sistema detecta que faltan tus credenciales. Por favor, usa la opción "Configurar Token y DB" en este mismo menú para agregarlas antes de que ingrese el próximo gasto.',
        ui.ButtonSet.OK
      );
    } else {
      ui.alert(
        '✅ ¡Éxito!',
        'La integración con Notion está ACTIVADA y completamente configurada.',
        ui.ButtonSet.OK
      );
    }
  } else if (response === ui.Button.NO) {
    setEnv('NOTION_ENABLED', 'false');
    ui.alert(
      '🛑 Desactivada',
      'La sincronización con Notion ha sido apagada. Tus datos solo se guardarán en este Google Sheet.',
      ui.ButtonSet.OK
    );
  }
}

/**
 * Invoca el despliegue del Webhook de Telegram hacia la URL de la Web App.
 * Proporciona feedback visual de éxito o error en el proceso.
 */
function uiSetupWebhook() {
  const ui = SpreadsheetApp.getUi();
  try {
    setupWebhook();
    ui.alert(
      '✅ Éxito',
      'Webhook de Telegram conectado y configurado correctamente.',
      ui.ButtonSet.OK
    );
  } catch (error) {
    ui.alert(
      '❌ Error',
      'Falló la configuración del Webhook: \n\n' + /** @type {Error} */ (error).message,
      ui.ButtonSet.OK
    );
  }
}

/**
 * UI Handler: lee todas las filas seleccionadas (resaltadas) en Sheets
 * y ejecuta el borrado dual en lote.
 */
function uiDeleteSelectedTransaction() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();

  if (sheet.getName() !== CONFIG.SHEETS.TRANSACTIONS) {
    ui.alert(
      '⚠️ Acción no permitida',
      'Por favor, selecciona filas estando en la hoja de "Transacciones".',
      ui.ButtonSet.OK
    );
    return;
  }

  // Rango completo que el usuario ha seleccionado con el ratón
  const range = sheet.getActiveRange();
  const startRow = range ? range.getRow() : 0;
  const numRows = range ? range.getNumRows() : 0;

  if (startRow < 2) {
    ui.alert(
      '⚠️ Selección inválida',
      'Por favor, asegúrate de no seleccionar los encabezados azules.',
      ui.ButtonSet.OK
    );
    return;
  }

  // IDs de la Columna A en ese rango, sin celdas vacías
  const idValues = sheet.getRange(startRow, 1, numRows, 1).getValues();
  const idsToDelete = idValues.map(row => row[0].toString().trim()).filter(id => id !== '');

  if (idsToDelete.length === 0) {
    ui.alert(
      '⚠️ Selección vacía',
      'Las filas seleccionadas no tienen ningún ID_Unico válido.',
      ui.ButtonSet.OK
    );
    return;
  }

  const response = ui.alert(
    '🛑 Confirmar Eliminación Múltiple',
    `Estás a punto de destruir ${idsToDelete.length} transacción(es) seleccionada(s).\n\nEsta acción las borrará permanentemente de Sheets y Notion. ¿Continuar?`,
    ui.ButtonSet.YES_NO
  );

  if (response === ui.Button.YES) {
    const resultMessage = deleteTransactionsByIds(idsToDelete);
    // Sheets muestra texto plano: se quitan las etiquetas HTML del mensaje de Telegram.
    ui.alert('Resultado', resultMessage.replace(/<[^>]+>/g, ''), ui.ButtonSet.OK);
  }
}

/**
 * UI Handler: activa o desactiva el envío de comentarios de transferencias a Gemini,
 * priorizando el consentimiento del usuario.
 */
function uiToggleTransferIA() {
  const ui = SpreadsheetApp.getUi();
  const currentState =
    getEnv('GEMINI_ANALYZE_TRANSFERS') === 'true' ? 'ACTIVADO 🟢' : 'DESACTIVADO 🔴';

  const response = ui.alert(
    'Privacidad: Análisis de Transferencias con IA',
    `Estado actual: ${currentState}\n\n¿Deseas que Gemini lea los comentarios de tus transferencias bancarias para categorizarlas automáticamente (Ej: "Pago arriendo, gastos comunes", "Pago bar")?\n\n⚠️ IMPORTANTE: Si activas esto, el texto de los comentarios será enviado a la API de Google. Si lo desactivas, las transferencias se guardarán, pero tendras que clasificarlas manualmente.`,
    ui.ButtonSet.YES_NO_CANCEL
  );

  if (response === ui.Button.YES) {
    setEnv('GEMINI_ANALYZE_TRANSFERS', 'true');
    ui.alert('✅ Activado', 'Gemini ahora clasificará tus transferencias.', ui.ButtonSet.OK);
  } else if (response === ui.Button.NO) {
    setEnv('GEMINI_ANALYZE_TRANSFERS', 'false');
    ui.alert('🛑 Desactivado', 'Listo, los comentarios NO se enviarán a Gemini.', ui.ButtonSet.OK);
  }
}

/**
 * UI Handler: sincronización manual de rescate a Notion.
 * Lee las filas seleccionadas en Sheets y las envía a Notion.
 */
function uiRescueNotionSync() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();

  // 1. Validar selección
  const range = sheet.getActiveRange();
  if (!range || range.getRow() < 2) {
    ui.alert(
      '⚠️ Selección inválida',
      'Por favor selecciona filas de datos, no los encabezados azules.',
      ui.ButtonSet.OK
    );
    return;
  }

  // 2. Columnas resueltas por nombre de encabezado (nunca por posición fija)
  const headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const cols = getTransactionColumns(headerRow);
  const data = range.getValues();

  // 3. Transformar las filas seleccionadas en DTOs para Notion
  /** @type {NotionTransaction[]} */
  const transactionsToSync = [];
  data.forEach(row => {
    const id = row[cols.ID_Unico];
    if (!id) return; // Saltar filas vacías si el usuario seleccionó de más

    // Sheets puede entregar la fecha como objeto Date: se pasa a yyyy-MM-dd
    const rawFecha = row[cols.Fecha];
    const fecha =
      rawFecha instanceof Date
        ? Utilities.formatDate(rawFecha, Session.getScriptTimeZone(), 'yyyy-MM-dd')
        : String(rawFecha);

    const origen = String(row[cols.Origen] || '').trim();
    transactionsToSync.push({
      ID_Unico: String(id).trim(),
      Fecha: fecha,
      Comercio_Limpio: String(row[cols.Comercio_Limpio] || '').trim() || 'Desconocido',
      Categoria: String(row[cols.Categoria] || '').trim() || 'Por Clasificar',
      Monto: Number(row[cols.Monto]),
      Tipo: String(row[cols.Tipo] || '').trim() || 'Gasto',
      // Si Origen está vacío en Sheets se usa un comodín para evitar el Error 400 de Notion
      Origen: origen || 'Rescate Manual',
    });
  });

  if (transactionsToSync.length === 0) {
    ui.alert(
      '⚠️ Vacío',
      'No se encontraron transacciones válidas en la selección.',
      ui.ButtonSet.OK
    );
    return;
  }

  const confirm = ui.alert(
    'Sincronización de Rescate',
    `Se enviarán ${transactionsToSync.length} transacciones directamente a Notion.\n\n¿Deseas continuar?`,
    ui.ButtonSet.YES_NO
  );

  if (confirm === ui.Button.YES) {
    pushToNotion(transactionsToSync);
    ui.alert(
      '✅ Rescate Finalizado',
      'Las transacciones fueron enviadas a Notion. Por favor, revisa Notion para confirmar.',
      ui.ButtonSet.OK
    );
  }
}

/**
 * UI Handler: ejecuta manualmente el motor de reprocesamiento (ignora los enfriamientos de modelos).
 */
function uiRunSweeper() {
  const ui = SpreadsheetApp.getUi();
  const mensaje = retryUnclassifiedTransactions({ ignoreCooldown: true });
  ui.alert('Reporte de IA', mensaje, ui.ButtonSet.OK);
}
