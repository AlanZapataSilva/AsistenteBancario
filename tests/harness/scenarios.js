'use strict';

/**
 * Escenarios reutilizables: entornos preparados y atajos para sembrar datos.
 */

const { createEnvironment, SCHEMA, REALISTIC_MODELS } = require('./load-gas');
const { bciEmail } = require('./builders');

/**
 * Entorno con la etiqueta de Gmail ya creada (lo que hace `installApp`).
 * @param {Parameters<typeof createEnvironment>[0]} [opts]
 */
function envWithLabel(opts) {
  const env = createEnvironment(opts);
  env.GmailApp.createLabel(SCHEMA.LABEL_PROCESSED);
  return env;
}

/**
 * Agrega un hilo de compra BCI.
 * @param {ReturnType<typeof createEnvironment>} env
 * @param {{id?: string, comercio?: string, monto?: string, subject?: string, mensaje?: string}} [p]
 */
function addBciThread(env, p = {}) {
  return env.GmailApp.addThread([
    {
      ...bciEmail({
        monto: p.monto ?? '10.000',
        comercio: p.comercio ?? 'COMERCIO DEMO',
        subject: p.subject,
        mensaje: p.mensaje,
      }),
      id: p.id ?? 'm1',
    },
  ]);
}

/**
 * Agrega una fila a Transacciones.
 * @param {ReturnType<typeof createEnvironment>} env
 * @param {string} id
 * @param {string} comercio
 * @param {string} categoria
 * @param {{fecha?: string, hora?: string, monto?: number, tipo?: string}} [extra]
 */
function addTxRow(env, id, comercio, categoria, extra = {}) {
  env.tx.appendRow([
    id,
    extra.fecha ?? '2026-09-27',
    extra.hora ?? '10:00',
    comercio,
    comercio,
    categoria,
    '',
    extra.monto ?? 1000,
    1,
    extra.tipo ?? 'Débito',
    'BCI',
  ]);
}

/**
 * Comportamientos que hacen fallar con `reply` a todos los modelos indicados.
 * @param {string[]} models
 * @param {{code: number, body: any}} reply
 * @returns {Record<string, {code: number, body: any}>}
 */
function failAll(models, reply) {
  return Object.fromEntries(models.map(m => [m, reply]));
}

module.exports = { envWithLabel, addBciThread, addTxRow, failAll, SCHEMA, REALISTIC_MODELS };
