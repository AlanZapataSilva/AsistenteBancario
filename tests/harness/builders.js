'use strict';

/**
 * Constructores de correos bancarios sintéticos, derivados de las expresiones regulares de
 * `config.gs`. No son correos reales (ver docs/AUDITORIA.md, riesgo de fixtures): sirven para
 * caracterizar el comportamiento de los parsers antes y después de cada refactor.
 */

/**
 * Tabla HTML con filas "etiqueta → valor", como la que producen los correos de BCI y Banco de Chile.
 * @param {Record<string, string>} rows
 * @returns {string}
 */
function htmlTable(rows) {
  const body = Object.entries(rows)
    .map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`)
    .join('\n');
  return `<html><body><table>\n${body}\n</table></body></html>`;
}

/**
 * Correo de BCI.
 * @param {object} p
 * @param {string} [p.subject]
 * @param {string} [p.fecha] - DD/MM/YYYY
 * @param {string} [p.hora] - HH:MM
 * @param {string} p.monto - Como aparece en el correo, ej. "24.590".
 * @param {string} p.comercio
 * @param {string} [p.cuotas]
 * @param {string} [p.mensaje]
 * @param {string} [p.extraHtml] - HTML libre agregado al final (ej. pie de página).
 * @returns {{from: string, subject: string, body: string, date: Date}}
 */
function bciEmail(p) {
  /** @type {Record<string, string>} */
  const rows = {
    Fecha: p.fecha ?? '27/09/2026',
    Hora: p.hora ?? '23:41',
    Monto: `$${p.monto}`,
    Comercio: p.comercio,
  };
  if (p.cuotas) rows.Cuotas = p.cuotas;
  if (p.mensaje) rows.Mensaje = p.mensaje;
  return {
    from: 'Bci <notificaciones@bci.cl>',
    subject: p.subject ?? 'Notificación de uso de tu tarjeta de crédito',
    body: htmlTable(rows) + (p.extraHtml ?? ''),
    date: new Date(Date.UTC(2026, 8, 28, 2, 41)),
  };
}

/**
 * Correo de Tenpo (texto plano).
 * @param {object} p
 * @param {string} p.monto
 * @param {string} p.comercio
 * @param {string} [p.fecha] - DD-MM-YYYY
 * @param {string} [p.hora]
 */
function tenpoEmail(p) {
  const plainBody = [
    'Hola, realizaste una compra con tu tarjeta Tenpo.',
    '',
    `Fecha:\n${p.fecha ?? '27-09-2026'}`,
    `Hora:\n${p.hora ?? '19:05:33'}`,
    `Monto transacción:\n$${p.monto}`,
    `Comercio:\n${p.comercio}`,
  ].join('\n');
  return {
    from: 'Tenpo <no-reply@tenpo.cl>',
    subject: 'Compra',
    plainBody,
    date: new Date(Date.UTC(2026, 8, 27, 22, 5)),
  };
}

/**
 * Correo de MACH.
 * @param {object} p
 * @param {'credito'|'debito'} p.kind
 * @param {string} p.monto
 * @param {string} p.comercio
 * @param {string} [p.cuotas]
 */
function machEmail(p) {
  const fechaHora = 'Fecha y hora\n27/09/2026 - 18:20';
  const plainBody =
    p.kind === 'credito'
      ? `${fechaHora}\nComercio ${p.comercio} Monto pagado $${p.monto}\nCantidad de cuotas ${p.cuotas ?? '1'}`
      : `${fechaHora}\nComercio\n${p.comercio}\nTotal\n$${p.monto}`;
  return {
    from: 'MACH <no-reply@mail.machbank.cl>',
    subject:
      p.kind === 'credito'
        ? 'Has hecho una compra con tu Tarjeta de Crédito MACHBANK'
        : 'Tu compra con MACH',
    plainBody,
    date: new Date(Date.UTC(2026, 8, 27, 21, 20)),
  };
}

/**
 * Correo del Banco de Chile (compra en párrafo o cobro de cheque en lista).
 * @param {object} p
 * @param {'compra'|'cheque'} p.kind
 * @param {string} p.monto
 * @param {string} [p.comercio]
 * @param {string} [p.cheque]
 * @param {string} [p.subject]
 */
function bancoChileEmail(p) {
  const body =
    p.kind === 'compra'
      ? `<p>Se realizó una compra por $${p.monto} en ${p.comercio} el 27/09/2026 20:15 con tu tarjeta.</p>`
      : `<ul><li>Número de cheque: ${p.cheque}</li><li>Monto: $${p.monto}</li><li>Fecha cobro: 27/09/2026</li></ul>`;
  return {
    from: 'Banco de Chile <serviciodetransferencias@bancochile.cl>',
    subject:
      p.subject ??
      (p.kind === 'compra' ? 'Compra con Tarjeta de Crédito' : 'Cobro de cheque para depósito'),
    body,
    date: new Date(Date.UTC(2026, 8, 27, 23, 15)),
  };
}

/**
 * Convierte un correo sintético en un mensaje con la interfaz de GmailMessage.
 * @param {{from: string, subject: string, body?: string, plainBody?: string, date?: Date, id?: string}} init
 * @returns {any}
 */
function asMessage(init) {
  const date = init.date ?? new Date(Date.UTC(2026, 8, 28, 3, 0));
  return {
    getId: () => init.id ?? 'msg_test',
    getFrom: () => init.from,
    getSubject: () => init.subject,
    getBody: () => init.body ?? '',
    getPlainBody: () => init.plainBody ?? '',
    getDate: () => date,
  };
}

module.exports = { htmlTable, bciEmail, tenpoEmail, machEmail, bancoChileEmail, asMessage };
