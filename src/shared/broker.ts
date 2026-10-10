/**
 * Dominio del broker en modo paper (fase 5) — contrato compartido.
 *
 * La app se conecta a un broker SOLO en modo paper (Alpaca paper; la URL
 * live se rechaza siempre, ver supuestos del plan y docs/alcance.md §3).
 * Una señal aprobada o reducida por la pasarela de riesgo se ejecuta en el
 * paper como una orden de mercado de entrada y, al ejecutarse, un OCO de
 * stop + objetivo. La app registra cada orden (`broker_orders`, migración
 * 010) con su hora y precio pedidos, hora y precio ejecutados y el
 * slippage en puntos básicos, concilia periódicamente posiciones y
 * órdenes con el broker y compara lo real con lo esperado del backtest.
 *
 * Convenciones:
 * - Los estados y tipos persistidos son los literales de aquí: son el
 *   CHECK de la base y los valores que ve el renderer.
 * - Idempotencia: `clientOrderId` es determinista ('tradia-<señal>-<pata>')
 *   y UNIQUE en `broker_orders`; el broker lo conoce igual.
 * - Las claves del broker jamás salen del proceso principal: viajan solo
 *   por `broker:connect`/`broker:test` y viven cifradas en `secrets` con
 *   los proveedores de `BROKER_SECRET_KEYS`.
 */

// ---------------------------------------------------------------------------
// Órdenes
// ---------------------------------------------------------------------------

/** Tipos de orden que admite el contrato del broker. */
export const BROKER_ORDER_TYPES = ['market', 'limit', 'stop', 'oco'] as const;
export type BrokerOrderType = (typeof BROKER_ORDER_TYPES)[number];

/** Lado de la orden en vocabulario de broker (compra/venta). */
export const BROKER_ORDER_SIDES = ['buy', 'sell'] as const;
export type BrokerOrderSide = (typeof BROKER_ORDER_SIDES)[number];

/**
 * Estados de una orden, compartidos por la app y el broker (los adaptadores
 * traducen los estados nativos a estos):
 * - 'pendiente': creada en la app, todavía no aceptada por el broker.
 * - 'enviada': aceptada por el broker y abierta, sin ejecutar.
 * - 'parcial': ejecutada en parte (`filledQuantity` < `quantity`).
 * - 'ejecutada': ejecutada por completo.
 * - 'cancelada': cancelada por la app o por el broker (p. ej. la otra pata
 *   del OCO al ejecutarse una).
 * - 'rechazada': rechazada por el broker o por la app (motivo en
 *   `rejectReason`); nunca se reintenta.
 * - 'huerfana': sin correspondencia app ↔ broker (una orden local sin
 *   respuesta del broker o una orden 'tradia-*' del broker sin registro).
 */
export const BROKER_ORDER_STATUSES = [
  'pendiente',
  'enviada',
  'parcial',
  'ejecutada',
  'cancelada',
  'rechazada',
  'huerfana',
] as const;
export type BrokerOrderStatus = (typeof BROKER_ORDER_STATUSES)[number];

/** Órdenes abiertas (cancelables y sujetas a conciliación). */
export const BROKER_ORDER_OPEN_STATUSES = ['pendiente', 'enviada', 'parcial'] as const;

/** Estados terminales: la orden ya no cambia ni se puede cancelar. */
export const BROKER_ORDER_FINAL_STATUSES = [
  'ejecutada',
  'cancelada',
  'rechazada',
  'huerfana',
] as const;

/**
 * Pata del plan de ejecución de una señal: 'entrada' es la orden de
 * mercado de apertura y 'salida' el OCO de stop + objetivo. NULL en
 * órdenes sueltas (p. ej. una limitada manual de prueba). Forma parte del
 * `clientOrderId` determinista 'tradia-<señal>-<pata>'.
 */
export const BROKER_ORDER_LEGS = ['entrada', 'salida'] as const;
export type BrokerOrderLeg = (typeof BROKER_ORDER_LEGS)[number];

/** Tiempo en vigor admitido por el contrato (Alpaca: 'day' y 'gtc'). */
export const BROKER_TIME_IN_FORCE = ['day', 'gtc'] as const;
export type BrokerTimeInForce = (typeof BROKER_TIME_IN_FORCE)[number];

/**
 * Registro de ejecución de una orden: la hora y el precio pedidos frente a
 * la hora y el precio ejecutados, y el slippage resultante en puntos
 * básicos (10 000 pb = 100 %).
 */
export interface OrderExecution {
  /** Instante en que la app pidió la orden (ISO 8601). */
  requestedAt: string;
  /**
   * Precio de referencia del pedido: el limit/stop en esos tipos, el
   * precio previsto (señal o última cotización) en una de mercado; null
   * en un OCO hasta saber qué pata ejecuta.
   */
  requestedPrice: number | null;
  /** Instante de la ejecución completa; null mientras no la haya. */
  executedAt: string | null;
  /** Precio medio de ejecución; null mientras no la haya. */
  executedPrice: number | null;
  /**
   * Slippage en puntos básicos con signo según el lado: positivo =
   * desfavorable (compra más cara o venta más barata de lo pedido); null
   * sin ejecución o sin precio de referencia. Ver `slippageBpsOf`.
   */
  slippageBps: number | null;
}

/**
 * Orden del broker tal como la ve la app (fila de `broker_orders`). Es el
 * tipo de la página «Órdenes», del evento `broker:order-updated` y de lo
 * que persiste `src/main/broker/repository.ts`.
 */
export interface BrokerOrder {
  /** Id local (`broker_orders.id`). */
  id: number;
  /** Id idempotente de la app ('tradia-<señal>-<pata>'); UNIQUE. */
  clientOrderId: string;
  /** Id que asignó el broker; null hasta que la acepta. */
  brokerOrderId: string | null;
  /** Señal que originó la orden; null en órdenes sueltas. */
  signalId: number | null;
  /** Estrategia principal de la señal; null si no consta. */
  strategyId: number | null;
  /** Pata del plan ('entrada' | 'salida'); null en órdenes sueltas. */
  leg: BrokerOrderLeg | null;
  ticker: string;
  type: BrokerOrderType;
  side: BrokerOrderSide;
  /** Cantidad pedida en unidades. */
  quantity: number;
  /** Cantidad ejecutada (igual a `quantity` en 'ejecutada'). */
  filledQuantity: number;
  /** Precio límite (limit y pata objetivo del OCO); null si no aplica. */
  limitPrice: number | null;
  /** Precio stop (stop y pata stop del OCO); null si no aplica. */
  stopPrice: number | null;
  /**
   * Grupo OCO que enlaza esta orden con su orden padre o sus patas en el
   * broker; null fuera de un OCO. En Alpaca es el id de la orden padre.
   */
  ocoGroupId: string | null;
  execution: OrderExecution;
  status: BrokerOrderStatus;
  /** Envíos intentados (1 en el primero; crece en cada reintento). */
  attempts: number;
  /** Motivo legible del rechazo; null en el resto de estados. */
  rejectReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Slippage en puntos básicos con el signo del contrato: positivo cuando la
 * ejecución fue peor que el pedido. En una compra, ejecutar por encima es
 * peor (+); en una venta, ejecutar por debajo es peor (+). Devuelve null
 * si falta el precio de referencia o el de ejecución.
 */
export function slippageBpsOf(
  side: BrokerOrderSide,
  requestedPrice: number | null,
  executedPrice: number | null,
): number | null {
  if (
    requestedPrice === null ||
    executedPrice === null ||
    !(requestedPrice > 0) ||
    !Number.isFinite(executedPrice)
  ) {
    return null;
  }
  const signedDiff = (executedPrice - requestedPrice) * (side === 'buy' ? 1 : -1);
  return Math.round((signedDiff / requestedPrice) * 10_000 * 100) / 100;
}

// ---------------------------------------------------------------------------
// Cuenta y posiciones
// ---------------------------------------------------------------------------

/** Lado de una posición del broker en su propio vocabulario. */
export const BROKER_POSITION_SIDES = ['long', 'short'] as const;
export type BrokerPositionSide = (typeof BROKER_POSITION_SIDES)[number];

/** Posición abierta en la cuenta del broker. */
export interface BrokerPosition {
  ticker: string;
  side: BrokerPositionSide;
  /** Unidades en cartera (siempre ≥ 0; el signo lo da `side`). */
  quantity: number;
  /** Precio medio de entrada. */
  avgEntryPrice: number;
  /** Valor de mercado en la divisa de la cuenta; null si no consta. */
  marketValue: number | null;
  /** Resultado no realizado en la divisa de la cuenta; null si no consta. */
  unrealizedPnl: number | null;
  currency: string;
}

/** Cuenta del broker (siempre paper en esta fase). */
export interface BrokerAccount {
  /** Número o id de la cuenta (se muestra en Ajustes). */
  accountId: string;
  /** Estado que reporta el broker ('ACTIVE' en Alpaca). */
  status: string;
  currency: string;
  /** Efectivo disponible. */
  cash: number;
  /** Valor total de la cuenta (efectivo + posiciones). */
  equity: number;
  /** Poder de compra; null si el broker no lo reporta. */
  buyingPower: number | null;
  /** Siempre true: la app solo admite cuentas paper. */
  paper: true;
}

// ---------------------------------------------------------------------------
// Conciliación con el broker
// ---------------------------------------------------------------------------

/** Tipos de descuadre que detecta la conciliación app ↔ broker. */
export const RECONCILE_DISCREPANCY_TYPES = [
  /** Posición que la app tiene y el broker no. */
  'posicion-faltante-broker',
  /** Posición que el broker tiene y la app no. */
  'posicion-faltante-app',
  /** Misma posición en ambos lados con cantidad distinta. */
  'posicion-cantidad',
  /** Misma posición en ambos lados con precio medio distinto (> 1 céntimo). */
  'posicion-precio',
  /** Orden abierta en la app que el broker no conoce. */
  'orden-faltante-broker',
  /** Orden abierta en el broker sin registro en la app. */
  'orden-faltante-app',
  /** Misma orden en ambos lados con estado o cantidad distinta. */
  'orden-estado',
] as const;
export type ReconcileDiscrepancyType = (typeof RECONCILE_DISCREPANCY_TYPES)[number];

/** Una discrepancia concreta de una conciliación (fila de `reconcile_discrepancies`). */
export interface ReconcileDiscrepancy {
  id: number;
  /** Ejecución de conciliación que la detectó (`reconcile_runs.id`). */
  runId: number;
  type: ReconcileDiscrepancyType;
  /** Activo afectado; null en descuadres sin activo. */
  ticker: string | null;
  /** Texto legible en español; es lo que muestra el banner de descuadre. */
  detail: string;
  /** Valor según la app, ya formateado ('12 uds', '190,50'); null si no aplica. */
  appValue: string | null;
  /** Valor según el broker, ya formateado; null si no aplica. */
  brokerValue: string | null;
  /** 'abierta' hasta que una ejecución limpia la marca 'resuelta'. */
  status: 'abierta' | 'resuelta';
  createdAt: string;
  resolvedAt: string | null;
}

/** Origen de una ejecución de conciliación. */
export const RECONCILE_TRIGGERS = ['programada', 'manual', 'rutina'] as const;
export type ReconcileTrigger = (typeof RECONCILE_TRIGGERS)[number];

/** Resultado de una ejecución: 'ok' sin descuadres, 'error' si no se pudo comparar. */
export const RECONCILE_RUN_RESULTS = ['ok', 'descuadre', 'error'] as const;
export type ReconcileRunResult = (typeof RECONCILE_RUN_RESULTS)[number];

/** Una ejecución de la conciliación (fila de `reconcile_runs`). */
export interface ReconcileRun {
  id: number;
  trigger: ReconcileTrigger;
  startedAt: string;
  /** null mientras la ejecución sigue en curso. */
  finishedAt: string | null;
  /** null mientras la ejecución sigue en curso. */
  result: ReconcileRunResult | null;
  /** Posiciones leídas en la app. */
  positionsApp: number;
  /** Posiciones leídas en el broker. */
  positionsBroker: number;
  /** Órdenes abiertas leídas en la app. */
  ordersApp: number;
  /** Órdenes abiertas leídas en el broker. */
  ordersBroker: number;
  /** Discrepancias nuevas detectadas en la ejecución. */
  discrepancies: number;
  /** Motivo legible del fallo cuando `result` es 'error'; null si no. */
  error: string | null;
}

/** Lectura de `reconcile:status`: la última ejecución y los descuadres abiertos. */
export interface ReconcileStatusResult {
  lastRun: ReconcileRun | null;
  openDiscrepancies: ReconcileDiscrepancy[];
}

/**
 * Evento `reconcile:discrepancy` tras cada ejecución con diferencias (o
 * tras una limpia que cierra el aviso: `discrepancies` vacío).
 */
export interface ReconcileDiscrepancyEvent {
  runId: number;
  /** ISO 8601 de la ejecución. */
  at: string;
  /** Descuadres abiertos tras la ejecución; vacío si cuadró todo. */
  discrepancies: ReconcileDiscrepancy[];
}

// ---------------------------------------------------------------------------
// Desviación real frente a backtest
// ---------------------------------------------------------------------------

/** Periodos del informe: semana de lunes a domingo y mes natural (NY). */
export const DEVIATION_PERIODS = ['semanal', 'mensual'] as const;
export type DeviationPeriod = (typeof DEVIATION_PERIODS)[number];

/** Consulta de `deviation:report`. */
export interface DeviationReportQuery {
  period: DeviationPeriod;
}

/** Una fila del informe: una estrategia en un periodo cerrado. */
export interface DeviationReportRow {
  strategyId: number;
  strategyName: string;
  /** Inicio del periodo ('YYYY-MM-DD', America/New_York). */
  desde: string;
  /** Fin del periodo ('YYYY-MM-DD', America/New_York), inclusive. */
  hasta: string;
  /** Operaciones paper cerradas de la estrategia en el periodo. */
  trades: number;
  /** Rentabilidad esperada del periodo (%), desde el último backtest. */
  expectedReturnPct: number | null;
  /** Rentabilidad real del periodo (%). */
  realReturnPct: number;
  /** Desviación en puntos porcentuales (real − esperado). */
  deviationPp: number | null;
  /** Tasa de acierto esperada (0–1) del último backtest. */
  expectedWinRate: number | null;
  /** Tasa de acierto real del periodo (0–1). */
  realWinRate: number;
  /** Slippage medio de las ejecuciones del periodo (puntos básicos). */
  avgSlippageBps: number | null;
  /** true si el periodo sale del margen configurado. */
  outOfMargin: boolean;
}

/** Informe de `deviation:report`: una fila por estrategia y periodo cerrado. */
export interface DeviationReport {
  period: DeviationPeriod;
  /** Margen de desviación configurado (± puntos porcentuales). */
  marginPp: number;
  /** Slippage medio máximo admitido (puntos básicos). */
  maxSlippageBps: number;
  generatedAt: string;
  rows: DeviationReportRow[];
}

/** Margen por defecto: ±2 puntos porcentuales (supuestos del plan). */
export const DEVIATION_MARGIN_PP_DEFAULT = 2;
/** Slippage medio máximo por defecto: 10 puntos básicos. */
export const DEVIATION_SLIPPAGE_BPS_DEFAULT = 10;
/** Márgenes duros de lo configurable en Ajustes. */
export const DEVIATION_MARGIN_PP_BOUNDS = { min: 0.1, max: 50 } as const;
export const DEVIATION_SLIPPAGE_BPS_BOUNDS = { min: 1, max: 500 } as const;

/** Alerta persistida cuando un periodo cierra fuera de margen (`deviation_alerts`). */
export interface DeviationAlert {
  id: number;
  strategyId: number;
  strategyName: string;
  period: DeviationPeriod;
  desde: string;
  hasta: string;
  expectedReturnPct: number;
  realReturnPct: number;
  deviationPp: number;
  avgSlippageBps: number | null;
  /** Márgenes vigentes cuando saltó la alerta. */
  marginPp: number;
  maxSlippageBps: number;
  /** Entrada del diario que recoge la alerta; null si se borró. */
  journalId: number | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Conexión del broker (Ajustes)
// ---------------------------------------------------------------------------

/** Adaptadores posibles: 'alpaca' real contra paper-api; 'simulado' en E2E. */
export const BROKER_ADAPTER_IDS = ['alpaca', 'simulado'] as const;
export type BrokerAdapterId = (typeof BROKER_ADAPTER_IDS)[number];

/** Estados de la conexión con la cuenta paper. */
export const BROKER_CONNECTION_STATES = [
  'desconectada',
  'comprobando',
  'conectada',
  'error',
] as const;
export type BrokerConnectionState = (typeof BROKER_CONNECTION_STATES)[number];

/**
 * Estado de la cuenta paper para Ajustes (`broker:status`, `broker:connect`,
 * `broker:disconnect`). Nunca incluye claves: el renderer solo sabe si hay
 * cuenta conectada, su número y su saldo.
 */
export interface BrokerStatus {
  state: BrokerConnectionState;
  /** Adaptador en uso; null si nunca se conectó. */
  adapter: BrokerAdapterId | null;
  /** Cuenta y saldo paper; null si no hay conexión. */
  account: BrokerAccount | null;
  /** Interruptor «Ejecutar señales aprobadas en paper» (settings). */
  executionEnabled: boolean;
  /** Motivo legible del último fallo; null si no hay. */
  error: string | null;
  /** Última validación correcta de la cuenta (ISO 8601); null si nunca. */
  checkedAt: string | null;
}

/**
 * Credenciales del broker tal como entran por `broker:connect` o
 * `broker:test`. Las claves de Alpaca son alfanuméricas con guion; las de
 * una cuenta live se rechazan al validar contra el endpoint paper
 * (nunca llega a probarse una URL live: el adaptador la rechaza).
 */
export interface BrokerCredentials {
  apiKeyId: string;
  apiSecret: string;
}

/** Petición de `broker:connect` (hoy solo las credenciales). */
export type BrokerConnectRequest = BrokerCredentials;

/**
 * Petición de `broker:test`: unas claves nuevas o, sin campos, las ya
 * guardadas (prueba de la conexión vigente).
 */
export interface BrokerTestRequest {
  apiKeyId?: string;
  apiSecret?: string;
}

/** Resultado de `broker:test`; `error` es legible y nunca contiene claves. */
export interface BrokerTestResult {
  ok: boolean;
  /** Cuenta validada cuando ok; null si falló. */
  account: BrokerAccount | null;
  error: string | null;
  latencyMs: number | null;
}

/** Proveedores del almacén `secrets` donde viven las claves del broker. */
export const BROKER_SECRET_KEYS = {
  apiKeyId: 'broker-alpaca-key-id',
  apiSecret: 'broker-alpaca-secret',
} as const;

// ---------------------------------------------------------------------------
// Órdenes desde el renderer
// ---------------------------------------------------------------------------

/** Tope del parámetro `limit` de `orders:list`. */
export const BROKER_ORDERS_MAX_LIMIT = 500;

/** Filtros de `orders:list`; todos opcionales y combinables. */
export interface BrokerOrdersQuery {
  status?: BrokerOrderStatus;
  /** Filtra por la estrategia que originó la señal. */
  strategyId?: number;
  ticker?: string;
  limit?: number;
  offset?: number;
}

/** Petición de `orders:cancel`: la orden local a cancelar. */
export interface CancelOrderRequest {
  /** Id local (`broker_orders.id`) de una orden abierta. */
  id: number;
}

/**
 * Petición de `orders:create`: una orden limitada manual, sin señal ni
 * estrategia asociadas (`leg` null). El `client_order_id` lo genera el
 * proceso principal con el prefijo 'tradia-manual-'.
 */
export interface CreateOrderRequest {
  ticker: string;
  side: BrokerOrderSide;
  /** Unidades a operar; > 0. */
  quantity: number;
  /** Precio límite; > 0. */
  limitPrice: number;
}

/** Evento `broker:order-updated`: una orden cambió de estado o de ejecución. */
export interface BrokerOrderUpdatedEvent {
  order: BrokerOrder;
}

// ---------------------------------------------------------------------------
// Ganchos E2E (solo TRADIA_E2E y sin empaquetar)
// ---------------------------------------------------------------------------

/** Fallos inyectables de la próxima llamada del broker simulado (`broker:fail-next`). */
export const BROKER_E2E_FAILURES = [
  /** La orden queda registrada pero la respuesta se pierde (ambigüedad real). */
  'timeout',
  /** 429 del broker, reintentable. */
  'rate-limit',
  /** 5xx del broker, reintentable. */
  'server',
  /** Rechazo de negocio, no reintentable. */
  'reject',
  /** La orden se ejecuta solo en parte. */
  'partial',
] as const;
export type BrokerE2eFailure = (typeof BROKER_E2E_FAILURES)[number];

export interface BrokerFailNextRequest {
  kind: BrokerE2eFailure;
}

/** Descuadres fabricables a propósito (`broker:create-discrepancy`). */
export const BROKER_E2E_DISCREPANCIES = [
  /** Altera la cantidad de una posición del broker. */
  'posicion-cantidad',
  /** El broker olvida una orden abierta de la app. */
  'orden-borrada',
  /** El broker muestra una orden 'tradia-*' que la app no registró. */
  'orden-fantasma',
] as const;
export type BrokerE2eDiscrepancy = (typeof BROKER_E2E_DISCREPANCIES)[number];

export interface BrokerDiscrepancyRequest {
  kind: BrokerE2eDiscrepancy;
}

/** Petición de `broker:seed-weeks`: semanas de operaciones a sembrar. */
export interface BrokerSeedWeeksRequest {
  /** Número de semanas (1–52); 8 por defecto en el servicio. */
  weeks?: number;
}

/** Resultado de los ganchos de siembra y fallo. */
export interface BrokerSeedWeeksResult {
  /** Órdenes paper sembradas en `broker_orders`. */
  orders: number;
}

export interface BrokerFailNextResult {
  /** Fallo que quedó armado para la próxima llamada. */
  armed: BrokerE2eFailure;
}

export interface BrokerDiscrepancyResult {
  /** Descuadre fabricado, listo para que lo detecte la conciliación. */
  kind: BrokerE2eDiscrepancy;
}
