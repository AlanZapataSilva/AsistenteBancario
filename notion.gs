/**

Archivo: notion.gs

Autor: Alan Zapata Silva

Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.

Este codigo es Source-Available. NO es Open Source.

Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.

Revise el archivo LICENSE.gs para conocer los terminos vinculantes.
*/
/**
 * @fileoverview Cliente de integración con la API de Notion.
 * Documentación oficial: https://developers.notion.com/
 */

/**
 * Envía un lote de transacciones a una base de datos de Notion.
 * Respeta el Rate Limit de Notion (Max 3 req/sec) usando un delay controlado.
 * @param {Array<Object>} transactions - Arreglo de transacciones parseadas.
 */
function pushToNotion(transactions) {
  if (!transactions || transactions.length === 0) return;

  const notionToken = getEnv('NOTION_API_TOKEN');
  const databaseId = getEnv('NOTION_DATABASE_ID');

  if (!notionToken || !databaseId) {
    logSystemEvent('WARN', 'Intento de envío a Notion abortado: Faltan credenciales.');
    return;
  }

  const url = 'https://api.notion.com/v1/pages';
  const headers = {
    'Authorization': `Bearer ${notionToken}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  let exitos = 0;

  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    
    // Mapeo estricto al schema de Notion
    const payload = {
      parent: { database_id: databaseId },
      properties: {
        "Comercio": { title: [{ text: { content: tx.Comercio_Limpio } }] },
        "Monto": { number: tx.Monto },
        "Fecha": { date: { start: tx.Fecha } },
        "Categoría": { select: { name: tx.Categoria } },
        "Tipo": { select: { name: tx.Tipo } },
        "ID_Unico": { rich_text: [{ text: { content: tx.ID_Unico } }] },
        "Origen": { select: { name: tx.Origen } } // ¡Perfecto!
      }
    };

    const options = {
      method: 'post',
      headers: headers,
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      
      if (code === 200) {
        exitos++;
      } else {
        Logger.log(`❌ Error Notion API (Tx: ${tx.ID_Unico}): ${response.getContentText()}`);
        logSystemEvent('ERROR', `Fallo al escribir en Notion (Código ${code})`, response.getContentText());
      }
      
    } catch (error) {
      logSystemEvent('ERROR', 'Fallo de red en API de Notion', error.message);
    }

    // 🛡️ EL FRENO DE MANO (Garantizado)
    // Fuera del try/catch para que se ejecute SIEMPRE.
    // 500ms = 2 peticiones por segundo. Infalible para cargas masivas.
    Utilities.sleep(500); 
  }
  
  Logger.log(`📓 Sincronización con Notion finalizada: ${exitos}/${transactions.length} transacciones guardadas.`);
}

/**
 * Busca y archiva (elimina) una transacción en Notion usando su ID_Unico.
 * @param {string} idUnico - El ID_Unico de la transacción.
 * @returns {boolean} True si se archivó correctamente, False si falló.
 */
function deleteTransactionInNotion(idUnico) {
  const notionToken = getEnv('NOTION_API_TOKEN');
  const databaseId = getEnv('NOTION_DATABASE_ID');

  if (!notionToken || !databaseId) {
    logSystemEvent('ERROR', 'Notion Delete', 'Faltan credenciales.');
    return false;
  }

  const headers = {
    'Authorization': `Bearer ${notionToken}`,
    'Content-Type': 'application/json',
    'Notion-Version': '2022-06-28'
  };

  // --- FASE 1: BUSCAR LA PÁGINA EN NOTION ---
  const queryUrl = `https://api.notion.com/v1/databases/${databaseId}/query`;
  const queryPayload = {
    "filter": {
      "property": "ID_Unico", // Debe llamarse EXACTAMENTE así en tu base de Notion
      "rich_text": {
        "equals": idUnico
      }
    }
  };

  const queryOptions = {
    method: 'post',
    headers: headers,
    payload: JSON.stringify(queryPayload),
    muteHttpExceptions: true
  };

  const queryResponse = UrlFetchApp.fetch(queryUrl, queryOptions);
  const queryCode = queryResponse.getResponseCode();
  const queryText = queryResponse.getContentText();

  // AUDITORÍA 1: ¿Falló la búsqueda?
  if (queryCode !== 200) {
    logSystemEvent('ERROR', 'Notion Query Error', `Http ${queryCode}: ${queryText}`);
    return false;
  }

  const queryJson = JSON.parse(queryText);
  
  // AUDITORÍA 2: ¿Encontró el ID o la lista vino vacía?
  if (!queryJson.results || queryJson.results.length === 0) {
    logSystemEvent('WARN', 'Notion Delete', `La búsqueda fue exitosa, pero Notion no encontró el ID: ${idUnico}. Revisa el nombre de la columna.`);
    return false;
  }

  const pageId = queryJson.results[0].id; // El ID nativo y secreto de Notion

  // --- FASE 2: ARCHIVAR (BORRAR) LA PÁGINA ---
  const deleteUrl = `https://api.notion.com/v1/pages/${pageId}`;
  const deleteOptions = {
    method: 'patch',
    headers: headers,
    payload: JSON.stringify({ "archived": true }),
    muteHttpExceptions: true
  };

  const deleteResponse = UrlFetchApp.fetch(deleteUrl, deleteOptions);
  
  // AUDITORÍA 3: ¿Falló el archivado?
  if (deleteResponse.getResponseCode() !== 200) {
    logSystemEvent('ERROR', 'Notion Archive Error', deleteResponse.getContentText());
    return false;
  }

  logSystemEvent('INFO', 'Notion Delete Exitoso', `La fila con ID ${idUnico} fue borrada de Notion.`);
  return true;
}