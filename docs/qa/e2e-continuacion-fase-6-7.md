# E2E · Continuación de la fase 6-7: tour, conexión, datos desactualizados, Órdenes y dinero real

_Testing · Playwright sobre la app Electron real · 12-10-2026_

## Resultado

| Comando | Resultado |
| --- | --- |
| `npm run test:e2e`, ejecución 1 | **47 passed** (4,5 min), código 0 |
| `npm run test:e2e`, ejecución 2 | **47 passed** (3,9 min), código 0 |
| `npm run test:e2e`, ejecución 3 | **47 passed** (4,2 min), código 0 |
| `npx playwright test e2e/live-gate.spec.ts --repeat-each=5` | **10 passed** (41,8 s), código 0 |
| `npx tsc --noEmit`, `npx eslint e2e`, `npx prettier --check e2e` | en verde |

- `playwright.config.ts` sigue con `retries: 0` y un solo worker.
- En `e2e/` no hay ningún `test.fixme`, `test.skip`, `test.fail` ni `.only`.
- Las tres ejecuciones se hicieron seguidas, sobre el mismo árbol, con `npm run test:e2e` (incluye `npm run build`).

### Punto de partida

Antes de esta tarea, **la batería entera fallaba**. Desde la llegada del tour, con un perfil vacío el tour se lanza solo al aceptar el aviso de riesgo, y su velo vuelve inerte el resto de la ventana. Todos los recorridos que no lo cerraban agotaban el tiempo a los ~32 s (lo avisó be-frescura-datos).

Al saltar el tour en los arranques, quedaban 2 fallos de 37 pruebas:

| Spec | Causa | Arreglo (solo en la prueba) |
| --- | --- | --- |
| `market-chart.spec.ts` | Buscaba la franja antigua por proveedor, `region «Datos del mercado»`, y el texto «Actualización solicitada». Ahora hay una franja única y «Actualizar ahora» devuelve el motivo real (P13). | Usa la región «Estado de los datos» (exactamente 1) y espera «No se pudo actualizar: fallo simulado del proveedor (network)». |
| `model-health.spec.ts:114` | La regla de degradación exige ≥ 30 operaciones cerradas (`DEGRADE_MIN_TRADES`). La prueba no sembraba ninguna, así que salía `insuficiente`. | Siembra 16 semanas con `testing.broker.seedWeeks` (32 operaciones por estrategia semilla) y usa la semilla 2, la perdedora. |

## Qué se ha añadido o cambiado en `e2e/`

- **`onboarding.helpers.ts`** (nuevo): `tourDialog()` y `skipGuidedTour()`. Lo usan todos los specs que arrancan la app sin probar el tour.
- **`phase-6-7.helpers.ts`**:
  - `launchPhaseApp` admite `onboarding: 'skip' | 'manual'` y variables de entorno extra.
  - `relaunchPhaseApp()` nuevo: cierra la app y la abre con el mismo perfil y el mismo servidor local, como el siguiente arranque del mismo usuario.
- **`onboarding-tour.spec.ts`** (nuevo, 3 pruebas):
  1. Primer arranque:
     - el aviso de riesgo va primero, aceptado solo con teclado;
     - el tour arranca solo, con el resto de la ventana `inert` y el foco atrapado (X → Saltar → Empezar → X, y también con Mayús+Tab);
     - se recorren los 10 pasos con `→`, `←`, Mayús+Tab e Intro, comparando título, texto y ruta con `TOUR_STEPS`;
     - «Terminar y añadir claves» deja el foco en «Clave de API de Tiingo»;
     - el tour no ha tocado la parada ni el dinero real.
  2. Pausa y reanudación:
     - Esc en el paso 4 muestra el aviso de pausa y devuelve el foco al `h1`;
     - el tour no se reabre en la misma sesión;
     - «Retomar el tour (paso 4 de 10)» funciona desde «Primeros pasos» y aparece también en Ajustes;
     - al reiniciar, el tour se reabre solo en el paso 4.
  3. Saltar y relanzar:
     - «Saltar tour» guarda la versión y la fecha;
     - al reiniciar no reaparece ni el aviso ni el tour;
     - Ajustes › Ayuda › «Ver el tour de nuevo» arranca en el paso 1;
     - «Terminar» devuelve el foco al botón y actualiza la fecha.
- **`provider-connection.spec.ts`** (nuevo, 3 pruebas):
  - Para Tiingo y para FRED se recorren los seis estados (`ok`, `sin-clave`, `clave-rechazada`, `cuota`, `sin-red`, `error`) con `testing.providers.simulateTest`. Cada uno se comprueba por su texto exacto y su acción:
    - `ok`: «Conectado…» con la fecha del último dato y «Actualizar datos ahora»;
    - `sin-clave` y `clave-rechazada`: «Añadir clave» y «Cambiar clave» llevan el foco al campo; el enlace a la cuenta lleva su `href`;
    - `cuota`, `sin-red` y `error`: «Probar de nuevo».
  - Se comprueba que el gancho se consume una sola vez y que `provider:*` queda en `fiable` tras un `ok`.
  - Perfil Responsable:
    - la clave guardada no aparece en el resultado IPC, en `data-status`, en el HTML ni en la salida del proceso principal;
    - guardar otra clave devuelve el resultado a «Sin probar»;
    - sin red real (sin gancho) el resultado es «Sin red»;
    - `#ajustes?provider=fred&focus=test` y `…tiingo&focus=key` enfocan el control correcto;
    - el gancho rechaza estados fuera del contrato.
- **`stale-data.spec.ts`** (nuevo, 2 pruebas):
  1. Con el proveedor caído y un cierre más:
     - hay una sola región «Estado de los datos» con «Datos desactualizados desde el 6 oct 2026» en Inicio, Mercado e IA, y el chip de cada pantalla dice lo mismo;
     - no queda ninguna franja por proveedor;
     - IA muestra «En pausa» en régimen, estrategias y predicciones, y `regimeOverview.stale` vale `true`;
     - «Ver detalles» da una fila por activo;
     - `evaluateSignalsNow` no evalúa nada: con una estrategia en paper no se crea ninguna señal ni predicción y la vela vieja no se evalúa;
     - «Actualizar ahora» explica el fallo;
     - al volver el proveedor, la franja desaparece («Datos al día.») y se recalculan la vela, la predicción, el régimen y la evaluación de la estrategia del 7-oct.
  2. Puesta al día sin intervención:
     - al reconectar tras un cierre sin red;
     - al abrir el mismo perfil el viernes 9: velas, resumen y régimen quedan al 9-oct.
- **`orders-live-mode.spec.ts`** (nuevo, 1 prueba):
  - la orden limitada paper creada desde Órdenes lleva «Paper · sin dinero real»;
  - tras activar el modo real y pasar la prueba de humo, Órdenes muestra sus órdenes SPY como «Dinero real» y sin botón de cancelar;
  - el filtro «Modo» separa Paper y Dinero real;
  - volver a paper no cambia la etiqueta del histórico;
  - en ningún momento aparece «Modo no disponible»;
  - en el Diario, la prueba de humo sale como «Dinero real», nunca como «Operación simulada», y todas sus entradas tienen `mode: 'live'`.
- **`ai-regime-prediction.spec.ts`** (1 prueba nueva):
  - tras un cierre más, «Predicciones por activo» tiene una sola fila por activo, la del 7-oct, sin «Desactualizada»;
  - el histórico va aparte, plegado y sin la vigente;
  - el filtro por activo funciona;
  - «Ver ficha del modelo», pulsado con Intro, se queda en `#ia` y enfoca y muestra la ficha.
- Los specs con arranque propio (`backup-restore`, `backtest-report`, `daily-routine`, `electron`, `journal-export`, `macro-context`, `market-chart`, `news-phase`, `risk-engine`, `signals-dashboard`, `strategies-*`, `strategy-stress`) llaman a `skipGuidedTour(page)` después de aceptar el aviso.

Capturas de los pasos clave: `docs/qa/capturas/continuacion-*.png`.

## Sesiones por perfil

### Profesional independiente que organiza varios proyectos

| Paso | Esperado | Observado | Evidencia |
| --- | --- | --- | --- |
| Perfil vacío; acepta el aviso solo con teclado | El tour no aparece antes del aviso; después arranca en el paso 1 | Correcto; foco en el título y resto inerte | `continuacion-tour-paso-1.png` |
| Recorre los 10 pasos con teclado | Cada paso navega a su ruta; la parada se resalta y no se pulsa | Correcto | `continuacion-tour-paso-6-parada.png`, `continuacion-tour-paso-10.png` |
| Pausa en el 4, retoma y reinicia | Se retoma desde Inicio; al reiniciar vuelve al 4 | Correcto | `continuacion-primeros-pasos-retomar.png` |
| «Probar conexión» de Tiingo y FRED | Seis estados con su motivo y su acción | Correcto, salvo el punto doble en «error» (H3) | `continuacion-probar-conexion-*.png`, `continuacion-hallazgo-error-proveedor-doble-punto.png` |
| Proveedor caído y un cierre más | Un único «Datos desactualizados desde el 6 oct 2026» y cálculos en pausa | Correcto | `continuacion-datos-desactualizados-ia.png`, `…-detalles.png`, `…-reintento.png`, `continuacion-datos-al-dia-ia.png` |
| IA: predicción vigente y ficha | Una fila por activo y foco en la ficha | Correcto | `continuacion-ia-prediccion-vigente.png`, `continuacion-ia-ver-ficha-modelo.png` |
| Dinero real completo (`live-gate`) ×5 | Activa desde la interfaz y concilia la prueba de humo | 10/10 | `fase-6-7-*.png` |

### Responsable de equipo que revisa entregas

| Paso | Esperado | Observado | Evidencia |
| --- | --- | --- | --- |
| Salta el tour y reinicia | No reaparece; se relanza desde Ajustes en el paso 1 | Correcto | `continuacion-ajustes-ayuda-tour.png` |
| Guarda claves y prueba | La clave no aparece en IPC, DOM, data-status ni registro | Correcto | salida de `provider-connection.spec.ts:192` |
| Sin red y reconexión; reapertura días después | Se pone al día sola | Correcto | `continuacion-datos-sin-red.png`, `continuacion-datos-puesta-al-dia-arranque.png` |
| Sin red mientras pasa un cierre | «Sin conexión: datos del 6 oct» o «Desactualizado» | **«Al día · cierre del 6 oct 2026»** (H2) | `continuacion-hallazgo-sin-red-sin-fecha-datos.png` |
| Órdenes y Diario tras la prueba de humo | Cada orden con su modo; Diario «Dinero real» | Correcto | `continuacion-ordenes-paper-y-real.png`, `continuacion-ordenes-filtro-dinero-real.png`, `continuacion-diario-prueba-humo-real.png` |
| Lista incompleta (`live-gate`) ×5 | Se rechaza en la interfaz y por IPC con cada requisito pendiente | 10/10 | `fase-6-7-dinero-real-bloqueado.png` |

## Fallos encontrados

Ninguno rompe la batería. Los tres son del producto: los he documentado sin cambiar el código de producción y sin convertirlos en pruebas en rojo.

### H1 · Un refresco macro fallido con los datos al día enciende «Datos desactualizados desde el 9 oct 2026», con fecha posterior a la sesión esperada — media · Backend

- **Pasos:**
  1. Reloj E2E en el martes 6-oct tras el cierre, con SPY seguido y todo «current».
  2. `testing.simulateProviderFailure(true)`, que lanza un refresco macro y falla.
- **Esperado:** con todas las series `macro:*` en `fiable` y 0 sesiones pendientes, no hay aviso de datos desactualizados, o como mucho un aviso de fallo del proveedor sin fecha «desde».
- **Observado:**
  - `data-status:freshness` devuelve `{state:'stale', sinceDate:'2026-10-09', expectedSessionDate:'2026-10-06', missingSessions:0}`.
  - Su único elemento es `provider:macro-simulated` («6 de 6 series fallaron en el último refresco»).
  - La franja dice «Datos desactualizados desde el 9 oct 2026», una fecha posterior a la sesión esperada, y pone régimen, predicciones y señales en pausa.
  - Aparte, en E2E el macro simulado (`src/main/market/macro/index.ts:51`, `createSimulatedMacroProvider` sin `now`) y el sondeo de `providers/index.ts` usan el reloj real y no el reloj de mercado anclado. Por eso las series «llegan» hasta el 9-oct cuando el reloj marca el 6-oct.
- **Evidencia:** `docs/qa/capturas/continuacion-hallazgo-desactualizado-con-datos-al-dia.png`. Salida del sondeo: `F1 summary {"state":"stale","sinceDate":"2026-10-09","expectedSessionDate":"2026-10-06","missingSessions":0,…}`.
- **Sospechosos:** el cálculo del resumen en `src/main/market/health.ts`: un `provider:*` en `desactualizado` sin ningún hijo atrasado no debería dar `stale` con «desde» posterior a `expectedSessionDate`. El reloj del simulador macro y del sondeo E2E también.

### H2 · Sin red, si pasa un cierre, el resumen de frescura sigue «Al día» mientras el régimen ya está caducado — media · Backend (y Frontend para el texto)

- **Pasos:**
  1. Con SPY al día (6-oct), `testing.simulateOffline(true)`.
  2. Adelantar el reloj 24 h (cierre del 7-oct).
  3. Abrir IA.
- **Esperado:**
  - según el diseño, «Sin conexión: datos del 6 oct 2026», o al menos un estado desactualizado coherente con `regimeOverview.stale`;
  - el régimen en pausa.
- **Observado:**
  - `freshness` = `{state:'current', expectedSessionDate:'2026-10-07', items:[]}`, mientras que `regimeOverview` = `{stale:true, sessionDate:'2026-10-06', expectedSessionDate:'2026-10-07'}`.
  - IA muestra «Al día · cierre del 6 oct 2026» y «Datos al día.».
  - El bloque de conexión dice «régimen y predicciones congelados **sin una instantánea disponible**», aunque sí la hay (la del 6-oct).
  - La franja de datos no aparece; solo se ve la franja global de sin conexión.
  - El estado de los datos solo cambia cuando falla un intento de descarga. Sin red no se intenta, así que no se marca el atraso según el calendario.
  - Al volver la red sí se pone al día (cubierto en `stale-data.spec.ts`).
- **Evidencia:** `docs/qa/capturas/continuacion-hallazgo-sin-red-sin-fecha-datos.png`. Salida del sondeo: `F2 summary {"state":"current",…}` y `F2 overview {"stale":true,"s":"2026-10-06","e":"2026-10-07"}`.
- **Sospechosos:**
  - `src/main/market/health.ts`: el resumen no compara la última vela con `expectedSessionDate` cuando no hay intento;
  - `components/DataFreshness.tsx`: con `offline` y `current` no muestra la fecha de los datos;
  - el texto «sin una instantánea disponible» de `components/ai/AiPage.tsx`.

### H3 · El estado «Error del proveedor» de «Probar conexión» sale con punto doble — baja · Frontend

- **Pasos:** en Ajustes, `testing.providers.simulateTest({provider:'tiingo', status:'error'})` y pulsar «Probar conexión».
- **Esperado:** «Tiingo no ha respondido como esperábamos: El proveedor no respondió como se esperaba. Vuelve a probar…»
- **Observado:** «…como se esperaba**..** Vuelve a probar; si se repite, revisa el estado del servicio.» El motivo del backend ya acaba en punto y `ProviderConnectionResult.tsx` añade otro. Pasa también con otros motivos reales que acaban en punto, como «El proveedor respondió sin datos recientes.».
- **Evidencia:** `docs/qa/capturas/continuacion-hallazgo-error-proveedor-doble-punto.png`.
- **En la prueba:** la expresión de `provider-connection.spec.ts` acepta `\.+` en ese punto, con un comentario. Al corregirlo hay que cambiarla a `\.`.

## Qué no se ha podido comprobar aquí

- Claves reales de Tiingo y FRED (`npm run qa:providers`) y la app empaquetada. Las hace el usuario.
- El progreso «Descargando n de m activos» es transitorio y en E2E dura menos de lo que tarda en leerse. Está cubierto en las pruebas de Vitest de `DataFreshness`, no en el E2E.
