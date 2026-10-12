# QA de la continuación de la fase 6-7 con los perfiles de usuario

_Claude · Predeterminado · 12-10-2026 (00:20–00:45 CEST)_

## Ronda de correcciones de Frontend · 12-10-2026

Los textos «Observado» y las capturas inferiores documentan la sesión original. Estado tras la corrección:

| Hallazgo | Estado de Frontend | Regresión |
| --- | --- | --- |
| N1 | **Corregido (parte Frontend)**: sin fecha no se escribe «desde el sin datos». El origen del resumen y la pausa falsa corresponden a Backend. | `DataFreshness.test.tsx`: stale y unreliable sin fecha. |
| N2 | **Corregido**: se limpian los mensajes al recuperarse o cambiar de incidente; las respuestas tardías no contaminan el siguiente aviso y los eventos de la propia descarga no descartan su resultado. | `DataFreshness.test.tsx`: recuperación, respuesta tardía y eventos durante la descarga. |
| N3 / E2E H3 | **Corregido**: un solo punto separa el motivo y la acción; el responsable de la composición era Frontend. | `ProviderConnectionResult.test.tsx` y `provider-connection.spec.ts`, expresión estricta `\.`. |
| N4 | **Corregido**: las cantidades y ejecuciones parciales conservan hasta nueve decimales. | `OrdersPage.test.tsx`: cantidad 0,000667 y parcial 0,000123; `orders-live-mode.spec.ts`. |
| N5 | **Corregido (parte Frontend)**: el panel rotula el límite de protección; Órdenes separa límite y referencia, y el slippage se identifica respecto a la referencia. | `live.test.tsx`, `OrdersPage.test.tsx` y `orders-live-mode.spec.ts`. |
| N6 | **Corregido**: «Volver a paper» en pantalla y franja para modo activo o suspendido; confirmación, Escape, foco restaurado, envío único y recuperación del error. Aplica el resultado de `live:deactivate` y conserva posiciones abiertas. | `ChecklistPage.test.tsx`, `live.test.tsx`, `live-gate.spec.ts` (incluye entrada en Diario) y `orders-live-mode.spec.ts`. |
| Fallo anterior 16 (etiqueta del filtro) | **Corregido**: el filtro se llama «Operación (paper o dinero real)». | `JournalPage.test.tsx`. |
| N7 y P13 | Backend; sin cambios en esta ronda. | Corresponden a `be-correcciones-ronda`. |

Verificación de esta ronda: `npm run typecheck`, `npm run lint`, `npm run format:check` y `npx vitest run src/renderer` en verde (**38 archivos, 426 pruebas**). `npm test` en verde (**181 archivos, 2.463 aprobadas y 8 fallos esperados de Backend**); no hay `it.fails`, `skip` ni `fixme` en renderer/E2E. `npm run test:e2e`: **47/47**; `live-gate.spec.ts --repeat-each=5`: **10/10**, incluidos confirmación, vuelta a paper y entrada en Diario. Las capturas E2E existentes se regeneraron al ejecutar los recorridos.


### Revalidación con cambios concurrentes de Backend

Después de las ejecuciones verdes anteriores, `be-correcciones-ronda` cambió `src/main` y añadió `NewsAnalysis.publishedAt`. El adaptador simulado y las fixtures de `NewsFeed.test.tsx` se alinearon a la fecha de publicación del titular; tipos pasan. Tras esa adaptación, `npx eslint src/renderer e2e`, las **426 pruebas de renderer** y Prettier sobre los archivos de Frontend/E2E vuelven a pasar.

La última comprobación global sobre ese árbol en edición deja **tres errores de lint** (`no-control-regex` en `market/macro/fred.ts:81`, `market/providers/tiingo.ts:74` y `services/secrets.ts:83`) y **cinco fallos de auditoría** C1–C5 por «Expect test to fail»: sus arreglos ya satisfacen la prueba, pero aún conserva `it.fails`. Quedan tres fallos esperados C6–C8. Esas correcciones y la revalidación conjunta corresponden a Backend y a la verificación final; no se modifica `src/main` en esta ronda de Frontend. Los resultados globales verdes anteriores documentan el árbol previo a esos cambios concurrentes.

## Entorno y método

- App construida con `npm run build` (typecheck incluido, en verde) y abierta con Playwright para Electron en modo E2E (`TRADIA_E2E=1`). Cada sesión arranca con un **perfil vacío** (`userData` temporal nuevo) y con el reloj de mercado anclado al 06-10-2026 22:00 UTC. Proveedores simulados, broker real simulado y ninguna clave real.
- Los guiones exploratorios fueron temporales y ya no están en el repositorio. Hay copia en `/tmp/qa-cont/specs/` y los registros en `/tmp/qa-cont/*.log`. No he cambiado código de producción.
- La hora local de la sesión (12-10 00:3x CEST, todavía 11-10 en UTC) sirve para comprobar el fallo de «hoy» con zona horaria.
- Capturas: `docs/qa/capturas/qa-continuacion-a-*.png` (perfil A) y `qa-continuacion-b-*.png` (perfil B).

### Baterías automáticas

| Comando | Resultado |
| --- | --- |
| `npm run build` | En verde |
| `npm run lint` | En verde (sin los guiones temporales de QA) |
| `npx vitest run --maxWorkers=2` | 180 archivos; **2444 aprobadas y 8 «expected fail»** (hallazgos C1 a C8 de la auditoría de cierre, todavía en `it.fails`) |
| Pruebas H1 a H5 de la auditoría | Las 5 pasan como `it`, ya no como `it.fails` |
| `npx playwright test` de las 8 specs de la continuación (`onboarding-tour`, `provider-connection`, `stale-data`, `live-gate`, `orders-live-mode`, `ai-regime-prediction`, `model-health`, `news-sentiment`) sobre la app construida | **18 de 18 pasan** (2,5 min). No he relanzado la batería `test:e2e` completa porque otra tarea la estaba ejecutando a la vez sobre el mismo `out/` |

El criterio 7 **todavía no se cumple**: quedan 8 `it.fails` (C1 a C8) en `src/main/{ai,live,providers}/__audit__`.

---

## Sesión 1 · Profesional independiente que organiza varios proyectos

**Veredicto: superada, con dos problemas nuevos (N1 y N2).** Un usuario nuevo se orienta con el tour, encuentra «Probar conexión» y entiende la franja de datos desactualizados. Pero una sola prueba de conexión fallida deja la app en un estado contradictorio.

| # | Pasos | Esperado | Observado | Evidencia |
| --- | --- | --- | --- | --- |
| 1 | Perfil vacío. Abrir la app y aceptar el aviso solo con teclado (Tab, Espacio, Tab, Intro) | El aviso va primero y el tour arranca después | El tour no existe antes de aceptar (0 diálogos). Al aceptar, se abre el paso 1 con el foco en el título | `qa-continuacion-a-aviso-riesgo.png`, `…-tour-paso-1.png` |
| 2 | «Empezar» con Intro y avanzar con → hasta el paso 4; pausar con Esc | Cada paso navega a su sección; Esc pausa y lo anuncia | Pasos 2 a 4 en `#inicio`, `#mercado` y `#fuentes` con los textos del diseño. Esc anuncia «Tour en pausa en el paso 4 de 10. Retómalo desde Inicio o Ajustes.» y el foco vuelve al h1 «Fuentes» | `…-tour-paso-2/3/4.png` |
| 3 | Inicio › «Primeros pasos» | Tarjeta con 3 líneas y «Retomar» | «1 de 3 hechos» (las fuentes por defecto cuentan). Botón «Retomar el tour (paso 4 de 10)» | `…-primeros-pasos.png` |
| 4 | Cerrar y reabrir la app con el mismo perfil | Sin aviso de riesgo; el tour se reabre en el paso 4 | Correcto. Pasos 5 a 10 recorridos; en el 6 se resalta «Parada» sin pulsarla. El paso 10 ofrece «Terminar» y «Terminar y añadir claves», que deja el foco en `#tiingo-key` | `…-tour-5…10.png`, `…-tour-terminado-ajustes.png` |
| 5 | Ajustes › Proveedores › «Probar conexión» en Tiingo y FRED; forzar los estados `sin-clave`, `clave-rechazada`, `cuota`, `sin-red` y `error` con el gancho E2E | «Conectado» con la fecha, o el motivo exacto y su acción | «Conectado · Último dato disponible: 9 oct 2026 · (102 ms)». Cada estado da su texto y su acción. «Añadir clave» enfoca el campo. Al guardar una clave, la clave no aparece en la página ni en el campo. **El estado `error` sale con doble punto** («…como se esperaba.. Vuelve a probar», N3) | `…-probar-conexion-inicial.png`, `…-sin-clave.png`, `…-error.png` |
| 6 | Seguir SPY, QQQ, AAPL y MSFT | Datos al día | «Al día · cierre del 6 oct 2026» | `…-inicio-al-dia.png` |
| 7 | IA › «Predicción por activo» › «Ver ficha del modelo» | Una fila vigente por activo; el enlace lleva a la ficha | 4 filas vigentes, con «Último cierre disponible · Cierre 6 oct» e «Histórico de predicciones (196)» plegado. El botón se queda en `#ia` y enfoca `#ai-model-card` | `…-ia-prediccion-vigente.png`, `…-ia-ficha-modelo.png` |
| 8 | Añadir una fuente RSS de agencia con un titular normal y otro de 230 caracteres | Titular confirmado y sin texto técnico visible | «(abre en el navegador externo)» ya es `sr-only` (1×1, recortado). El titular largo no desborda | `…-noticias.png` |
| 9 | Proveedor caído y avanzar un cierre; recorrer Inicio, Mercado, Macro e IA | Un único estado «Datos desactualizados desde …» con acciones y cálculos en pausa | Una franja «Estado de los datos» en cada pantalla, con el mismo texto: «Datos desactualizados desde el 6 oct 2026». IA muestra «En pausa» en el régimen, las estrategias y las predicciones. No hay predicciones de la sesión 07-10 ni señales nuevas. «Actualizar ahora» devuelve el motivo real («No se pudo actualizar: fallo simulado del proveedor (network)»). «Ver detalles» enumera cada activo | `…-desactualizado-inicio/mercado/macro/ia.png`, `…-reintento.png`, `…-detalles.png` |
| 10 | Sin red y después volver a tener red | Se pone al día solo al reconectar | Sin red, la franja se queda sin «Actualizar ahora». Al volver la red, queda al día en 0,7 s, anuncia «Datos al día.», se calcula la predicción del 07-10 y desaparece la pausa | `…-sin-red.png`, `…-al-dia-ia.png` |
| 11 | Con los datos al día, un «Probar conexión» de FRED que falla (`error`) | Ese aviso se queda en Ajustes; los datos siguen al día | **N1:** la franja global pasa a «**Datos desactualizados desde el sin datos**» y IA muestra «En pausa». Mientras tanto, el backend sigue calculando el régimen y las predicciones del 07-10. Solo se arregla con otra prueba correcta. «Actualizar ahora» responde «Datos actualizados.» pero la franja sigue. **N2:** los mensajes «No se pudo actualizar…» de un intento anterior se quedan en la franja nueva | `…-desactualizado-sin-datos-tras-prueba-fallida.png`, `…-no-fiable-tras-prueba-fallida.png`; `/tmp/qa-cont/perfil-a3.log` |
| 12 | Dinero real: guardar los límites 300/50/5/1, ir a Ajustes y volver | Los límites siguen ahí | Los campos conservan 300 y 50; «faltan 7 de 7» | `…-dinero-real-limites-al-volver.png` |
| 13 | Ajustes › Ayuda › «Ver el tour de nuevo» y después «Saltar tour» | Arranca en el paso 1; al saltar, el foco vuelve al botón | Correcto. Anuncia «Tour omitido. Puedes verlo cuando quieras en Ajustes.» | `…-tour-relanzado.png` |

---

## Sesión 2 · Responsable de equipo que revisa entregas

**Veredicto: superada, con problemas nuevos de severidad media (N4, N5 y N6).** La activación desde la interfaz con todo cumplido funciona a la primera. La prueba de humo y su rastro en Órdenes y en el Diario son correctos, salvo cómo se muestran la cantidad y el precio pedido. Tampoco hay forma de volver a paper desde la interfaz.

| # | Pasos | Esperado | Observado | Evidencia |
| --- | --- | --- | --- | --- |
| 1 | Perfil vacío: aceptar el aviso y pulsar «Saltar tour» | Se anuncia y el foco queda en el h1 | «Tour omitido…», foco en el h1 «Estado del sistema» y «Primeros pasos» visible | `/tmp/qa-cont/perfil-b.log` |
| 2 | Conectar el broker paper y crear una orden limitada de AAPL desde Órdenes | La orden muestra su modo | «Paper · sin dinero real». Ninguna fila dice «Modo no disponible» | `qa-continuacion-b-ordenes-paper.png` |
| 3 | Sembrar la evidencia automática, pulsar «Probar parada» y firmar las 3 declaraciones (con plantilla y nota) | Cada fila «Cumplido» con su evidencia y la fecha local | Parada: «Última prueba hoy (12 oct 2026).» con la hora local del 12-10 (en UTC aún era 11-10). Declaraciones: «“…” — suscrita el 12 oct 2026.» más la nota, sin «Sin evidencia guardada.» | `…-parada-evidencia.png`, `…-declaracion-evidencia.png` |
| 4 | Guardar los límites 200/20/5/1 | Se ve la frase de confirmación y no hay errores espurios | La frase se ve. Solo falta «Conecta y verifica las claves live del broker.» y no aparece «Los requisitos cambiaron» | `/tmp/qa-cont/perfil-b.log` |
| 5 | Ajustes: claves live simuladas › volver a Dinero real › Activar › Esc › Activar › escribir la frase › confirmar | Los límites se conservan y la activación funciona desde la interfaz | Los límites siguen (200). «Todos los requisitos están vigentes». El foco inicial va a «Cancelar y seguir en paper» y Esc cierra el diálogo. Queda «Dinero real activo», sin «faltan 0 de 7» y con la franja «DINERO REAL · Capital 200,00 USD · Orden 20,00 USD…». El secreto no se muestra nunca | `…-lista-completa.png`, `…-activado.png` |
| 6 | «Ejecutar prueba de 1,00 USD» › confirmar | Compra, cierre y conciliación sin descuadres; precios y slippage coherentes | «Cerrada y conciliada». Ejecutado a 1.499,06 USD, 0,000667 uds (≈1 USD) y conciliación «Sin diferencias». **N5:** «Precio pedido compra 1.544,03 USD» (el límite de protección) frente a «0 pb · sin desviación» y a «referencia 1499,06» en el Diario. **Persiste P13:** «Ejecución de compra» no tiene hora | `…-prueba-humo.png` |
| 7 | Órdenes con el modo real activo; filtro Modo › «Dinero real» | Las órdenes reales de la prueba aparecen rotuladas | Dos filas «Dinero real» (compra y venta de SPY) junto a la de paper; el filtro funciona. **N4:** la columna Cantidad dice **0** (en el IPC, 0,000667). **N5:** la compra es «Limitada» a 1.544,03 en el IPC, pero la columna «Precio pedido» dice 1499,06 | `…-ordenes-real.png`, `…-ordenes-filtro-real.png`, `…-ordenes-todos-los-modos.png` |
| 8 | Diario › «Prueba de humo real completada…» | Rotulada como dinero real | Tipo «Dinero real · Operación»; subtítulo «Señales, operaciones paper y de dinero real…». Las tres entradas llevan `mode: live` | `…-diario-humo.png` |
| 9 | Degradar «Reversión RSI/Bollinger» con dos revisiones mensuales › Salud de modelos › Posponer al 15-01-2027 con motivo | Degradada; el aplazamiento queda en el Diario | Degradada y la propuesta queda «pospuesta». Diario: «Propuesta de reentrenamiento 2026-Q4 pospuesta hasta 2027-01-15. Motivo: …». **N7:** la fila dice «32 operaciones · desviación Sin backtest de referencia: …» mientras la propuesta dice «Desviación −36,0 % … con 34 operaciones» | `…-salud-degradada.png`, `…-salud-pospuesta.png` |
| 10 | Drift de datos sostenido en el modelo › Ver detalle | Motivo sin doble punto y Brier móvil con referencia | «Degradada por drift sostenido: Drift de datos simulado sostenido durante 20 sesiones. No se debe…». No hay «..» en toda la página. «Brier móvil 0,304 · Ficha 0,197 · diferencia 0,107 · 60/60 predicciones resueltas». Variables «desde 23 sept 2026» | `…-salud-modelo-detalle.png` |
| 11 | Terminar la prueba y volver a paper desde la interfaz | Un control «Volver a paper» o «Desactivar dinero real» | **N6:** no existe. La franja solo ofrece «Ver límites» y «Parada». `live:deactivate` existe en el preload, pero ningún componente lo usa | `/tmp/qa-cont/perfil-b.log` paso 10; `grep deactivate src/renderer` |

---

## Los 20 fallos de la entrega anterior

| # | Fallo | Estado | Evidencia |
| --- | --- | --- | --- |
| 1 | Una orden real de mercado puede superar el techo por orden | **Corregido en compras; persiste en cortos** | H2 pasa (`live.audit.test.ts:539`). La variante en corto con hueco al alza sigue como `it.fails` C4 (`live.audit.test.ts:700`) |
| 2 | `live.evidence` sembrada cumple los requisitos en la app empaquetada | Corregido | H1 pasa (`live.audit.test.ts:370`) |
| 3 | Racha aislada a caballo de fin de mes degrada en 24 h | Corregido | H3 pasa (`ai.audit.test.ts:950`); en la UI, una revisión deja «En observación» |
| 4 | Sin activos ligados, el LLM atribuye sentimiento a un ticker no mencionado | Corregido | H4 pasa (`ai.audit.test.ts:316`) |
| 5 | Un titular desconfirmado sigue influyendo | Corregido | H5 pasa (`ai.audit.test.ts:334`). C6, un caso relacionado (titular antiguo analizado hoy), sigue `it.fails` |
| 6 | Órdenes: «Modo no disponible» en las órdenes paper | Corregido | «Paper · sin dinero real»; `qa-continuacion-b-ordenes-paper.png` |
| 7 | «Dinero real bloqueado · faltan 0 de 7» tras activar | Corregido | Tras activar: «Dinero real activo», 0 apariciones; `…-b-activado.png` |
| 8 | «(abre en el navegador externo)» visible en cada titular | Corregido | El texto es `sr-only` (1×1, `clip: rect(0 0 0 0)`); `…-a-noticias.png` |
| 9 | Motivo de degradación del modelo con doble punto | Corregido | «…durante 20 sesiones. No se debe…», sin «..»; `…-b-salud-modelo-detalle.png` |
| 10 | Los límites guardados sin confirmar se pierden al salir de Dinero real | Corregido | Al volver de Ajustes, 300/50 (A) y 200 (B) |
| 11 | Tras guardar los límites no se puede activar desde la interfaz | Corregido | Activado desde el diálogo a la primera; `live-gate.spec.ts:141` en verde |
| 12 | «Ver ficha del modelo» navega a Inicio | Corregido | Se queda en `#ia` con el foco en `#ai-model-card`; `…-a-ia-ficha-modelo.png` |
| 13 | «Predicción por activo» mezcla el histórico | Corregido | 4 filas vigentes e «Histórico de predicciones (196)» aparte; `…-a-ia-prediccion-vigente.png` |
| 14 | Posponer no deja entrada en el Diario | Corregido | «Propuesta de reentrenamiento 2026-Q4 pospuesta hasta 2027-01-15. Motivo: …» |
| 15 | Con el modo real, Órdenes no muestra las órdenes reales | Corregido | Dos filas «Dinero real» de SPY; `…-b-ordenes-real.png` (con N4 y N5 nuevos) |
| 16 | Diario rotula la prueba de humo como «Operación simulada» | Corregido | «Dinero real · Operación»; `…-b-diario-humo.png`. El filtro «Tipo» aún llama «Operación simulada» a la categoría (menor) |
| 17 | Prueba de humo a −8.278 pb y cantidad con precio ajeno | Corregido | 0,000667 uds × 1.499,06 ≈ 1,00 USD; referencia = cotización; slippage 0 pb en el simulador (ver N5 sobre la etiqueta «Precio pedido») |
| 18 | Declaraciones cumplidas con «Sin evidencia guardada.» | Corregido | «“…” — suscrita el 12 oct 2026.» con la nota; `…-b-declaracion-evidencia.png` |
| 19 | La evidencia de la parada dice «hoy» con la fecha UTC | Corregido | A las 00:37 CEST del 12-10 (11-10 en UTC): «Última prueba hoy (12 oct 2026).» |
| 20 | «60/60 resueltas» con «Brier móvil Sin referencia» y «Sin referencia %» | Corregido | «Brier móvil 0,304 · Ficha 0,197 · diferencia 0,107 · 60/60»; «Sin referencia %» aparece 0 veces |

**Resumen:** 19 corregidos y 1 corregido en parte (n.º 1: el caso en corto sigue abierto como C4).

---

## Problemas nuevos

### N1 · Media · Backend (y Frontend) — Un «Probar conexión» fallido con los datos al día pone toda la app en «Datos desactualizados desde el sin datos»

- **Pasos:**
  1. Perfil vacío, seguir SPY y esperar a «Al día».
  2. En Ajustes, «Probar conexión» de FRED con un resultado `error` (gancho `providers.simulateTest`; en la vida real, un fallo puntual o un 5xx de FRED).
  3. Ir a Inicio, IA y Macro.
  4. Pulsar «Actualizar ahora».
- **Esperado:** el fallo de la prueba se queda en la fila de FRED en Ajustes. Si de verdad afecta a la frescura, la franja da una fecha real. La pausa de la interfaz coincide con lo que calcula el backend.
- **Observado:**
  - `dataStatus.freshness()` pasa a `{state:'stale', sinceDate:null, items:[provider:fred]}`.
  - La franja global dice «Datos desactualizados desde el sin datos».
  - IA muestra «En pausa: … No se calculan nuevas probabilidades». Sin embargo, tras avanzar un cierre, el backend calcula el régimen y las predicciones del 07-10.
  - «Actualizar ahora» responde «Datos actualizados.» y la franja no se va. Solo desaparece con otra prueba de conexión correcta.
- **Evidencia:** `docs/qa/capturas/qa-continuacion-a-desactualizado-sin-datos-tras-prueba-fallida.png`; `/tmp/qa-cont/perfil-a3.log`; `applyToDataStatus` en `src/main/providers/index.ts`; `sessionDateLabel(null)` → «sin datos» en `DataFreshness.tsx:13`.
- **Responsable propuesto:** backend (que el resultado de la prueba no marque como desactualizados los datos que están al día, o que la frescura agregada lo ignore si no hay `lastOkAt`). Frontend: no componer «desde el sin datos».

### N2 · Baja · Frontend — Los mensajes de un «Actualizar ahora» anterior se quedan en la franja

- **Pasos:** provocar el estado desactualizado y pulsar «Actualizar ahora» con el proveedor fallando. Volver a estar al día y provocar otro aviso (N1).
- **Esperado:** la franja nueva empieza sin mensajes de intentos anteriores.
- **Observado:** aparecen «No se pudo actualizar: fallo simulado del proveedor (network)» y «…proveedor macro (network)» de la incidencia anterior. Causa: el estado `messages` de `DataFreshness` no se limpia al cambiar el resumen.
- **Evidencia:** `/tmp/qa-cont/perfil-a2.log` (paso 14, «franja inicio»); `qa-continuacion-a-no-fiable-tras-prueba-fallida.png`.

### N3 · Baja · Frontend — El estado «Error del proveedor» sale con doble punto

- **Pasos:** Ajustes › «Probar conexión» con resultado `error`.
- **Esperado:** «…no ha respondido como esperábamos: El proveedor no respondió como se esperaba. Vuelve a probar…»
- **Observado:** «…como se esperaba.. Vuelve a probar…». El mensaje del backend ya termina en punto y la plantilla añade otro. `provider-connection.spec.ts` lo tolera con `\.+`.
- **Evidencia:** `qa-continuacion-a-probar-conexion-error.png`.

### N4 · Media · Frontend — Órdenes muestra «Cantidad 0» en las órdenes reales fraccionarias de la prueba de humo

- **Pasos:** activar el dinero real (broker simulado) › prueba de 1 USD › Órdenes.
- **Esperado:** la cantidad real (0,000667 uds), como en el Diario.
- **Observado:** la columna Cantidad dice **0** en la compra y en la venta. En `orders.list({mode:'live'})`, `qty: 0.000667`. Quien audita el dinero real no puede ver cuánto se compró.
- **Evidencia:** `qa-continuacion-b-ordenes-real.png`, `…-ordenes-todos-los-modos.png`; `/tmp/qa-cont/perfil-b2.log`.

### N5 · Baja · Frontend/Backend — «Precio pedido» de la compra de humo no coincide entre pantallas

- **Pasos:** ejecutar la prueba de humo y comparar el panel, Órdenes y el Diario.
- **Esperado:** el mismo precio pedido (o «límite» y «referencia» rotulados por separado) y un slippage calculado respecto a ese precio.
- **Observado:**
  - Panel: «Precio pedido compra 1.544,03 USD» (el límite de protección, +3 %) y, a la vez, «Slippage 0 pb · sin desviación».
  - Órdenes: tipo «Limitada» con «Precio pedido 1499,06 USD».
  - Diario: «referencia 1499,06 USD, slippage 0 pb».
  - Quien revisa lee una diferencia de 45 USD con «sin desviación».
- **Evidencia:** `qa-continuacion-b-prueba-humo.png`, `…-ordenes-real.png`; `smokeTest.requestedPrice = 1544.03` en `/tmp/qa-cont/perfil-b.log`.

### N6 · Media · Frontend — No hay forma de volver a paper desde la interfaz con el dinero real activo

- **Pasos:** activar el dinero real y ejecutar la prueba de humo. Buscar cómo terminar y volver a «Señales + paper trading».
- **Esperado:** una acción explícita «Desactivar dinero real» o «Volver a paper» (`live:deactivate` existe y `docs/dinero-real.md` registra «la vuelta a paper» en el Diario).
- **Observado:** la franja solo ofrece «Ver límites» y «Parada», y «Dinero real» no tiene ningún control. Las únicas salidas son la parada de emergencia o retirar una declaración. Ningún componente del renderer llama a `window.tradia.live.deactivate`.
- **Evidencia:** `/tmp/qa-cont/perfil-b.log` (paso 10); `grep -rn deactivate src/renderer/src` (solo en el adaptador simulado).
- **Decisión de supervisión:** Frontend añade el control usando los botones, diálogo y tokens aprobados; no requiere otra tarea de Diseño.

### N7 · Baja · Backend — Salud de modelos contradice la propuesta en la estrategia degradada

- **Pasos:** `broker.seedWeeks({weeks:16})` y dos `simulateDrift({kind:'rendimiento', subjectId:2})`. Abrir Salud de modelos.
- **Esperado:** la fila y la propuesta citan la misma desviación y el mismo número de operaciones.
- **Observado:** la fila dice «32 operaciones · desviación Sin backtest de referencia: no hay expectativa con la que comparar la desviación.», un texto concatenado tras «desviación». La propuesta dice «Desviación −36,0 % … con 34 operaciones». Puede deberse al gancho E2E, pero en pantalla se lee como una contradicción.
- **Evidencia:** `qa-continuacion-b-salud-degradada.png`.

### Persiste (ya conocido, fuera de los 20)

- **P13 (baja, backend):** el paso «Ejecución de compra» de la prueba de humo sigue sin hora (`smokeTest.steps` no lo incluye).

### Observaciones (no son fallos del producto)

- En modo E2E, «Probar conexión» usa siempre el sondeo simulado. En cambio, la ingesta cambia a Tiingo real en cuanto se guarda una clave. Con una clave falsa guardada en E2E, la prueba dice «Conectado» y la descarga falla. En la app empaquetada los dos caminos usan la red real.
- En E2E, «Ejecutada: 8/10/2026 17:00» aparece antes que la hora de envío (12/10), porque el broker simulado usa el reloj de mercado anclado.
- Sin clave, el modo E2E responde «Conectado» con «Sin clave guardada» al lado. Lo esperan las propias pruebas E2E; fuera de E2E el resultado es `sin-clave`.

## Fuera de alcance / no comprobado

Claves reales de Tiingo, FRED y Alpaca, el LLM real y la CLI de Claude, los paquetes nativos en los tres sistemas y el reentrenamiento con datos reales. Son comprobaciones del usuario (`docs/tareas-del-usuario.md`).

## Ronda de correcciones de Backend · 12-10-2026

| Hallazgo | Estado en Backend | Detalle y regresión |
| -------- | ----------------- | ------------------- |
| N1 | **Corregido (parte Backend)** | El resumen de frescura ya no pasa a `stale` por un `provider:*` en mal estado sin hijos atrasados, ni inventa un «desde» posterior a la sesión esperada. Regresiones: `health.test.ts` («un fallo de sondeo sin datos de hijos no marca atraso ni inventa una fecha» y las dos de proveedor en fallo). La parte Frontend (texto «desde el sin datos») ya estaba corregida en su ronda. |
| N5 | **Corregido (parte Backend)** | `LiveSmokeTestResult` lleva `referencePrice` (el último cierre de referencia) aparte de `requestedPrice` (el límite de protección sobre él), y el asiento del Diario nombra referencia y límite por separado. Regresión: `smoke.test.ts`. El rótulo del panel («Límite de protección») correspondía a Frontend. |
| N7 | **Corregido** | Una ficha degradada muestra en «Salud de modelos» los números de la revisión que la degradó —los mismos del motivo de la propuesta— en vez de la muestra en vivo, que podía quedarse sin referencia. Regresión: `drift/service.test.ts` («una ficha degradada muestra los números de la revisión que la degradó, como la propuesta»). |
| P13 | **Corregido (parte Backend)** | `LiveSmokeTestResult` lleva `buyExecutedAt`/`sellExecutedAt` con la hora de ejecución de cada pata; el panel ya puede fechar «Ejecución de compra». Regresión: `smoke.test.ts`. |
