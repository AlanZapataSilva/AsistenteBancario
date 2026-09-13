/**
 * Archivo: gemini.gs
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.gs para conocer los terminos vinculantes.
 * * VERSIÓN ACTUAL: Estable + Gemini 2.5 Pro + Fallback Recursivo a 2.5 Flash
 */

/**
 * @fileoverview Conexión con la API de Google Gemini utilizando el estándar REST oficial.
 * Implementa Caché de Diccionario para no quemar tokens en comercios ya conocidos.
 */

'use strict';

/**
 * Obtiene el modelo más reciente disponible directamente desde la API de Gemini.
 * Utiliza CacheService para evitar latencia y consumo de cuota extra.
 * @private
 * @param {string} apiKey - Llave de la API.
 * @param {string} family - Familia del modelo ("pro" o "flash").
 * @returns {string} El nombre exacto del modelo más reciente (ej. "models/gemini-3.1-pro-preview").
 */
/**
 * Obtiene el modelo oficial más reciente disponible desde la API de Gemini.
 * Utiliza CacheService y Regex estricto para evitar modelos experimentales.
 * @private
 * @param {string} apiKey - Llave de la API.
 * @param {string} family - Familia del modelo ("pro" o "flash").
 * @returns {string} El nombre exacto del modelo más reciente (ej. "gemini-2.5-pro").
 */
function _getDynamicGeminiModelName(apiKey, family) {
  const cache = CacheService.getScriptCache();
  const cacheKey = `GEMINI_LATEST_MODEL_${family.toUpperCase()}`;
  
  // Purgamos la caché corrupta en la primera ejecución
  cache.remove(cacheKey); 

  const cachedModel = cache.get(cacheKey);
  if (cachedModel) return cachedModel;

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

  if (res.getResponseCode() !== 200) {
    throw new Error(`Fallo al descubrir modelos: ${res.getContentText()}`);
  }

  const json = JSON.parse(res.getContentText());

  // REGEX QUIRÚRGICO: Solo acepta formato estricto (ej. gemini-2.5-pro, gemini-3.0-flash-preview)
  // Rechaza explícitamente "-customtools", "-vision", etc.
  const regexOficial = new RegExp(`^models/gemini-\\d+\\.\\d+-${family}(?:-preview|-latest)?$`, 'i');

  const availableModels = json.models.filter(m => 
    regexOficial.test(m.name) && 
    m.supportedGenerationMethods.includes("generateContent")
  );

  if (availableModels.length === 0) {
    throw new Error(`No hay modelos oficiales activos para la familia: ${family}`);
  }

  availableModels.sort((a, b) => b.name.localeCompare(a.name));
  
  const selectedModel = availableModels[0].name.replace('models/', '');
  cache.put(cacheKey, selectedModel, 21600);
  
  return selectedModel;
}
/**
 * Realiza la llamada a la API de Gemini intentando en una cascada de modelos.
 * @private
 * @param {Object} payload - Objeto JSON con el prompt.
 * @returns {Object} Respuesta parseada de la API.
 */
function _fetchGeminiAPIWithCascade(payload) {
  const apiKey = getEnv('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada.');

  // CASCADA DE SUPERVIVENCIA: De mayor calidad a mayor resiliencia.
  // Intentaremos en este orden exacto.
  const MODEL_CASCADE = [
    _getDynamicGeminiModelName(apiKey, "pro"),   // 1. Dinámico Pro (Ej. 3.0/2.5 Pro)
    _getDynamicGeminiModelName(apiKey, "flash"), // 2. Dinámico Flash (Ej. 3.0/2.5 Flash)
    "gemini-1.5-pro-latest",                     // 3. Estable Pro anterior
    "gemini-1.5-flash-latest",                   // 4. Estable Flash anterior
    "gemini-1.5-flash-8b"                        // 5. Modelo ultraligero (Último recurso)
  ];

  for (let i = 0; i < MODEL_CASCADE.length; i++) {
    const modelName = MODEL_CASCADE[i];
    logSystemEvent('INFO', `Intento de IA (${i+1}/${MODEL_CASCADE.length})`, `Usando modelo: ${modelName}`);
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    const responseText = response.getContentText();
    let json;

    try { json = JSON.parse(responseText); } 
    catch (e) { 
      logSystemEvent('WARN', `Fallo de parseo en ${modelName}`, responseText.substring(0, 100));
      continue; // Saltamos al siguiente modelo
    }

    // Si es éxito (200), salimos del ciclo y devolvemos la data
    if (responseCode === 200 && !json.error) {
      return json;
    }

    // Si hay error (Cuota, 503, 500), registramos y el ciclo for intentará el siguiente modelo
    const errorMsg = json.error ? json.error.message : `HTTP ${responseCode}`;
    logSystemEvent('WARN', `Modelo ${modelName} falló`, errorMsg);
  }

  // Si terminamos el ciclo y ninguno funcionó, disparamos error crítico.
  throw new Error('Todos los modelos de la cascada de supervivencia fallaron o están saturados.');
}

/**
 * Clasifica transacciones financieras usando IA (Batch).
 * @param {Array<Object>} transacciones - Lista de transacciones a procesar.
 * @returns {Array<Object>} Arreglo con las nuevas entradas para el diccionario.
 */
function categorizeWithGemini(transacciones) {
  // 1. Diccionario Local (Omitido por brevedad, igual a tu lógica anterior)
  let comerciosDesconocidosMap = new Map();
  const diccionarioLocal = getDictionaryMap();
  const analyzeTransfers = getEnv('GEMINI_ANALYZE_TRANSFERS') === 'true';

  transacciones.forEach(t => {
    const key = t.Comercio_Original.toLowerCase();
    if (diccionarioLocal.has(key)) {
      const datosLocales = diccionarioLocal.get(key);
      t.Comercio_Limpio = datosLocales.Comercio_Limpio;
      t.Categoria = datosLocales.Categoria;
      t.Subcategoria = datosLocales.Subcategoria;
    } else {
      let datoIA = { Comercio_Original: t.Comercio_Original, Tipo: t.Tipo, Comentario_Adjunto: "N/A" };
      if (t.Tipo === 'Transferencia' && t.Comentario && analyzeTransfers) {
        datoIA.Comentario_Adjunto = t.Comentario;
      }
      comerciosDesconocidosMap.set(t.Comercio_Original, datoIA);
    }
  });

  if (comerciosDesconocidosMap.size === 0) return [];

  const listadoParaGemini = Array.from(comerciosDesconocidosMap.values());
  const prompt = `...tu prompt exacto... \n${JSON.stringify(listadoParaGemini, null, 2)}`;
  
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, response_mime_type: "application/json" }
  };

  try {
    // INVOCAMOS A LA CASCADA
    const jsonResponse = _fetchGeminiAPIWithCascade(payload);
    const clasificaciones = JSON.parse(jsonResponse.candidates[0].content.parts[0].text);

    let diccionarioNuevos = [];
    clasificaciones.forEach(clasificacion => {
      if (clasificacion.Comercio_Original) {
        diccionarioNuevos.push(clasificacion);
        transacciones.forEach(t => {
          if (t.Comercio_Original === clasificacion.Comercio_Original) {
            t.Comercio_Limpio = clasificacion.Comercio_Limpio;
            t.Categoria = clasificacion.Categoria;
            t.Subcategoria = clasificacion.Subcategoria;
          }
        });
      }
    });
    return diccionarioNuevos;
  } catch (error) {
    logSystemEvent('ERROR', 'Colapso total de Gemini API', error.message);
    return []; // Devolvemos vacío para que queden como "Por Clasificar" en Sheets, sin romper la ejecución
  }
}






















































// /**
//  * Clasifica transacciones financieras usando IA con soporte para Fallback y Privacidad.
//  * @param {Array<Object>} transacciones - Lista de transacciones a procesar.
//  * @param {string} [modelo="pro"] - "pro" para Gemini 2.5 Pro, "flash" para Gemini 2.5 Flash.
//  * @returns {Array<Object>} Arreglo con las nuevas entradas para el diccionario.
//  */
// function categorizeWithGemini(transacciones, modelo = "pro") {
//   logSystemEvent('INFO', `Iniciando Gemini (${modelo.toUpperCase()})`, `Evaluando ${transacciones.length} transacciones.`);
  
//   const apiKey = getEnv('GEMINI_API_KEY');
//   if (!apiKey) {
//     logSystemEvent('ERROR', 'Falta API Key', 'GEMINI_API_KEY no configurada.');
//     return [];
//   }

//   // 1. Aplicar "Caché de Diccionario" local primero
//   const diccionarioLocal = getDictionaryMap(); 
  
//   // Usaremos un Map para evitar enviar duplicados en el mismo lote
//   let comerciosDesconocidosMap = new Map();
  
//   const analyzeTransfers = getEnv('GEMINI_ANALYZE_TRANSFERS') === 'true';

//   transacciones.forEach(t => {
//     const key = t.Comercio_Original.toLowerCase();
    
//     if (diccionarioLocal.has(key)) {
//       const datosLocales = diccionarioLocal.get(key);
//       t.Comercio_Limpio = datosLocales.Comercio_Limpio;
//       t.Categoria = datosLocales.Categoria;
//       t.Subcategoria = datosLocales.Subcategoria;
//     } else {
//       // PROMPTING ESTRUCTURADO: Preparamos un objeto limpio para la IA
//       let datoIA = {
//         Comercio_Original: t.Comercio_Original,
//         Tipo: t.Tipo,
//         Comentario_Adjunto: "N/A"
//       };
      
//       // Inyección Condicional de Privacidad
//       if (t.Tipo === 'Transferencia' && t.Comentario && analyzeTransfers) {
//         datoIA.Comentario_Adjunto = t.Comentario;
//         logSystemEvent('INFO', 'Privacidad IA', `Comentario de transferencia incluido para: ${t.Comercio_Original}`);
//       }
      
//       comerciosDesconocidosMap.set(t.Comercio_Original, datoIA);
//     }
//   });

//   if (comerciosDesconocidosMap.size === 0) {
//     logSystemEvent('INFO', 'Cache Gemini', 'Comercio resuelto 100% por caché local.');
//     return [];
//   }

//   // 2. Armar la consulta a la IA (JSON to JSON)
//   const listadoParaGemini = Array.from(comerciosDesconocidosMap.values());
  
//   const prompt = `
//   Eres un experto financiero. Categoriza la siguiente lista de transacciones bancarias (entregada en formato JSON).
  
//   Reglas de análisis estricto:
//   1. Si el "Tipo" es "Transferencia" y tiene un "Comentario_Adjunto" distinto a "N/A", usa OBLIGATORIAMENTE ese comentario para deducir la categoría exacta del gasto o ingreso (ej. si dice "Piscina", categoriza como "Entretenimiento" o "Deportes").
//   2. Si el "Tipo" es "Débito" o "Crédito", ignora el comentario y analiza el nombre en "Comercio_Original" (ej. "UBER TRIP" -> Transporte).
//   3. El campo "Comercio_Limpio" debe contener el nombre comercial legible, o mantener el nombre de la persona si es una transferencia.

//   Devuelve EXCLUSIVAMENTE un arreglo JSON con esta estructura exacta para cada elemento analizado:
//   [
//     {
//       "Comercio_Original": "DEBE ser exactamente igual al que recibiste de entrada para no romper la base de datos",
//       "Comercio_Limpio": "Nombre comercial limpio o nombre de la persona",
//       "Categoria": "Categoría financiera general (ej. Transporte, Supermercado, Vivienda, Transferencias)",
//       "Subcategoria": "Subcategoría específica (ej. Viajes, Despensa, Arriendo)"
//     }
//   ]
  
//   Transacciones a analizar:
//   ${JSON.stringify(listadoParaGemini, null, 2)}
//   `;

//   const payload = {
//     contents: [{ parts: [{ text: prompt }] }],
//     // generationConfig: OBLIGA a Gemini a devolver solo JSON
//     generationConfig: {
//       temperature: 0.1, 
//       response_mime_type: "application/json" 
//     }
//   };

//   let modelName = modelo === "flash" ? "gemini-2.5-flash" : "gemini-2.5-pro";
//   const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  
//   try {
//     const response = UrlFetchApp.fetch(url, {
//       method: 'post',
//       contentType: 'application/json',
//       payload: JSON.stringify(payload),
//       muteHttpExceptions: true
//     });

//     const responseCode = response.getResponseCode();
//     const responseText = response.getContentText();
//     let json;

//     try {
//       json = JSON.parse(responseText);
//     } catch (e) {
//       throw new Error(`Respuesta API no JSON. Código: ${responseCode}. Text: ${responseText.substring(0, 100)}`);
//     }
    
//     // GESTIÓN DE CUOTA
//     if (responseCode === 429 || (json.error && json.error.status === 'RESOURCE_EXHAUSTED')) {
//       throw new Error('CUOTA_EXCEDIDA'); 
//     }

//     if (json.error || responseCode !== 200) {
//       throw new Error(`API Error ${responseCode}: ${json.error ? json.error.message : 'Desconocido'}`);
//     }

//     // Extraer y parsear respuesta JSON de Gemini
//     const rawContent = json.candidates[0].content.parts[0].text;
//     const clasificaciones = JSON.parse(rawContent);

//     // 3. Mapear resultados
//     let diccionarioNuevos = [];
    
//     clasificaciones.forEach(clasificacion => {
//       // Validamos que Gemini haya devuelto las propiedades esperadas
//       if (clasificacion.Comercio_Original) {
//         diccionarioNuevos.push(clasificacion);
        
//         // Actualizamos las transacciones en memoria
//         transacciones.forEach(t => {
//           if (t.Comercio_Original === clasificacion.Comercio_Original) {
//             t.Comercio_Limpio = clasificacion.Comercio_Limpio;
//             t.Categoria = clasificacion.Categoria;
//             t.Subcategoria = clasificacion.Subcategoria;
//           }
//         });
//       }
//     });

//     logSystemEvent('INFO', `Gemini ${modelo.toUpperCase()} Exitoso`, `Se clasificaron ${diccionarioNuevos.length} comercios/transferencias nuevas.`);
//     return diccionarioNuevos;

//   } catch (error) {
//     Logger.log(`Error en Gemini: ${error.message}`);
    
//     // Fallback Recursivo
//     if (error.message === 'CUOTA_EXCEDIDA') {
//       if (modelo === "pro") {
//         logSystemEvent('WARN', 'Cuota Pro Excedida', 'Iniciando Fallback a modelo Flash.');
//         return categorizeWithGemini(transacciones, "flash"); 
//       } else {
//          logSystemEvent('ERROR', 'Cuota Total Excedida', 'Se agotó la cuota Pro y Flash. Quedarán "Por Clasificar".');
//          return []; 
//       }
//     }

//     logSystemEvent('ERROR', `Fallo en Gemini (${modelo.toUpperCase()})`, error.message);
//     return []; 
//   }
// }

// /**
//  * Herramienta de auditoría robusta para consultar directamente a Google qué modelos 
//  * están vivos y disponibles para nuestra API Key.
//  */
// function checkAvailableModels() {
//   const apiKey = getEnv('GEMINI_API_KEY');
  
//   if (!apiKey) {
//     Logger.log("❌ ERROR: La API Key no existe o no está configurada en las variables.");
//     return;
//   }
  
//   // 1. Limpiamos cualquier salto de línea o espacio fantasma que corrompa la URL
//   const cleanApiKey = apiKey.trim();
//   // Usando el modelo insignia más reciente disponible en tu cuenta
//   const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;
  
//   try {
//     const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
//     const responseCode = response.getResponseCode();
//     const responseText = response.getContentText();
    
//     Logger.log(`=== AUDITORÍA DE CONEXIÓN ===`);
//     Logger.log(`Código HTTP: ${responseCode}`);
//     Logger.log(`Respuesta RAW: ${responseText}`);
    
//     if (!responseText) {
//       Logger.log("❌ ERROR CRÍTICO: Google devolvió una respuesta vacía. Verifica si hay restricciones de red o prueba regenerando la API Key.");
//       return;
//     }
    
//     const json = JSON.parse(responseText);
    
//     if (json.error) {
//       Logger.log(`❌ ERROR DE LA API: ${json.error.message}`);
//       return;
//     }
    
//     Logger.log("=== MODELOS DISPONIBLES EN TU CUENTA ===");
//     if (json.models) {
//       json.models.forEach(model => {
//         Logger.log(`Nombre: ${model.name} | Métodos: ${model.supportedGenerationMethods.join(", ")}`);
//       });
//     } else {
//       Logger.log("Formato inesperado: " + JSON.stringify(json).substring(0, 100));
//     }
    
//   } catch (error) {
//     Logger.log("❌ EXCEPCIÓN DEL SCRIPT: " + error.message);
//   }
// }

// /**
//  * Realiza la llamada a la API de Gemini con manejo robusto de errores y control de cuota.
//  * @param {Object} payload - Objeto JSON con el prompt y configuraciones.
//  * @param {string} [modelo="pro"] - Tipo de modelo a utilizar ("pro" o "flash").
//  * @returns {Object} Respuesta parseada de la API.
//  */
// function fetchGeminiAPI(payload, modelo = "pro") {
//   const apiKey = getEnv('GEMINI_API_KEY');
//   if (!apiKey) throw new Error('GEMINI_API_KEY no configurada.');

//   // Zero Hardcoding: Intentar obtener la versión del modelo desde variables de entorno,
//   // con un fallback de seguridad a la versión solicitada por la API.
//   const envProModel = getEnv('GEMINI_PRO_MODEL') || 'gemini-3.1-pro-preview';
//   const envFlashModel = getEnv('GEMINI_FLASH_MODEL') || 'gemini-3.1-flash-preview'; // Asumiendo paridad
  
//   const modelName = modelo === "flash" ? envFlashModel : envProModel;
//   const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  
//   const options = {
//     method: 'post',
//     contentType: 'application/json',
//     payload: JSON.stringify(payload),
//     muteHttpExceptions: true
//   };

//   try {
//     const response = UrlFetchApp.fetch(url, options);
//     const responseCode = response.getResponseCode();
//     const responseText = response.getContentText();
//     let json;

//     try {
//       json = JSON.parse(responseText);
//     } catch (e) {
//       throw new Error(`Respuesta API no JSON. Código: ${responseCode}. Text: ${responseText.substring(0, 100)}`);
//     }
    
//     // GESTIÓN DE CUOTA Y ERRORES
//     if (responseCode === 429 || (json.error && json.error.status === 'RESOURCE_EXHAUSTED')) {
//       throw new Error('CUOTA_EXCEDIDA'); 
//     }

//     if (json.error || responseCode !== 200) {
//       // Manejo específico para obsolescencia de modelos (404)
//       if (responseCode === 404 && json.error && json.error.message.includes('no longer available')) {
//         throw new Error(`MODELO_DEPRECADO: El modelo ${modelName} ya no está disponible. Actualiza las variables de entorno.`);
//       }
//       throw new Error(`API Error ${responseCode}: ${json.error ? json.error.message : 'Desconocido'}`);
//     }

//     return json;

//   } catch (error) {
//     console.error(`❌ Fallo en fetchGeminiAPI: ${error.message}`);
//     throw error;
//   }
// }

/**
 * Test unitario para validar el módulo de Gemini de forma aislada.
 */
function testGeminiIntegration() {
  // 1. Mock de transacciones que simulan la salida del parser
  const mockTransacciones = [
    {
      Comercio_Original: "UBER TRIP HELP.UBER.C",
      Tipo: "Crédito",
      Comentario: "N/A"
    },
    {
      Comercio_Original: "AMZN MKTP US*123",
      Tipo: "Crédito",
      Comentario: "N/A"
    },
    {
      Comercio_Original: "Juan Perez",
      Tipo: "Transferencia",
      Comentario: "Pago cuota asado"
    }
  ];

  console.log("Iniciando prueba de categorizeWithGemini...");
  
  // 2. Invocamos la función principal de gemini.gs
  const clasificaciones = categorizeWithGemini(mockTransacciones, "pro");
  
  // 3. Verificamos la salida
  if (clasificaciones && clasificaciones.length > 0) {
    console.log("✅ ÉXITO: Gemini devolvió el siguiente JSON estructurado:");
    console.log(JSON.stringify(clasificaciones, null, 2));
  } else {
    console.error("❌ FALLO: Gemini devolvió un arreglo vacío. Revisa la pestaña 'Logs'.");
  }
}