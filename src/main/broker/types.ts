/**
 * Contrato de adaptadores de broker — Fase 5 (solo paper).
 *
 * Un adaptador habla con la API del broker en modo paper y traduce su
 * vocabulario al contrato compartido (`src/shared/broker.ts`): cuenta,
 * posiciones y órdenes con los estados normalizados. Nunca hay un modo
 * real: `paperOnly` es una propiedad del adaptador y cualquier URL que no
 * sea paper se rechaza en la construcción.
 *
 * Errores: toda operación rechaza con `BrokerError`, cuyo `kind` decide la
 * reacción del gestor de órdenes: 'rate-limit', 'server', 'timeout' y
 * 'network' son reintentables (`retryable`); 'reject' (rechazo de
 * negocio), 'auth', 'not-found' y 'bad-data' no lo son.
 */
import type {
  BrokerAccount,
  BrokerAdapterId,
  BrokerOrderSide,
  BrokerOrderStatus,
  BrokerOrderType,
  BrokerPosition,
  BrokerTimeInForce,
} from '../../shared/broker';

// ---------------------------------------------------------------------------
// Orden tal como la reporta el broker
// ---------------------------------------------------------------------------

/**
 * Orden en el vocabulario normalizado del broker. A diferencia de
 * `BrokerOrder` (la vista persistida de la app), no tiene id local,
 * trazabilidad de señal ni contador de intentos: es lo que el broker
 * conoce. Una orden OCO se reporta como la orden padre (type 'oco') con
 * sus dos patas en `legs`.
 */
export interface RemoteOrder {
  /** Id que asignó el broker a la orden. */
  brokerOrderId: string;
  /** Id idempotente con el que se envió ('tradia-<señal>-<pata>'). */
  clientOrderId: string;
  ticker: string;
  type: BrokerOrderType;
  side: BrokerOrderSide;
  quantity: number;
  filledQuantity: number;
  limitPrice: number | null;
  stopPrice: number | null;
  /** Estado normalizado ('pendiente'/'huerfana' no los produce el broker). */
  status: BrokerOrderStatus;
  /** Instante en que el broker aceptó la orden (ISO 8601). */
  submittedAt: string;
  /** Instante de la ejecución completa; null mientras no la haya. */
  filledAt: string | null;
  /** Precio medio de ejecución; null mientras no lo haya. */
  filledAvgPrice: number | null;
  /**
   * Grupo OCO de la orden: el id del padre en las patas de un OCO o el
   * propio id en el padre; null fuera de un OCO.
   */
  ocoGroupId: string | null;
  /** Patas hijas de una orden OCO (una limit y una stop); null si no es OCO. */
  legs: RemoteOrder[] | null;
}

/**
 * Orden a enviar al broker. Para type 'oco' `limitPrice` es el objetivo y
 * `stopPrice` el stop de protección (order_class=oco en Alpaca).
 */
export interface BrokerOrderRequest {
  /** Id idempotente de la app; el broker lo devuelve tal cual. */
  clientOrderId: string;
  ticker: string;
  type: BrokerOrderType;
  side: BrokerOrderSide;
  quantity: number;
  /** Obligatorio en 'limit' y 'oco'; ignorado en el resto. */
  limitPrice?: number | null;
  /** Obligatorio en 'stop' y 'oco'; ignorado en el resto. */
  stopPrice?: number | null;
  /** 'day' por defecto cuando el adaptador lo admite. */
  timeInForce?: BrokerTimeInForce;
}

/** Filtro de `listOrders`. */
export interface ListOrdersRequest {
  /** Solo órdenes abiertas ('enviada'/'parcial' normalizadas). */
  openOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Interfaz del adaptador
// ---------------------------------------------------------------------------

export interface BrokerAdapter {
  /** Identificador estable del adaptador ('alpaca', 'simulado'). */
  readonly id: BrokerAdapterId;
  /** Siempre true: el contrato solo admite cuentas paper. */
  readonly paperOnly: true;
  /** Cuenta paper conectada (número, saldo y divisa). */
  getAccount(): Promise<BrokerAccount>;
  /** Posiciones abiertas en la cuenta. */
  listPositions(): Promise<BrokerPosition[]>;
  /** Órdenes conocidas por el broker; filtrable a las abiertas. */
  listOrders(request?: ListOrdersRequest): Promise<RemoteOrder[]>;
  /**
   * Orden por `clientOrderId` (idempotencia): null si el broker no la
   * conoce. Se consulta antes de reintentar un envío.
   */
  getOrderByClientId(clientOrderId: string): Promise<RemoteOrder | null>;
  /**
   * Envía una orden. Rechaza con 'reject' cuando el broker la rechaza por
   * negocio (importe, símbolo, horario); los errores reintentables son
   * 'timeout', 'rate-limit', 'server' y 'network'.
   */
  submitOrder(request: BrokerOrderRequest): Promise<RemoteOrder>;
  /**
   * Cancela una orden abierta por su id del broker. Rechaza con
   * 'not-found' si no existe o ya está cerrada.
   */
  cancelOrder(brokerOrderId: string): Promise<RemoteOrder>;
}

// ---------------------------------------------------------------------------
// Errores tipados
// ---------------------------------------------------------------------------

export const BROKER_ERROR_KINDS = [
  /** Credencial ausente, inválida o de una cuenta live (401/403). */
  'auth',
  /** Cuota del broker agotada (429); reintentable. */
  'rate-limit',
  /** Fallo del lado del broker (5xx); reintentable. */
  'server',
  /** La respuesta se perdió por tiempo de espera; reintentable. */
  'timeout',
  /** Fallo de transporte (DNS, TCP, TLS); reintentable. */
  'network',
  /** Rechazo de negocio (orden inválida, cuenta sin permiso); no se reintenta. */
  'reject',
  /** Orden o recurso inexistente (404); no se reintenta. */
  'not-found',
  /** Entrada inválida o respuesta malformada; no se reintenta. */
  'bad-data',
] as const;

export type BrokerErrorKind = (typeof BROKER_ERROR_KINDS)[number];

/** Kinds de `BrokerError` que corresponden a un fallo real del broker. */
const RETRYABLE_KINDS: readonly BrokerErrorKind[] = [
  'rate-limit',
  'server',
  'timeout',
  'network',
];

export interface BrokerErrorDetails {
  /** Adaptador que lanzó el error ('alpaca', 'simulado'). */
  adapter: string;
  /** client_order_id afectado, si aplica. */
  clientOrderId?: string;
  /** Código HTTP de la respuesta, si la hubo. */
  status?: number;
  /** Espera sugerida antes de reintentar (solo 'rate-limit'). */
  retryAfterMs?: number;
  cause?: unknown;
}

export class BrokerError extends Error {
  readonly kind: BrokerErrorKind;
  readonly adapter: string;
  readonly clientOrderId: string | undefined;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(kind: BrokerErrorKind, message: string, details: BrokerErrorDetails) {
    super(message, { cause: details.cause });
    this.name = 'BrokerError';
    this.kind = kind;
    this.adapter = details.adapter;
    this.clientOrderId = details.clientOrderId;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }

  /** 'rate-limit', 'server', 'timeout' y 'network' merecen reintento. */
  get retryable(): boolean {
    return RETRYABLE_KINDS.includes(this.kind);
  }
}

export function isBrokerError(error: unknown): error is BrokerError;
export function isBrokerError(error: unknown, kind: BrokerErrorKind): error is BrokerError;
export function isBrokerError(error: unknown, kind?: BrokerErrorKind): boolean {
  return error instanceof BrokerError && (kind === undefined || error.kind === kind);
}

// ---------------------------------------------------------------------------
// Validación de entrada (los adaptadores la aplican antes de tocar el broker)
// ---------------------------------------------------------------------------

/** Tickers del universo US: letras, dígitos, punto y guion (p. ej. 'BRK.B'). */
export const BROKER_TICKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,11}$/;

const isPositive = (n: unknown): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n > 0;

/**
 * Valida la forma de una orden antes de enviarla: ticker y cantidad
 * positivos, precios coherentes con el tipo (limit exige `limitPrice`,
 * stop exige `stopPrice`, oco exige los dos) y `clientOrderId` corto.
 * Lanza `BrokerError` 'bad-data'.
 */
export function assertValidOrderRequest(request: BrokerOrderRequest, adapter: string): void {
  const bad = (detail: string): never => {
    throw new BrokerError('bad-data', `orden inválida: ${detail}`, {
      adapter,
      clientOrderId: typeof request?.clientOrderId === 'string' ? request.clientOrderId : undefined,
    });
  };
  if (typeof request !== 'object' || request === null) bad('la petición no es un objeto');
  if (
    typeof request.clientOrderId !== 'string' ||
    request.clientOrderId.trim().length === 0 ||
    request.clientOrderId.length > 64
  ) {
    bad('clientOrderId debe ser una cadena no vacía de hasta 64 caracteres');
  }
  if (!BROKER_TICKER_PATTERN.test(request.ticker)) bad(`ticker inválido: ${request.ticker}`);
  if (!isPositive(request.quantity)) bad(`cantidad debe ser > 0: ${request.quantity}`);
  const limit = request.limitPrice ?? null;
  const stop = request.stopPrice ?? null;
  if (limit !== null && !isPositive(limit)) bad(`precio límite debe ser > 0: ${limit}`);
  if (stop !== null && !isPositive(stop)) bad(`precio stop debe ser > 0: ${stop}`);
  if (request.type === 'limit' && limit === null) bad("una orden 'limit' necesita limitPrice");
  if (request.type === 'stop' && stop === null) bad("una orden 'stop' necesita stopPrice");
  if (request.type === 'oco' && (limit === null || stop === null)) {
    bad("una orden 'oco' necesita limitPrice (objetivo) y stopPrice");
  }
  if (
    request.timeInForce !== undefined &&
    !(['day', 'gtc'] as readonly string[]).includes(request.timeInForce)
  ) {
    bad(`timeInForce inválido: ${request.timeInForce}`);
  }
}
