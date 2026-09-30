/**
 * Archivo: utils.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Utilidades puras y deterministas (sin servicios de Google).
 */

/**
 * Formatea un monto en pesos chilenos con punto como separador de miles (ej. 1500000 → "1.500.000").
 * No depende de `Intl`, cuyo soporte de locales en Apps Script no es fiable.
 * @param {number|string} amount
 * @returns {string}
 */
function formatClp(amount) {
  const rounded = Math.round(Number(amount) || 0);
  const digits = String(Math.abs(rounded)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return rounded < 0 ? `-${digits}` : digits;
}

/**
 * Mensaje legible de un valor capturado en un `catch` (que puede no ser un `Error`).
 * @param {unknown} error
 * @returns {string}
 */
function getErrorMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) {
    return String(/** @type {{message: unknown}} */ (error).message);
  }
  return String(error);
}

/**
 * Traza de pila de un valor capturado en un `catch` (o su mensaje si no hay pila).
 * @param {unknown} error
 * @returns {string}
 */
function getErrorStack(error) {
  if (error && typeof error === 'object' && 'stack' in error) {
    const stack = /** @type {{stack: unknown}} */ (error).stack;
    if (stack) return String(stack);
  }
  return getErrorMessage(error);
}
