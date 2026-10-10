# Broker en modo paper (fase 5)

La app se conecta a una **cuenta de paper trading del broker** para
ejecutar las señales aprobadas con dinero simulado, concilia su registro
con el del broker y compara los resultados reales con el backtest. El
dinero real sigue fuera del alcance (ver `docs/alcance.md`, sección 3).

Piezas: `src/main/broker/alpaca.ts` (adaptador Alpaca paper),
`simulated.ts` (broker simulado para pruebas y E2E), `orderManager.ts`
(envío, reintentos y huérfanas), `reconcileService.ts` (conciliación),
`deviationService.ts` (informe real vs backtest), `repository.ts`
(persistencia, migración 010) e `index.ts` (servicio, IPC y ganchos).

## Solo paper

- El adaptador real es Alpaca con la URL fija
  `https://paper-api.alpaca.markets`: cualquier otra URL lanza
  `BrokerError('bad-data')` en el constructor, así que una cuenta live
  nunca se prueba por accidente.
- Además, el servicio rechaza antes de tocar la red las claves cuyo id no
  empieza por `PK` (la convención de Alpaca para paper; las live usan
  `AK`). El mensaje es claro: «Estas claves no corresponden a una cuenta
  paper. No se han guardado.»
- La cuenta se valida contra el endpoint paper **antes** de guardar las
  claves: unas credenciales inválidas obtienen 401 y no se persisten.
- En Ajustes la cuenta aparece con la insignia «Solo paper».

## Claves: cifradas y sin permiso de retirada

- Las claves viven en `services.secrets`, cifradas con el llavero del
  sistema operativo (Keychain en macOS, DPAPI en Windows,
  gnome-keyring/KWallet en Linux). Nunca en texto plano.
- **Sin llavero no hay conexión**: si el SO no puede cifrar, `setKey`
  falla y la conexión no se completa con un mensaje legible.
- Genera las claves en el panel de Alpaca paper **sin permiso de
  retirada** (solo trading): la app nunca necesita mover fondos.
- Las claves no salen del proceso principal: ningún canal IPC las
  devuelve (el renderer solo recibe `BrokerStatus`, con cuenta y saldo) y
  `redact` las elimina de errores y registros.
- `broker:disconnect` las borra del almacén.
- Al arrancar, si hay claves guardadas la app reconecta sola: es
  residente en bandeja y las señales deben seguir ejecutándose.

## Ejecución de señales

Cada `signals:new` con decisión `aprobada` o `reducida` entra al gestor
de órdenes. Sin cuenta conectada sigue el seguimiento local de
`signals/paper.ts` (la cartera simulada interna convive con el broker).

- Entrada: orden **de mercado** `tradia-<señal>-entrada` (buy/sell según
  largo/corto; cantidad = `decision.size`).
- Salida: al ejecutarse la entrada se crea el **OCO**
  `tradia-<señal>-salida` con la pata contraria (`limitPrice` = objetivo,
  `stopPrice` = stop, `gtc`). El OCO se reconstruye tras un reinicio a
  partir de la señal persistida.
- Puertas: parada de emergencia activa, sin conexión o interruptor
  «Ejecutar señales aprobadas en paper» apagado → la orden queda
  `bloqueada` con entrada `error` en el Diario. Señales vetadas o sin
  tamaño se ignoran.
- Cada orden registra hora y precio **pedidos** y **ejecutados**; el
  slippage en puntos básicos (`slippageBpsOf`) se muestra en la página
  «Órdenes». En el OCO la referencia es el nivel de la pata que ejecutó.
- Tipos soportados por el adaptador: mercado, limitadas, stop y OCO.
  La cancelación (`orders:cancel`) envía DELETE y confirma con un GET.

## Idempotencia, reintentos y huérfanas

- **Duplicados**: el `clientOrderId` es determinista (`tradia-<señal>-<pata>`),
  así que una misma señal nunca crea dos órdenes; reemitir el evento es
  inocuo.
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
simulado y se registran tres canales extra:

- `broker:fail-next` — arma un fallo (`timeout`, `rate-limit`, `server`,
  `reject`, `partial`) para la próxima llamada.
- `broker:create-discrepancy` — fabrica un descuadre
  (`posicion-cantidad`, `orden-borrada`, `orden-fantasma`).
- `broker:seed-weeks` — siembra N semanas de operaciones cerradas (8 por
  defecto) para el informe.

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
