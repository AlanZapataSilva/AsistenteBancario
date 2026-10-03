/**
 * Archivo: parser.js
 * Autor: Alan Zapata Silva
 * Copyright 2026 Alan Zapata Silva. Todos los derechos reservados.
 * Este codigo es Source-Available. NO es Open Source.
 * Queda estrictamente prohibida su modificacion, creacion de obras derivadas y uso comercial.
 * Revise el archivo LICENSE.js para conocer los terminos vinculantes.
 */

/**
 * @fileoverview Motor de Transformación (ETL - Transform).
 * Procesa el mensaje de Gmail, aplica Regex para extraer datos financieros,
 * sanitiza entidades HTML y empaqueta el resultado en un DTO estándar.
 */

/**
 * Extrae el dominio de la dirección del remitente de un encabezado From
 * (`"Nombre" <usuario@dominio.cl>` o `usuario@dominio.cl`), en minúsculas.
 * @private
 * @param {string} fromHeader
 * @returns {string} Dominio, o '' si no se pudo determinar.
 */
function _senderDomain(fromHeader) {
  const angle = fromHeader.match(/<([^>]+)>/);
  const address = (angle ? angle[1] : fromHeader).trim().toLowerCase();
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1).replace(/[>\s]+$/g, '');
}

/**
 * Indica si un dominio es `root` o uno de sus subdominios (`mail.machbank.cl` ∈ `machbank.cl`).
 * Evita que dominios parecidos (`tenpo-promos.xyz`) pasen por un banco.
 * @private
 * @param {string} domain
 * @param {string} root
 * @returns {boolean}
 */
function _isDomainOf(domain, root) {
  return domain === root || domain.endsWith('.' + root);
}

/**
 * Router / Dispatcher Central con Resolución de Entidades.
 * Identifica el banco emisor por el DOMINIO del remitente (no por coincidencia de texto) y
 * delega la extracción al parser específico de ese banco.
 * @param {GoogleAppsScript.Gmail.GmailMessage} message - El mensaje de Gmail.
 * @returns {Transaction|null} El DTO estandarizado o null si el banco no está soportado.
 */
function parseBankEmail(message) {
  const sender = message.getFrom().toLowerCase();
  const domain = _senderDomain(sender);
  /** @type {Transaction|null} */
  let dto;

  try {
    // 1. Enrutadores
    if (_isDomainOf(domain, 'bci.cl')) {
      dto = parseBciEmail(message);
    } else if (_isDomainOf(domain, 'tenpo.cl')) {
      dto = parseTenpoEmail(message);
    } else if (_isDomainOf(domain, 'machbank.cl')) {
      dto = parseMachEmail(message);
    } else if (_isDomainOf(domain, 'bancochile.cl')) {
      dto = parseBancoChileEmail(message);
    } else {
      logSystemEvent('WARN', 'Router', `Banco no soportado: ${sender}`);
      return null;
    }

    // --- CAPA DE RESOLUCIÓN DE ENTIDADES (ALTA CONFIANZA) ---
    if (dto && dto.Comercio_Original) {
      // Recorremos nuestro diccionario de Alias
      for (let i = 0; i < MERCHANT_ALIASES.length; i++) {
        const alias = MERCHANT_ALIASES[i];
        if (alias.pattern.test(dto.Comercio_Original)) {
          // Si hace match, forzamos el Comercio_Original y el Comercio_Limpio
          // (Manteniendo el rastro de USD si existe)
          const isUsd = dto.Comercio_Original.includes('(USD');
          const usdSuffix = isUsd
            ? dto.Comercio_Original.substring(dto.Comercio_Original.indexOf('(USD'))
            : '';

          dto.Comercio_Original = alias.cleanName + (usdSuffix ? ` ${usdSuffix}` : '');
          dto.Comercio_Limpio = alias.cleanName;

          logSystemEvent('INFO', 'Entity Resolution', `Normalizado a: ${dto.Comercio_Limpio}`);
          break; // Detenemos la búsqueda al encontrar el primer match
        }
      }
    }

    return dto;
  } catch (error) {
    logSystemEvent('ERROR', 'Error en el Router Principal', getErrorMessage(error));
    return null;
  }
}

/** Entidades HTML frecuentes en los correos de los bancos. */
const HTML_ENTITIES = Object.freeze({
  '&aacute;': 'á',
  '&eacute;': 'é',
  '&iacute;': 'í',
  '&oacute;': 'ó',
  '&uacute;': 'ú',
  '&ntilde;': 'ñ',
  '&Aacute;': 'Á',
  '&Eacute;': 'É',
  '&Iacute;': 'Í',
  '&Oacute;': 'Ó',
  '&Uacute;': 'Ú',
  '&Ntilde;': 'Ñ',
  '&nbsp;': ' ',
  '&amp;': '&',
});

/**
 * Texto visible de un correo HTML: sin estilos, comentarios ni etiquetas, con las entidades
 * decodificadas y los espacios colapsados. Los comentarios HTML se descartan porque BCI deja
 * párrafos comentados que el usuario no ve.
 * @private
 * @param {string} html
 * @returns {string}
 */
function _htmlToVisibleText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[A-Za-z]+;/g, entity =>
      Object.prototype.hasOwnProperty.call(HTML_ENTITIES, entity)
        ? /** @type {Record<string, string>} */ (HTML_ENTITIES)[entity]
        : entity
    )
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Indica si el monto de un correo BCI está en dólares. Se decide por la moneda escrita en la
 * propia celda del monto ("USD 23,80"); solo si la celda no trae moneda se recurre al titular
 * "compra en comercio internacional". Una mención a "USD" en otra parte del correo no cuenta.
 * @private
 * @param {string} htmlBody
 * @param {string} visibleText
 * @returns {boolean}
 */
function _isBciUsdAmount(htmlBody, visibleText) {
  const moneda = htmlBody.match(BCI_LOGIC.REGEX.MONEDA);
  if (moneda && moneda[1]) return /^US/i.test(moneda[1]);
  return /realizaste una compra en comercio internacional/i.test(visibleText);
}

/**
 * Convierte un monto en dólares escrito al estilo chileno ("23,80", "1.234,56") o anglosajón
 * ("23.80") a número.
 * @private
 * @param {string} raw
 * @returns {number}
 */
function _parseUsdAmount(raw) {
  const value = raw.trim();
  if (value.includes(',')) return parseFloat(value.replace(/\./g, '').replace(',', '.'));
  if (/\.\d{1,2}$/.test(value)) return parseFloat(value);
  return parseFloat(value.replace(/\./g, ''));
}

/**
 * Indica si un correo BCI es una anulación (reverso). Se reconoce por el titular
 * ("Realizaste una anulación …") o por el asunto. Si la palabra aparece en otro contexto
 * (p. ej. un pie de página) NO se invierte el signo, pero se deja un aviso por si BCI cambió
 * la redacción del titular.
 * @private
 * @param {string} visibleText
 * @param {string} subject
 * @returns {boolean}
 */
function _isBciAnulacion(visibleText, subject) {
  if (/realizaste una anulaci[oó]n/i.test(visibleText) || /anulaci[oó]n/i.test(subject)) {
    return true;
  }
  if (/anulaci[oó]n/i.test(visibleText)) {
    logSystemEvent(
      'WARN',
      'Posible anulación BCI no reconocida',
      `El correo "${subject}" menciona una anulación fuera del titular; se registró con monto positivo. Revisa si BCI cambió el formato.`
    );
  }
  return false;
}

/**
 * Procesa un mensaje individual del banco BCI y extrae los datos clave.
 * Convierte compras internacionales a CLP y detecta Anulaciones (Montos Negativos).
 * @param {GoogleAppsScript.Gmail.GmailMessage} message - El mensaje de Gmail.
 * @returns {Transaction|null} El DTO estandarizado de la transacción.
 */
function parseBciEmail(message) {
  try {
    const htmlBody = message.getBody();
    const subject = message.getSubject() || '';
    const regex = BCI_LOGIC.REGEX;

    const matchFecha = htmlBody.match(regex.FECHA);
    const matchHora = htmlBody.match(regex.HORA);
    const matchMonto = htmlBody.match(regex.MONTO);
    const matchComercio = htmlBody.match(regex.COMERCIO);
    const matchCuotas = htmlBody.match(regex.CUOTAS);
    const matchMensaje = htmlBody.match(regex.MENSAJE);

    if (!matchMonto || !matchMonto[1]) {
      logSystemEvent('WARN', 'Fallo de Parseo BCI', `No se pudo extraer el MONTO en: ${subject}`);
      return null;
    }
    if (!matchComercio || !matchComercio[1]) {
      logSystemEvent(
        'WARN',
        'Fallo de Parseo BCI',
        `No se pudo extraer el COMERCIO en: ${subject}`
      );
      return null;
    }

    // --- 1. ESTANDARIZACIÓN DE FECHA ---
    const fechaFallback = Utilities.formatDate(
      message.getDate(),
      Session.getScriptTimeZone(),
      'yyyy-MM-dd'
    );
    let rawFecha = matchFecha ? matchFecha[1].trim() : fechaFallback;
    const dateParts = rawFecha.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
    if (dateParts) {
      rawFecha = `${dateParts[3]}-${dateParts[2]}-${dateParts[1]}`; // YYYY-MM-DD
    }

    // --- 2. SANITIZACIÓN DE COMERCIO ---
    // El banco rellena con espacios ("PAYU   *UBER TRIP        SANTIAGO     CL"): se colapsan.
    let comercioRaw = matchComercio[1]
      .replace(/&amp;/g, '&')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    if (/^\d+$/.test(comercioRaw)) {
      comercioRaw = 'Cuenta Propia ' + comercioRaw;
    }

    // --- 3. PROCESAMIENTO DE MONEDA (CLP vs USD) ---
    const visibleText = _htmlToVisibleText(htmlBody);
    const esInternacional = _isBciUsdAmount(htmlBody, visibleText);
    let montoRaw = matchMonto[1].trim();
    let montoNumerico = 0;

    if (esInternacional) {
      const montoUsd = _parseUsdAmount(montoRaw);
      const tasaCambio = getUsdToClpRate(rawFecha);

      montoNumerico = Math.round(montoUsd * tasaCambio);
      logSystemEvent(
        'INFO',
        'Conversión USD a CLP',
        `Compra de USD ${montoUsd} procesada a $${montoNumerico} CLP (Dólar a $${tasaCambio})`
      );
      comercioRaw = `${comercioRaw} (USD ${montoUsd})`;
    } else {
      montoRaw = montoRaw.replace(/[^\d]/g, '');
      montoNumerico = parseInt(montoRaw, 10);
    }

    // --- 3.5 DETECCIÓN DE ANULACIONES (REVERSOS) ---
    // Solo BCI envía anulaciones. El titular del correo real dice "Realizaste una anulación
    // nacional con tu tarjeta de crédito": se busca esa frase, no la palabra en cualquier parte.
    const esAnulacion = _isBciAnulacion(visibleText, subject);
    if (esAnulacion) {
      montoNumerico = montoNumerico * -1;
      // Extraemos la fecha y hora limpias solo para el Log
      const fechaLimpia = matchFecha ? matchFecha[1].trim() : 'Fecha Desconocida';
      const horaLimpia = matchHora ? matchHora[1].trim() : 'Hora Desconocida';

      logSystemEvent(
        'INFO',
        'Anulación BCI',
        `Se detectó reverso de fondos el ${fechaLimpia} a las ${horaLimpia}. Monto ajustado a ${montoNumerico}`
      );
    }

    // --- 4. CUOTAS Y TIPO ---
    const cuotasNumerico = matchCuotas && matchCuotas[1] ? parseInt(matchCuotas[1], 10) : 1;
    const subjLower = subject.toLowerCase();
    let tipoGasto = 'Desconocido';

    if (subjLower.includes('tarjeta de crédito') || subjLower.includes('credito')) {
      tipoGasto = 'Crédito';
    } else if (subjLower.includes('débito') || subjLower.includes('debito')) {
      tipoGasto = 'Débito';
    } else if (subjLower.includes('transferencia')) {
      tipoGasto = 'Transferencia';
    } else if (subjLower.includes('compra') || subjLower.includes('pago')) {
      tipoGasto = 'Gasto/Pago';
    }

    const horaFallback = Utilities.formatDate(
      message.getDate(),
      Session.getScriptTimeZone(),
      'HH:mm'
    );

    // --- 5. CONSTRUCCIÓN DEL DTO ---
    return {
      Fecha: rawFecha,
      Hora: matchHora ? matchHora[1].trim() : horaFallback,
      Comercio_Original: comercioRaw,
      Comercio_Limpio: comercioRaw,
      Categoria: 'Por Clasificar Automáticamente',
      Subcategoria: '',
      Monto: montoNumerico,
      Cuotas: cuotasNumerico,
      Tipo: tipoGasto,
      Comentario: matchMensaje ? matchMensaje[1].replace(/<[^>]+>/g, '').trim() : '',
      Origen: 'BCI',
    };
  } catch (error) {
    logSystemEvent('ERROR', 'Error interno en parseBciEmail', getErrorMessage(error));
    return null;
  }
}

/**
 * Procesa un mensaje de Tenpo y extrae los datos clave.
 * @param {GoogleAppsScript.Gmail.GmailMessage} message
 * @returns {Transaction|null} DTO estandarizado.
 */
function parseTenpoEmail(message) {
  try {
    // Tenpo envía un texto plano muy estructurado, es más seguro parsear eso que el HTML
    const body = message.getPlainBody();
    const subject = message.getSubject() || '';
    const regex = TENPO_LOGIC.REGEX;

    const matchFecha = body.match(regex.FECHA);
    const matchHora = body.match(regex.HORA);
    const matchMonto = body.match(regex.MONTO);
    const matchComercio = body.match(regex.COMERCIO);

    // --- VALIDACIONES CRÍTICAS ---
    if (!matchMonto || !matchMonto[1]) {
      logSystemEvent('WARN', 'Fallo Tenpo', `Monto no encontrado en: ${subject}`);
      return null;
    }
    if (!matchComercio || !matchComercio[1]) {
      logSystemEvent('WARN', 'Fallo Tenpo', `Comercio no encontrado en: ${subject}`);
      return null;
    }

    // --- NORMALIZACIÓN ---
    const comercioRaw = matchComercio[1].trim();

    // Limpiamos el monto (ej. "24.590" -> 24590)
    const montoLimpio = matchMonto[1].replace(/[^\d]/g, '');
    const montoNumerico = parseInt(montoLimpio, 10);

    // Fechas y Horas de respaldo
    let rawFecha = matchFecha
      ? matchFecha[1].trim()
      : Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const horaFallback = Utilities.formatDate(
      message.getDate(),
      Session.getScriptTimeZone(),
      'HH:mm'
    );

    // Estandarización de Fecha de DD-MM-YYYY a YYYY-MM-DD
    const dateParts = rawFecha.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
    if (dateParts) {
      rawFecha = `${dateParts[3]}-${dateParts[2]}-${dateParts[1]}`;
    }

    // --- CONSTRUCCIÓN DEL DTO ---
    return {
      Fecha: rawFecha,
      Hora: matchHora ? matchHora[1].trim() : horaFallback,
      Comercio_Original: comercioRaw,
      Comercio_Limpio: comercioRaw,
      Categoria: 'Por Clasificar Automáticamente',
      Subcategoria: '',
      Monto: montoNumerico,
      Cuotas: 1, // Por regla de negocio, Tenpo es prepago
      Tipo: 'Débito',
      Origen: 'TENPO',
    };
  } catch (error) {
    logSystemEvent('ERROR', 'Error interno en parseTenpoEmail', getErrorMessage(error));
    return null;
  }
}

/**
 * Procesa un mensaje de MACH (Soporta Débito y Crédito).
 * @param {GoogleAppsScript.Gmail.GmailMessage} message
 * @returns {Transaction|null} DTO estandarizado.
 */
function parseMachEmail(message) {
  try {
    const body = message.getPlainBody();
    const subject = message.getSubject() || '';
    const regex = MACH_LOGIC.REGEX;

    // Extracción
    const matchFechaHora = body.match(regex.FECHA_HORA);
    const matchMonto = body.match(regex.MONTO);
    const matchComercioCredito = body.match(regex.COMERCIO_CREDITO);
    const matchComercioDebito = body.match(regex.COMERCIO_DEBITO);
    const matchCuotas = body.match(regex.CUOTAS);

    // Determinar el comercio dependiendo de si es formato crédito o débito
    let comercioRaw = '';
    if (matchComercioCredito && matchComercioCredito[1]) {
      comercioRaw = matchComercioCredito[1].trim();
    } else if (matchComercioDebito && matchComercioDebito[1]) {
      comercioRaw = matchComercioDebito[1].trim();
    }

    // --- VALIDACIONES CRÍTICAS ---
    if (!matchMonto || !matchMonto[1]) {
      logSystemEvent('WARN', 'Fallo MACH', `Monto no encontrado en: ${subject}`);
      return null;
    }
    if (!comercioRaw) {
      logSystemEvent('WARN', 'Fallo MACH', `Comercio no encontrado en: ${subject}`);
      return null;
    }

    // --- NORMALIZACIÓN ---
    const montoLimpio = matchMonto[1].replace(/[^\d]/g, '');
    const montoNumerico = parseInt(montoLimpio, 10);

    // Fechas y Horas
    let rawFecha = Utilities.formatDate(
      message.getDate(),
      Session.getScriptTimeZone(),
      'yyyy-MM-dd'
    );
    let rawHora = Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'HH:mm');

    if (matchFechaHora) {
      // Convertir DD/MM/YYYY a YYYY-MM-DD
      const dateParts = matchFechaHora[1].trim().split('/');
      if (dateParts.length === 3) {
        rawFecha = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
      }
      rawHora = matchFechaHora[2].trim();
    }

    // Cuotas (Si es 0 o no existe, lo forzamos a 1)
    let cuotasNumerico = matchCuotas && matchCuotas[1] ? parseInt(matchCuotas[1], 10) : 1;
    if (cuotasNumerico === 0) cuotasNumerico = 1;

    // Determinar Tipo por Asunto
    const tipoGasto = subject.toLowerCase().includes('crédito') ? 'Crédito' : 'Débito';

    // --- CONSTRUCCIÓN DEL DTO ---
    return {
      Fecha: rawFecha,
      Hora: rawHora,
      Comercio_Original: comercioRaw,
      Comercio_Limpio: comercioRaw,
      Categoria: 'Por Clasificar Automáticamente',
      Subcategoria: '',
      Monto: montoNumerico,
      Cuotas: cuotasNumerico,
      Tipo: tipoGasto,
      Origen: 'MACH',
    };
  } catch (error) {
    logSystemEvent('ERROR', 'Error interno en parseMachEmail', getErrorMessage(error));
    return null;
  }
}

/**
 * Procesa un mensaje del Banco de Chile (Soporta Débito, Crédito y Cheques).
 * @param {GoogleAppsScript.Gmail.GmailMessage} message
 * @returns {Transaction|null} DTO estandarizado.
 */
function parseBancoChileEmail(message) {
  try {
    // Usamos el HTML body porque Banco de Chile a veces codifica los tildes (&uacute;)
    const body = message.getBody();
    // Limpiamos etiquetas HTML sobrantes para que el texto sea como un párrafo continuo
    const plainText = body.replace(/<[^>]+>/g, ' ');

    const subject = message.getSubject() || '';
    const regex = BANCOCHILE_LOGIC.REGEX;

    // Extracción
    const matchMonto = plainText.match(regex.MONTO);
    const matchFecha = plainText.match(regex.FECHA);
    const matchHora = plainText.match(regex.HORA);
    const matchComercioCompra = plainText.match(regex.COMERCIO_COMPRA);
    const matchChequeNum = plainText.match(regex.CHEQUE_NUM);
    const matchMensaje = body.match(regex.MENSAJE);

    // Lógica de Determinación de Comercio
    let comercioRaw = '';
    if (matchChequeNum && matchChequeNum[1]) {
      comercioRaw = 'Cobro Cheque N° ' + matchChequeNum[1].trim();
    } else if (matchComercioCompra && matchComercioCompra[1]) {
      comercioRaw = matchComercioCompra[1].trim();
      // Limpiamos posibles espacios dobles generados por el HTML (Ej: "FLOW   *MIA SPA")
      comercioRaw = comercioRaw.replace(/\s+/g, ' ');
    }

    // --- VALIDACIONES CRÍTICAS ---
    if (!matchMonto || !matchMonto[1]) {
      logSystemEvent('WARN', 'Fallo Banco de Chile', `Monto no encontrado en: ${subject}`);
      return null;
    }
    if (!comercioRaw) {
      logSystemEvent(
        'WARN',
        'Fallo Banco de Chile',
        `Comercio/Cheque no encontrado en: ${subject}`
      );
      return null;
    }

    // --- NORMALIZACIÓN ---
    const montoLimpio = matchMonto[1].replace(/[^\d]/g, '');
    const montoNumerico = parseInt(montoLimpio, 10);

    // Estandarización de Fechas (DD/MM/YYYY -> YYYY-MM-DD)
    let rawFecha = Utilities.formatDate(
      message.getDate(),
      Session.getScriptTimeZone(),
      'yyyy-MM-dd'
    );
    if (matchFecha && matchFecha[1]) {
      const dateParts = matchFecha[1].trim().split('/');
      if (dateParts.length === 3) {
        rawFecha = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`;
      }
    }

    const rawHora = matchHora
      ? matchHora[1].trim()
      : Utilities.formatDate(message.getDate(), Session.getScriptTimeZone(), 'HH:mm');

    // Lógica de Determinación de Tipo
    const subjLower = subject.toLowerCase();
    let tipoGasto = 'Débito'; // Por defecto (Cargo en Cuenta)

    if (subjLower.includes('crédito') || subjLower.includes('credito')) {
      tipoGasto = 'Crédito';
    } else if (subjLower.includes('cheque')) {
      tipoGasto = 'Cheque';
    }

    // --- CONSTRUCCIÓN DEL DTO ---
    return {
      Fecha: rawFecha,
      Hora: rawHora,
      Comercio_Original: comercioRaw,
      Comercio_Limpio: comercioRaw,
      Categoria: 'Por Clasificar Automáticamente',
      Subcategoria: '',
      Monto: montoNumerico,
      Cuotas: 1, // Los correos de notificación del Chile no indican cuotas, se asume 1
      Tipo: tipoGasto,
      Comentario: matchMensaje ? matchMensaje[1].replace(/<[^>]+>/g, '').trim() : '',
      Origen: 'BANCO_DE_CHILE',
    };
  } catch (error) {
    logSystemEvent('ERROR', 'Error interno en parseBancoChileEmail', getErrorMessage(error));
    return null;
  }
}

/**
 * Consulta la API de Mindicador.cl para obtener el valor del Dólar Observado.
 * @param {string} fechaYyyyMmDd - Fecha de la transacción en formato YYYY-MM-DD.
 * @returns {number} El valor del dólar en CLP.
 */
function getUsdToClpRate(fechaYyyyMmDd) {
  try {
    // Mindicador.cl exige la fecha en formato DD-MM-YYYY
    const parts = fechaYyyyMmDd.split('-');
    const fechaApi = `${parts[2]}-${parts[1]}-${parts[0]}`;
    const url = `https://mindicador.cl/api/dolar/${fechaApi}`;

    // Intentamos buscar el valor exacto de ese día
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() === 200) {
      const data = JSON.parse(response.getContentText());
      if (data.serie && data.serie.length > 0) {
        return data.serie[0].valor;
      }
    }

    // FALLBACK 1: Si es fin de semana/feriado (la serie viene vacía), pedimos el dólar actual
    const fallbackResponse = UrlFetchApp.fetch('https://mindicador.cl/api/dolar', {
      muteHttpExceptions: true,
    });
    if (fallbackResponse.getResponseCode() === 200) {
      const fallbackData = JSON.parse(fallbackResponse.getContentText());
      if (fallbackData.serie && fallbackData.serie.length > 0) {
        return fallbackData.serie[0].valor;
      }
    }

    // FALLBACK 2: Falla catastrófica de la API, usamos un valor estático razonable (y se avisa:
    // el monto en CLP de esa transacción es una estimación, no el dólar real del día).
    logSystemEvent(
      'WARN',
      'Fallo API Divisas',
      `mindicador.cl no respondió para ${fechaYyyyMmDd}. Usando dólar estático de 950 CLP: el monto convertido es aproximado.`
    );
    return 950;
  } catch (error) {
    logSystemEvent(
      'WARN',
      'Fallo API Divisas',
      `No se pudo obtener el dólar para ${fechaYyyyMmDd}. Usando 950. Error: ${getErrorMessage(error)}`
    );
    return 950;
  }
}
