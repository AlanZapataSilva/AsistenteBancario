/**
 * Archivo: gemini.gs
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.gs para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Conexión con la API de Google Gemini utilizando el estándar REST oficial.
 * Implementa Caché de Diccionario para no quemar tokens en comercios ya conocidos,
 * y una cascada de resiliencia multi-modelo para garantizar alta disponibilidad.
 */

'use strict';

/**
 * Obtiene el modelo oficial más reciente disponible desde la API de Gemini para la familia indicada.
 * Utiliza CacheService. Si falla la consulta a la API o no encuentra coincidencias, retorna null en lugar de lanzar una excepción.
 * @private
 * @param {string} apiKey - Llave de la API.
 * @param {string} family - Familia del modelo ("pro" o "flash").
 * @returns {string|null} El nombre exacto del modelo (ej. "gemini-2.5-pro") o null si falla.
 */
function _getDynamicGeminiModelName(apiKey, family) {
  try {
    const cache = CacheService.getScriptCache();
    const cacheKey = `GEMINI_LATEST_MODEL_${family.toUpperCase()}`;
    const cachedModel = cache.get(cacheKey);
    if (cachedModel) return cachedModel;

    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });

    if (res.getResponseCode() !== 200) {
      logSystemEvent('WARN', `Auto-Descubrimiento Gemini (${family})`, `HTTP ${res.getResponseCode()}: ${res.getContentText().substring(0, 150)}`);
      return null;
    }

    const json = JSON.parse(res.getContentText());
    if (!json.models || !Array.isArray(json.models)) return null;

    const regexOficial = new RegExp(`^models/gemini-\\d+\\.\\d+-${family}(?:-preview|-latest)?$`, 'i');

    const availableModels = json.models.filter(m => 
      m.name &&
      regexOficial.test(m.name) && 
      Array.isArray(m.supportedGenerationMethods) &&
      m.supportedGenerationMethods.includes("generateContent")
    );

    if (availableModels.length === 0) return null;

    availableModels.sort((a, b) => b.name.localeCompare(a.name));
    
    const selectedModel = availableModels[0].name.replace('models/', '');
    cache.put(cacheKey, selectedModel, 21600); // Guardar en caché 6 horas
    
    return selectedModel;
  } catch (err) {
    logSystemEvent('WARN', `Error en _getDynamicGeminiModelName (${family})`, err.message);
    return null;
  }
}

/**
 * Realiza la llamada a la API de Gemini intentando en una cascada de modelos.
 * @private
 * @param {Object} payload - Objeto JSON con el prompt y configuración.
 * @returns {Object} Respuesta parseada de la API de Gemini.
 */
function _fetchGeminiAPIWithCascade(payload) {
  const apiKey = getEnv('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada.');

  // Construir la lista de modelos de forma segura y perezosa
  const dynamicPro = _getDynamicGeminiModelName(apiKey, "pro");
  const dynamicFlash = _getDynamicGeminiModelName(apiKey, "flash");

  const staticFallbacks = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
    "gemini-1.5-pro",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash-8b"
  ];

  const rawCascade = [dynamicPro, dynamicFlash, ...staticFallbacks];
  // Eliminar nulos y duplicados manteniendo el orden de prioridad
  const MODEL_CASCADE = rawCascade.filter((model, index) => model && rawCascade.indexOf(model) === index);

  for (let i = 0; i < MODEL_CASCADE.length; i++) {
    const modelName = MODEL_CASCADE[i];
    logSystemEvent('INFO', `Intento de IA (${i + 1}/${MODEL_CASCADE.length})`, `Usando modelo: ${modelName}`);
    
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    };

    try {
      const response = UrlFetchApp.fetch(url, options);
      const responseCode = response.getResponseCode();
      const responseText = response.getContentText();
      let json;

      try { 
        json = JSON.parse(responseText); 
      } catch (e) { 
        logSystemEvent('WARN', `Fallo de parseo JSON HTTP en ${modelName}`, responseText.substring(0, 100));
        continue;
      }

      if (responseCode === 200 && json && !json.error && json.candidates && json.candidates.length > 0) {
        return json;
      }

      const errorMsg = json && json.error ? json.error.message : `HTTP ${responseCode}`;
      logSystemEvent('WARN', `Modelo ${modelName} falló`, errorMsg);

    } catch (networkError) {
      logSystemEvent('WARN', `Error de red invocando ${modelName}`, networkError.message);
    }
  }

  throw new Error('Todos los modelos de la cascada de supervivencia fallaron o están saturados.');
}

/**
 * Clasifica transacciones financieras usando IA (Batch).
 * @param {Array<Object>} transacciones - Lista de transacciones a procesar.
 * @returns {Array<Object>} Arreglo con las nuevas entradas para el diccionario.
 */
function categorizeWithGemini(transacciones) {
  if (!transacciones || transacciones.length === 0) return [];

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
  
  const prompt = `
  Eres un experto financiero chileno. Categoriza la siguiente lista de transacciones bancarias (entregada en formato JSON).

  Reglas de análisis estricto:
  1. Si el "Tipo" es "Transferencia" y tiene un "Comentario_Adjunto" distinto a "N/A", usa OBLIGATORIAMENTE ese comentario para deducir la categoría exacta del gasto o ingreso (ej. si dice "Pago arriendo", categoriza como "Vivienda" / "Arriendo").
  2. Si el "Tipo" es "Débito" o "Crédito", ignora el comentario y analiza el nombre en "Comercio_Original" (ej. "UBER TRIP" -> "Transporte" / "Viajes").
  3. El campo "Comercio_Limpio" debe contener el nombre comercial legible (ej. "Starbucks", "PedidosYa"), o mantener el nombre de la persona si es una transferencia personal.

  Devuelve EXCLUSIVAMENTE un arreglo JSON con esta estructura exacta para cada elemento analizado:
  [
    {
      "Comercio_Original": "DEBE ser exactamente igual al que recibiste de entrada para no romper la base de datos",
      "Comercio_Limpio": "Nombre comercial limpio o nombre de la persona",
      "Categoria": "Categoría financiera general (ej. Transporte, Supermercado, Vivienda, Salud, Entretenimiento, Servicios)",
      "Subcategoria": "Subcategoría específica (ej. Viajes, Despensa, Arriendo, Farmacia, Restaurantes, Luz/Agua)"
    }
  ]

  Transacciones a analizar:
  ${JSON.stringify(listadoParaGemini, null, 2)}
  `;
  
  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { 
      temperature: 0.1, 
      response_mime_type: "application/json" 
    }
  };

  try {
    const jsonResponse = _fetchGeminiAPIWithCascade(payload);
    
    if (!jsonResponse.candidates || jsonResponse.candidates.length === 0) {
      throw new Error('La respuesta de Gemini no incluyó candidatos válidos.');
    }

    const rawContent = jsonResponse.candidates[0].content.parts[0].text;
    // Sanitizar posibles bloques de código Markdown
    const cleanJsonText = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    const clasificaciones = JSON.parse(cleanJsonText);

    if (!Array.isArray(clasificaciones)) {
      throw new Error('La respuesta parseada de Gemini no es un arreglo JSON.');
    }

    let diccionarioNuevos = [];
    clasificaciones.forEach(clasificacion => {
      if (clasificacion && clasificacion.Comercio_Original) {
        diccionarioNuevos.push(clasificacion);
        transacciones.forEach(t => {
          if (t.Comercio_Original === clasificacion.Comercio_Original) {
            t.Comercio_Limpio = clasificacion.Comercio_Limpio || t.Comercio_Original;
            t.Categoria = clasificacion.Categoria || 'Por Clasificar Automáticamente';
            t.Subcategoria = clasificacion.Subcategoria || '';
          }
        });
      }
    });

    logSystemEvent('INFO', 'Gemini IA Exitoso', `Se clasificaron ${diccionarioNuevos.length} comercio(s) nuevo(s).`);
    return diccionarioNuevos;

  } catch (error) {
    logSystemEvent('ERROR', 'Colapso total de Gemini API', error.message);
    return []; // Devolvemos vacío para que queden como "Por Clasificar Automáticamente" en Sheets
  }
}

/**
 * Test unitario para validar el módulo de Gemini de forma aislada.
 */
function testGeminiIntegration() {
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
  
  const clasificaciones = categorizeWithGemini(mockTransacciones);
  
  if (clasificaciones && clasificaciones.length > 0) {
    console.log("✅ ÉXITO: Gemini devolvió el siguiente JSON estructurado:");
    console.log(JSON.stringify(clasificaciones, null, 2));
  } else {
    console.error("❌ FALLO: Gemini devolvió un arreglo vacío. Revisa la pestaña 'Logs'.");
  }
}
