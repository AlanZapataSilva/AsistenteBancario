/**
 * Archivo: schema.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Esquema de la hoja `Transacciones`: relaciona los campos del DTO con los
 * encabezados de la hoja y resuelve posiciones de columna desde la fila de encabezados,
 * en vez de fijar índices a mano.
 */

/**
 * Campo del DTO → encabezado de la hoja `Transacciones`.
 * El orden de las claves define el orden de las columnas al escribir filas nuevas.
 */
const TRANSACTION_FIELDS = Object.freeze({
  ID_Unico: 'ID_Unico',
  Fecha: 'Fecha',
  Hora: 'Hora',
  Comercio_Original: 'Comercio Original',
  Comercio_Limpio: 'Comercio Limpio',
  Categoria: 'Categoría',
  Subcategoria: 'Subcategoría',
  Monto: 'Monto',
  Cuotas: 'Cuotas',
  Tipo: 'Tipo',
  Origen: 'Origen',
});

/**
 * Resuelve la posición (base 0) de cada campo a partir de la fila de encabezados de la hoja.
 * @param {any[]} headerRow - Primera fila de la hoja `Transacciones`.
 * @returns {TransactionColumns}
 * @throws {Error} Si falta alguno de los encabezados esperados.
 */
function getTransactionColumns(headerRow) {
  const headers = headerRow.map(h => String(h).trim());
  /** @type {Record<string, number>} */
  const columns = {};
  Object.keys(TRANSACTION_FIELDS).forEach(field => {
    const header = /** @type {Record<string, string>} */ (TRANSACTION_FIELDS)[field];
    const index = headers.indexOf(header);
    if (index === -1) {
      throw new Error(`Falta la columna "${header}" en la hoja ${CONFIG.SHEETS.TRANSACTIONS}.`);
    }
    columns[field] = index;
  });
  return /** @type {TransactionColumns} */ (columns);
}

/**
 * Convierte una transacción en la fila que se escribe en la hoja (orden de `TRANSACTION_FIELDS`).
 * @param {Transaction} tx
 * @returns {any[]}
 */
function transactionToRow(tx) {
  const record = /** @type {Record<string, any>} */ (tx);
  return Object.keys(TRANSACTION_FIELDS).map(field => record[field]);
}

/**
 * Normaliza un nombre de comercio para usarlo como clave de comparación (diccionario, agrupación).
 * Colapsa los espacios internos: las reglas antiguas del diccionario guardadas con espacios de
 * relleno ("ANTHROPIC* CLAUDE SUB    +1415…") siguen coincidiendo con los comercios ya limpios.
 * @param {any} text
 * @returns {string}
 */
function normalizeMerchantKey(text) {
  return String(text === null || text === undefined ? '' : text)
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
