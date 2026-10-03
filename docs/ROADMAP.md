# Roadmap: oportunidades de mejora

Catálogo priorizado de mejoras y funcionalidades nuevas, resultado de la auditoría. **Nada de esto está
implementado**: son propuestas ordenadas por impacto, esfuerzo y riesgo. Las mejoras de robustez que el
incidente de Gemini hizo urgentes (cascada, reintentos, sweeper, seguridad) sí se implementaron; ver
`docs/AUDITORIA.md`.

Escala: **Impacto** (A/M/B), **Esfuerzo** (S = horas, M = días, L = semanas), **Riesgo** (A/M/B).
Los cambios que tocan el esquema de Sheets se marcan con 🧱 (afectan a Looker Studio y Notion).

## Ola 0: cerrar pendientes de la auditoría

| #   | Propuesta                                                                                                                                | Impacto | Esfuerzo | Riesgo | Nota                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1 | Pruebas con **correos reales anonimizados** del resto de formatos (Tenpo, MACH, Banco de Chile, transferencias y débito de BCI)          | M       | S        | B      | F-PAR-1/2 ya se corrigieron con dos correos reales de BCI (anulación y compra en USD). El resto de los parsers sigue probado con correos sintéticos.                                                  |
| 0.2 | Decidir el destino de `BCI_LOGIC.SUBJECTS` y similares (hoy sin uso, distintos de la query real)                                         | M       | S        | M      | Unificar la query desde la configuración **ampliaría** los correos ingeridos (`Comprobante de Compra Tarjeta de Débito`, `Pago de Cuenta en Linea`…). Requiere validar los parsers con esos formatos. |
| 0.3 | Verificar en vivo (menú «🩺 Diagnóstico») el nombre exacto del parámetro de _thinking_ de Gemini 3.x y si el `LockService` es reentrante | M       | S        | B      | El código funciona sin depender de ninguna de las dos respuestas.                                                                                                                                     |

## Ola 1: blindar la ingesta más allá del correo

Hoy el correo es el **único** canal. Si el banco cambia el formato, el correo cae en spam o Gmail
retrasa el envío, se pierden gastos sin aviso (ahora al menos se ponen en cuarentena y se alerta).

| #   | Propuesta                                                                             | Impacto | Esfuerzo | Riesgo | Detalle                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------- | ------- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1.1 | **Alerta de "silencio anómalo" por banco**                                            | A       | S        | B      | Si un banco que suele enviar correos no aparece en N días, avisar. Detecta cambios de formato o filtros de Gmail sin intervención.                                       |
| 1.2 | **Conciliación con la cartola** (CSV/Excel/PDF mensual)                               | A       | M        | M      | Cargar la cartola y marcar movimientos que no están en la hoja. Es la red de seguridad definitiva contra correos perdidos. Los PDF se pueden leer con Gemini multimodal. |
| 1.3 | **Foto de boleta o voucher por Telegram**, leída con Gemini                           | M       | M        | B      | El usuario envía la foto; Gemini extrae comercio, monto y fecha y crea la transacción. Útil para efectivo.                                                               |
| 1.4 | **Reenvío de notificaciones push/SMS** (MacroDroid, Tasker, Atajos de iOS) al webhook | M       | M        | M      | Canal independiente del correo. Reutiliza `doPost` con el mismo secreto y allowlist.                                                                                     |
| 1.5 | **Open banking en Chile** (Fintoc, Floid, Belvo)                                      | A       | L        | A      | Datos directos del banco, sin parsear correos. A validar: disponibilidad para personas naturales, costos y condiciones legales (Ley Fintech 21.521).                     |
| 1.6 | Reproceso de correos en cuarentena desde el menú                                      | M       | S        | B      | Hoy basta quitar la etiqueta de "Procesado" a mano.                                                                                                                      |

## Ola 2: calidad de los datos

| #   | Propuesta                                                                                          | Impacto | Esfuerzo | Riesgo | Detalle                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------- | ------- | -------- | ------ | --------------------------------------------------------------------------------------------------------- |
| 2.1 | 🧱 **Monto original, moneda y tasa en columnas propias**                                           | A       | M        | M      | Hoy el USD se guarda dentro del nombre del comercio (`Amazon (USD 10.5)`), lo que ensucia el diccionario. |
| 2.2 | 🧱 **Conservar el nombre bruto del banco** (F-CFG-3)                                               | M       | S        | B      | Columna adicional; hoy el alias sobrescribe `Comercio_Original`.                                          |
| 2.3 | **Aplicar cambios del diccionario al historial** usando la casilla «Auditoría Manual», hoy sin uso | A       | M        | M      | Si el usuario corrige una categoría, propagarla a las filas anteriores.                                   |
| 2.4 | **Detección de duplicados entre fuentes** (correo vs gasto manual vs cartola)                      | M       | M        | M      | Mismo monto, fecha y comercio parecido.                                                                   |
| 2.5 | **Transferencias entre cuentas propias** y **ingresos vs gastos**                                  | A       | M        | M      | Hoy una transferencia recibida y una enviada no se distinguen, y un traspaso propio infla el gasto.       |
| 2.6 | 🧱 Columnas de observabilidad: modelo usado, intentos, `Notion_ID`                                 | M       | S        | B      | `Notion_ID` evita la consulta previa a cada actualización o borrado en Notion.                            |
| 2.7 | Taxonomía de categorías cerrada y editable                                                         | M       | M        | B      | Hoy las categorías las propone la IA (el prompt ya reutiliza las existentes).                             |

## Ola 3: integraciones

| #   | Propuesta                                                                                                                                                               | Impacto | Esfuerzo | Riesgo |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------- | ------ |
| 3.1 | Notion bidireccional (leer ediciones hechas allí) y actualizar a la versión de API vigente (`Notion-Version` sigue en `2022-06-28`; el modelo de _data sources_ cambió) | M       | M        | M      |
| 3.2 | Webhooks salientes (n8n, Make, Home Assistant) al registrar una transacción                                                                                             | M       | S        | B      |
| 3.3 | Respaldo semanal a Drive (CSV/JSON)                                                                                                                                     | M       | S        | B      |
| 3.4 | Exportación a Firefly III, Actual Budget o YNAB                                                                                                                         | B       | M        | B      |
| 3.5 | Looker Studio: plantilla lista con presupuesto vs real                                                                                                                  | M       | M        | B      |

## Ola 4: inteligencia y experiencia

| #   | Propuesta                                                                                                    | Impacto | Esfuerzo | Riesgo |
| --- | ------------------------------------------------------------------------------------------------------------ | ------- | -------- | ------ |
| 4.1 | Comandos de Telegram: `/resumen`, `/hoy`, `/mes`, `/pendientes`, `/reclasificar`                             | A       | S        | B      |
| 4.2 | Resumen semanal y mensual automático por Telegram                                                            | A       | S        | B      |
| 4.3 | **Presupuestos por categoría** con alertas al 80 % y 100 %                                                   | A       | M        | B      |
| 4.4 | Detección de anomalías y de suscripciones recurrentes                                                        | M       | M        | B      |
| 4.5 | **Clasificador local por similitud** como último recurso sin IA (coincidencia por tokens con el diccionario) | M       | M        | M      |
| 4.6 | Segundo proveedor de IA opcional, si Gemini cae por horas                                                    | B       | M        | M      |
| 4.7 | Edición de un gasto manual (los `edited_message` hoy se ignoran por la deduplicación)                        | B       | S        | B      |

## Ola 5: plataforma, privacidad y operación

| #   | Propuesta                                                                          | Impacto | Esfuerzo | Riesgo | Detalle                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------- | ------- | -------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5.1 | **Privacidad del tier gratuito de Gemini**                                         | A       | S        | B      | Verificar los términos vigentes: en el tier gratuito los datos pueden usarse para mejorar productos de Google. Con datos financieros, considerar activar facturación (además de dar acceso a más modelos). |
| 5.2 | Cola de reintentos genérica (Gemini, Notion, Telegram) con estado visible          | M       | M        | M      | Hoy cada integración reintenta a su manera.                                                                                                                                                                |
| 5.3 | Retención y rotación de la hoja `Logs`                                             | M       | S        | B      | Crece sin límite; `appendRow` por evento es lento.                                                                                                                                                         |
| 5.4 | Índice de `ID_Unico` en caché                                                      | M       | S        | B      | `getExistingTransactionIds` lee la columna A completa en cada corrida; se nota con años de datos.                                                                                                          |
| 5.5 | Archivo anual de transacciones                                                     | B       | S        | B      | Límite de celdas de Sheets.                                                                                                                                                                                |
| 5.6 | `oauthScopes` explícitos y mínimos en `appsscript.json`                            | M       | S        | M      | Exige re-autorizar una vez.                                                                                                                                                                                |
| 5.7 | Verificación SPF/DKIM del remitente (`Authentication-Results` vía `getRawContent`) | M       | M        | M      | Defensa contra correos suplantados que imiten a un banco. Hoy solo se valida el dominio del `From`.                                                                                                        |
| 5.8 | Tests con correos reales en CI                                                     | M       | S        | B      | Ver 0.1.                                                                                                                                                                                                   |

## Secuencia recomendada

1. **Ola 0** (pocas horas) y el despliegue con clasp.
2. **1.1 + 4.1 + 4.2**: bajo riesgo y mucho valor diario (alerta de silencio, comandos y resúmenes).
3. **1.2** (conciliación con cartola): la mejor garantía de que no se pierde nada.
4. **2.5 + 2.1**: son cambios de esquema; conviene hacerlos juntos y avisar a Looker Studio y Notion.
5. El resto según el uso real.
