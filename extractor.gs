/**
 * Archivo: extractor.gs
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.gs para conocer los terminos vinculantes.
 * * VERSIÓN ACTUAL: Estable + Idempotencia de Doble Capa (Etiquetas + ID Único)
 */

/**
 * @fileoverview Motor de extracción (ETL - Extract).
 * Se encarga de consultar a Gmail, recuperar correos bancarios no procesados,
 * derivarlos al parser para extraer la información y gestionar el estado 
 * de los correos (Idempotencia visual mediante etiquetas).
 */

/**
 * Función principal que orquesta la extracción de correos.
 * Debe ser llamada por un Trigger temporal (ej. cada 1 hora).
 */
function processEmails() {
  // === CRONÓMETRO DE SEGURIDAD (Evita el Timeout de 6 min de Google) ===
  const startTime = Date.now();
  // Bajamos el límite a 3.5 minutos para darle tiempo de sobra al último lote de terminar
  const MAX_EXECUTION_TIME = 3.5 * 60 * 1000;

  logSystemEvent('INFO', 'Inicio Extracción', 'Buscando nuevos correos bancarios...');
  
  const baseQuery = '((from:bci.cl (subject:"Aviso de Transferencia" OR subject:"Notificación de uso de tu tarjeta de crédito")) OR (from:tenpo.cl subject:"Compra") OR (from:machbank.cl subject:"compra") OR (from:bancochile.cl (subject:"Cargo en Cuenta" OR subject:"Compra con Tarjeta" OR subject:"Cobro de cheque"))) -subject:dcto -subject:descuento -subject:promoción -subject:Ahorra -subject:Tienes ';

  const isBackfillCompleted = getEnv('INITIAL_BACKFILL_COMPLETED') === 'true';
  const queryConfig = isBackfillCompleted ? `newer_than:5d ${baseQuery}` : `newer_than:365d ${baseQuery}`;
  
  const labelName = CONFIG.GMAIL.LABEL_PROCESSED;
  const finalQuery = `${queryConfig} -label:${labelName}`;
  
  // === BUCLE DE PAGINACIÓN CONTINUA ===
  while (true) {
    // 1. CONTROL DE TIEMPO: Si nos queda poco tiempo, delegamos el trabajo y escapamos
    if (Date.now() - startTime > MAX_EXECUTION_TIME) {
      logSystemEvent('INFO', 'Paginación Activa', '⏳ Tiempo máximo alcanzado (4.5 min). Programando relevo en 10 segundos...');
      ScriptApp.newTrigger('continueProcessEmails').timeBased().after(10 * 1000).create();
      return; // Detenemos esta ejecución de forma segura
    }

    try {
      // 2. Buscamos el siguiente lote de 20 (más pequeño, más rápido)
      const threads = GmailApp.search(finalQuery, 0, 20);
      
      // 3. CONDICIÓN DE TÉRMINO: Ya no quedan correos en este rango de tiempo
      if (threads.length === 0) {
        if (!isBackfillCompleted) {
          setEnv('INITIAL_BACKFILL_COMPLETED', 'true');
          logSystemEvent('INFO', 'Sistema', '✅ Carga histórica completada al 100%. Pasando a Modo Producción (5 días).');
        } else {
          logSystemEvent('INFO', 'Fin Extracción', 'No hay más transacciones pendientes en este lote.');
        }
        break; // Rompemos el bucle while y terminamos
      }

      // --- 4. EXTRACCIÓN Y PROCESAMIENTO DEL LOTE ---
      let transaccionesExtraidas = [];
      const existingIds = getExistingTransactionIds(); 

      for (let i = 0; i < threads.length; i++) {
        const thread = threads[i];
        const messages = thread.getMessages();
        
        for (let j = 0; j < messages.length; j++) {
          const message = messages[j];
          const msgId = message.getId();

          if (existingIds.has(msgId)) continue; 

          const extractedData = parseBankEmail(message); 
          
          if (extractedData && extractedData.Monto !== 0) { // Aceptamos positivos y negativos
            extractedData.ID_Unico = msgId;
            transaccionesExtraidas.push(extractedData);
          }
        }
        
        // Etiquetamos el hilo para no volver a leerlo en el siguiente ciclo del 'while'
        const label = GmailApp.getUserLabelByName(labelName);
        if (label) thread.addLabel(label);
      }

      // --- 5. GUARDAR EN BASE DE DATOS Y APLICAR IA ---
      if (transaccionesExtraidas.length > 0) {
        logSystemEvent('INFO', 'Lote procesado', `Se extrajeron ${transaccionesExtraidas.length} transacciones. Enviando a IA/BD...`);
        
        const diccionarioNuevos = categorizeWithGemini(transaccionesExtraidas); 
        saveToDatabase(transaccionesExtraidas, diccionarioNuevos);
        
        if (typeof notifyTransferRules === "function") {
          notifyTransferRules(transaccionesExtraidas);
        }
      }

    } catch (error) {
      logSystemEvent('ERROR', 'Error crítico en bucle de extracción', error.stack || error.message);
      break; // Si hay un error fatal (ej. Gmail se cae), rompemos el bucle
    }
  }
}

/**
 * Función utilitaria para aplicar una etiqueta a un hilo de correos.
 * Si la etiqueta no existe en el Gmail del usuario, la crea automáticamente.
 * * @private
 * @param {GoogleAppsScript.Gmail.GmailThread} thread - El hilo de correos a etiquetar.
 * @param {string} labelName - El nombre de la etiqueta (ej. "SaaS_Procesado").
 */
function _markThreadAsProcessed(thread, labelName) {
  try {
    let label = GmailApp.getUserLabelByName(labelName);
    if (!label) {
      // Si el usuario acaba de instalar el SaaS, creamos la etiqueta por él
      label = GmailApp.createLabel(labelName);
    }
    thread.addLabel(label);
  } catch (error) {
    logSystemEvent('WARN', 'Error al aplicar etiqueta', `No se pudo etiquetar el hilo. Motivo: ${error.message}`);
  }
}

/**
 * Función puente para la Ejecución Encadenada.
 * Se invoca automáticamente si el Backfill se queda sin tiempo.
 */
function continueProcessEmails() {
  // 1. Limpiamos el gatillo temporal que nos invocó para no dejar basura
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'continueProcessEmails') {
      ScriptApp.deleteTrigger(t);
    }
  });
  
  logSystemEvent('INFO', 'Sistema', '🔄 Reanudando ejecución encadenada...');
  
  // 2. Volvemos a llamar al motor principal
  processEmails();
}

// function repararBackfill() {
//   setEnv('INITIAL_BACKFILL_COMPLETED', 'false');
//   Logger.log("✅ Sistema reiniciado. El próximo processEmails retomará el Backfill.");
// }