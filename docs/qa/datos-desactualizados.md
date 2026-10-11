# Diagnóstico: la app real con datos desactualizados

Fase 6-7 (continuación). Tarea «Diagnóstico de la app real con datos desactualizados».
Fecha de la sesión: domingo 11-oct-2026, entre las 02:08 y las 02:16 (hora de Madrid).
Build: `npm run build` sobre la rama `orquesta/fase-fase-6-7-ia-predictiva-y-capital-mi-e43b6d`
(HEAD `11855e0d`, con cambios sin confirmar de otros agentes en `src/main/ai/news/repository.ts`, que este
diagnóstico no toca). Al terminar, `npm run build` ya no compila por los cambios en curso de otro agente en
`src/main/live/{broker,smoke}.ts` (TS2322/TS2345). El recorrido usó el build de las 02:03, que compilaba.
`npx playwright test --list` sigue listando las 37 pruebas de `e2e/`.

Este informe solo describe problemas. Las correcciones son de `be-frescura-datos` (Backend) y
`fe-datos-conexion` (Frontend). No se ha cambiado nada de `src/`.

## Cómo se ha probado

La app se ha abierto **fuera del modo E2E** (sin `TRADIA_E2E`) con Playwright para Electron. El recorrido
está en `docs/qa/datos-desactualizados/recorrido/` y no forma parte de `npm run test:e2e`:

```bash
npm run build
npx playwright test -c docs/qa/datos-desactualizados/recorrido          # todos los escenarios (≈5 min)
npx playwright test -c docs/qa/datos-desactualizados/recorrido -g "B0|B1" # uno concreto (B1-B3, C y D necesitan B0)
```

- `bootstrap.cjs` se carga con `electron --require` antes del proceso principal. Fija un `userData`
  temporal (la app real no acepta otro: `TRADIA_E2E_USER_DATA` solo vale con E2E) y puede mover el reloj del
  proceso principal (`QA_FAKE_NOW`). Además desvía `api.tiingo.com` y `api.stlouisfed.org` a un servidor
  local que imita a los dos proveedores. Así el código que corre es el de producción (proveedor Tiingo y FRED
  reales, ingesta, salud del dato, régimen, predicción ONNX, señales y parada). Solo cambia el otro lado de
  la red.
- `TRADIA_CONNECTIVITY_URLS` apunta a dos URL `/health` del mismo servidor. Para simular que se cae internet,
  el servidor corta la conexión. Ojo: con **una sola** URL la app la descarta en silencio y usa las de
  internet (`[connectivity] endpoints configurados no válidos`).
- Las claves de Tiingo y FRED se guardan desde Ajustes, como lo haría un usuario. Las velas y las
  observaciones son sintéticas pero siguen el calendario de NYSE (festivos incluidos). En las series del
  Tesoro faltan los días de mercado de bonos cerrado (Columbus Day y Veterans Day).
- Cada escenario guarda capturas (`.png`), el texto visible de cada pantalla (`.txt`), el estado interno por
  IPC (`.json`: `data-status`, última vela, régimen, predicciones, señales y salud) y el log del proceso
  principal (`*-main.log`).

Resultado del comando de recorrido (última ejecución completa, más B0 y B3 repetidos después):

```
✓ A · perfil vacío sin claves (reloj real) (24.1s)
✓ B0 · siembra: base al día del viernes 18-sep-2026 (reloj atrasado) (24.2s)
✓ B1 · 23 días después, proveedor caído (no puede ponerse al día) (26.7s)
✓ B2 · 23 días después, proveedor disponible (¿se pone al día al arrancar?) (27.7s)
✓ C · sin red al abrir con datos viejos y vuelta a la red (57.4s)
✓ D1 · domingo 11-oct-2026 con datos del viernes 9 (fin de semana) (30.7s)
✓ D2 · miércoles 14-oct-2026 tras Columbus Day (festivo de bonos, bolsa abierta) (30.8s)
✓ D3 · viernes 27-nov-2026 tras Acción de Gracias (30.8s)
✓ B3 · estrategia en paper y proveedor que solo llega al 25-sep (sigue desactualizado) (28.1s)
```

«Passed» solo significa que el recorrido llegó al final y guardó la evidencia. Los fallos del producto están
abajo.

**Límites del entorno** (no son fallos del producto):

- Con el reloj adelantado (D2, D3) solo se mueve el reloj del proceso principal. El renderer sigue en la hora
  real, así que en esas capturas las horas relativas que calcula la interfaz («Con retraso» de noticias,
  «hace…») no son fiables. El estado de los datos sí lo es, porque se calcula en el proceso principal.
- Las capturas son de la ventana de 1440×1000. La zona principal tiene su propio desplazamiento, así que
  cada `.png` va acompañado del `.txt` con el texto completo de la pantalla.
- Las fuentes de noticias son las RSS reales de internet. No se han simulado.

## Resumen de escenarios

| Escenario                                                      | Resultado                                                                                                                                                                                                  | Evidencia principal                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A · Perfil vacío sin claves                                    | Falla. Franja roja «FRED · Desactualizado · 6 de 6 series fallaron» sin haber configurado nada. El modelo sale como «Saludable» y «fiable» sin un solo dato. Inicio y Macro se contradicen.                | `a1-inicio-recien-abierta.png`, `a2-salud-de-modelos.png`, `a-estado.json`  |
| B0 · Siembra (19-sep, reloj atrasado)                          | Sirve para preparar los datos, pero aparece un fallo: guardar la clave de FRED no descarga nada y Macro queda «sin datos» hasta el día siguiente.                                                          | `b0-macro.png`, `b0-estado-sembrado.json`                                   |
| B1 · 23 días después, proveedor caído                          | Falla. Salta la **parada de emergencia** por «Dato de mercado anómalo». Hay tres franjas con texto técnico y ningún «Datos desactualizados desde 18 sept». IA presenta el régimen del 18-sep como el actual. | `b1-inicio-al-abrir.png`, `b1-ia.png`, `b1-estado.json`                     |
| B2 · 23 días después, proveedor disponible                     | **Correcto**: al arrancar descarga las 15 sesiones que faltaban y recalcula régimen y predicciones hasta el 9-oct.                                                                                          | `b2-estado-al-abrir.json`, `b2-ia.png`                                      |
| B3 · Estrategias en paper, proveedor solo hasta el 25-sep      | Falla. No sale ninguna franja. Inicio muestra «Precios · Tiingo 11 oct 2026». Señales, régimen y predicciones se calculan con la vela del 25-sep como si fuera la actual.                                   | `b3-inicio.png`, `b3-ia.png`, `b3-estado.json`                              |
| C · Sin red al abrir y vuelta a la red                         | Falla. Un corte de red al abrir activa la parada de emergencia. Al volver la red no reintenta Tiingo ni FRED: 0 peticiones en 30 s y la parada sigue activa con «Agentes en pausa · Pausa manual».         | `c1-inicio-sin-red.png`, `c2-inicio-tras-volver-red.png`, `c-resumen.json`  |
| D1 · Domingo con datos del viernes                             | Precios correctos («fiable»). Falla Macro: el IPC (CPIAUCSL) sale «Desactualizado», aunque agosto es el último dato publicado. El IPC de septiembre se publica a mediados de octubre.                       | `d1-macro.png`, `d1-estado-domingo.json`                                    |
| D2 · Miércoles tras Columbus Day                               | Falla. DGS2, DGS10 y T10Y2Y salen «Desactualizado» porque el lunes 12 no hubo mercado de bonos.                                                                                                             | `d2-macro.png`, `d2-estado-columbus.json`                                   |
| D3 · Viernes tras Acción de Gracias                            | **Correcto**: todo «fiable» con las velas del miércoles 25.                                                                                                                                                 | `d3-estado-thanksgiving.json`, `d3-inicio.png`                              |

## Problemas

Gravedad: **alta** = la app decide o se bloquea con datos viejos, o engaña sobre su estado; **media** = el
usuario ve estados contradictorios o no puede resolverlo desde la interfaz; **baja** = textos o detalles.

### P1 · Un fallo de red o del proveedor activa la parada de emergencia como «Dato de mercado anómalo» — alta · Backend

- **Pantalla:** franja global (todas las páginas), Riesgo y barra de estado.
- **Pasos:** (C) abre la app con datos de hace 23 días sin internet. O (B1) ábrela con Tiingo respondiendo
  HTTP 503.
- **Esperado:** sin red o con el proveedor caído, los datos quedan «Desactualizados desde 18 sept». Las
  decisiones se pausan mientras dure el corte y se reanudan solas al volver. No es un dato anómalo.
- **Observado:** «Parada activa: Dato de mercado anómalo · Activada por Sistema ·
  provider:tiingo: [tiingo] fallo de transporte: TypeError: fetch failed». Log:
  `[risk] parada de emergencia activada (dato-anomalo: provider:tiingo: …)`. Ocurre en la primera pasada:
  cuatro activos que fallan suman `consecutiveFailures = 4` en el proveedor en un solo intento, y eso ya
  supera la regla de «3 fallos seguidos» (`provider:tiingo no-fiable … f 4` en `b1-estado.json` nada más
  abrir).
- **Evidencia:** `b1-inicio-al-abrir.png`, `c1-inicio-sin-red.png`, `c-main.log`, `b1-estado.json`.
- **Sospechosos:** `src/main/risk/killSwitch.ts` (`observeDataStatus`: cualquier `no-fiable` dispara la
  parada) y `src/main/market/ingestion.ts` (cuenta un fallo del proveedor por cada activo de la misma
  pasada).
- **Estado (Backend):** corregido. `observeDataStatus` solo dispara `dato-anomalo` con `no-fiable` de
  contenido anómalo (`consecutiveFailures === 0` en `ticker:`/`macro:`); los fallos de red o del
  proveedor (`consecutiveFailures > 0`) no son una emergencia.

### P2 · Al volver la red no se pone al día y la parada sigue activa, rotulada como «Pausa manual» — alta · Backend

- **Pantalla:** Inicio, barra de estado y Mercado.
- **Pasos:** (C) abre sin red con datos del 18-sep → vuelve la red (la app lo detecta en 3,8 s) → espera
  30 s.
- **Esperado:** al reconectar intenta ponerse al día (Tiingo y FRED) y, si lo consigue, quita los avisos.
- **Observado:** 0 peticiones nuevas a Tiingo en 30 s (`tiingoRequestsBefore: 4, tiingoRequestsAfter: 4`).
  Las velas siguen en el 18-sep. Noticias sí hace «pasada inmediata del lector», pero mercado y macro esperan
  a su temporizador de reintento de 30 min. La parada sigue activa. La barra dice «Agentes en pausa · Pausa
  manual», aunque el usuario no ha pausado nada.
- **Evidencia:** `c-resumen.json`, `c2-inicio-tras-volver-red.png`, `c-main.log`, `c-peticiones.txt`.
- **Sospechosos:** `src/main/market/ingestion.ts` (`evaluate` sin conexión hace `armTimer(retryIntervalMs)`
  y nadie escucha `connectivity:changed`), `src/main/market/macro/service.ts` (igual) y el origen del motivo
  «Pausa manual» de la parada (`src/main/risk/killSwitch.ts` / `services/scheduler.ts`). En
  `components/SystemStatus.tsx` solo se rotula el motivo.
- **Estado (Backend):** corregido. Mercado y macro se ponen al día al reconectar
  (`connectivity:changed`) y al volver de suspensión (`powerMonitor.resume`). La parada por
  `sin-conexion` se levanta sola al volver la red; el resto de causas no la activan, así que ya no
  queda una parada por un corte de red.

### P3 · Con velas viejas no hay un estado único «Datos desactualizados desde …» — alta · Frontend (con contrato de Backend)

- **Pantalla:** Inicio, franja global, Mercado e IA.
- **Pasos:** (B1) abre con datos del 18-sep y el proveedor caído. (B3) abre con un proveedor que solo llega
  al 25-sep.
- **Esperado:** un único aviso coherente: «Datos desactualizados desde el 18 sept (faltan 15 sesiones)», con
  sus acciones (Reintentar, Comprobar claves, Ver estado).
- **Observado:** en B1 aparecen tres franjas a la vez (parada, «Tiingo · No fiable», «FRED ·
  Desactualizado») con texto interno (`provider:tiingo:`, `[tiingo] error del servidor (HTTP 503):
  maintenance`, `TypeError: fetch failed`). La única fecha útil («falta la vela del 2026-09-21 (+14 más)»)
  solo sale en Mercado. En B3 el proveedor responde bien pero sin velas nuevas, así que
  `provider:tiingo` queda «fiable» y **no sale ninguna franja**: `ProviderBanner` solo mira las claves
  `provider:*` y no ve los cuatro `ticker:*` en «desactualizado».
- **Evidencia:** `b1-inicio-al-abrir.png`, `b3-inicio.png`, `b3-estado.json`.
- **Sospechosos:** `src/renderer/src/components/ProviderBanner.tsx` (filtro `provider:` y `entry.reason` en
  bruto) y `src/main/market/health.ts` (no hay un resumen de frescura global que el renderer pueda pintar).
- **Estado (Backend):** contrato listo. `data-status:freshness` devuelve un solo resumen
  (`DataFreshnessSummary`) con `state` ('current' | 'catching-up' | 'stale' | 'unreliable' | 'no-data'),
  `sinceDate` (último dato real más antiguo), `expectedSessionDate`, `missingSessions`, `items` (cada
  entrada mala con su fecha de último dato real, incluidos los `provider:*`) y `progress` ({done,total}
  durante la puesta al día). `catching-up` tiene prioridad sobre `stale` mientras la pasada corre. La
  pinta del aviso único es de Frontend.

### P4 · El régimen, las predicciones y las señales se calculan y se muestran sobre datos viejos como si fueran actuales — alta · Backend (y Frontend para el aviso)

- **Pantalla:** IA, ficha de estrategia y motor de señales.
- **Pasos:** (B1) datos del 18-sep, hoy 11-oct. (B3) estrategias en paper y velas solo hasta el 25-sep.
- **Esperado:** con datos más antiguos que la última sesión esperada, el régimen, la predicción y las señales
  no se calculan o quedan marcados «Sin calcular · datos desactualizados desde …». Las estrategias no se
  activan ni desactivan por un régimen caducado.
- **Observado:**
  - IA: «Régimen del mercado · Referencia SPY · cierre 18 sept 2026 · Lateral». Las estrategias salen
    «Desactivada por régimen… el régimen actual es Lateral». Ninguna advertencia de antigüedad. En B3,
    «Instantánea calculada 11 oct 2026, 02:15» con el régimen del 25-sep.
  - Predicción por activo: «Próximas 5 sesiones · Cierre 18 sept 2026». Ese horizonte terminó el 25-sep.
    Junto a ella sale «Calculado 11 oct 2026».
  - Señales: en B3 las cuatro estrategias en paper se evaluaron el 11-oct sobre la vela del 25-sep
    (`signals:strategies` → `lastBarDate: "2026-09-25"`, `lastOutcome: "sin-senal"`). Con estos datos
    sintéticos no se cumplió ninguna regla, pero nada impide emitir y mandar al riesgo una señal sobre una
    vela de hace 10 sesiones. La parada tampoco actúa, porque `desactualizado` no la dispara (P1 es lo
    contrario: la dispara por fallos de red).
  - Al arrancar, `ai/regime` y `ai/prediction` hacen una «pasada inicial sobre los datos ya guardados» sin
    mirar su frescura.
- **Evidencia:** `b1-ia.png`, `b3-ia.png`, `b3-estado.json` (`signalStrategies`, `regime`, `predictions`).
- **Sospechosos:** `src/main/ai/regime/index.ts` (pasada inicial y `handleBarStored`),
  `src/main/ai/prediction/index.ts` / `service.ts`, `src/main/signals/index.ts` y `engine.ts`
  (`handleBarStored` → `evaluateTicker(event.lastDate)` sin comprobar la sesión esperada). Ninguno consulta
  `data_status` ni `calendar.lastExpectedSession`. En el renderer: `components/ai/RegimePanel.tsx` y
  `PredictionsTable.tsx`.
- **Estado (Backend):** corregido. Los tres servicios reciben `expectedSessionDate` con la sesión
  esperada del calendario: el régimen no recalcula sobre velas por detrás (y el overview lo marca
  `stale`), la predicción no crea sesiones nuevas (sí resuelve las pendientes) y las señales devuelven
  `'stale-data'` sin emitir ni pasar a riesgo ni marcar la vela como procesada. El aviso «Sin calcular»
  en IA es de Frontend.

### P5 · La deriva del modelo suma «sesiones» con cada revisión aunque no lleguen datos nuevos — media · Backend

- **Pantalla:** Salud de modelos.
- **Pasos:** (B0 → B1) siembra el 19-sep y vuelve a abrir el 11-oct sin datos nuevos (proveedor caído).
- **Esperado:** la persistencia de la deriva cuenta sesiones de mercado con datos nuevos. Si no ha llegado
  ninguna vela desde la revisión anterior, el contador no avanza y la revisión dice «sin datos nuevos».
- **Observado:** «Drift de datos en vigilancia: 2 de 20 sesiones · Desde hace 2 sesiones» con exactamente la
  misma muestra (velas hasta el 18-sep). La revisión inicial de cada día suma una «sesión»
  (`streak = previous.streak + 1`). Si alguien abre la app 20 días seguidos con el proveedor caído, el modelo
  queda **degradado** con datos congelados.
- **Evidencia:** `b1-salud-de-modelos.png` / `.txt`, `b2-estado-tras-ponerse-al-dia.json`
  (`dataDrift.sessions: 2`).
- **Sospechosos:** `src/main/ai/drift/service.ts` (`evaluateDataDrift` y `evaluateResultDrift`: el streak
  sube por revisión, no por sesión nueva) y `src/main/ai/drift/index.ts` (pasada inicial en cada arranque).
- **Estado (Backend):** corregido. La racha solo avanza cuando hay datos nuevos (la última vela u
  observación del conjunto cambió desde la revisión anterior); si no, la revisión queda congelada y su
  detalle dice `sinDatosNuevos: 'si'`.

### P6 · El IPC mensual (CPIAUCSL) sale «Desactualizado» durante la primera quincena de cada mes — media · Backend

- **Pantalla:** Macro, Inicio («Macro · FRED · Con retraso») y notificación de «alerta».
- **Pasos:** (D1) domingo 11-oct con el IPC publicado hasta agosto (2026-08-01). Así está FRED en esa fecha:
  el de septiembre se publica hacia el 14-15 de octubre.
- **Esperado:** «Fiable». La observación de agosto es la última publicada.
- **Observado:** «CPIAUCSL ◷ Desactualizado · falta la observación esperada; último dato: 2026-08-01», y
  en Inicio «Macro · FRED · Con retraso». En D2 (14-oct, con septiembre publicado) pasa a «Fiable».
- **Evidencia:** `d1-macro.png`, `d1-inicio.png`, `d1-estado-domingo.json`.
- **Sospechoso:** `src/main/market/health.ts` (`expectedMacroMinDate`: en las series mensuales exige el día
  1 del mes anterior desde el día 1 del mes en curso, sin tener en cuenta el calendario de publicación).
- **Estado (Backend):** corregido. Las series mensuales solo exigen la observación del mes `M-1` a partir
  del día 15 del mes `M` (ventana de publicación real de FRED); antes, la del mes `M-2` basta. El IPC de
  agosto es «Fiable» el 11-oct y el de septiembre no se pide hasta el 15-oct.

### P7 · Tras un festivo del mercado de bonos (Columbus Day, Veterans Day), las series del Tesoro salen «Desactualizado» — media · Backend

- **Pantalla:** Macro e Inicio.
- **Pasos:** (D2) miércoles 14-oct-2026 a las 15:00 (Madrid). El lunes 12 la bolsa abrió y el mercado de
  bonos cerró. FRED tiene DGS2, DGS10 y T10Y2Y hasta el 9-oct, porque el 12 no hay dato y el 13 aún no se ha
  publicado.
- **Esperado:** «Fiable». No falta ninguna observación publicable.
- **Observado:** DGS2, DGS10 y T10Y2Y «Desactualizado · falta la observación esperada; último dato:
  2026-10-09».
- **Evidencia:** `d2-macro.png`, `d2-estado-columbus.json`.
- **Sospechoso:** `src/main/market/health.ts` (`computeMacro` y `expectedMacroMinDate` usan el calendario
  de NYSE para series que siguen el de bonos SIFMA o la Reserva Federal).
- **Estado (Backend):** corregido. Las series del Tesoro (DGS2, DGS10, T10Y2Y…) usan el calendario de
  bonos (`bondCalendar`, SIFMA): Columbus Day y Veterans Day no son sesión esperada, así que el dato del
  viernes sigue «Fiable» el miércoles siguiente.

### P8 · Guardar la clave de FRED no descarga nada, y el «Reintentar» de la franja de FRED reintenta Tiingo — media · Backend + Frontend

- **Pantalla:** Ajustes → Macro y franja «FRED · Desactualizado».
- **Pasos:** (B0) con la app abierta, guarda las claves de Tiingo y FRED → añade activos → abre Macro.
  Pulsa «Reintentar» en la franja de FRED.
- **Esperado:** al guardar una clave válida se lanza el primer refresco. «Reintentar» en la franja de FRED
  reintenta FRED.
- **Observado:** los activos se descargan (Tiingo se resuelve en cada pasada), pero Macro sigue «Sin dato ·
  falta la observación esperada; último dato: sin datos» hasta el siguiente arranque o la cita diaria
  (`b0-estado-sembrado.json`: `provider:fred desactualizado · 6 de 6 series fallaron`). La franja de FRED
  llama a `window.tradia.market.refreshNow()`, que es el refresco de Tiingo, y no existe un canal IPC para
  refrescar macro. Sin claves, el mensaje que devuelve habla de otro proveedor («Configura el proveedor en
  Ajustes para actualizar»).
- **Evidencia:** `b0-macro.png`, `b0-estado-sembrado.json`, `a4-reintentar-sin-claves.png`.
- **Sospechosos:** `src/main/market/macro/service.ts` / `index.ts` (sin disparo al guardar la clave ni
  canal `macro:refresh-now`), `src/shared/ipc.ts` (`macro` solo tiene `getSeries`) y
  `src/renderer/src/components/ProviderBanner.tsx` (`retry` siempre llama a `market.refreshNow`).
- **Estado (Backend):** corregido. Existe `macro:refresh-now` (IPC `macro:refresh-now`,
  `window.tradia.macro.refreshNow`), y guardar la clave de FRED (`secrets:changed` con `provider:
  'fred'`) lanza la primera descarga igual que volver la red o despertar el equipo. La asignación del
  botón «Reintentar» a cada proveedor es de Frontend (`affectedProviders` ya decide market/macro por las
  entradas del resumen).

### P9 · Con el perfil vacío y sin claves salta la franja roja «FRED · Desactualizado · 6 de 6 series fallaron» — media · Backend + Frontend

- **Pantalla:** franja global (todas las páginas) e Inicio.
- **Pasos:** (A) instala desde cero, acepta el aviso de riesgo y no configures nada.
- **Esperado:** un estado neutro «Sin configurar · añade tu clave de FRED», igual que en Mercado y Macro
  («Conecta tus fuentes de datos»). No un fallo.
- **Observado:** en todas las páginas, «FRED · Desactualizado · 6 de 6 series fallaron en el último refresco
  · Último dato correcto: No hay un dato correcto registrado · Reintentar». Inicio dice «Precios · Sin
  configurar», pero «Macro · FRED · Con retraso», y las tarjetas macro dicen «Desactualizado». El servicio
  macro intenta FRED sin clave y lo apunta como un fallo (`auth: sin clave de API guardada`).
- **Evidencia:** `a1-inicio-recien-abierta.png`, `a2-macro.png`, `a-main.log`, `a-estado.json`.
- **Sospechosos:** `src/main/market/macro/index.ts` / `service.ts` (sin clave debería quedar «sin
  proveedor», como Tiingo en `ingestion.ts`), `components/ProviderBanner.tsx` y
  `components/dashboard/ConnectionBlock.tsx`.
- **Estado (Backend):** corregido. `isConfigured` corta el refresco sin clave de FRED: no se descarga, no
  se escribe ningún estado de fallo y la entrada `provider:fred` desaparece, así que un perfil vacío no
  enseña un aviso rojo («no-data» en el resumen de frescura). El texto «Sin configurar» es de Frontend.

### P10 · Inicio dice «Régimen · Sin clasificar» mientras IA muestra «Tendencia · Volatilidad baja» — media · Frontend

- **Pantalla:** Inicio (bloque «Contexto macro») frente a IA.
- **Pasos:** (D1) con todos los datos al día, abre Inicio y después IA.
- **Esperado:** el mismo régimen en las dos pantallas, o una etiqueta que deje claro que son cosas
  distintas.
- **Observado:** Inicio: «Régimen · Sin clasificar · Fuente FRED». IA: «Referencia SPY · cierre 9 oct 2026 ·
  Tendencia · Volatilidad baja». El texto de Inicio está fijo en el código.
- **Evidencia:** `d1-inicio.png` / `.txt`, `d1-ia.png` / `.txt`.
- **Sospechoso:** `src/renderer/src/components/dashboard/MacroBlock.tsx:15` (`Régimen · <strong>Sin
  clasificar</strong>` fijo).

### P11 · «Precios · Tiingo» muestra la hora de la última consulta, no la fecha del último dato — media · Frontend (con Backend)

- **Pantalla:** Inicio → «Conexión y fuentes».
- **Pasos:** (B3) el proveedor responde, pero solo tiene velas hasta el 25-sep. Hoy es 11-oct.
- **Esperado:** «Precios · Tiingo · último cierre 25 sept · desactualizado desde el 28 sept».
- **Observado:** «Precios · Tiingo · 11 oct 2026, 02:15 CEST · Con retraso». La fecha es `lastOkAt` (cuándo
  respondió el proveedor), no la de la última vela. En B1 pasa al revés: la franja dice «Último dato
  correcto: No hay un dato correcto registrado» cuando hay 1.255 velas verificadas hasta el 18-sep, porque
  `provider:tiingo.lastOkAt` es `null` aunque cada `ticker:*` tiene `lastOkAt`.
- **Evidencia:** `b3-inicio.png` / `.txt`, `b1-inicio-al-abrir.png`, `b1-estado.json`.
- **Sospechosos:** `src/renderer/src/components/dashboard/ConnectionBlock.tsx` (`latest()` sobre
  `lastOkAt`), `components/ProviderBanner.tsx` (`lastCorrectDate(entry.lastOkAt)` de la clave `provider:*`)
  y `src/main/market/ingestion.ts` (`markProviderOk` / estado del proveedor sin `lastOkAt` ni fecha del
  último dato).
- **Estado (Backend):** contrato listo. `data-status:freshness` expone en `items` la fecha del último
  dato real de cada `provider:*` (la más reciente de sus tickers o series, no el `lastOkAt` del HTTP), y
  la evaluación marca el proveedor `desactualizado` con la fecha real cuando su dato más reciente queda
  por detrás de lo esperado. El repintado de «Precios · Tiingo · último cierre …» es de Frontend.

### P12 · El modelo sale «Saludable» y `modelo:0.1.0` «fiable» sin un solo dato, mientras su ficha dice «no apto» — media · Backend

- **Pantalla:** Salud de modelos frente a IA (ficha del modelo).
- **Pasos:** (A) perfil vacío, abre Salud de modelos y después IA.
- **Esperado:** «Sin datos suficientes», como las estrategias. Y el estado del sistema del modelo coherente
  con su ficha («Datos sintéticos · no apto»).
- **Observado:** Salud de modelos: «Saludable 1 · 0 variables con PSI > 0,25 · 0/60 predicciones resueltas ·
  Desde hace 0 sesiones». IA: «Ficha del modelo · Datos sintéticos · no apto». `data_status`:
  `modelo:0.1.0 fiable`.
- **Evidencia:** `a2-salud-de-modelos.png` / `.txt`, `a2-ia.png`, `a-estado.json`.
- **Sospechosos:** `src/main/ai/drift/service.ts` (estado sin muestra) y `src/main/ai/prediction/service.ts`
  (línea 187: `fiable` solo con que exista la ficha, sin mirar si es apta).
- **Estado (Backend):** corregido. `modelo:*` solo sale `fiable` cuando la ficha es apta; con ficha no
  apta queda `desactualizado` con el propio motivo de la ficha («Datos sintéticos · no apto»), y sin
  ficha «sin ficha registrada; solo se informa». En «Salud de modelos» el modelo queda `insuficiente`
  («Aún no hay 60 predicciones resueltas.») mientras no haya ni una resuelta; ya no aparece «Saludable»
  sin evidencia.

### P13 · «Reintentar» confirma «Actualización solicitada. Esperando datos verificados.» aunque el intento ya ha fallado — baja · Backend + Frontend

- **Pantalla:** franja «Tiingo · No fiable».
- **Pasos:** (B1) con Tiingo respondiendo 503, pulsa «Reintentar».
- **Esperado:** «No se pudo actualizar: Tiingo no responde (HTTP 503). Volveremos a intentarlo a las …».
- **Observado:** «Actualización solicitada. Esperando datos verificados.» Los cuatro activos han vuelto a
  fallar en ese instante (el log muestra otra ronda de `ingesta … falló`) y el contador del proveedor pasa de
  4 a 8.
- **Evidencia:** `b1-tras-reintentar.png` / `.txt`, `b1-estado-final.json`, `b1-main.log`.
- **Sospechosos:** `src/main/market/ingestion.ts` (`refreshNow` devuelve `accepted: true` aunque fallen
  todos) y `components/ProviderBanner.tsx`.
- **Estado (Backend):** corregido. `market.refreshNow` y `macro.refreshNow` devuelven `ok: false` con
  `detail` cuando la pasada aceptada no puso los datos al día: el motivo del proveedor si falló todo
  («error del servidor (HTTP 503)», «sin la vela del …»), o «N de M series fallaron (motivo)» si el
  fallo fue parcial. `accepted: false` sigue solo para los rechazos (sin conexión, sin proveedor, sin
  activos, en curso). El mensaje al usuario es de Frontend (`result.ok === false` → «No se pudo
  actualizar: {detail}»).

### P14 · Con cuatro estrategias en paper, Inicio dice «Todavía no hay señales. Activa una estrategia…» — baja · Frontend

- **Pantalla:** Inicio → «Señales vivas».
- **Pasos:** (B3) pasa las cuatro estrategias a paper y deja que se evalúen.
- **Esperado:** «Sin señales: tus 4 estrategias en paper se evaluaron con la vela del 25 sept (datos
  desactualizados)».
- **Observado:** «Todavía no hay señales. Activa una estrategia y espera el siguiente cierre de vela.»
- **Evidencia:** `b3-inicio.txt` (línea 110 y siguientes), `b3-estado.json` (`signalStrategies`).
- **Sospechoso:** `src/renderer/src/components/dashboard/` (bloque de señales de Inicio).

### P15 · «Configurar claves» lleva a la parte de arriba de Ajustes, no a «Proveedores de datos» — baja · Frontend

- **Pantalla:** Mercado y Macro sin claves → Ajustes.
- **Pasos:** (A) en Mercado pulsa «Configurar claves».
- **Esperado:** abre Ajustes en la sección «Proveedores de datos», con el foco en «Clave de API de
  Tiingo».
- **Observado:** abre Ajustes por la sección «General» (inicio con el sistema y notificaciones). Las claves
  quedan más abajo y hay que desplazarse.
- **Evidencia:** `a3-configurar-claves.png` / `.txt`.
- **Sospechoso:** `src/renderer/src/components/MarketDataPage.tsx` (enlace a `#ajustes` sin ancla de
  sección).

## Lo que funciona

- **Ponerse al día al arrancar (B2):** con datos de hace 23 días y el proveedor disponible, la primera pasada
  baja las 15 sesiones que faltaban. También recalcula el régimen (9-oct) y las predicciones, y todo queda
  «fiable» en menos de 2 s.
- **Fin de semana y festivos de la bolsa (D1, D3):** el domingo con velas del viernes y el viernes después de
  Acción de Gracias con velas del miércoles, los precios quedan «fiable». El calendario de NYSE funciona.
- **Mercado** sí explica bien el problema de cada activo: «Desactualizado · falta la vela del 2026-09-21
  (+14 más); último dato: 2026-09-18 · El histórico está desactualizado; puede faltar el último cierre.»
  (`b1-mercado.txt`).
- **Sin red:** la franja «Sin conexión: las decisiones están en pausa» aparece al instante y desaparece al
  volver la red (3,8 s).

## Reparto propuesto

| Responsable                    | Problemas                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Backend (`be-frescura-datos`)  | P1, P2, P4 (cálculo), P5, P6, P7, P8 (refresco macro y disparo al guardar la clave), P9 (estado sin clave), P12, P13 |
| Frontend (`fe-datos-conexion`) | P3, P4 (aviso en IA), P8 (franja de FRED), P10, P11, P14, P15                                                  |

Para P3, P4 y P11 Backend debe exponer primero un resumen de frescura único. Por ejemplo: «último dato
verificado», «última sesión esperada», «sesiones que faltan» y «motivo» por ámbito (precios y macro).
Frontend lo pinta como el estado único «Datos desactualizados desde …».

## Estado de las correcciones de Backend (`be-frescura-datos`)

Cubiertas por `npx vitest run src/main/market src/main/ai src/main/signals` (560 pruebas en verde),
`npm run typecheck` y `npm run lint`:

- **P1:** la parada de emergencia solo reacciona a `no-fiable` por contenido anómalo; los fallos de
  red/proveedor ya no la activan (`risk/killSwitch.ts`, `killSwitch.test.ts`).
- **P2:** puesta al día al reconectar (mercado y macro) y al volver de suspensión
  (`powerMonitor.resume` en `ingestion.ts` y `macro/service.ts`, con pruebas en
  `ingestion.test.ts` y `macro/service.test.ts`). La parada `sin-conexion` se levanta sola.
- **P3/P11 (contrato):** `data-status:freshness` expone el resumen único con fecha real del último
  dato por entrada (incluidos `provider:*`), sesiones que faltan y `progress {done,total}` durante la
  puesta al día; `catching-up` tiene prioridad sobre `stale` mientras la pasada corre
  (`health.ts`, `health.test.ts`).
- **P4:** régimen, predicción y señales guardan contra datos por detrás de la sesión esperada
  (`regime/service.ts` → `stale`, `prediction/service.ts` → sin sesiones nuevas,
  `signals/engine.ts` → `'stale-data'` sin emitir ni marcar). Regresión de integración en
  `market/__integration__/data-flow.test.ts`.
- **P5:** la racha de drift solo avanza con datos nuevos (`sinDatosNuevos` en
  `drift/service.ts`, `drift/service.test.ts`).
- **P6:** ventana de publicación mensual de FRED (día 15) en `expectedMacroMinDate` (`health.ts`,
  `health.test.ts`).
- **P7:** series del Tesoro contra el calendario de bonos SIFMA (`bondCalendar` en `health.ts`,
  `health.test.ts`).
- **P8 (Backend):** `macro:refresh-now` y disparo al guardar la clave de FRED (`macro/index.ts`);
  refresco también al volver de suspensión.
- **P9 (Backend):** FRED sin clave queda neutro (`isConfigured`), sin estados de fallo.
- **Frescura por proveedor (nuevo):** un `provider:*` que responde pero sirve datos viejos queda
  `desactualizado` con la fecha real del último dato; con los hijos al día y sin fallos acumulados
  vuelve a `fiable`. Regresión en `health.test.ts` («frescura por proveedor»).
- **P12:** `modelo:*` solo es `fiable` con ficha apta (sin aptitud queda `desactualizado` con el
  motivo de la ficha), y «Salud de modelos» muestra `insuficiente` sin predicciones resueltas
  (`prediction/service.ts`, `drift/service.ts`, `drift/insufficient-data.test.ts`).
- **P13 (Backend):** `refreshNow` de mercado y macro devuelven `ok`/`detail` con el motivo real de la
  pasada fallida o parcial (`ingestion.ts`, `macro/service.ts`, con pruebas).
- **Fin de semana / 3 sesiones:** tras un fin de semana con la vela del viernes no se marca nada;
  con 3 sesiones de mercado sin datos (p. ej. Columbus Day, que cierra bonos y no la bolsa) sí sale
  `desactualizado` (`health.test.ts`).

Pendiente de `fe-datos-conexion`: la pinta del aviso único (P3), los avisos de «datos
desactualizados» en IA (P4), el botón «Reintentar» por proveedor y los textos de `ok/detail`
(P8/P13), el bloque de conexión con la fecha del último dato (P11) y P10/P14/P15.
