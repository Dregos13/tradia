# Motor de señales (fases 4 y 6)

La app **avisa pero no ejecuta**: el motor evalúa las estrategias al cierre
de cada vela y emite señales informativas que pasan por el motor de riesgo.
Una señal aprobada solo puede abrir una posición en la cartera simulada;
nunca se envía ninguna orden a un broker. Las divisas siguen las mismas
reglas con su calendario 24/5 (ver «Divisas»).

## Disparo

- El servicio de ingesta (`market/ingestion`) emite el evento interno
  `onBarsStored` cada vez que guarda un lote con velas nuevas de un activo
  (histórico inicial, actualización diaria, recuperación de cierres
  perdidos o refresco manual). El motor evalúa ese activo al cierre de su
  última vela.
- El gancho de desarrollo `signals:evaluate-now` (solo `TRADIA_E2E` y sin
  empaquetar) fuerza una pasada sobre toda la lista de seguimiento a la
  última vela de cada activo.

## Guardas: cuándo no se evalúa

No hay evaluación mientras:

- los agentes están en pausa (`scheduler`: manual del usuario u offline),
- la conexión está caída (`connectivity` en 'offline'),
- la parada de emergencia está activa (`killSwitch`).

La vela que llega durante el bloqueo **no** queda marcada como procesada:
al reanudarse puede evaluarse si vuelve a dispararse el evento.

## Evaluación por estrategia

- Solo emiten las estrategias en estado `activa` o `paper`. Cada ficha se
  resuelve a su ejecutable:
  - **Clásica**: implementación registrada en `strategy_implementations`
    ↔ catálogo de `backtest/strategies` (los mismos módulos del backtest).
  - **Propia**: sus reglas del lenguaje propio se compilan con
    `parseStrategyRules` a la `Strategy` del motor
    (`createCustomStrategy`, la misma que corre el backtest). Una ficha
    cuyas reglas no compilan —o cuyos parámetros no resuelven los
    periodos/niveles del programa— se **omite con un único aviso por
    versión** en el registro y no detiene la evaluación de las demás.
- **Filtro de régimen (fase 6)**: además, cada ficha se resuelve con
  `resolveStrategyRegime` contra el **régimen del mercado** (referencia
  SPY, el mismo que usa la página «IA» y el backtest con filtro). Si la
  ficha queda `desactivada` —o `degradada`, que tiene prioridad— **no
  vota** y la decisión queda en el Diario (entrada `resumen`, resultado
  `sin-senal`) con el motivo de la ficha. Sin régimen calculado todas
  quedan habilitadas.
- Cada estrategia se rejuega con su **versión vigente** y sus parámetros
  sobre sus mercados (`executableMarkets`: solo tickers válidos) usando la
  sonda de `src/main/signals/probe.ts`, que reproduce la semántica del
  motor de backtest: velas reveladas sesión a sesión (sin look-ahead),
  órdenes llenadas en la apertura siguiente, stop antes que objetivo
  intrabarra, hueco de apertura ejecuta a la apertura, y liquidación del
  activo cuya serie termina.
- Las velas son las **guardadas** (una sola fuente por serie: la del lote
  disparador, o la más reciente del activo) en su **serie ajustada**
  (`adj*` con respaldo crudo), truncadas a la fecha de la vela evaluada.
- El resultado son las órdenes de la última sesión: `buy` → propuesta
  `largo` (compra), `sell` → propuesta `corto` (venta). En las propias,
  una apertura en corto (`entryShort`) sale como `sell` de entrada y su
  recompra (`exitShort`) como `buy` de salida (la pata `leg` de la sonda
  decide qué regla de la ficha se cita en el motivo). Una estrategia que
  no ordena nada sobre el activo simplemente no vota.

## Agregación por activo

Por cada activo y fecha de vela se juntan los votos de las estrategias que
lo cubren:

- **Direcciones contrarias** (al menos un `largo` y un `corto`): no hay
  señal. Queda una entrada `contradiccion` en el diario con las propuestas
  enfrentadas (`resultado: sin-senal`).
- **Coinciden**: una señal con esa dirección.
  - `confianza` = la **media** de las confianzas de los votos.
  - `stop` = el más prudente para dimensionar (`largo`: el más bajo;
    `corto`: el más alto); `null` si ninguna propuesta trae stop.
  - `objetivo` = el más cercano a la entrada (`largo`: el menor;
    `corto`: el mayor); `null` si ninguno lo trae.
  - `motivo` = las reglas de entrada/salida de cada ficha que votó, unidas
    con « · » y acotadas.
  - `entrada` = cierre de la última vela de la serie usada.

### Confianza de cada voto

Las estrategias clásicas no declaran una confianza propia: se usa la tasa
de acierto del backtest representativo de la versión
(`metricsSummary.winRatePct / 100`, acotada a 0–1). Sin métricas, el voto
vale la confianza neutral `0,5`. Las anomalías (confianza fuera de 0–1)
llegan a la pasarela, que las veta (`SIGNAL_INVALID`).

### Confianza combinada con la IA (fase 6)

Con la integración activa (`deps.ai`), la confianza media de los votos se
combina con dos factores que **solo confirman o rebajan**: ninguno crea la
señal y ninguno evita la pasarela de riesgo.

- **Probabilidad del modelo apto** (`aiPrediction`): solo participa si la
  ficha es apta (`eligibleModel`: origen `real` y Brier fuera de muestra
  mejor que la referencia) **y** la última predicción del activo casa con
  su versión y hash. La probabilidad calibrada en la dirección de la
  señal se normaliza sobre el 0,5 neutral: `factor = 2 · p` (0,6 → ×1,2).
  - Si `p < 0,5` el modelo **contradice la dirección**: no se opera,
    queda una entrada `contradiccion` en el Diario (`sin-senal`) y la
    vela queda marcada.
  - Si el modelo **no es apto** la predicción no participa en absoluto
    (ni sube ni veta: «no participa en señales ni órdenes»).
- **Sentimiento de titulares confirmados** (`news_analysis`): los
  análisis del activo dentro de una ventana de 5 días
  (`SIGNAL_NEWS_WINDOW_MS`), hasta `SIGNAL_NEWS_MAX_ITEMS` (10). Cada
  análisis puntúa `+1`/`−1`/`0` (positivo/negativo/neutro o mixto),
  alineado con la dirección; la media acota el ajuste a
  `±SIGNAL_NEWS_SENTIMENT_ADJUST` (±15 %). Un titular sin verificar no
  tiene análisis, así que nunca llega a esta capa.
- **Umbral**: cuando al menos un factor participó, la confianza
  combinada `votos × modelo × noticias` (acotada a 1) exige
  `SIGNAL_MIN_CONFIDENCE` (0,55); por debajo **no se opera**, queda una
  entrada `resumen` con el motivo «Confianza baja» y la vela marcada.
  Sin aportes de la IA se conserva el comportamiento de la fase 4.

El motivo de la señal añade el detalle (`IA: modelo vX prob. subida … ·
noticias: n análisis …`) y `datos_usados.ai` guarda el régimen consultado,
la probabilidad, la versión y el hash del modelo y los `newsItemIds`
usados — el mismo contexto viaja en la intención a la pasarela.

## Pasarela única de riesgo

Toda señal entra por `services.risk.submitSignal` (canal
`risk:submit-signal`), con `origin: 'estrategia'`. La regla de eslint
`no-restricted-imports` impide que `src/main/signals/` importe los
escritores del motor de riesgo (repositorio, servicio o parada): las
señales no tienen otra puerta. La decisión completa (`RiskDecision`:
estado, tamaño, motivos) se guarda con la señal; las vetadas también se
persisten — «sin señal» solo ocurre por contradicción (entre estrategias
o del modelo) o por confianza baja, y ambas viven solo en el Diario.

## Persistencia e idempotencia

Tabla `signals` (migración 008). Cada fila guarda:

- `estrategias`: los votos (id, nombre, **versión**, dirección, confianza
  y motivo) que respaldan la señal;
- `datos_usados`: ventana de velas (`desde`/`hasta`/`barCount`), la vela
  que disparó la evaluación (`vela_fecha`), el lote (`batchId`) y su
  **versión limpia** (`batchVersion`) y la fuente;
- `decision`: la respuesta completa de la pasarela;
- `datos_usados.ai` (fase 6): régimen consultado, probabilidad, versión y
  hash del modelo apto usado y los titulares que ajustaron la confianza.

Idempotencia en dos niveles: marcas persistentes `ticker|vela` en settings
(`signals.processedBars`, acotadas a las 2 000 más recientes) y el
`UNIQUE (ticker, vela_fecha)` de la tabla, reafirmado por el repositorio
(un conflicto devuelve la fila existente sin reemitir eventos). La marca
solo se escribe cuando la evaluación llega a un **resultado definitivo**
(señal persistida, contradicción —de estrategias o del modelo—, confianza
baja o evaluación completa sin votos): un fallo temporal de la pasarela
de riesgo, de la persistencia o de una estrategia deja la vela sin
marcar, y una reentrega del mismo cierre reintenta la evaluación
completa.

## Emisión y diario

Cada señal persistida:

1. registra una entrada `senal` en el diario (`journal.record`) con el
   motivo, los datos usados, el resultado (`aprobada`/`reducida`/`vetada`)
   y el cumplimiento de reglas de la decisión;
2. emite `signals:new` al renderer por `ctx.broadcast` — en la app, el
   servicio de entrega lo intercepta para la notificación de escritorio y
   los canales externos.

Los errores de evaluación (una estrategia que lanza) se anotan como
entrada `error` con el activo y la estrategia, marcan esa estrategia con
resultado `error` en el panel y **no** detienen a las demás.

## Posiciones simuladas (`signals/paper.ts`)

Cada señal persistida con decisión **aprobada** o **reducida** y tamaño

> 0 abre una posición en la cartera simulada (`risk_portfolio_positions`,
> fase 3 + columnas de la migración 009). La apertura copia la entrada, el
> stop, el objetivo y el tamaño de la decisión de la pasarela y enlaza la
> posición con la señal (`senal_id`) y con la vela que la emitió
> (`vela_apertura`). **Nunca se envía una orden a un broker.**

- **Seguimiento**: cada lote guardado (`onBarsStored`) evalúa las
  posiciones abiertas del activo contra la vela recién llegada, siempre
  que sea estrictamente posterior a la de la apertura (la vela de la
  señal ya cotizó antes de que existiera la posición).
- **Cierre**: misma semántica que el motor de backtest y la sonda —
  intrabarra, **el stop primero** si la vela toca los dos niveles, y un
  hueco más allá del nivel ejecuta a la apertura (`largo`: salida
  `min(apertura, stop)` / `max(apertura, objetivo)`; `corto`, simétrico).
- **Liquidación**: en una sola transacción se marca la fila
  (`cerrada_en`, `salida`, `motivo_salida`) y se anota el P&L realizado
  en la curva de capital (`risk_equity_history`); la curva solo registra
  resultados realizados.
- **Diario**: cada cierre escribe una entrada `operacion` con el motivo,
  los datos de la operación (entrada, salida, tamaño, P&L y %, velas de
  apertura/cierre), el resultado (`ganancia`/`perdida`/`empate`), las
  reglas cumplidas y la señal enlazada.
- **Límites**: tras cada vela se comparan la pérdida diaria, semanal y
  mensual realizadas y el drawdown con los límites vigentes. Cada límite
  que **pasa a estar alcanzado** (transición, no estado) escribe una
  entrada `limite` del diario y un aviso `limite-alcanzado` por los
  canales de entrega; las medidas se reportan además a los observadores
  de la parada (`observeDailyLoss`, `observeDrawdown`), que la activan
  sola según sus umbrales (drawdown ≥ máximo, pérdida ≥ 1,5 × diaria).

La escritura de la cartera sigue siendo exclusiva del módulo de riesgo
(la regla `no-restricted-imports` impide importarla desde `signals/`):
el tracker la usa a través de `services.risk`
(`openPaperPosition`/`listPaperPositions`/`closePaperPosition`/
`getPaperRiskState`/`getLimits`) y queda inerte si esa API falta.

`risk:get-portfolio` devuelve al panel la cartera completa: posiciones
abiertas con marca y P&L no realizado, drawdown y pérdida diaria frente a
su límite, y exposición por activo y por sector frente a su límite.

## Divisas (EUR/USD y compañía)

Las divisas se operan **solo en la cartera simulada interna**. Ninguna
orden de divisas llega al bróker, ni en paper ni con dinero real: el
bróker conectado (Alpaca) no opera divisas. Reglas compartidas en
`src/shared/fxTrading.ts`.

### Calendario 24/5

- Cada activo usa su calendario (`market/assetCalendar.ts`): NYSE para
  acciones y ETF; `fxCalendar` (lunes a viernes por día UTC, también en
  los festivos de NYSE; sin vela esperada el 25-12 ni el 01-01) para los
  pares.
- La guarda de frescura del motor de señales, del régimen y de la
  predicción pide la última sesión esperada **del activo**: la vela del
  4 de julio de un par se evalúa (NYSE cierra, divisas no) y la del 3 ya
  llega atrasada. La sesión anterior que acota la predicción también es
  la del calendario del activo.
- Régimen que habilita las estrategias: en un par, el **régimen del propio
  par** (con su frescura 24/5); en acciones, el del mercado (SPY).
- Drift: la muestra del PSI son las últimas sesiones de la serie de cada
  activo, así que un par aporta sus sesiones 24/5 sin conversión.
- Modo cautela: a un par solo le aplican `alto-impacto` (FOMC, NFP, IPC…)
  y `vix`. Las reglas de sesión de NYSE (`festivo`, `apertura`,
  `sesion-corta`, `vencimiento`) y `resultados` no: el par cotiza en los
  festivos de EE. UU. y su vela del viernes llega el sábado a la 01:00 UTC.

### Destino de cada señal

Cada señal lleva `destination` (y `destinationReason`):

| Activo | Destino | Qué pasa con una aprobada |
| --- | --- | --- |
| Acción / ETF | `cartera-simulada` | Abre posición simulada |
| EURUSD, GBPUSD (cotizados en USD) | `cartera-simulada` | Abre posición simulada (largo o corto) |
| USDJPY, USDCHF | `solo-analisis` | Nunca abre: «par no cotizado en USD: solo análisis por ahora» |

Los pares no cotizados en USD tienen régimen, predicción y señal, pero la
pasarela los veta con `ANALYSIS_ONLY` («Par no cotizado en USD: solo
análisis por ahora»): su P&L iría en JPY o CHF y la cartera no convierte
divisas. La cartera tampoco los admite por la vía directa
(`openPaperPosition`).

### Tamaño, exposición y P&L

- El tamaño que da la pasarela son **unidades de la moneda base** (euros
  en EURUSD): capital × riesgo % / |entrada − stop|, en unidades enteras.
  Como el precio va en USD, el nominal (tamaño × precio), el riesgo y el
  P&L ((salida − entrada) × tamaño, con signo del lado) salen en USD, la
  divisa de la cuenta.
- Para los límites, un par **expone a su moneda base** (`divisa` = 'EUR')
  y cuenta en el sector `divisas`. Entran por activo, sector, divisa
  (`maxCurrencyExposurePct`), apalancamiento, correlación, posiciones
  abiertas, pérdidas y drawdown igual que una acción.
- El límite de **liquidez no aplica** a los pares: las velas diarias de
  divisas no traen volumen (Tiingo FX lo da a 0) y su profundidad es de
  otro orden que la cartera simulada.
- Largo y corto con las mismas reglas de stop y objetivo que una acción;
  el diario de la operación lleva `divisa` (moneda de exposición) y
  `divisaPnl` = 'USD', y muestra precios a 5 decimales.
- Con la parada de emergencia activa no se abre ninguna posición (la
  pasarela veta, el seguidor no abre y la cartera rechaza con
  `[parada-activa]`). Los cierres por stop u objetivo siguen.

### Nunca al bróker

El rechazo es «[divisa-sin-broker] el bróker conectado no opera divisas:
se opera solo en la cartera simulada» (`FX_BROKER_REJECTION_MESSAGE`), en
cuatro puertas:

1. Gestor de órdenes (`broker/orderManager.ts`, paper y real): una señal
   de un par no crea orden (resultado `bloqueada` con el motivo); una
   orden limitada manual se rechaza; y, como última defensa, ningún envío
   de un par llega al adaptador (la orden queda `rechazada`).
2. Rutina: el postmercado solo concilia con la cuenta (no envía
   órdenes); la sincronización periódica del gestor, que sí lanza los OCO
   pendientes, no puede lanzar el de un par (misma última defensa).
3. Guardián de órdenes reales (`live/orderGuard.ts`): bloquea cualquier
   orden de un par, incluida una pata de salida.
4. Adaptador Alpaca (paper y live): rechaza la orden sin salir a la red.

### Conciliación diaria

La rutina sigue el calendario de NYSE y la vela de divisas del día D llega
a la 01:00 UTC de D+1, después de la conciliación de las 17:30. Por eso
las señales, los cierres y las operaciones de los pares se concilian en el
siguiente día de NYSE: ventana [sesión anterior de NYSE, día). Las de un
festivo de NYSE (4 de julio) entran en la conciliación del siguiente día
hábil. Una señal `solo-analisis` nunca exige posición.

### Backtest

- Coste de divisas propio: **2 pb de deslizamiento fijo por ejecución,
  siempre en contra, sin comisión ni spread aparte**
  (`FX_BACKTEST_COSTS` / `DEFAULT_FX_COSTS`). Cubre el diferencial típico
  de EUR/USD y GBP/USD (0,1–1,5 pips) más el deslizamiento de una orden
  de mercado. Se aplica por activo: en un universo mixto las acciones
  siguen con sus costes. Se puede fijar por ejecución con `fxCosts`.
- Anualización: con algún par en el universo, la curva sigue el 24/5 y se
  anualiza con **260 sesiones** por año; solo acciones, 252.
- Calentamiento: en sesiones del calendario del universo (24/5 si todo son
  pares; NYSE en cuanto hay una acción). Las ventanas de walk-forward se
  cuentan en velas, así que ya siguen el calendario de cada serie.

## Estado por estrategia (`signals:strategies`)

El bloque «Estrategias» del panel lista todas las fichas con su estado y
versión, más la última vela evaluada, el instante y el resultado
(`senal`/`sin-senal`/`vetada`/`error`) y la señal emitida, si la hubo. El
estado es volátil: refleja la última evaluación del proceso en curso.

## Lectura

- `signals:list` — filtros por activo, decisión, estrategia y rango de la
  vela; más recientes primero (`creado_en`, `id` desc).
- `signals:get` — detalle por id.
