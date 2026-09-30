/**
 * Archivo: types.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Definiciones de tipos (solo JSDoc, sin código en tiempo de ejecución).
 * Sirven para la verificación estática con `tsc --checkJs` y como documentación de los DTOs.
 */

/**
 * Transacción normalizada, tal como la producen los parsers y la consume la capa de datos.
 * @typedef {object} Transaction
 * @property {string} [ID_Unico] - ID del mensaje de Gmail (o `TG_<id>` en Telegram).
 * @property {string} Fecha - `yyyy-MM-dd`.
 * @property {string} Hora - `HH:mm` o `HH:mm:ss`.
 * @property {string} Comercio_Original - Texto tal como llegó del banco (tras resolución de alias).
 * @property {string} Comercio_Limpio - Nombre legible.
 * @property {string} Categoria - Categoría o `Por Clasificar Automáticamente`.
 * @property {string} Subcategoria - Subcategoría (puede ser vacía).
 * @property {number} Monto - Monto en CLP (negativo en anulaciones).
 * @property {number} Cuotas - Número de cuotas (mínimo 1).
 * @property {string} Tipo - `Crédito`, `Débito`, `Transferencia`, `Cheque`, `Gasto/Pago`, `Efectivo/Manual`…
 * @property {string} Origen - `BCI`, `TENPO`, `MACH`, `BANCO_DE_CHILE`, `Telegram`…
 * @property {string} [Comentario] - Mensaje adjunto a una transferencia.
 */

/**
 * Campos de una transacción que se envían a Notion.
 * @typedef {Pick<Transaction, 'ID_Unico'|'Fecha'|'Comercio_Limpio'|'Categoria'|'Monto'|'Tipo'|'Origen'>} NotionTransaction
 */

/**
 * Regla del diccionario de comercios (una fila de la hoja `Diccionario`).
 * @typedef {object} DictionaryEntry
 * @property {string} Comercio_Original
 * @property {string} Comercio_Limpio
 * @property {string} Categoria
 * @property {string} Subcategoria
 */

/**
 * Valores que el diccionario devuelve para un comercio conocido.
 * @typedef {object} DictionaryValue
 * @property {string} Comercio_Limpio
 * @property {string} Categoria
 * @property {string} Subcategoria
 */

/**
 * Elemento mínimo que necesita el clasificador (una transacción o un comercio pendiente).
 * @typedef {object} ClassifiableItem
 * @property {string} Comercio_Original
 * @property {string} Tipo
 * @property {string} [Comentario]
 * @property {string} [Comercio_Limpio]
 * @property {string} [Categoria]
 * @property {string} [Subcategoria]
 */

/**
 * Motivo de fallo de una llamada a Gemini.
 * @typedef {'auth'|'not_found'|'quota_zero'|'rate_limited'|'overloaded'|'bad_request'|'empty'|'truncated'|'invalid_response'|'cooldown'|'deadline'|'unknown'} GeminiFailureKind
 */

/**
 * @typedef {object} GeminiFailure
 * @property {GeminiFailureKind} kind
 * @property {string} message - Descripción legible y sin secretos.
 */

/**
 * Un intento individual contra un modelo (para diagnóstico).
 * @typedef {object} GeminiAttempt
 * @property {string} model
 * @property {number} code - Código HTTP (0 = error de red).
 * @property {GeminiFailureKind|'ok'|'network'} kind
 * @property {string} [message]
 * @property {number} ms - Duración del intento.
 * @property {'full'|'noThinking'|'noSchema'} variant - Variante de la petición usada.
 */

/**
 * Petición genérica a Gemini.
 * @typedef {object} GeminiRequest
 * @property {string} prompt
 * @property {object} [schema] - `responseSchema` (salida estructurada).
 * @property {number} [maxOutputTokens]
 * @property {(text: string) => (string|null)} [validate] - Devuelve un mensaje de error o null si la respuesta es válida.
 */

/**
 * @typedef {object} GeminiCallOptions
 * @property {number} [deadlineMs] - Presupuesto total de la llamada.
 * @property {boolean} [ignoreCooldown] - Intenta también los modelos en enfriamiento.
 */

/**
 * @typedef {object} GeminiCallResult
 * @property {boolean} ok
 * @property {string} text - Texto de la respuesta (vacío si falló).
 * @property {string|null} model - Modelo que respondió.
 * @property {GeminiAttempt[]} attempts
 * @property {GeminiFailure|null} failure
 */

/**
 * Resultado de clasificar un lote de transacciones.
 * @typedef {object} ClassificationResult
 * @property {number} total - Transacciones recibidas.
 * @property {number} resolvedByDictionary
 * @property {number} resolvedByAI
 * @property {number} pending - Siguen sin clasificar.
 * @property {DictionaryEntry[]} newDictionaryEntries - Reglas nuevas para persistir en el diccionario.
 * @property {GeminiFailure|null} failure - Último fallo de IA (null si no hubo).
 * @property {string|null} model - Modelo que clasificó.
 * @property {GeminiAttempt[]} attempts
 */

/**
 * Posiciones (base 0) de cada columna de la hoja `Transacciones`, resueltas desde su fila de encabezados.
 * @typedef {object} TransactionColumns
 * @property {number} ID_Unico
 * @property {number} Fecha
 * @property {number} Hora
 * @property {number} Comercio_Original
 * @property {number} Comercio_Limpio
 * @property {number} Categoria
 * @property {number} Subcategoria
 * @property {number} Monto
 * @property {number} Cuotas
 * @property {number} Tipo
 * @property {number} Origen
 */

/**
 * @typedef {object} TelegramChat
 * @property {number|string} id
 */

/**
 * @typedef {object} TelegramMessage
 * @property {number} message_id
 * @property {string} [text]
 * @property {TelegramChat} chat
 */

/**
 * @typedef {object} TelegramCallbackQuery
 * @property {string} id
 * @property {string} [data]
 * @property {{chat: TelegramChat}} message
 */

/**
 * @typedef {object} TelegramUpdate
 * @property {TelegramMessage} [message]
 * @property {TelegramMessage} [edited_message]
 * @property {TelegramCallbackQuery} [callback_query]
 */
