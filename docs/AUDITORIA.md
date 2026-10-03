# Auditoría de AsistenteBancario

Auditoría completa del código (Google Apps Script V8, ~2.500 líneas originales). Cada hallazgo tiene
un ID, su evidencia en el código **original** (`archivo:línea` del commit `aef0158`), su estado y la
prueba automática que lo cubre. Las pruebas viven en `tests/` y se ejecutan con `npm test`.

- **Corregido**: arreglado y cubierto por una prueba que antes fallaba.
- **Diferido**: decisión consciente de no cambiarlo en esta iteración (motivo indicado).
- **Pendiente de muestras**: requiere correos reales anonimizados para corregirlo con seguridad
  (hoy no queda ninguno en este estado).

## 1. El incidente de Gemini ("Colapso total de Gemini API")

Los logs del 27-sep-2026 corresponden al commit `f1b772a` (cascada fija de 5 modelos). El commit
`aef0158` (HEAD antes de la auditoría) tenía otra cascada y **nunca se desplegó**: no existía
`.clasp.json`, el código se copiaba a mano. Aun así, la cascada de `aef0158` tampoco habría funcionado.

| ID  | Causa raíz                                                                                                                                                                                                                                                                                                                                                                       | Evidencia original                                                               | Estado                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| RC1 | Código desplegado ≠ repositorio (sin pipeline de despliegue)                                                                                                                                                                                                                                                                                                                     | No hay `.clasp.json`; los logs muestran `gemini-1.5-pro-latest`, ausente en HEAD | **Corregido** en el repo (clasp configurado); el despliegue lo hace el usuario |
| RC2 | La cascada apuntaba a modelos inservibles: Pro-preview primero (cuota `limit: 0` en tier gratuito), `1.5-*` inexistentes (404), `2.0-*` apagados, `2.5` con acceso limitado; los estables vigentes (`3.7/3.6/3.5-flash`, `3.5/3.1-flash-lite`) nunca se intentaban                                                                                                               | `gemini.gs:81-92`, log del incidente                                             | **Corregido**                                                                  |
| RC3 | Descubrimiento de modelos defectuoso: un solo modelo por familia, regex sin `flash-lite`, orden con `localeCompare` (`3.10 < 3.8`, `-preview` gana a la versión estable), `ListModels` sin paginar, modelo cacheado 6 h aunque fallara                                                                                                                                           | `gemini.gs:26-65`                                                                | **Corregido**                                                                  |
| RC4 | Sin reintento ante un 503 transitorio (`3.8-flash`, el más nuevo y más saturado): salta directo al siguiente modelo                                                                                                                                                                                                                                                              | `gemini.gs:94-129`                                                               | **Corregido**                                                                  |
| RC5 | El fallo total se tragaba en silencio: devolvía `[]`, los hilos ya estaban etiquetados y nada volvía a intentarlo                                                                                                                                                                                                                                                                | `gemini.gs:229-232`, `extractor.gs:84-99`                                        | **Corregido**                                                                  |
| RC6 | El sweeper no podía funcionar: `cleanAndSortData` duplicada en dos archivos (gana la última cargada; una no llama al sweeper); el sweeper pedía el lock de script estando ya tomado y luego `saveToDatabase` lo pedía otra vez; llamaba a la IA con el lock tomado; escribía celda por celda por índices obsoletos; ignoraba lo resoluble por diccionario; no actualizaba Notion | `maitenance.gs:24-31, 71-155`, `maintenance.gs`                                  | **Corregido**                                                                  |
| RC7 | Alerta de Telegram inútil para diagnosticar: sin detalle, sin límite de frecuencia y sin escapar HTML                                                                                                                                                                                                                                                                            | `logger.gs:35-37`                                                                | **Corregido**                                                                  |
| RC8 | API key en la URL (`?key=`): las excepciones de `UrlFetchApp` incluyen la URL y filtraban la clave a Logs y Telegram                                                                                                                                                                                                                                                             | `gemini.gs:33,98`                                                                | **Corregido** (header `x-goog-api-key` + redacción de secretos en el logger)   |

**Nota sobre el lock.** No está documentado si `LockService` es reentrante. El nuevo diseño **nunca
anida locks**, por lo que funciona en ambos casos (las pruebas ejecutan el sweeper con lock
reentrante y no reentrante). Además el nuevo `processEmails` usa un lock de _usuario_ distinto del
lock de _script_ que protege Sheets.

**Verificación en vivo (2026-10-03, «🩺 Diagnóstico»).** El `LockService` **sí es reentrante**, así que
la hipótesis RC6(b) no se cumplía en producción. Al clonar el proyecto en vivo se confirmó la causa
real de RC6(a): Apps Script cargaba `maintenance.js` **después** de `maitenance.js`, por lo que la
versión de `cleanAndSortData` **sin** sweeper era la activa y las transacciones pendientes nunca se
reprocesaban de noche. El código en vivo era exactamente el commit `f1b772a` (RC1 confirmado).
El descubrimiento encontró 10 modelos de texto y una clasificación real respondió con `gemini-3.7-flash`.

### Cómo funciona ahora

1. `listGeminiModelNames` recorre **todas** las páginas de ListModels; los modelos se ordenan por
   versión numérica: flash estable → flash-lite estable → preview → pro (solo con `GEMINI_ALLOW_PRO=true`).
2. Cada modelo recuerda su salud en `CacheService` (circuit breaker): 404 y "cuota 0" → 6 h;
   saturación → 5 min; 429 con `retryDelay` → ese tiempo. Un modelo en enfriamiento no se vuelve a golpear.
3. Una saturación (503) se reintenta una vez con backoff; un 429 corto espera el `retryDelay` y reintenta.
4. Si la API rechaza `thinkingConfig` o `responseSchema` (400) se reintenta sin ellos.
5. Credenciales inválidas (401/403/400 "API key not valid") fallan de inmediato con una alerta
   específica y no se insiste durante 10 minutos (o hasta cambiar la clave).
6. Cada elemento viaja con un `id` numérico que la IA debe devolver: se acabaron los descalces por
   mayúsculas o tildes. Admite éxito parcial; nada entra al diccionario si no fue pedido.
7. Si **todo** falla, las transacciones se guardan igual como `Por Clasificar Automáticamente`, los
   hilos se etiquetan, se deja **un solo** registro con el motivo por modelo y **una** alerta con
   detalle. Al final de cada corrida horaria y cada noche el sweeper las reintenta solo.
8. `GEMINI_MODELS` (CSV) permite fijar la lista de respaldo sin tocar código si `ListModels` no responde.

## 2. Integridad y seguridad

| ID      | Hallazgo                                                                                                                                                                                                | Evidencia original             | Estado                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-EXT-1 | Se etiquetaba el hilo **antes** de guardar: si el guardado fallaba, la transacción se perdía para siempre                                                                                               | `extractor.gs:84-99`           | **Corregido** (parsear → clasificar → guardar → etiquetar)                                                                                                   |
| F-EXT-2 | Si la etiqueta de Gmail no existía nunca se marcaba y el bucle repetía los mismos hilos hasta agotar el tiempo                                                                                          | `extractor.gs:85-86, 115`      | **Corregido** (se crea si falta)                                                                                                                             |
| F-EXT-3 | Idempotencia fuera del lock; trigger horario y relevo podían solaparse y duplicar                                                                                                                       | `extractor.gs:74`, `dao.gs:73` | **Corregido** (dedupe por `ID_Unico` dentro del lock; guarda de proceso con lock de usuario)                                                                 |
| F-EXT-4 | Un correo que el parser no entendía devolvía `null` y el hilo igual se etiquetaba: se perdía con un WARN                                                                                                | `extractor.gs:76-86`           | **Corregido** (etiqueta `SaaS_Finanzas/Error_Parseo` + alerta)                                                                                               |
| F-DAO-1 | El diccionario se anexaba sin upsert (duplicados)                                                                                                                                                       | `dao.gs:96-124`                | **Corregido**                                                                                                                                                |
| F-DAO-2 | Con las casillas de auditoría marcadas en ~1000 filas, `getLastRow()` del Diccionario desplazaba las reglas nuevas muy abajo                                                                            | `setup.gs:68-75`, `dao.gs:114` | **Corregido** (última fila por columna A). _Por confirmar en vivo si Sheets cuenta las casillas vacías como contenido; el código es robusto en ambos casos._ |
| F-CLS-1 | Una clasificación basada en el comentario de una transferencia se guardaba en el diccionario por nombre de persona y contaminaba futuras transferencias                                                 | `gemini.gs:139-233`            | **Corregido** (no se persiste; cada par persona+comentario se clasifica por separado)                                                                        |
| F-TG-1  | `/borrar`, `/start` y los botones se ejecutaban **antes** de validar el chat autorizado                                                                                                                 | `telegram.gs:27-79`            | **Corregido** (allowlist de `TELEGRAM_CHAT_ID` para toda interacción)                                                                                        |
| F-TG-2  | _(Corrección de la auditoría)_ Se sospechó que sin `TELEGRAM_SECRET_TOKEN` la autenticación pasaba (`null !== null`). **No es así**: `e.parameter` siempre es un objeto y `undefined !== null` rechaza. | `telegram.gs:19`               | **No era un fallo**; ahora es explícito (fail-closed) y tiene prueba                                                                                         |
| F-TG-3  | Mensajes de error y nombres de comercio sin escapar HTML: Telegram rechazaba el mensaje completo                                                                                                        | `telegram.gs:92, 151, 229`     | **Corregido**                                                                                                                                                |
| F-TG-4  | Los gastos manuales se guardaban como "Ingreso Manual" y nunca se clasificaban, aunque el bot lo prometía                                                                                               | `telegram.gs:141`              | **Corregido** (pasan por el clasificador)                                                                                                                    |
| F-NOT-1 | `pushToNotion` corría **dentro** del lock (500 ms × N)                                                                                                                                                  | `dao.gs:128-136`               | **Corregido** (fuera del lock)                                                                                                                               |
| F-NOT-2 | El borrado en Notion no respetaba el freno de velocidad (regla 5 de AGENTS.md)                                                                                                                          | `notion.gs:98-170`             | **Corregido**                                                                                                                                                |
| F-NOT-3 | Sin manejo de 429 en Notion                                                                                                                                                                             | `notion.gs`                    | **Corregido** (reintento con `Retry-After`)                                                                                                                  |
| F-SWP-6 | Reclasificar no actualizaba Notion                                                                                                                                                                      | `maitenance.gs`                | **Corregido** (`updateTransactionInNotion`)                                                                                                                  |
| F-UI-1  | `uiRescueNotionSync` leía `tx.Comercio_Limpio`/`tx.Categoria` pero los encabezados son `Comercio Limpio`/`Categoría`: enviaba siempre "Desconocido" y "Por Clasificar" a Notion                         | `ui.gs:253-270`                | **Corregido** (columnas por encabezado)                                                                                                                      |

## 3. Parser y configuración

| ID      | Hallazgo                                                                                                           | Estado                                                                                                                                                                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-PAR-1 | El USD se detectaba por la subcadena "USD" en **todo** el HTML: un pie de página podía convertir una compra en CLP | **Corregido** con un correo real: la moneda se lee de la celda del monto ("USD 23,80"); solo si la celda no trae moneda se usa el titular "compra en comercio internacional". También se interpreta bien "USD 1.234,56".                           |
| F-PAR-2 | La anulación se detectaba por la palabra "anulación" en **todo** el HTML: un pie de página podía invertir el signo | **Corregido** con un correo real: se reconoce el titular "Realizaste una anulación …" (o el asunto). Si la palabra aparece en otro lugar se registra positivo y se deja un WARN «Posible anulación BCI no reconocida». Solo BCI envía anulaciones. |
| F-PAR-5 | Los comercios de BCI traen espacios de relleno ("PAYU *UBER TRIP SANTIAGO CL")                                     | **Corregido**: se colapsan, y la clave del diccionario también, así que las reglas antiguas siguen coincidiendo.                                                                                                                                   |
| F-PAR-3 | Remitente validado con `includes('tenpo')` etc.                                                                    | **Corregido** (se valida el dominio: `bci.cl`, `tenpo.cl`, `machbank.cl`, `bancochile.cl` y subdominios)                                                                                                                                           |
| F-PAR-4 | El dólar de respaldo (950 CLP) se usaba sin dejar rastro                                                           | **Corregido** (WARN explícito)                                                                                                                                                                                                                     |
| F-CFG-1 | `/C.\s*VERDE/` nunca coincidía con "CRUZ VERDE"                                                                    | **Corregido**                                                                                                                                                                                                                                      |
| F-CFG-2 | `/UBER/` absorbía Uber Eats (comida) como transporte                                                               | **Corregido**                                                                                                                                                                                                                                      |
| F-CFG-4 | Alias demasiado amplios (`/LIDER/`, `/MELI/`, `/EII/`…) capturaban palabras ajenas ("LIDERAZGO", "MELIA")          | **Corregido** (exigen que no los rodeen letras)                                                                                                                                                                                                    |
| F-CFG-3 | El alias sobrescribe `Comercio_Original` y se pierde el texto bruto del banco                                      | **Diferido**: `Comercio_Original` es la clave del diccionario; conservar el bruto exige una columna nueva (cambio de esquema). Ver ROADMAP.                                                                                                        |
| F-CFG-5 | `SUBJECTS` de `config` sin uso y distintos de la query de Gmail codificada                                         | **Diferido**: ampliar la query cambiaría qué correos se ingieren. Decisión del usuario (ver ROADMAP).                                                                                                                                              |

## 4. Limpieza y mantenibilidad

| ID      | Hallazgo                                                                                                                                      | Estado                                                               |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| F-STR-1 | Nombres globales duplicados entre archivos (`maintenance.gs` vs `maitenance.gs`; `setup.gs` con todo su contenido dos veces)                  | **Corregido** (archivo único `maintenance.js`; prueba de estructura) |
| F-STR-2 | Función de prueba `testGeminiIntegration` en el código desplegado                                                                             | **Corregido** (las pruebas viven en `tests/`, fuera del despliegue)  |
| F-STR-3 | Trazas de depuración `[FLAG …]` y código comentado                                                                                            | **Corregido**                                                        |
| F-UI-2  | El mensaje de tiempo decía "4.5 min" pero el límite real es 3,5 min                                                                           | **Corregido**                                                        |
| F-UI-3  | El asistente sugería la clave débil "MiClave123" para el webhook                                                                              | **Corregido** (se genera un UUID si el usuario no escribe una)       |
| F-UI-4  | `Intl.NumberFormat('es-CL')` no es fiable en Apps Script                                                                                      | **Corregido** (`formatClp`)                                          |
| —       | Errores tipográficos (menú "SLEECCIONADA"), texto de ayuda que decía "última columna" para `ID_Unico` (es la primera), `askAndSave` duplicado | **Corregido**                                                        |
| —       | Índices de columna fijos (regla 4 de AGENTS.md)                                                                                               | **Corregido** en DAO, sweeper y mantenimiento (`schema.js`)          |

| F-LOG-1 | La hoja `Logs` crecía sin límite | **Corregido** (poda nocturna: conserva ~3.000 eventos) |
| F-MAN-1 | Sin `oauthScopes` explícitos: Apps Script pedía acceso total a Gmail (`mail.google.com`) | **Corregido** (`gmail.modify`, `spreadsheets.currentonly`, `script.*`). **Exige re-autorizar una vez** tras el despliegue; verificar con «🩺 Diagnóstico». No se puede probar sin cuenta de Google. |
| — | Sin forma de comprobar el sistema en vivo | **Agregado**: menú «🩺 Diagnóstico del sistema» (`runDiagnostics`) |

## 5. Verificación

- `npm run check` = sintaxis (`vm`) + Prettier + ESLint + `tsc` (checkJs, `strict`) + pruebas.
- El harness (`tests/harness/`) carga los archivos en un único contexto `vm` como GAS y simula Sheets,
  Gmail, UrlFetch, Cache, Lock, Gemini, Telegram y Notion, incluidos los errores exactos del incidente.
- La línea base se congeló **antes** de tocar el código: 148 pruebas sobre el código original (93 de
  comportamiento a conservar y 55 defectos confirmados que fallaban por la razón esperada). Después de
  cada fase se repite la misma suite. Los únicos cambios de comportamiento son los listados arriba.
- Estado actual: **190 pruebas, todas en verde, sin `todo`**. Cobertura de líneas ≈ 95 %.
  `npm run check` termina en 0 con ESLint sin advertencias y `tsc --strict`.
- **Correos reales**: `tests/fixtures/` tiene dos correos reales de BCI anonimizados (nombre y tarjeta
  reemplazados; se recortaron estilos e imágenes sin tocar titular, tabla ni pie legal): una anulación
  con tarjeta de crédito (en quoted-printable, tal como llega) y una compra en dólares. El código
  original ya los procesaba bien; se usaron para acotar la detección sin perder esos casos.
- **Limitación**: Tenpo, MACH, Banco de Chile y las transferencias de BCI siguen probándose con correos
  sintéticos derivados de las expresiones regulares.
