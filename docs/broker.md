# Broker: paper (fase 5) y real mínimo (fase 7)

La app se conecta a una **cuenta de paper trading del broker** para
ejecutar las señales aprobadas con dinero simulado, concilia su registro
con el del broker y compara los resultados reales con el backtest. Con
la lista del modo real cumplida, límites escritos y la frase de
confirmación, puede además conectar una **cuenta real mínima**
(máximo 1 000 USD) en `api.alpaca.markets`, con sus propias claves, su
propia tabla de órdenes y sus propios techos.

Piezas: `src/main/broker/alpaca.ts` (adaptador Alpaca paper),
`alpacaLive.ts` (adaptador Alpaca live con la puerta de la lista),
`simulated.ts` (broker simulado para pruebas y E2E), `orderManager.ts`
(envío, reintentos y huérfanas), `reconcileService.ts` (conciliación),
`deviationService.ts` (informe real vs backtest), `repository.ts`
(persistencia de ambas tablas, migraciones 010 y 012) e `index.ts`
(servicio, IPC y ganchos). El modo real vive en `src/main/live/`:
`service.ts` (lista, modo y límites), `broker.ts` (conexión, claves y
ejecución real), `orderGuard.ts` (los techos por orden), `smoke.ts`
(prueba de humo de 1 USD en SPY con conciliación), `scaling.ts` (estado
informativo del escalado) e `index.ts` (IPC `live:*` y enrutado de
señales).

## Separación paper/real (inviolable)

- **URL fija cada adaptador**: `https://paper-api.alpaca.markets` para
  paper y `https://api.alpaca.markets` para real. Cualquier otra URL
  lanza `BrokerError('bad-data')` en el constructor —ninguna URL llega
  desde la interfaz, un fichero o un canal IPC.
- **Claves en ranuras distintas**: las paper (`broker-alpaca-key-id`,
  `broker-alpaca-secret`, prefijo `PK`) y las live
  (`broker-alpaca-live-key-id`, `broker-alpaca-live-secret`, prefijo
  `AK`) nunca comparten ranura ni se aceptan cruzadas: unas `PK…` en
  `live:connect` y unas `AK…` en `broker:connect` se rechazan antes de
  tocar la red, con mensaje claro y sin guardar nada.
- **Tablas de órdenes distintas**: las paper van a `broker_orders`
  (migración 010) y las reales a `broker_orders_live` (migración 012,
  mismo esquema). La conciliación, el informe real vs backtest y la
  muestra «3 meses de paper» solo leen la tabla paper; la guarda de
  techos solo lee la live. El repositorio interpola el nombre de la
  tabla desde una lista blanca de dos valores —nunca texto de fuera.
- **Una señal nunca sale dos veces**: con el modo real 'activo' y la
  cuenta live conectada, `liveExecutionActive` hace que el gestor paper
  ceda las señales al gestor real; el resto del tiempo las ejecuta el
  paper como siempre.

## Solo paper

- Además de la URL fija, el servicio rechaza antes de tocar la red las
  claves cuyo id no empieza por `PK` (la convención de Alpaca para
  paper; las live usan `AK`). El mensaje es claro: «Estas claves no
  corresponden a una cuenta paper. No se han guardado.»
- La cuenta se valida contra el endpoint paper **antes** de guardar las
  claves: unas credenciales inválidas obtienen 401 y no se persisten.
- En Ajustes la cuenta aparece con la insignia «Solo paper».

## Dinero real mínimo (fase 7)

La cuenta real solo existe si la **lista de comprobación** está
completa (`live:checklist` → `allComplete`). Sin ella:

- `live:connect` se rechaza con «La lista de comprobación del modo real
  no está completa. Las claves live no se han guardado.»
- `createAlpacaLiveBroker` no se puede construir (la puerta se evalúa
  en el proceso principal al crear el adaptador y otra vez **antes de
  cada envío**: una orden nunca sale a la red con la puerta cerrada).

Con la lista cumplida, `live:connect` valida las claves `AK…` contra la
cuenta real (`GET /v2/account` en `api.alpaca.markets`) **antes** de
guardarlas cifradas en su ranura live. La franja muestra la cuenta
enmascarada («•••• 4821») y el broker; el `live:changed` emite el
nuevo estado a todas las ventanas. Al arrancar, con claves guardadas y
la puerta abierta la cuenta reconecta sola (app residente en bandeja).

**Techos por orden** (`live/orderGuard.ts`, consultados por el gestor
antes de cada envío —además del motor de riesgo, la parada y la
conectividad—, contra los límites escritos confirmados, siempre dentro
de los fijos de la fase):

- **Por orden**: nocional estimado (cantidad × limit/stop o precio de
  referencia de la señal) ≤ `orderUsd` (≤ 200 USD).
- **Posiciones abiertas**: una posición nueva se rechaza si ya hay
  `openPositions` (≤ 2); ampliar una existente no cuenta.
- **Capital**: posiciones abiertas (coste medio) + nocional de las
  compras aún abiertas + la nueva orden ≤ `capitalUsd` (≤ 1 000 USD).
- **Pérdida diaria**: la pérdida realizada en la sesión de Nueva York
  de hoy ≥ `dailyLossUsd` (≤ 20 USD) bloquea nuevas entradas.
- Una orden de mercado sin precio de referencia se bloquea (nunca a
  ciegas); las patas de **salida** (el OCO de protección) pasan
  siempre: cierran riesgo, y una posición real no queda atrapada por
  un límite.
- Una orden bloqueada queda en el Diario con el motivo legible y nunca
  llega a la red.

El modo real solo se activa escribiendo la frase literal generada con
los límites vigentes (`live:activate`), y se suspende solo ante la
parada de emergencia, la pérdida de conexión o una reevaluación que
deje la lista incompleta —nunca se reactiva automáticamente.

**Broker real simulado**: con `TRADIA_E2E=1` y sin empaquetar,
`live:use-simulated-broker` conmuta el adaptador live al servidor falso
(`createAlpacaLiveFakeFetch`): la misma API REST v2 y la misma puerta,
pero exige claves con prefijo `AK` y devuelve 401 a cualquier otra —
permite probar el flujo completo sin tocar la red real.

## Claves: cifradas y sin permiso de retirada

- Las claves viven en `services.secrets`, cifradas con el llavero del
  sistema operativo (Keychain en macOS, DPAPI en Windows,
  gnome-keyring/KWallet en Linux). Nunca en texto plano.
- **Sin llavero no hay conexión**: si el SO no puede cifrar, `setKey`
  falla y la conexión no se completa con un mensaje legible.
- Genera las claves en el panel de Alpaca **sin permiso de retirada**
  (solo trading): la app nunca necesita mover fondos.
- Las claves no salen del proceso principal: ningún canal IPC las
  devuelve (el renderer solo recibe `BrokerStatus`/`LiveState`, con
  cuenta enmascarada y saldo) y `redact` las elimina de errores y
  registros.
- `broker:disconnect` las borra del almacén.
- Al arrancar, si hay claves guardadas la app reconecta sola: es
  residente en bandeja y las señales deben seguir ejecutándose.

## Ejecución de señales

Cada `signals:new` con decisión `aprobada` o `reducida` entra al gestor
de órdenes del modo vigente (paper siempre, real solo con el modo
'activo' y la cuenta conectada). Sin cuenta conectada sigue el
seguimiento local de `signals/paper.ts` (la cartera simulada interna
convive con el broker).

- Entrada: orden **de mercado** `tradia-<señal>-entrada` (buy/sell según
  largo/corto; cantidad = `decision.size`).
- Salida: al ejecutarse la entrada se crea el **OCO**
  `tradia-<señal>-salida` con la pata contraria (`limitPrice` = objetivo,
  `stopPrice` = stop, `gtc`). El OCO se reconstruye tras un reinicio a
  partir de la señal persistida.
- Puertas: parada de emergencia activa, sin conexión o interruptor
  «Ejecutar señales aprobadas en paper» apagado → la orden queda
  `bloqueada` con entrada `error` en el Diario. En real el interruptor
  es el modo 'activo' y los techos escritos. Señales vetadas o sin
  tamaño se ignoran.
- Cada orden registra hora y precio **pedidos** y **ejecutados**; el
  slippage en puntos básicos (`slippageBpsOf`) se muestra en la página
  «Órdenes». En el OCO la referencia es el nivel de la pata que ejecutó.
- Tipos soportados por el adaptador: mercado (fraccionarias incluidas),
  limitadas, stop y OCO. La cancelación (`orders:cancel`) envía DELETE
  y confirma con un GET.
- Órdenes manuales: `orders:create` envía una **limitada suelta** desde la
  página «Órdenes» (`{ticker, side, quantity, limitPrice}`, `gtc`, pata
  null y `client_order_id` `tradia-manual-<instante>-<n>`). Comparte el
  conducto de reintentos e idempotencia; la bloquean la parada de
  emergencia y la falta de conexión (el interruptor de ejecución es solo
  de las señales), y en la cuenta real también los techos.

## Idempotencia, reintentos y huérfanas

- **Duplicados**: el `clientOrderId` es determinista (`tradia-<señal>-<pata>`),
  así que una misma señal nunca crea dos órdenes; reemitir el evento es
  inocuo. La unicidad es por cuenta: paper y real son libros distintos.
- **Reintentos**: ante un fallo transitorio (timeout, 429, 5xx, red) se
  espera `250·2^(n-1)` ms —respetando el `Retry-After` del 429— y se
  reenvía **con el mismo `clientOrderId`**, hasta 3 intentos. Antes de
  reenviar se consulta `getOrderByClientId`: si el envío anterior llegó
  (timeout ambiguo), se adopta la remota en lugar de duplicar.
- **Rechazos**: un `reject` de negocio o un error no tipado deja la orden
  `rechazada` con su motivo, sin reintento y con entrada `error` en el
  Diario.
- **Huérfanas** (en `syncWithBroker`, cada minuto y al volver la
  conexión): una orden local `pendiente` con más de 2 min sin respuesta,
  o una `enviada`/`parcial` que el broker ya no conoce, pasa a
  `huerfana`; una orden abierta `tradia-*` en el broker sin fila local se
  importa como `huerfana`. Si el broker no responde no se marca nada
  (`unreachable`): el descuadre podría ser del medio, no de la orden.

## Conciliación

- **Cuándo**: cada 15 min con cuenta conectada y conexión, tras la
  tarea 'conciliacion' de la rutina (postmercado) y a demanda con
  `reconcile:run` («Conciliar ahora»). Sin cuenta o sin conexión la
  pasada programada se salta sin rastro; la manual devuelve una
  ejecución `error` legible.
- **Qué compara**: las posiciones derivadas de `broker_orders` (coste
  medio como el broker: pondera en aumentos, conserva en reducciones,
  reinicia al cruzar signo) y las órdenes abiertas, en ambos sentidos.
  Cantidad exacta; precio medio con tolerancia de 1 céntimo; las
  `pendiente` solo cuentan pasados 2 min de gracia.
- **Avisos**: cada descuadre nuevo queda `abierta` (deduplicado por
  tipo+activo+detalle, para no reavisar cada 15 min), una entrada
  `error` en el Diario por pasada, el evento `reconcile:discrepancy`
  (banner en «Órdenes») y una notificación `limite-alcanzado` por
  escritorio y canales externos. Una ejecución limpia marca los
  abiertos como `resuelta`.
- **Comprobarlo**: con el broker simulado (E2E), el gancho
  `broker:create-discrepancy` fabrica el descuadre
  (`posicion-cantidad`, `orden-borrada`, `orden-fantasma`) y la
  conciliación lo detecta.

## Informe real vs backtest

- **Periodos**: semana lunes–domingo y mes natural, en America/New_York;
  solo se informan periodos **cerrados**.
- **Operación cerrada**: par entrada+salida ejecutadas emparejado por
  `senal_id` o por la raíz del `clientOrderId`, atribuida al periodo del
  cierre.
- **Comparación**: rentabilidad real del periodo frente a la esperada
  (expectativa por operación del último backtest de la estrategia), más
  tasa de acierto y slippage medio. Una fila por estrategia y periodo.
- **Márgenes** (Ajustes): `deviationMarginPp` (±pp de desviación, 2 por
  defecto) y `deviationSlippageBps` (slippage medio máximo, 10 por
  defecto). Un periodo cerrado fuera de margen crea una `deviation_alert`
  (deduplicada), una entrada en el Diario y una notificación.
- El informe se recalcula cada hora y en el postmercado para que las
  alertas salgan aunque nadie abra «Real vs backtest».

## Ganchos E2E

Solo con `TRADIA_E2E=1` y sin empaquetar el adaptador es el broker
simulado y se registran canales extra. El simulado ejecuta al último
cierre ingerido del ticker —el mismo mercado del que salen las
señales— con el slippage fijo configurado; sin velas guardadas usa un
precio fijo derivado de la semilla.

- `broker:fail-next` — arma un fallo (`timeout`, `rate-limit`, `server`,
  `reject`, `partial`) para la próxima llamada.
- `broker:create-discrepancy` — fabrica un descuadre
  (`posicion-cantidad`, `orden-borrada`, `orden-fantasma`).
- `broker:seed-weeks` — siembra N semanas de operaciones cerradas (8 por
  defecto) para el informe.
- `live:use-simulated-broker` — conmuta la cuenta real al broker live
  simulado (servidor falso con prefijo `AK`), para probar el flujo
  completo del modo real sin tocar la red.

## Probar contra Alpaca paper de verdad

`npm run qa:alpaca-paper` ejecuta `scripts/qa-alpaca-paper.mjs`, que
empaqueta el adaptador real y, con las claves de tu cuenta paper en el
entorno:

```sh
APCA_API_KEY_ID=PKxxxxxxxx APCA_API_SECRET_KEY=xxxxxxxx npm run qa:alpaca-paper
```

El script lee la cuenta, envía y cancela una orden limitada lejana y un
OCO de compra, e imprime el resultado para cotejarlo con el panel web de
Alpaca paper. Sin claves sale con el uso (exit 2). Nunca apunta a la URL
live: el adaptador la rechazaría.
