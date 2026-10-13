# Verificación final · Fase 6-7 (continuación)

_Claude · Predeterminado (Testing) · 12-10-2026 · rama `orquesta/fase-fase-6-7-ia-predictiva-y-capital-mi-e43b6d` sobre `6fde0555`, árbol de trabajo limpio salvo este informe_

_Revisado a fondo por Devin · SWE (Testing) el 13-10-2026 sobre `b3a51091`: V1 y V2 ya estaban corregidos en la rama (commit `145b61a7`) y V3 se ha corregido en esta revisión (`testTimeout` en `vitest.config.ts`). Veredicto actualizado: **en verde** (§7)._

## Veredicto

**En verde tras la revisión a fondo del 13-10-2026** (verificación original: «casi en verde», con V1 y V2 abiertos; ambos quedaron corregidos en `145b61a7` y V3 en esta revisión).

- `typecheck`, `lint` y `format:check` pasan.
- `test:e2e` pasa (47/47) y `live-gate.spec.ts --repeat-each=5` da 10/10.
- `npm test`: en la verificación original falló 1 de 3 ejecuciones por una carrera de foco en `RiskGate.test.tsx` (V1, corregida con `waitFor` en `145b61a7`). En la revisión, la batería seguía siendo intermitente bajo carga: 1 de 3 ejecuciones falló con tests jsdom pesados que superaban el límite de 5 s (V3, corregido subiendo `testTimeout` a 15 s en `vitest.config.ts`). Con la corrección: 2 de 2 ejecuciones en verde, 183 archivos y 2.510 pruebas.
- Los 8 hallazgos de la auditoría (C1–C8), los 3 del E2E (H1–H3), los 7 del QA (N1–N7) y P13 están cerrados con su regresión.
- No queda ningún `it.fails`, `fixme`, `skip` ni `.only` en las auditorías ni en el E2E.
- `git ls-files .venv-ml` está vacío.

## 1. Comandos

Lanzados en serie sobre el mismo árbol (`/tmp/vf/*.log`):

| Comando | Resultado | Duración |
| --- | --- | --- |
| `npm run typecheck` | **EXIT 0** | 4,9 s |
| `npm run lint` | **EXIT 0**, sin avisos | 4,3 s |
| `npm run format:check` | **EXIT 0** («All matched files use Prettier code style!») | 4,8 s |
| `npm test`, ejecución 1 | **EXIT 1**: 181 archivos, **2.476 pasan y 1 falla** (`RiskGate.test.tsx > bloquea la navegación y enfoca el aviso hasta aceptar con teclado`) | 37 s |
| `npm test`, ejecución 2 | **EXIT 0**: 181 archivos, 2.477/2.477 | ≈37 s |
| `npm test`, ejecución 3 | **EXIT 0**: 181 archivos, 2.477/2.477 | ≈37 s |
| `npx vitest run src/renderer/src/components/RiskGate.test.tsx` (aislada) | 5/5 | 1,9 s |
| `npm run test:e2e`, ejecución 1 (incluye `npm run build`) | **EXIT 0**: **47 passed** | 4,2 min |
| `npm run test:e2e`, ejecución 2 | **EXIT 0**: **47 passed** | 4,7 min |
| `npx playwright test e2e/live-gate.spec.ts --repeat-each=5` | **EXIT 0**: **10 passed** | 43,2 s |
| `git ls-files .venv-ml \| wc -l` | **0** (`.venv-ml/` está en `.gitignore` y existe solo en local) | — |
| `grep -rnE 'it\.fails\|test\.fixme\|test\.skip\(\|it\.skip\(\|describe\.skip\(\|\.only\(' src e2e \| wc -l` | **0** | — |

- `playwright.config.ts`: `retries: 0` y `workers: 1`. Los verdes del E2E no se deben a reintentos.
- Los únicos condicionales son `describe.skipIf(ON_WINDOWS)` e `it.skipIf(ON_WINDOWS)`, en `src/main/ai/news/claudeCli.test.ts:134,328`. Usan la CLI falsa POSIX, no están en auditorías ni en el E2E y en macOS se ejecutan. En Windows lo cubre `claudeCli.audit.test.ts:367` (C3).

## 2. Escenarios que fallaron en cada informe, repetidos

Comando: `npx vitest run src/main/live/__audit__ src/main/ai/__audit__ src/main/providers/__audit__ src/main/market/health.test.ts src/main/live/smoke.test.ts src/main/ai/drift/service.test.ts src/main/services/secrets.test.ts src/main/ai/news/local.test.ts src/main/ai/news/service.test.ts src/main/ai/prediction/parity.test.ts src/main/backtest/service.regime.test.ts src/renderer/src/components/DataFreshness.test.tsx src/renderer/src/components/orders/OrdersPage.test.tsx`

Resultado: **14 archivos, 277/277**. Además, `ProviderConnectionResult.test.tsx` y las carpetas de renderer `live`, `journal`, `ai` y `model-health` dan **6 archivos, 105/105**.

### Auditoría (`auditoria-continuacion-fase-6-7.md`)

| Hallazgo | Estado | Prueba repetida (ya como `it`) |
| --- | --- | --- |
| C1 · CLI con herramientas | Cerrado | `claudeCli.audit.test.ts:284` |
| C2 · stderr sin tope | Cerrado | `claudeCli.audit.test.ts:342` |
| C3 · `.cmd` en Windows | Cerrado (en código); falta comprobarlo en un Windows real (tarea del usuario) | `claudeCli.audit.test.ts:367` |
| C4 · corto por encima del techo | Cerrado | `live.audit.test.ts:700` |
| C5 · predicción vieja | Cerrado | `ai.audit.test.ts:784` |
| C6 · titular antiguo analizado hoy | Cerrado | `ai.audit.test.ts:505` |
| C7 · `detail` de Tiingo con la clave | Cerrado | `providers.audit.test.ts:238` |
| C8 · transporte de Tiingo con la clave | Cerrado | `providers.audit.test.ts:253`, `secrets.test.ts` |
| H1–H5, P7 y régimen desconocido (auditoría previa) | Cerrados | `live.audit.test.ts:370,539,612,683,719`, `ai.audit.test.ts:316,334,405,768,950` |

### E2E (`e2e-continuacion-fase-6-7.md`)

| Hallazgo | Estado | Evidencia |
| --- | --- | --- |
| H1 · refresco macro fallido enciende «desactualizado desde el 9 oct» | Cerrado | `health.test.ts` («un proveedor en fallo con todos sus hijos al día…» y «…con un hijo atrasado sí pesa…»); `stale-data.spec.ts` en las dos ejecuciones |
| H2 · sin red pasa un cierre y sigue «Al día» | Cerrado | `health.test.ts` («marca el atraso por calendario aunque ninguna pasada lo haya escrito»), `DataFreshness.test.tsx`, `AiPage.test.tsx`; `stale-data.spec.ts` |
| H3 · punto doble en «Error del proveedor» | Cerrado | `ProviderConnectionResult.test.tsx`; `provider-connection.spec.ts` exige `\.` |

### QA por perfiles (`perfiles-continuacion-fase-6-7.md`)

| Hallazgo | Estado | Evidencia |
| --- | --- | --- |
| N1 · «Datos desactualizados desde el sin datos» | Cerrado (Backend y Frontend) | `health.test.ts` («un fallo de sondeo sin datos de hijos…»), `DataFreshness.test.tsx` (stale sin fecha) |
| N2 · mensajes viejos en la franja | Cerrado | `DataFreshness.test.tsx` (recuperación y respuesta tardía) |
| N3 · punto doble | Cerrado | Igual que H3 |
| N4 · «Cantidad 0» en órdenes fraccionarias | Cerrado | `OrdersPage.test.tsx` (0,000667 y parcial 0,000123); `orders-live-mode.spec.ts` |
| N5 · «Precio pedido» incoherente | Cerrado | `smoke.test.ts` (`referencePrice` y `precioLimite` en el Diario); `SmokeTestPanel.tsx:165` rotula «Límite de protección de la compra» |
| N6 · no se puede volver a paper | Cerrado | `ChecklistPage.test.tsx`, `live.test.tsx`; `live-gate.spec.ts` ×5 y `orders-live-mode.spec.ts` |
| N7 · fila de salud contra la propuesta | Cerrado | `drift/service.test.ts:799` |
| **P13 · «Ejecución de compra» sin hora** | **Abierto en Frontend (V2)** | Backend: `smoke.test.ts` con `buyExecutedAt`/`sellExecutedAt`. Pero `SmokeProgress.tsx:27` sigue con `at: null` y ningún componente lee `buyExecutedAt` (solo `adapters/simulated.ts` y la fixture `live.test.tsx:35`) |

### Los 20 fallos de la entrega anterior: regresión de cada uno

| # | Fallo | Regresión |
| --- | --- | --- |
| 1 | Orden real por encima del techo (compras y cortos) | `live.audit.test.ts:539,683,700`, `orderGuard.test.ts` |
| 2 | `live.evidence` sembrada válida en la app empaquetada | `live.audit.test.ts:370,612` |
| 3 | Racha aislada a caballo de fin de mes | `ai.audit.test.ts:950`, `drift/service.test.ts:595` |
| 4 | Ticker no mencionado | `ai.audit.test.ts:316`, `claudeCli.audit.test.ts:268` |
| 5 | Titular desconfirmado influye | `ai.audit.test.ts:334,405` |
| 6 | «Modo no disponible» en las órdenes paper | `OrdersPage.test.tsx`, `orders-live-mode.spec.ts` |
| 7 | «faltan 0 de 7» tras activar | `ChecklistPage.test.tsx:221,270,394` |
| 8 | «(abre en el navegador externo)» visible | `NewsFeed.test.tsx:209` |
| 9 | Motivo de degradación con doble punto | `drift/service.test.ts:470` |
| 10 | Límites perdidos al salir de «Dinero real» | `ChecklistPage.test.tsx`, `live-gate.spec.ts` |
| 11 | No se activa desde la interfaz | `live-gate.spec.ts` (×5, 10/10) |
| 12 | «Ver ficha del modelo» lleva a Inicio | `ai-regime-prediction.spec.ts`, `AiPage.test.tsx` |
| 13 | Predicción por activo mezcla el histórico | `ai-regime-prediction.spec.ts`, `AiPage.test.tsx` |
| 14 | Posponer sin entrada en el Diario | `drift/service.test.ts:719,747`, `ai.audit.test.ts:876` |
| 15 | Órdenes no muestra las reales | `orders-live-mode.spec.ts` |
| 16 | Diario: «Operación simulada» | `orders-live-mode.spec.ts`, `JournalPage.test.tsx` |
| 17 | Humo a −8.278 pb y precio ajeno | `smoke.test.ts:282,551,585`, `live.audit.test.ts:719` |
| 18 | «Sin evidencia guardada.» en declaraciones cumplidas | `ChecklistPage.test.tsx:437` |
| 19 | Parada «hoy» con fecha UTC | `ChecklistPage.test.tsx:470` |
| 20 | «60/60» con «Sin referencia» | `ModelHealthPage.test.tsx:98`, `drift/service.test.ts:433,452` |

## 3. Criterios de aceptación de la misión

| # | Criterio | Estado | Evidencia |
| --- | --- | --- | --- |
| 1 | Activar el dinero real sin la lista cumplida se rechaza desde la pantalla y por IPC, mostrando cada pendiente; solo se activa con todo cumplido y los límites confirmados | **Cumplido** | `live-gate.spec.ts` ×5 (10/10), `live.audit.test.ts`, captura `fase-6-7-dinero-real-bloqueado.png` |
| 2 | Humo con el importe mínimo, cierre y conciliación sin descuadres; Diario con hora, precio pedido, ejecutado y slippage; los techos bloquean antes del broker | **Cumplido**, con la salvedad de V2 (la hora de la ejecución de compra no se pinta en el panel; sí está en el Diario y en el resultado) | `smoke.test.ts`, `live.audit.test.ts:539,683,700`, `orders-live-mode.spec.ts`, `continuacion-diario-prueba-humo-real.png` |
| 3 | Régimen en la ficha de estrategia («funciona en» y «falla en») y comparación con y sin filtro; la página IA con el régimen por activo y del mercado y las estrategias activas o desactivadas | **Cumplido** | `service.regime.test.ts`, `StrategyAi.test.tsx`, `AiPage.test.tsx`, `ai-regime-prediction.spec.ts` |
| 4 | Ficha del modelo con versión, horizonte, periodos, Brier frente a la referencia y calibración; paridad ONNX en Node frente al pipeline | **Cumplido** | `prediction/parity.test.ts` («las salidas servidas coinciden con las del fixture a 1e-6», hash SHA-256), `AiPage.test.tsx`, `continuacion-ia-ver-ficha-modelo.png` |
| 5 | Titulares etiquetados; un titular sin verificar nunca crea señal; todo pasa por `risk:submit-signal`; un drift sostenido degrada y una racha aislada no | **Cumplido** | `news/local.test.ts:30` (≥90 % activo, ≥70 % sentimiento sobre `headlines.labeled.json`), `ai.audit.test.ts`, `signals.audit.test.ts`, `drift/service.test.ts:253,535,595,770,791` |
| 6 | Los cuatro comandos en verde | **No del todo**: `npm test` dio verde en 2 de 3 ejecuciones (V1) | §1 |
| 7 | Lo anterior, sin `it.fails`/`fixme`/`skip`, y cada uno de los 20 fallos con su regresión | **Cumplido salvo V1** | `grep` = 0; tabla de los 20 fallos |
| 8 | Dinero real con el broker simulado: rechazo por pantalla e IPC, activación desde la interfaz, `live-gate` ×5; `live.evidence` ignorada fuera de E2E | **Cumplido** | `live-gate.spec.ts --repeat-each=5`: 10/10; `live.audit.test.ts:370,612` |
| 9 | «Probar conexión» de Tiingo y FRED: «Conectado» con la fecha o el motivo exacto, sin devolver ni registrar la clave | **Cumplido** | `provider-connection.spec.ts` (6 estados × 2 proveedores y clave ausente del IPC, el DOM, `data-status` y los registros), `providers.audit.test.ts:187-253`, `continuacion-probar-conexion-*.png` |
| 10 | Un único «Datos desactualizados desde …» con acciones; puesta al día al arrancar y al reconectar; régimen, predicciones y señales en pausa | **Cumplido** | `stale-data.spec.ts` (2 pruebas, en las dos ejecuciones), `health.test.ts`, `ai.audit.test.ts:758`, `continuacion-datos-*.png` |
| 11 | Noticias sin API de pago: «Suscripción» si hay CLI y, si no, local; CLI falsa en las pruebas; nada sin verificar o desconfirmado influye y no se atribuyen tickers no mencionados | **Cumplido** | `news/service.test.ts:334`, `claudeCli.test.ts` (`fake-claude-cli.mjs`), `claudeCli.audit.test.ts`, `ai.audit.test.ts:316,334,505` |
| 12 | Tour con perfil vacío, que se salta, se retoma, se relanza desde Ajustes, se recorre con teclado y no se salta el aviso de riesgo | **Cumplido** | `onboarding-tour.spec.ts` (3 pruebas), `RiskGate.test.tsx`, `continuacion-tour-*.png` |

## 4. Sesiones por perfil

Las dos sesiones se han hecho repitiendo, sobre la rama conjunta, los recorridos automatizados de cada perfil y los escenarios que fallaron. No he hecho una exploración manual nueva.

- **Profesional independiente que organiza varios proyectos:**
  - `onboarding-tour.spec.ts` (aviso con teclado, 10 pasos, pausa y reanudación);
  - `provider-connection.spec.ts`;
  - `stale-data.spec.ts` (proveedor caído, sin red y reconexión);
  - `ai-regime-prediction.spec.ts` (predicción vigente y ficha).

  Todo en verde en las dos ejecuciones del E2E.
- **Responsable de equipo que revisa entregas:**
  - `live-gate.spec.ts` ×5 (rechazo, activación, vuelta a paper y Diario);
  - `orders-live-mode.spec.ts` (modo de cada orden y Diario «Dinero real»);
  - `model-health.spec.ts`;
  - las auditorías C1–C8.

  Todo en verde. Encontrado V2 al revisar P13.

## 5. Hallazgos abiertos en la verificación original (todos cerrados al 13-10-2026)

### V1 · Media · Frontend (prueba) — `RiskGate.test.tsx` falla de forma intermitente y pone `npm test` en rojo — **CERRADO**

- **Pasos:** `npm test` con la batería completa en paralelo (en la primera ejecución de las tres).
- **Esperado:** 2.477/2.477 siempre.
- **Observado:** `bloquea la navegación y enfoca el aviso hasta aceptar con teclado` → `expect(element).toHaveFocus()`. Se esperaba `<h1 id="risk-title">` y el foco estaba en `<body>`. Aislada pasa 5/5, y las ejecuciones 2 y 3 pasaron.
- **Causa probable:** `RiskGate.test.tsx:26` hace `expect(await screen.findByRole('heading', …)).toHaveFocus()`. `findByRole` resuelve en cuanto aparece el encabezado, pero el foco lo pone un `useEffect` (`RiskDisclaimer.tsx:19`), que bajo carga todavía no ha corrido. El producto sí enfoca: lo comprueban `onboarding-tour.spec.ts` y el E2E.
- **Arreglo sugerido:** esperar el foco con `await waitFor(() => expect(heading).toHaveFocus())`.
- **Evidencia:** `/tmp/vf/test.log` (ejecución 1), `/tmp/vf/test2.log` y `/tmp/vf/test3.log`.
- **Cierre:** `145b61a7` aplicó el arreglo sugerido (`await waitFor(() => expect(heading).toHaveFocus())`, `RiskGate.test.tsx:27`). La prueba pasó en las 5 ejecuciones de la revisión, incluida una con otros timeouts bajo carga.

### V2 · Baja · Frontend — P13 sigue a medias: el panel de la prueba de humo no pinta la hora de «Ejecución de compra» — **CERRADO**

- **Pasos:** activar el dinero real con el broker simulado y ejecutar la prueba de 1 USD.
- **Esperado:** cada paso con su hora, incluida «Ejecución de compra» (`LiveSmokeTestResult.buyExecutedAt`, que Backend ya entrega).
- **Observado:** `SmokeProgress.tsx:27` fija `at: null` para ese paso. Ningún componente lee `buyExecutedAt` ni `sellExecutedAt` (`grep -rn buyExecutedAt src/renderer/src/components` → solo la fixture `live/live.test.tsx:35`).
- **Evidencia:** código citado. El informe de perfiles marca P13 como «Corregido (parte Backend)… el panel ya puede fechar».
- **Cierre:** `145b61a7` cambió `SmokeProgress.tsx:27` a `at: result?.buyExecutedAt ?? null` y añadió la regresión `V2: la ejecución de compra muestra su hora solo si llega buyExecutedAt` (`live/live.test.tsx`, `it.each` con y sin hora).

### V3 · Media · Frontend (pruebas) — la batería jsdom sigue siendo intermitente bajo carga aunque V1 esté cerrado — **CERRADO**

Hallazgo nuevo de la revisión a fondo (13-10-2026, `b3a51091`):

- **Pasos:** `npm test` completo, 3 ejecuciones en serie sobre `b3a51091`.
- **Esperado:** 2.510/2.510 siempre.
- **Observado:** la 1.ª ejecución falló con 3 pruebas en rojo por `Test timed out in 5000ms`: `MarketWorkspace.test.tsx:73` («normaliza el ticker, dibuja OHLC ajustado…») y `StrategiesPage.test.tsx` («crea, exige nota…» en :97, y «valida JSON…» por arrastre del timeout anterior). Aisladas pasan 17/17 en 4,5 s; las ejecuciones 2 y 3 pasaron completas. No es la misma carrera de V1: son tests largos de `user-event` que superan el límite por defecto de 5 s cuando los 183 workers compiten por CPU (en esta máquina corren varios agentes a la vez).
- **Arreglo aplicado:** `testTimeout: 15_000` en `vitest.config.ts`. Con él, 2 ejecuciones más de `npm test` completas en verde (2.510/2.510 cada una).
- **Evidencia:** `../vf-audit/test-run{1..5}.log` fuera del árbol; `git show` del cambio en `vitest.config.ts`.

## 6. Fuera de alcance / no comprobado aquí

Estas comprobaciones son del usuario (`docs/tareas-del-usuario.md`):

- las claves reales de Tiingo, FRED y Alpaca;
- la CLI real de Claude y la API de Anthropic;
- el reentrenamiento con datos reales;
- la app empaquetada en macOS, Windows y Linux, incluido C3 en un Windows real;
- la revisión legal y fiscal.

## 7. Revisión a fondo — verificación repetida (Devin · SWE · 13-10-2026)

Rama `orquesta/fase-fase-6-7-ia-predictiva-y-capital-mi-e43b6d` sobre `b3a51091`. Entre la verificación original (`6fde0555`) y esta revisión entraron las rondas de cierre de los 23 fallos y, entre ellos, `145b61a7`, que corrigió V1 y V2. Los comandos se repitieron sobre el árbol actual; las diferencias con la tabla de §1 vienen del tiempo transcurrido, no de errores del informe original.

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | **EXIT 0** |
| `npm run lint` | **EXIT 0**, sin avisos |
| `npm run format:check` | **EXIT 0** |
| `npm test`, ejecución 1 | **EXIT 1**: 2.507/2.510; 3 timeouts de 5 s en jsdom (`MarketWorkspace`, `StrategiesPage`) → V3 |
| `npm test`, ejecuciones 2 y 3 | **EXIT 0**: 183 archivos, 2.510/2.510 |
| `npm test`, ejecuciones 4 y 5 (con `testTimeout: 15_000`) | **EXIT 0**: 2.510/2.510 |
| `npm run test:e2e` (incluye `npm run build`) | **EXIT 0**: **47 passed** |
| `npx playwright test e2e/live-gate.spec.ts --repeat-each=5` | **EXIT 0**: **10 passed** |
| Auditorías + regresiones (`__audit__` ×6, `health`, `smoke`, `drift`, `secrets`, `news/*`, `parity`, `service.regime`) | **15 archivos, 310/310** |
| Renderer: `ProviderConnectionResult` + `live`, `journal`, `ai`, `model-health` | **6 archivos, 109/109** (la regresión de V2 entre ellas) |
| `git ls-files .venv-ml` | **0** |
| `grep -rnE 'it\.fails\|test\.fixme\|test\.skip\(\|it\.skip\(\|describe\.skip\(\|\.only\(' src e2e` | **0** (quedan los `skipIf(ON_WINDOWS)` de `claudeCli.test.ts`, que en macOS corren) |
| `grep -rn 'console\.log' e2e` | **0**; no hay specs de exploración sueltos en `e2e/` |

**Cambios hechos en esta revisión:**

- `vitest.config.ts`: `testTimeout: 15_000`. Motivo: los fallos observados eran siempre `Test timed out in 5000ms` en pruebas jsdom largas de `user-event` bajo 183 workers en paralelo; nunca fallos de aserción. Triplicar el límite elimina el modo de fallo medido sin esconder cuelgues reales.
- Este informe: veredicto y §5 actualizados al estado verificado; V1 y V2 marcados como cerrados con su commit y su regresión; V3 documentado y cerrado.

**Estado de los hallazgos de la verificación original:** V1 y V2 estaban ya corregidos en la rama por `145b61a7` («Foco estable en el aviso de riesgo y hora de ejecución en la prueba de humo»), con la regresión de V2 en `live.test.tsx`; ambos se han confirmado en el código y en las ejecuciones. V3 es nuevo de esta revisión y queda cerrado con `testTimeout`.

**Criterios 6 y 7:** con `testTimeout` aplicado, los cuatro comandos terminan en verde y la batería ya no muestra el modo de fallo intermitente observado. Los criterios 1–5 y 8–12 se mantienen como en §3; sus evidencias se han repetido aquí (E2E 47/47, live-gate 10/10, auditorías 310/310) sin encontrar divergencias.
