/**

Archivo: setup.gs

Autor: Alan Zapata Silva

Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.

Este codigo es Source-Available. NO es Open Source.

Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.

Revise el archivo LICENSE.gs para conocer los terminos vinculantes.
*/

/**
 * @fileoverview Script de instalación y configuración inicial de la infraestructura del SaaS.
 */

/**
 * Orquestador principal de instalación.
 * Ejecuta esta función manualmente por única vez para preparar el entorno.
 */
function installApp() {
  try {
    Logger.log('Iniciando instalación del SaaS Financiero...');
    _setupSheets();
    _setupGmail();
    Logger.log('Instalación completada con éxito. El entorno está listo.');
  } catch (error) {
    Logger.log('❌ Error crítico durante la instalación: ' + error.message);
    throw error; // Falla explícita, sin silenciar.
  }
}

/**
 * Configura las hojas de cálculo, inyecta encabezados y congela paneles.
 * @private
 */
function _setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  const sheetsToCreate = [
    { name: CONFIG.SHEETS.TRANSACTIONS, headers: CONFIG.HEADERS.TRANSACTIONS },
    { name: CONFIG.SHEETS.DICTIONARY, headers: CONFIG.HEADERS.DICTIONARY },
    { name: CONFIG.SHEETS.LOGS, headers: CONFIG.HEADERS.LOGS }
  ];

  sheetsToCreate.forEach(sheetConfig => {
    Logger.log(`Hoja a crear: ${sheetConfig.name}`);
    let sheet = ss.getSheetByName(sheetConfig.name);
    
    if (!sheet) {
      sheet = ss.insertSheet(sheetConfig.name);
      Logger.log(`✅ Hoja creada: ${sheetConfig.name}`);
    } else {
      Logger.log(`ℹ️ La hoja ya existe: ${sheetConfig.name}`);
    }
    
    // Inyectar encabezados
    const headerRange = sheet.getRange(1, 1, 1, sheetConfig.headers.length);
    headerRange.setValues([sheetConfig.headers]);
    
    // Formato estructural: Congelar fila 1, negritas y centrar texto horizontalmente en la celda.
    headerRange.setFontWeight('bold').setHorizontalAlignment('center');
    sheet.setFrozenRows(1);
    
    // Si es la hoja de Diccionario, añadir Checkboxes en la columna de Auditoría
    if (sheetConfig.name === CONFIG.SHEETS.DICTIONARY) {
       const auditColIndex = sheetConfig.headers.indexOf('Auditoría Manual (Check)') + 1;
       const maxRows = sheet.getMaxRows();
       if (maxRows > 1) {
         sheet.getRange(2, auditColIndex, maxRows - 1, 1).insertCheckboxes();
       }
    }
    
    // Ajustar columnas para mejor lectura
    sheet.autoResizeColumns(1, sheetConfig.headers.length);
  });
}

/**
 * Configura la etiqueta de Gmail necesaria para el flujo unidireccional.
 * @private
 */
function _setupGmail() {
  const labelName = CONFIG.GMAIL.LABEL_PROCESSED;
  const existingLabel = GmailApp.getUserLabelByName(labelName);
  
  if (!existingLabel) {
    GmailApp.createLabel(labelName);
    Logger.log(`✅ Etiqueta de Gmail creada: ${labelName}`);
  } else {
    Logger.log(`ℹ️ La etiqueta de Gmail ya existe: ${labelName}`);
  }
}/**
 * @fileoverview Script de instalación y configuración inicial de la infraestructura del SaaS.
 */

/**
 * Orquestador principal de instalación.
 * Ejecuta esta función manualmente por única vez para preparar el entorno.
 */
function installApp() {
  try {
    Logger.log('Iniciando instalación del SaaS Financiero...');
    _setupSheets();
    _setupGmail();
    Logger.log('Instalación completada con éxito. El entorno está listo.');
  } catch (error) {
    Logger.log('❌ Error crítico durante la instalación: ' + error.message);
    throw error; // Falla explícita, sin silenciar.
  }
}

/**
 * Configura las hojas de cálculo, inyecta encabezados y congela paneles.
 * @private
 */
function _setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  const sheetsToCreate = [
    { name: CONFIG.SHEETS.TRANSACTIONS, headers: CONFIG.HEADERS.TRANSACTIONS },
    { name: CONFIG.SHEETS.DICTIONARY, headers: CONFIG.HEADERS.DICTIONARY },
    { name: CONFIG.SHEETS.LOGS, headers: CONFIG.HEADERS.LOGS }
  ];

  sheetsToCreate.forEach(sheetConfig => {
    Logger.log(`Hoja a crear: ${sheetConfig.name}`);
    let sheet = ss.getSheetByName(sheetConfig.name);
    
    if (!sheet) {
      sheet = ss.insertSheet(sheetConfig.name);
      Logger.log(`✅ Hoja creada: ${sheetConfig.name}`);
    } else {
      Logger.log(`ℹ️ La hoja ya existe: ${sheetConfig.name}`);
    }
    
    // Inyectar encabezados
    const headerRange = sheet.getRange(1, 1, 1, sheetConfig.headers.length);
    headerRange.setValues([sheetConfig.headers]);
    
    // Formato estructural: Congelar fila 1, negritas y centrar texto horizontalmente en la celda.
    headerRange.setFontWeight('bold').setHorizontalAlignment('center');
    sheet.setFrozenRows(1);
    
    // Si es la hoja de Diccionario, añadir Checkboxes en la columna de Auditoría
    if (sheetConfig.name === CONFIG.SHEETS.DICTIONARY) {
       const auditColIndex = sheetConfig.headers.indexOf('Auditoría Manual (Check)') + 1;
       const maxRows = sheet.getMaxRows();
       if (maxRows > 1) {
         sheet.getRange(2, auditColIndex, maxRows - 1, 1).insertCheckboxes();
       }
    }
    
    // Ajustar columnas para mejor lectura
    sheet.autoResizeColumns(1, sheetConfig.headers.length);
  });
}

/**
 * Configura la etiqueta de Gmail necesaria para el flujo unidireccional.
 * @private
 */
function _setupGmail() {
  const labelName = CONFIG.GMAIL.LABEL_PROCESSED;
  const existingLabel = GmailApp.getUserLabelByName(labelName);
  
  if (!existingLabel) {
    GmailApp.createLabel(labelName);
    Logger.log(`✅ Etiqueta de Gmail creada: ${labelName}`);
  } else {
    Logger.log(`ℹ️ La etiqueta de Gmail ya existe: ${labelName}`);
  }
}