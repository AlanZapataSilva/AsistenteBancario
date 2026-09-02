/**
Archivo: config.gs
Autor: Alan Zapata Silva
Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
Este codigo es Source-Available. NO es Open Source.
Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
Revise el archivo LICENSE.gs para conocer los terminos vinculantes.
*/

/**
 * @fileoverview Configuración global, reglas de negocio y gestión de variables de entorno.
 * Arquitectura V5 - Zero Hardcoding.
 */

/**
 * Obtiene una variable de entorno desde PropertiesService (Memoria Segura).
 * @param {string} key - Clave de la variable (ej. 'TELEGRAM_TOKEN').
 * @returns {string|null} Valor de la variable o null si no existe.
 */
function getEnv(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

/**
 * Guarda o actualiza una variable de entorno en PropertiesService.
 * Ideal para ejecutar desde la consola una sola vez al inicializar el proyecto.
 * @param {string} key - Clave de la variable.
 * @param {string} value - Valor secreto.
 */
function setEnv(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

/**
 * Constantes estructurales del sistema.
 * Utilizamos Object.freeze para asegurar su inmutabilidad en tiempo de ejecución.
 */
const CONFIG = Object.freeze({
  SHEETS: {
    TRANSACTIONS: 'Transacciones',
    DICTIONARY: 'Diccionario',
    LOGS: 'Logs'
  },
  HEADERS: {
    TRANSACTIONS: ['ID_Unico', 'Fecha', 'Hora', 'Comercio Original', 'Comercio Limpio', 'Categoría', 'Subcategoría', 'Monto', 'Cuotas', 'Tipo', 'Origen'],
    DICTIONARY: ['Comercio Banco','Comercio Limpio', 'Categoría Gemini', 'Subcategoría', 'Auditoría Manual (Check)'],
    LOGS: ['Timestamp', 'Nivel', 'Mensaje', 'Stack Trace']
  },
  GMAIL: {
    LABEL_PROCESSED: 'SaaS_Finanzas/Procesado'
  }
});

/**
 * Lógica de negocio específica del Banco BCI.
 * Asuntos de correo válidos y Expresiones Regulares de extracción.
 */
const BCI_LOGIC = Object.freeze({
  SUBJECTS: [
    'Aviso de Transferencia de Fondos',
    'Notificación de uso de tu tarjeta de crédito',
    'Comprobante de Compra Tarjeta de Débito',
    'Pago de Cuenta en Linea',
    'Pago crédito consumo'
  ],
  REGEX: {
    // El ">\s*" inicial asegura que solo lea los títulos de las tablas HTML, ignorando párrafos de texto
    FECHA: />\s*(?:Fecha|Fecha de abono|Fecha y hora)[\s\S]*?<td[^>]*>\s*([\d\/\-]+)/i,
    HORA: />\s*(?:Hora|Fecha y hora)[\s\S]*?<td[^>]*>\s*(?:[\d\/\-]+\s+)?([\d:]+)/i,
    MONTO: />\s*(?:Monto|Monto transferido|Monto Total)[\s\S]*?<td[^>]*>\s*(?:\$|USD)?\s*([\d\.,]+)/i,
    COMERCIO: />\s*(?:Comercio|Nombre|Cuenta de destino|Nombre del destinatario)[\s\S]*?<td[^>]*>\s*(.+?)\s*<\/td>/i,
    CUOTAS: />\s*Cuotas[\s\S]*?<td[^>]*>\s*(\d+)/i,
    MENSAJE: />\s*(?:Mensaje|Comentario)[\s\S]*?<td[^>]*>\s*([\s\S]+?)\s*<\/td>/i
  }
});

/**
 * Lógica de negocio específica de Tenpo.
 * Basado en la extracción de texto plano (PlainBody) del correo.
 */
const TENPO_LOGIC = Object.freeze({
  SUBJECTS: [
    'Compra',
    'Comprobante de pago exitoso'
  ],
  REGEX: {
    // Busca "Fecha:" seguido de saltos de línea y atrapa DD-MM-YYYY
    FECHA: /Fecha:[\s\n]*([\d\-]{10})/i,
    // Busca "Hora:" seguido de saltos de línea y atrapa HH:MM:SS
    HORA: /Hora:[\s\n]*([\d:]{8})/i,
    // El . atrapa la "ó" codificada, seguido de $ y el número
    MONTO: /Monto transacci.n:[\s\n]*\$?([\d\.]+)/i,
    // Atrapa todo el texto en la línea inmediatamente debajo de "Comercio:"
    COMERCIO: /Comercio:[\s\n]*([^\n]+)/i 
  }
});

/**
 * Lógica de negocio específica de MACH.
 * Maneja estructuras verticales (Débito) y horizontales (Crédito).
 */
const MACH_LOGIC = Object.freeze({
  SUBJECTS: [
    'Tu compra con MACH',
    'Has hecho una compra con tu Tarjeta de Crédito MACHBANK'
  ],
  REGEX: {
    // Busca "Fecha y hora" o "Fecha y hora de pago" y extrae DD/MM/YYYY y HH:MM
    FECHA_HORA: /Fecha y hora(?: de pago)?[\s\n]*([\d\/]{10})\s*-\s*([\d:]{5})/i,
    // Busca "Total" (Débito) o "Monto pagado" (Crédito)
    MONTO: /(?:Total|Monto pagado)[\s\n]*\$([\d\.]+)/i,
    // Comercio en Crédito (horizontal)
    COMERCIO_CREDITO: /Comercio\s+(.+?)\s+Monto pagado/i,
    // Comercio en Débito (vertical)
    COMERCIO_DEBITO: /Comercio[\s\n]+([^\n]+)/i,
    // Busca cantidad de cuotas (solo presente en crédito)
    CUOTAS: /Cantidad de cuotas[\s\n]*(\d+)/i
  }
});

/**
 * Lógica de negocio específica del Banco de Chile.
 * Maneja compras (Débito/Crédito en párrafo) y cobro de Cheques (en lista).
 */
const BANCOCHILE_LOGIC = Object.freeze({
  SUBJECTS: [
    'Cargo en Cuenta',
    'Compra con Tarjeta de Crédito',
    'Cobro de cheque para depósito'
  ],
  REGEX: {
    MONTO: /(?:compra por|Monto:)\s*\$?\s*([\d\.]+)/i,
    COMERCIO_COMPRA: / en \s*(.*?)\s* el \s*\d{2}\/\d{2}\/\d{4}/i,
    CHEQUE_NUM: /N(?:ú|&uacute;|u)mero de cheque:\s*(\d+)/i,
    FECHA: /(?: el |Fecha cobro:\s*)([\d\/]{10})/i,
    HORA: / el \s*[\d\/]{10}\s*([\d:]+)/i,
    MENSAJE: />\s*(?:Mensaje|Comentario)[\s\S]*?<td[^>]*>\s*([\s\S]+?)\s*<\/td>/i
  }
});

/**
 * Capa de Resolución de Entidades (Entity Resolution).
 * Si el comercio original contiene alguno de estos patrones (Regex), 
 * se forzará su nombre limpio antes de consultar a Gemini o a la base de datos.
 * Esto evita duplicados, alucinaciones de IA y agrupa sucursales.
 */
const MERCHANT_ALIASES = [
  { pattern: /UBER/i, cleanName: "Uber" },
  { pattern: /CABIFY/i, cleanName: "Cabify" },
  { pattern: /COPEC/i, cleanName: "Copec" }, // Atrapa "Copec Zervo", "Copec App", etc.
  { pattern: /MERCADO\s*LIBRE|MELI/i, cleanName: "Mercado Libre" },
  { pattern: /PEDIDOS\s*YA/i, cleanName: "PedidosYa" },
  { pattern: /RAPPI/i, cleanName: "Rappi" },
  { pattern: /LIDER/i, cleanName: "Lider" },
  { pattern: /JUMBO/i, cleanName: "Jumbo" },
  { pattern: /EII/i, cleanName: "Echeverria Izquierdo" },
  { pattern: /LIME\*RIDE/i, cleanName: "Lime" },
  { pattern: /AHUM/i, cleanName: "Farmacias Ahumada" },
  { pattern: /C.\s*VERDE/i, cleanName: "Farmacias Cruz Verde" },
  { pattern: /SBX/i, cleanName: "Starbucks" },
  { pattern: /STARBUCKS/i, cleanName: "Starbucks" }
  
];