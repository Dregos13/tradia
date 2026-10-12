# Cierre uno a uno de los 23 fallos pendientes · Fase 6-7

_Claude · Predeterminado (Testing) · 12-10-2026 · rama `orquesta/fase-fase-6-7-ia-predictiva-y-capital-mi-e43b6d` sobre `ca851496` (incluye be-motivo-regimen-fechas, fe-fechas-desactualizado-unicas y be-motivos-frescura-sin-iso)_

## Veredicto

- **22 de los 23 fallos están cerrados.** Cada uno tiene su prueba de regresión, ejecutada en verde sobre la rama conjunta.
- **El nº 11 (transporte de Tiingo) queda cerrado a medias.** La clave ya no sale en el error. Pero una clave **ya guardada** antes de la corrección con un carácter de control sigue apareciendo en «Probar conexión» como «Sin conexión a internet.» (R1).
- **Hay 3 hallazgos nuevos, todos de gravedad baja.** Salieron al repetir los recorridos en la app real:
  - **R2 (Backend):** motivos transitorios en ISO visibles en Inicio.
  - **R3 (Frontend):** sin red, Inicio se queda congelado en «Actualizando».
  - **R4 (Frontend):** sin red, los paneles de IA dicen «fecha del último dato no disponible» junto a la fecha que sí se conoce.
- Los comandos del entregable están todos en verde:
  - `typecheck`, `lint` y `format:check`;
  - `npm test` ×3 (y otras ×3 después de añadir las pruebas);
  - `test:e2e` ×2 (47/47);
  - `live-gate.spec.ts --repeat-each=5` (10/10).
- `grep -rnE 'it\.fails|test\.fixme|\.skip\(|\.only\(' src e2e` da **0** y `git ls-files .venv-ml` da **0**.

No he tocado código de producto. He añadido solo pruebas y evidencia:

- `src/main/market/macro/reconexion.test.ts` (nueva): FRED se pone al día al volver la red. No había ninguna prueba de esa parte del fallo nº 1.
- `src/main/ai/__audit__/claudeCli.audit.test.ts:299` (nueva `it`): fija `--setting-sources ''`, `--tools ''`, `--strict-mcp-config`, un `cwd` neutro y la ausencia de shell, también en `ping()`. Ninguna prueba comprobaba explícitamente `--setting-sources ''` (criterio 17).
- `docs/qa/cierre-fallos/app-real/`: repetición en la app real (sin modo E2E) del escenario de datos viejos y sin red de `regresion-2`. Añade pasos de «Probar conexión», del reintento de FRED y de un refresco macro fallido. Incluye capturas, volcados y registros.
- `docs/qa/cierre-fallos/comandos/`: salida de cada comando.

El E2E ha regenerado las capturas de `docs/qa/capturas/*.png`, como en las entregas anteriores.

## 1. Comandos

Lanzados en serie con `/tmp/cf/battery.sh`. La salida está en `docs/qa/cierre-fallos/comandos/`.

| Comando | Resultado | Duración |
| --- | --- | --- |
| `npm run typecheck` | **EXIT 0** | 5 s |
| `npm run lint` | **EXIT 0** | 4 s |
| `npm run format:check` | **EXIT 0** («All matched files use Prettier code style!») | 5 s |
| `npm test`, ejecución 1 | **EXIT 0**: 182 archivos, 2.488/2.488 | 40 s |
| `npm test`, ejecución 2 | **EXIT 0**: 182 archivos, 2.488/2.488 | 40 s |
| `npm test`, ejecución 3 | **EXIT 0**: 182 archivos, 2.488/2.488 | 38 s |
| `npm run test:e2e`, ejecución 1 (incluye `npm run build`) | **EXIT 0**: **47 passed** | 4,3 min |
| `npm run test:e2e`, ejecución 2 | **EXIT 0**: **47 passed** | 4,4 min |
| `npx playwright test e2e/live-gate.spec.ts --repeat-each=5` | **EXIT 0**: **10 passed** | 43,8 s |
| `grep -rnE 'it\.fails\|test\.fixme\|\.skip\(\|\.only\(' src e2e \| wc -l` | **0** | — |

Tras añadir las dos pruebas nuevas, repetí la parte de Vitest y las comprobaciones estáticas (`/tmp/cf/battery2.sh`, `comandos/resumen-bateria-2.txt`):

| Comando | Resultado |
| --- | --- |
| Pasada de las regresiones de los 23 fallos (ver §2) | **EXIT 0**: 23 archivos, **397/397** |
| `npm run typecheck`, `npm run lint` y `npm run format:check` | **EXIT 0** los tres |
| `npm test` ×3 | **EXIT 0** las tres: 183 archivos, **2.491/2.491** |
| `grep` de `it.fails`/`fixme`/`skip`/`only` | **0** |
| `git ls-files .venv-ml \| wc -l` | **0** |
| `npx playwright test -c docs/qa/cierre-fallos/app-real` (app real, tras `electron-vite build`) | **EXIT 0**: 3 passed (4,0 min) |

`playwright.config.ts` tiene `retries: 0` y `workers: 1`, así que ningún verde se debe a reintentos.

## 2. Los 23 fallos, en el orden del motor

Pasada de regresión: `npx vitest run src/main/market/macro/reconexion.test.ts src/main/market/ingestion.test.ts src/main/risk/killSwitch.test.ts src/renderer/src/components/Connectivity.test.tsx src/main/ai/regime/service.test.ts src/main/ai/prediction/service.test.ts src/main/ai/__audit__ src/main/market/__integration__/data-flow.test.ts src/renderer/src/components/DataFreshness.test.tsx src/renderer/src/components/ai/AiPage.test.tsx src/main/market/health.test.ts src/main/ai/regime/enablement.test.ts src/main/live/__audit__ src/main/providers/__audit__ src/main/services/secrets.test.ts src/renderer/src/components/ProviderConnectionResult.test.tsx src/renderer/src/components/live src/renderer/src/components/orders/OrdersPage.test.tsx src/main/live/smoke.test.ts src/main/ai/drift/service.test.ts src/renderer/src/components/RiskGate.test.tsx`

Resultado: **23 archivos, 397/397** (`comandos/regresiones.txt`). Las pruebas E2E citadas pasaron en las dos ejecuciones de `test:e2e`. Los escenarios «app real» son los de `docs/qa/cierre-fallos/app-real/regresion.spec.ts`.

| # | Fallo | Estado | Prueba de regresión | Resultado |
| --- | --- | --- | --- | --- |
| 1 | Al volver la red no reintenta Tiingo ni FRED, y la parada sigue activa rotulada como «Pausa manual» | **Cerrado** | `src/main/market/macro/reconexion.test.ts:58` y `:70` (**nueva**, FRED); `src/main/market/ingestion.test.ts:247`; `src/main/risk/killSwitch.test.ts:382`; `src/renderer/src/components/Connectivity.test.tsx:130`; `e2e/stale-data.spec.ts:225`; app real `regresion.spec.ts:511` (C-largo) | Verde. App real: tras 80 s sin red aparece «Parada activa: Pérdida de conexión · Activada por Sistema» y nunca «Pausa manual» (`app-real/c1-sin-red-80s.txt:21`). Al volver la red la parada se levanta (`c2-parada-tras-volver-red.json`: `active:false`, agentes sin pausa). Tiingo pasa de 4 a 8 peticiones y FRED de 6 a 12; las velas llegan al 9 oct y el régimen queda vigente (`c-resumen.json`, `c2-estado-tras-volver-red.json`) |
| 2 | Régimen, predicciones y señales se calculan y se muestran sobre velas viejas como si fueran actuales | **Cerrado** | `src/main/ai/regime/service.test.ts:363`, `:375`; `src/main/ai/prediction/service.test.ts:338`; `src/main/ai/__audit__/ai.audit.test.ts:752`; `src/main/market/__integration__/data-flow.test.ts:208`; `e2e/stale-data.spec.ts:83`; app real `regresion.spec.ts:466` (B3) | Verde. App real con Tiingo solo hasta el 25 sept: régimen y predicciones «En pausa», «un régimen caducado no habilita ni desactiva estrategias» (`app-real/b3-ia.txt:55-67`) |
| 3 | Con datos desactualizados, la franja global y los paneles de IA dan fechas distintas de «Datos desactualizados desde …», e Inicio muestra la fecha en ISO y la fuente como FRED | **Cerrado** (ver R2–R4 para el caso sin red) | `e2e/stale-data.spec.ts:83` (aserciones 148-160: la misma fecha en la franja y en los dos paneles, sin ISO); `src/renderer/src/components/DataFreshness.test.tsx:191`, `:337`, `:176`; `src/renderer/src/components/ai/AiPage.test.tsx:449`; `src/main/market/health.test.ts:882`; `src/main/ai/regime/enablement.test.ts:27`; app real B3 | Verde. App real: franja, «Régimen del mercado», «Predicción por activo» e Inicio dicen «Datos desactualizados desde el 25 sept 2026». El cierre de cálculo va aparte: «Calculado con el cierre del 18 sept 2026». Inicio dice «Régimen · En pausa: datos desactualizados · Referencia SPY · Fuente precios diarios» (`b3-ia.txt:21,37,51,53,63,65`; `b3-inicio.txt:21,57,112`). No hay ninguna fecha ISO en IA ni en Inicio |
| 4 | La CLI de Claude se lanza con herramientas disponibles (`--allowedTools ''` no las desactiva) y con las reglas de permisos del usuario | **Cerrado** | `src/main/ai/__audit__/claudeCli.audit.test.ts:284` (`--tools ''`) y `:299` (**nueva**: `--setting-sources ''`, `--strict-mcp-config`, `cwd` neutro y sin shell, también en `ping()`); `src/main/ai/news/claudeCli.test.ts:163` (argv exacto con la CLI falsa) | Verde |
| 5 | En Windows, con Claude Code instalado por npm (`claude.cmd`), el análisis por suscripción falla siempre con spawn EINVAL | **Cerrado en código** (comprobarlo en un Windows real es tarea del usuario) | `src/main/ai/__audit__/claudeCli.audit.test.ts:384` (el falso lanza EINVAL si se ejecuta un `.cmd` sin shell, como Node en Windows) | Verde |
| 6 | Una entrada real en corto se ejecuta por encima del techo por orden con un hueco al alza | **Cerrado** | `src/main/live/__audit__/live.audit.test.ts:700` | Verde |
| 7 | Una predicción de una sesión anterior (incluso de semanas) ajusta la confianza de la señal actual | **Cerrado** | `src/main/ai/__audit__/ai.audit.test.ts:778` | Verde |
| 8 | La salida de la CLI de Claude por stderr no tiene tope | **Cerrado** | `src/main/ai/__audit__/claudeCli.audit.test.ts:362` | Verde |
| 9 | Un titular publicado hace semanas y analizado hoy ajusta la confianza de las señales | **Cerrado** | `src/main/ai/__audit__/ai.audit.test.ts:506` | Verde |
| 10 | Un 200 de Tiingo con «detail» que repite la clave la devuelve en «Probar conexión» y en data_status | **Cerrado** | `src/main/providers/__audit__/providers.audit.test.ts:238` | Verde |
| 11 | Un fallo de transporte de Tiingo lleva la clave sin redactar y se presenta como «Sin conexión» | **Abierto a medias** (R1) | Clave redactada: `src/main/providers/__audit__/providers.audit.test.ts:250`. Clave nueva con controles rechazada al guardar: `src/main/services/secrets.test.ts:180` | Verde lo que cubren. **Sigue abierto:** una clave ya guardada con un carácter de control da «Sin conexión a internet.» (R1, comprobado con el `fetch` real de Node) |
| 12 | Un refresco macro fallido con los datos al día enciende «Datos desactualizados desde el 9 oct 2026», posterior a la sesión esperada | **Cerrado** | `src/main/market/health.test.ts:670`, `:694`; app real C-largo (FRED con 503 y `macro.refreshNow()`) | Verde. App real: `refreshNow` devuelve `ok:false` y el resumen sigue en `current` sin `sinceDate`. Inicio dice «Datos al día.» (`app-real/c-proveedores.json` «freshness-tras-macro», `c5-inicio-tras-fallo-macro.txt:22`) |
| 13 | Sin red, si pasa un cierre, la frescura sigue «Al día» mientras el régimen ya está caducado | **Cerrado** | `src/main/market/health.test.ts:754`; `src/renderer/src/components/DataFreshness.test.tsx:306`; `e2e/stale-data.spec.ts:225` (IA sin «Al día» y régimen «En pausa:») | Verde |
| 14 | El estado «Error del proveedor» de Probar conexión sale con punto doble | **Cerrado** | `src/renderer/src/components/ProviderConnectionResult.test.tsx:7` (H3/N3, tres variantes del motivo); `e2e/provider-connection.spec.ts:117`; app real C-largo | Verde. App real con Tiingo en 503: «Error del proveedor · … (HTTP 503). Vuelve a probar; …», con un solo punto (`c-proveedores.json` «error-Tiingo») |
| 15 | Un «Probar conexión» fallido con los datos al día pone toda la app en «Datos desactualizados desde el sin datos» y una pausa que el backend no aplica | **Cerrado** | `src/main/market/health.test.ts:728`; `src/renderer/src/components/DataFreshness.test.tsx:244` (N1); app real C-largo | Verde. App real: tras la prueba fallida el resumen sigue en `current` y la franja dice «Datos al día.» (`c-proveedores.json` «freshness-tras-error», `c4-probar-conexion-error.txt:22`) |
| 16 | Con el dinero real activo no hay forma de volver a paper desde la interfaz | **Cerrado** | `src/renderer/src/components/live/ChecklistPage.test.tsx:571`; `src/renderer/src/components/live/live.test.tsx:545`; `e2e/live-gate.spec.ts:141` (paso N6 en la línea 329) | Verde; `live-gate` 10/10 con `--repeat-each=5` |
| 17 | Órdenes muestra «Cantidad 0» en las órdenes reales fraccionarias de la prueba de humo | **Cerrado** | `src/renderer/src/components/orders/OrdersPage.test.tsx:356` (N4) | Verde |
| 18 | El «Precio pedido» de la compra de humo no coincide entre el panel, Órdenes y el Diario | **Cerrado** | `src/main/live/smoke.test.ts:425`; `src/renderer/src/components/orders/OrdersPage.test.tsx:365` (N5); `src/renderer/src/components/live/live.test.tsx:562` (N5) | Verde |
| 19 | Los mensajes de un «Actualizar ahora» anterior se quedan en la franja de datos | **Cerrado** | `src/renderer/src/components/DataFreshness.test.tsx:269`, `:287`, `:320` (N2) | Verde |
| 20 | El estado «Error del proveedor» de «Probar conexión» sale con doble punto | **Cerrado** (duplicado del nº 14) | `src/renderer/src/components/ProviderConnectionResult.test.tsx:7`; `e2e/provider-connection.spec.ts:117` | Verde |
| 21 | Salud de modelos contradice la propuesta en la estrategia degradada (desviación y número de operaciones) | **Cerrado** | `src/main/ai/drift/service.test.ts:799` (N7); `e2e/model-health.spec.ts:114` | Verde |
| 22 | RiskGate.test.tsx falla de forma intermitente bajo carga y pone npm test en rojo | **Cerrado** | `src/renderer/src/components/RiskGate.test.tsx:21` (el foco ya se espera con `waitFor`, línea 27) | Verde en las **6** ejecuciones de `npm test` completas |
| 23 | El panel de la prueba de humo no muestra la hora de «Ejecución de compra» aunque el backend ya entrega buyExecutedAt (P13) | **Cerrado** | `src/renderer/src/components/live/live.test.tsx:577` (V2, con y sin `buyExecutedAt`); `SmokeProgress.tsx:27` ya lee `result?.buyExecutedAt` | Verde |

## 3. Sesiones por perfil

### Profesional independiente que organiza varios proyectos · tour, «Probar conexión», sin red y reconexión, datos desactualizados

1. **Tour.** `e2e/onboarding-tour.spec.ts:89`, `:177` y `:228`: el aviso de riesgo con teclado, los 10 pasos solo con teclado, pausa con Esc y reanudación, y saltar y relanzar desde Ajustes. Verde en las dos ejecuciones del E2E. En la app real, un perfil nuevo abre el tour solo y su velo bloquea los clics hasta pulsar «Saltar tour», que es lo esperado. Lo he añadido al arranque de `app-real/regresion.spec.ts`.
2. **Sin red con datos viejos y vuelta de la red (app real, C-largo).** Siembro velas hasta el 18 sept y abro la app el 12 oct sin red.
   - A los 60 s salta «Parada activa: Pérdida de conexión».
   - Tras 80 s recupero la red: en 51 s desaparece «Sin conexión» y la parada se levanta sola.
   - Tiingo (4→8) y FRED (6→12) se ponen al día, las velas llegan al 9 oct y el régimen queda vigente.
3. **«Probar conexión» en Ajustes (app real).**
   - Con la red: «Conectado. Último dato disponible: 9 oct 2026» (Tiingo) y «… 8 oct 2026» (FRED).
   - Tiingo en 503: «Error del proveedor» con un solo punto y sin encender «desactualizados».
   - FRED en 503 con un refresco macro: tampoco enciende «desactualizados».
4. **Datos desactualizados (E2E).** `e2e/stale-data.spec.ts:83` y `:225`: una sola fecha en la franja, en los paneles y en los chips, «Actualizar ahora» con el motivo real, puesta al día al reconectar y al arrancar días después.

- **Esperado:** pausa solo mientras dura el corte, puesta al día sola al reconectar, «Probar conexión» con el motivo exacto, sin claves ni falsos «desactualizados», y fechas coherentes.
- **Observado:** todo lo esperado se cumple. Al revisar Inicio sin red aparecen R2 y R3 (la tarjeta VIX congelada en «Actualizando», con un motivo en ISO) y R4 (texto contradictorio sin red en IA).
- **Evidencia:** `docs/qa/cierre-fallos/app-real/c1-sin-red-80s.{png,txt}`, `c1-parada-80s.json`, `c2-*.json`, `c-resumen.json`, `c-proveedores.json`, `c3-probar-conexion-ok.png`, `c4-probar-conexion-error.png`, `c5-inicio-tras-fallo-macro.png`, `c-main.log`; `comandos/e2e1.txt`, `e2e2.txt`.

### Responsable de equipo que revisa entregas · dinero real, prueba de humo, Órdenes, Diario, Salud de modelos y noticias

1. **Dinero real.**
   - `e2e/live-gate.spec.ts:52`: sin la lista cumplida se rechaza en la interfaz y por IPC directo, y se muestra cada requisito.
   - `:141`: con todo cumplido y los límites confirmados se activa, pasa la prueba de humo y vuelve a paper.
   - ×5 = 10/10.
   - Auditorías C4 (`live.audit.test.ts:700`) y H1/H2/P7.
2. **Prueba de humo y Diario.**
   - `smoke.test.ts:425`: precio pedido (referencia), ejecutado y slippage.
   - `live.test.tsx:562`: el límite se rotula aparte del slippage.
   - `live.test.tsx:577`: la hora de «Ejecución de compra».
3. **Órdenes.** `e2e/orders-live-mode.spec.ts:86`: el modo de cada orden, las reales de la prueba de humo y el Diario «Dinero real». Además `OrdersPage.test.tsx:356` (fraccionarias) y `:365`.
4. **Salud de modelos.** `e2e/model-health.spec.ts:33` y `:114`, y `drift/service.test.ts:799` (la ficha cuadra con la propuesta).
5. **Noticias y CLI.**
   - `e2e/news-sentiment.spec.ts:109` y `:158`: un titular sin verificar queda fuera de las señales.
   - `ai.audit.test.ts:316`, `:334` y `:506`.
   - Auditoría de la CLI C1–C3 más la nueva prueba de `--setting-sources ''`.
6. **Datos viejos (app real, B3).** Con Tiingo solo hasta el 25 sept recorro Inicio, Mercado, IA, Salud de modelos, Macro, Estrategias y Diario. La fecha de «desactualizados» es la misma en todas las pantallas y en formato local, y el régimen y las predicciones están en pausa.

- **Esperado:** el dinero real solo se activa con la lista cumplida, la prueba de humo se concilia y se refleja igual en el panel, en Órdenes y en el Diario, Salud coincide con la propuesta, y ninguna noticia vieja o sin verificar influye.
- **Observado:** todo lo esperado se cumple. Lo único que queda es R1: la clasificación «Sin conexión» con una clave antigua, en el borde del fallo nº 11.
- **Evidencia:** `comandos/livegate.txt` (10 passed), `comandos/e2e1.txt` y `e2e2.txt`, `comandos/regresiones.txt`; `app-real/b3-*.txt|png`, `b3-estado.json`, `b3-main.log`.

## 4. Hallazgos abiertos

### R1 · Baja · Backend: una clave de Tiingo ya guardada con un carácter de control da «Sin conexión a internet.» en «Probar conexión» (segunda mitad del fallo nº 11)

- **Pasos:**
  1. Perfil con una clave de Tiingo guardada antes de la corrección de `secrets:set-key` y con un `\r` en medio (pegada desde un documento de Windows).
  2. Con internet, pulsar «Probar conexión» de Tiingo, o esperar a la ingesta.
- **Esperado:** el motivo real: la clave no es válida o tiene caracteres no válidos y hay que volver a pegarla. Así lo pedía la auditoría C8 («la prueba dice que la clave no es válida»).
- **Observado:**
  - La clave ya sale redactada: `[tiingo] fallo de transporte: TypeError: Headers.append: "Token ***" is an invalid header value.`
  - Pero `classifyProbeError` lo clasifica como `{"status":"sin-red","message":"Sin conexión a internet."}`, porque es un `network` sin `status` (`src/main/providers/tester.ts:150-155`). La ingesta lo cuenta como caída del proveedor.
  - `setKey` ya rechaza estas claves (`secrets.ts:83-91`), pero `getKey` devuelve sin validar las que ya estaban guardadas.
- **Evidencia:** prueba temporal (borrada después) con `createTiingoProvider({ fetch: globalThis.fetch, getApiKey: async () => 'tk…SECRETO\rtiingo' })` y `classifyProbeError`. La salida fue `CLASS {"status":"sin-red","message":"Sin conexión a internet.","reachedNetwork":false}`.
- **Arreglo sugerido:**
  - Validar la clave en `getKey` o justo antes de la petición: con controles, dar un `auth` con un motivo claro y no hacer la petición.
  - O clasificar el `TypeError` de cabecera inválida como `clave-rechazada`.

### R2 · Baja · Backend: los motivos transitorios de «actualizando» escriben fechas ISO y llegan a Inicio

- **Pasos:** app real, perfil con datos del 18 sept, abrir sin red (escenario C-largo) e ir a Inicio › Contexto macro.
- **Esperado:** ninguna fecha AAAA-MM-DD visible en Inicio (criterio 14), en el mismo formato local que el resto de motivos (`sessionDateLabel`).
- **Observado:**
  - La tarjeta VIXCLS muestra «descargando observaciones del 2026-09-17 al 2026-10-12 en 'fred'» (`app-real/c1-sin-red-80s.txt:135`).
  - Viene de `src/main/market/macro/service.ts:233`.
  - La ingesta tiene los mismos motivos en ISO: `src/main/market/ingestion.ts:496` («descargando velas del … al …») y `:534` («esperando la vela del …»). Backend ya lo había avisado en be-motivos-frescura-sin-iso.
- **Evidencia:** `docs/qa/cierre-fallos/app-real/c1-sin-red-80s.png` y `.txt:120-135`.

### R3 · Baja · Frontend: sin red, Inicio se queda con un «Actualizando» transitorio que el backend ya no tiene

- **Pasos:** los mismos que en R2. Tras 80 s sin red, mirar la tarjeta VIX de Inicio.
- **Esperado:** el último estado real. VIXCLS está en `desactualizado` («falta la observación esperada; último dato: 17 sept 2026») desde las 13:40:21 UTC, según `dataStatus.get()`.
- **Observado:**
  - Inicio sigue mostrando «◌ Actualizando» y el motivo de la descarga, aunque no hay red y la descarga ya falló.
  - Causa: con `offlineRef.current`, `useDashboard` conserva la instantánea anterior de todos los bloques salvo la parada (`src/renderer/src/components/dashboard/useDashboard.ts:89`) e ignora `dataStatus.onChanged` (`:152`). Si la caída llega con un estado transitorio, ese estado queda congelado.
- **Evidencia:** `app-real/c1-sin-red-80s.txt:120-135` frente a `app-real/c1-estado-80s.json` (`macro:VIXCLS`, `state: "desactualizado"`, `updatedAt 13:40:21Z`; volcado a las 13:41:50Z).
- **Arreglo sugerido:** no conservar `actualizando` en la instantánea sin red (mostrar el último estado estable o «Sin conexión»), o seguir aplicando los cambios de `data-status` que llegan del proceso principal, que no dependen de la red.

- **Estado:** Corregido en fe-fix-cierre-r3-r4. Regresión: `src/renderer/src/components/dashboard/Dashboard.test.tsx:332` (evento de actualizando a desactualizado sin red; conserva la observación local y cambia la tarjeta).

### R4 · Baja · Frontend: sin red, los paneles de IA dicen «fecha del último dato no disponible» junto a la fecha que sí se conoce

- **Pasos:** escenario de `e2e/stale-data.spec.ts:225`: sin red pasa un cierre; abrir IA.
- **Esperado:** un único estado coherente (criterio 10). Por ejemplo, «Sin conexión · no se pudo comprobar si hay datos más recientes», sin negar la fecha.
- **Observado:**
  - En la misma página: «Sin conexión · datos del 6 oct 2026», «Calculado con el cierre del 6 oct 2026» en los dos paneles y, en el estado de esos paneles, «Datos desactualizados · fecha del último dato no disponible».
  - La fecha del último dato sí se conoce. Lo que no se sabe es desde cuándo están desactualizados.
  - La spec lo fija así (`e2e/stale-data.spec.ts:253-256`), y el texto sale de `DataFreshness.tsx:27`.
- **Evidencia:** `e2e/stale-data.spec.ts:244-258`; `docs/qa/capturas/continuacion-datos-sin-red.png`.

- **Estado:** Corregido en fe-fix-cierre-r3-r4. Regresiones: `src/renderer/src/components/DataFreshness.test.tsx:371`, `src/renderer/src/components/ai/AiPage.test.tsx:394` y `e2e/stale-data.spec.ts:225` (ambos paneles muestran la fecha conocida y el aviso sin red, sin negarla ni mostrar fechas ISO). Captura actualizada: `docs/qa/capturas/continuacion-datos-sin-red.png`.
- **Validación de R3/R4:** `npm run typecheck`, `npm run lint`, `npm test` (183 archivos, 2493 pruebas) y `npx playwright test e2e/stale-data.spec.ts` (2 pruebas, tras `npx electron-vite build`) en verde.

## 5. Fuera de alcance / no comprobado aquí

Estas comprobaciones son tareas del usuario (`docs/tareas-del-usuario.md`):

- las claves reales de Tiingo, FRED y Alpaca;
- la CLI real de Claude, incluido `claude.cmd` en un Windows real (fallo nº 5), y la API de Anthropic;
- la app empaquetada en macOS, Windows y Linux;
- el reentrenamiento con datos reales;
- la revisión legal y fiscal.

Aquí se han usado el modo E2E, la CLI falsa y, en la app real, un servidor local que imita a Tiingo y FRED.
