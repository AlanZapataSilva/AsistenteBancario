/**
 * Archivo: ui.gs
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.gs para conocer los terminos vinculantes.
 * * VERSIÓN ACTUAL: Estable + Notion UX Upgrade + Documentación JSDoc
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
    .addItem('🧠 Activar análisis Mensajes de Transferencias (IA)', 'uiToggleTransferIA') // NUEVO BOTÓN
    .addSeparator()
    .addSubMenu(ui.createMenu('📓 Integración Notion')
      .addItem('Configurar Token y DB', 'uiConfigNotion')
      .addItem('Activar/Desactivar Sincronización', 'uiToggleNotion'))
    .addSeparator()
    .addItem('🧹 Ordenar Base de Datos', 'uiRunMaintenance')
    .addSeparator()
    .addItem('🗑️ Eliminar Transacción SLEECCIONADA (⚠️ Antes selecciona ID de transacción a borrar)', 'uiDeleteSelectedTransaction')
    .addItem('🚑 Rescatar a Notion (Filas Seleccionadas)', 'uiRescueNotionSync')
    .addToUi();
}

/**
 * Wizard interactivo para configurar las credenciales base del sistema (Core).
 * Pide al usuario las claves de Gemini y Telegram, y las guarda de forma 
 * persistente y segura en las Propiedades del Script usando setEnv().
 */
function uiConfigWizard() {
  const ui = SpreadsheetApp.getUi();
  
  // Función auxiliar privada para abstraer la lógica de pedir y guardar variables
  const askAndSave = (promptText, envKey) => {
    const response = ui.prompt('Seguridad', promptText, ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() == ui.Button.OK) {
      const value = response.getResponseText().trim();
      if (value) setEnv(envKey, value);
    }
  };

  askAndSave('Pega tu API Key de GEMINI:', 'GEMINI_API_KEY');
  askAndSave('Pega el Token de tu Bot de TELEGRAM:', 'TELEGRAM_BOT_TOKEN');
  askAndSave('Pega tu Chat ID de Telegram:', 'TELEGRAM_CHAT_ID');
  askAndSave('Inventa un Password (Ej: MiClave123) para Webhook:', 'TELEGRAM_SECRET_TOKEN');
  askAndSave('Pega la URL de tu Web App:', 'WEB_APP_URL');
  
  ui.alert('✅ Éxito', 'Credenciales Core guardadas en la bóveda del script.', ui.ButtonSet.OK);
}

/**
 * Wizard interactivo específico para la conexión con la API de Notion.
 * Pide el Token y el ID de la base de datos de destino.
 */
function uiConfigNotion() {
  const ui = SpreadsheetApp.getUi();
  
  const askAndSave = (promptText, envKey) => {
    const response = ui.prompt('Configuración Notion', promptText, ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() == ui.Button.OK) {
      const value = response.getResponseText().trim();
      if (value) setEnv(envKey, value);
    }
  };

  askAndSave('Token Secreto de Notion (Empieza con secret_ o ntn_...):', 'NOTION_API_TOKEN');
  askAndSave('ID de la Base de Datos (32 caracteres de la URL):', 'NOTION_DATABASE_ID');
  
  ui.alert('✅ Éxito', 'Credenciales de Notion guardadas en la bóveda.', ui.ButtonSet.OK);
}

/**
 * Interfaz inteligente para habilitar o deshabilitar la sincronización Dual-Write con Notion.
 * Verifica si las credenciales existen antes de confirmar la activación, 
 * mejorando drásticamente la Experiencia de Usuario (UX).
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

  // Manejo de la decisión del usuario
  if (response === ui.Button.YES) {
    setEnv('NOTION_ENABLED', 'true'); // Enciende la válvula principal
    
    // Auditoría de infraestructura: Verificar si el usuario ya configuró los tokens
    const token = getEnv('NOTION_API_TOKEN');
    const db = getEnv('NOTION_DATABASE_ID');
    
    if (!token || !db) {
      ui.alert(
        '⚠️ Casi listo', 
        'Notion ha sido ACTIVADO.\n\nSin embargo, el sistema detecta que faltan tus credenciales. Por favor, usa la opción "Configurar Token y DB" en este mismo menú para agregarlas antes de que ingrese el próximo gasto.', 
        ui.ButtonSet.OK
      );
    } else {
      ui.alert('✅ ¡Éxito!', 'La integración con Notion está ACTIVADA y completamente configurada.', ui.ButtonSet.OK);
    }
    
  } else if (response === ui.Button.NO) {
    setEnv('NOTION_ENABLED', 'false'); // Cierra la válvula principal
    ui.alert('🛑 Desactivada', 'La sincronización con Notion ha sido apagada. Tus datos solo se guardarán en este Google Sheet.', ui.ButtonSet.OK);
  }
}

/**
 * Invoca el despliegue del Webhook de Telegram hacia la URL de la Web App.
 * Proporciona feedback visual de éxito o error en el proceso.
 */
function uiSetupWebhook() {
  const ui = SpreadsheetApp.getUi();
  try {
    setupWebhook(); // Llama a la función del módulo telegram.gs
    ui.alert('✅ Éxito', 'Webhook de Telegram conectado y configurado correctamente.', ui.ButtonSet.OK);
  } catch (error) {
    ui.alert('❌ Error', 'Falló la configuración del Webhook: \n\n' + error.message, ui.ButtonSet.OK);
  }
}

/**
 * UI Handler: Lee todas las filas seleccionadas (resaltadas) en Sheets 
 * y ejecuta el borrado dual en lote.
 */
function uiDeleteSelectedTransaction() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();
  
  if (sheet.getName() !== CONFIG.SHEETS.TRANSACTIONS) {
    ui.alert('⚠️ Acción no permitida', 'Por favor, selecciona filas estando en la hoja de "Transacciones".', ui.ButtonSet.OK);
    return;
  }
  
  // Obtener el rango completo que el usuario ha seleccionado con el ratón
  const range = sheet.getActiveRange();
  const startRow = range.getRow();
  const numRows = range.getNumRows();
  
  if (startRow < 2) {
    ui.alert('⚠️ Selección inválida', 'Por favor, asegúrate de no seleccionar los encabezados azules.', ui.ButtonSet.OK);
    return;
  }
  
  // Extraer todos los IDs de la Columna A en ese rango
  const idValues = sheet.getRange(startRow, 1, numRows, 1).getValues();
  
  // Filtrar celdas vacías y convertirlos en un arreglo plano
  const idsToDelete = idValues.map(row => row[0].toString().trim()).filter(id => id !== "");
  
  if (idsToDelete.length === 0) {
    ui.alert('⚠️ Selección vacía', 'Las filas seleccionadas no tienen ningún ID_Unico válido.', ui.ButtonSet.OK);
    return;
  }
  
  const response = ui.alert(
    '🛑 Confirmar Eliminación Múltiple',
    `Estás a punto de destruir ${idsToDelete.length} transacción(es) seleccionada(s).\n\nEsta acción las borrará permanentemente de Sheets y Notion. ¿Continuar?`,
    ui.ButtonSet.YES_NO
  );
  
  if (response === ui.Button.YES) {
    // Invocamos al nuevo motor batch
    const resultMessage = deleteTransactionsByIds(idsToDelete);
    
    // Limpiamos las etiquetas HTML para que Google Sheets lo muestre como texto plano
    const plainTextMsg = resultMessage.replace(/<[^>]+>/g, '');
    ui.alert('Resultado', plainTextMsg, ui.ButtonSet.OK);
  }
}

/**
 * UI Handler: Toggle para habilitar/deshabilitar el envío de comentarios 
 * de transferencias a Gemini, priorizando el consentimiento del usuario.
 */
function uiToggleTransferIA() {
  const ui = SpreadsheetApp.getUi();
  const currentState = getEnv('GEMINI_ANALYZE_TRANSFERS') === 'true' ? 'ACTIVADO 🟢' : 'DESACTIVADO 🔴';
  
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
 * UI Handler: Sincronización manual de rescate a Notion.
 * Lee las filas seleccionadas en Sheets y las empuja a Notion.
 */
function uiRescueNotionSync() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();

  // 1. Validar selección
  const range = sheet.getActiveRange();
  const startRow = range.getRow();
  const numRows = range.getNumRows();

  if (startRow < 2) {
    ui.alert('⚠️ Selección inválida', 'Por favor selecciona filas de datos, no los encabezados azules.', ui.ButtonSet.OK);
    return;
  }

  // 2. Obtener encabezados de la fila 1 para mapear las columnas mágicamente
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const data = range.getValues();

  let transactionsToSync = [];

  // 3. Transformar las filas seleccionadas en DTOs para Notion
  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    let tx = {};

    // Construir el objeto buscando qué dato está en qué columna
    for (let j = 0; j < headers.length; j++) {
      const colName = headers[j].toString().trim();
      tx[colName] = row[j];
    }

    if (!tx.ID_Unico) continue; // Saltar filas vacías si el usuario seleccionó de más

    // Formatear Fecha (Si Sheets la tiene como objeto Date, la pasamos a YYYY-MM-DD)
    if (tx.Fecha instanceof Date) {
      tx.Fecha = Utilities.formatDate(tx.Fecha, Session.getScriptTimeZone(), "yyyy-MM-dd");
    }

    // Preparar el objeto final asegurando que todos los campos requeridos por pushToNotion existan
    transactionsToSync.push({
      ID_Unico: tx.ID_Unico.toString().trim(),
      Fecha: tx.Fecha.toString(),
      Comercio_Limpio: tx.Comercio_Limpio ? tx.Comercio_Limpio.toString().trim() : "Desconocido",
      Categoria: tx.Categoria ? tx.Categoria.toString().trim() : "Por Clasificar",
      Monto: Number(tx.Monto),
      Tipo: tx.Tipo ? tx.Tipo.toString().trim() : "Gasto",
      // Si la columna Origen no existe o está vacía en Sheets, le ponemos un comodín para evitar el Error 400
      Origen: (tx.Origen && tx.Origen.toString().trim() !== "") ? tx.Origen.toString().trim() : "Rescate Manual"
    });
  }

  if (transactionsToSync.length === 0) {
    ui.alert('⚠️ Vacío', 'No se encontraron transacciones válidas en la selección.', ui.ButtonSet.OK);
    return;
  }

  const confirm = ui.alert(
    'Sincronización de Rescate',
    `Se enviarán ${transactionsToSync.length} transacciones directamente a Notion.\n\n¿Deseas continuar?`,
    ui.ButtonSet.YES_NO
  );

  if (confirm === ui.Button.YES) {
    // Invocamos tu función existente que ya tiene el freno de mano (Utilities.sleep)
    pushToNotion(transactionsToSync);
    ui.alert('✅ Rescate Finalizado', 'Las transacciones fueron enviadas a Notion. Por favor, revisa Notion para confirmar.', ui.ButtonSet.OK);
  }
}