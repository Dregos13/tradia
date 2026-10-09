# Motor de señales (fase 4)

La app **avisa pero no ejecuta**: el motor evalúa las estrategias al cierre
de cada vela y emite señales informativas que pasan por el motor de riesgo.
Una señal aprobada solo puede abrir una posición en la cartera simulada;
nunca se envía ninguna orden a un broker.

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

- Solo emiten las estrategias en estado `activa` o `paper` que además
  tienen una implementación ejecutable registrada
  (`strategy_implementations` ↔ catálogo de `backtest/strategies`).
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
  `largo` (compra), `sell` → propuesta `corto` (venta). Una estrategia que
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

## Pasarela única de riesgo

Toda señal entra por `services.risk.submitSignal` (canal
`risk:submit-signal`), con `origin: 'estrategia'`. La regla de eslint
`no-restricted-imports` impide que `src/main/signals/` importe los
escritores del motor de riesgo (repositorio, servicio o parada): las
señales no tienen otra puerta. La decisión completa (`RiskDecision`:
estado, tamaño, motivos) se guarda con la señal; las vetadas también se
persisten — «sin señal» solo ocurre por contradicción.

## Persistencia e idempotencia

Tabla `signals` (migración 008). Cada fila guarda:

- `estrategias`: los votos (id, nombre, **versión**, dirección, confianza
  y motivo) que respaldan la señal;
- `datos_usados`: ventana de velas (`desde`/`hasta`/`barCount`), la vela
  que disparó la evaluación (`vela_fecha`), el lote (`batchId`) y su
  **versión limpia** (`batchVersion`) y la fuente;
- `decision`: la respuesta completa de la pasarela.

Idempotencia en dos niveles: marcas persistentes `ticker|vela` en settings
(`signals.processedBars`, acotadas a las 2 000 más recientes) y el
`UNIQUE (ticker, vela_fecha)` de la tabla, reafirmado por el repositorio
(un conflicto devuelve la fila existente sin reemitir eventos). La marca
solo se escribe cuando la evaluación llega a un **resultado definitivo**
(señal persistida, contradicción o evaluación completa sin votos): un
fallo temporal de la pasarela de riesgo, de la persistencia o de una
estrategia deja la vela sin marcar, y una reentrega del mismo cierre
reintenta la evaluación completa.

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
fase 3 + columnas de la migración 009). La apertura copia la entrada, el
stop, el objetivo y el tamaño de la decisión de la pasarela y enlaza la
posición con la señal (`senal_id`) y con la vela que la emitió
(`vela_apertura`). **Nunca se envía una orden a un broker.**

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

## Estado por estrategia (`signals:strategies`)

El bloque «Estrategias» del panel lista todas las fichas con su estado y
versión, más la última vela evaluada, el instante y el resultado
(`senal`/`sin-senal`/`vetada`/`error`) y la señal emitida, si la hubo. El
estado es volátil: refleja la última evaluación del proceso en curso.

## Lectura

- `signals:list` — filtros por activo, decisión, estrategia y rango de la
  vela; más recientes primero (`creado_en`, `id` desc).
- `signals:get` — detalle por id.
