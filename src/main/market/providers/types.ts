/**
 * Contrato de proveedores de datos de mercado — Fase 1.
 *
 * Un proveedor entrega velas diarias OHLCV (`getBars`), la última cotización
 * conocida (`getQuote`) y las acciones corporativas del rango
 * (`getCorporateActions`). Cada proveedor declara sus `rateLimits`
 * (peticiones por hora y por día) para que la ingesta use `rateLimiter.ts`
 * y no se pase de cuota.
 *
 * Errores: toda operación rechaza con `MarketDataError`, cuyo `kind` tipado
 * decide la reacción: 'auth' (pedir o revisar la clave), 'rate-limit' y
 * 'network' (reintentables), 'not-found' (ticker inexistente) y 'bad-data'
 * (entrada rechazada o respuesta malformada).
 */
import type { AssetClass } from '../../../shared/ipc';

/** Fecha de sesión del mercado, 'YYYY-MM-DD' (sin hora ni zona). */
export type SessionDate = string;

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Tickers del universo US: letras, dígitos, punto y guion (p. ej. 'BRK.B'). */
export const TICKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,11}$/;

/** Una vela diaria tal como la entrega el proveedor (precios crudos). */
export interface Bar {
  /** Fecha de la sesión, 'YYYY-MM-DD'. */
  date: SessionDate;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Acciones negociadas en la sesión. */
  volume: number;
  /** Cierre ajustado hacia atrás por splits y dividendos, según el proveedor. */
  adjClose: number;
  /** Acciones nuevas por cada antigua repartidas ese día (1 = sin split). */
  splitFactor: number;
  /** Dividendo en efectivo por acción repartido ese día (0 = sin dividendo). */
  dividend: number;
}

/** Última cotización conocida de un activo. */
export interface Quote {
  ticker: string;
  /** Sesión de la que procede el precio ('YYYY-MM-DD'). */
  date: SessionDate;
  /** Último precio (cierre de la última vela disponible). */
  last: number;
  volume: number | null;
}

/** Ficha mínima de un símbolo en el proveedor, para validar altas. */
export interface TickerInfo {
  /** Símbolo en su forma guardada ('AAPL', 'EURUSD'). */
  ticker: string;
  /** Tipo de activo según el símbolo: 'fx' solo para los pares admitidos. */
  assetClass: AssetClass;
  /** Nombre descriptivo cuando el proveedor lo publica. */
  name?: string;
}

export type CorporateActionKind = 'split' | 'dividend';

export interface CorporateAction {
  ticker: string;
  /** Fecha ex de la acción ('YYYY-MM-DD'). */
  date: SessionDate;
  kind: CorporateActionKind;
  /** split: acciones nuevas por cada antigua (4 = 4:1). dividend: efectivo por acción. */
  value: number;
}

/** Cuota de uso declarada por el proveedor (peticiones por ventana deslizante). */
export interface RateLimits {
  perHour: number;
  perDay: number;
}

export interface MarketDataProvider {
  /** Identificador estable del proveedor: 'tiingo', 'simulated'… */
  readonly id: string;
  readonly rateLimits: RateLimits;
  /**
   * Velas diarias entre `desde` y `hasta` (ambos inclusive, 'YYYY-MM-DD'),
   * ordenadas ascendentemente por fecha. Devuelve [] si el rango no tiene
   * sesiones con datos; lanza 'not-found' si el ticker no existe.
   */
  getBars(ticker: string, desde: SessionDate, hasta: SessionDate): Promise<Bar[]>;
  /**
   * Ficha del símbolo para validar altas: resuelve si el proveedor lo
   * cubre; lanza 'not-found' si no existe (o 'bad-data' si la entrada no
   * es válida). Una petición por llamada como máximo.
   */
  getTickerInfo(ticker: string): Promise<TickerInfo>;
  /** Última cotización disponible del activo. */
  getQuote(ticker: string): Promise<Quote>;
  /** Splits y dividendos del rango, ordenados por fecha. */
  getCorporateActions(
    ticker: string,
    desde: SessionDate,
    hasta: SessionDate,
  ): Promise<CorporateAction[]>;
}

// ---------------------------------------------------------------------------
// Errores tipados
// ---------------------------------------------------------------------------

export const MARKET_DATA_ERROR_KINDS = [
  /** Credencial ausente, inválida o rechazada (401/403). */
  'auth',
  /** Cuota del proveedor agotada (429 o limitador local). */
  'rate-limit',
  /** Ticker o recurso inexistente (404). */
  'not-found',
  /** Fallo de transporte o del servidor remoto (5xx, tiempo de espera). */
  'network',
  /** Entrada rechazada o respuesta malformada/inesperada. */
  'bad-data',
] as const;

export type MarketDataErrorKind = (typeof MARKET_DATA_ERROR_KINDS)[number];

export interface MarketDataErrorDetails {
  /** Identificador del proveedor que lanzó el error. */
  provider: string;
  ticker?: string;
  /** Código HTTP de la respuesta, si la hubo. */
  status?: number;
  /** Espera sugerida antes de reintentar (solo 'rate-limit'). */
  retryAfterMs?: number;
  cause?: unknown;
}

export class MarketDataError extends Error {
  readonly kind: MarketDataErrorKind;
  readonly provider: string;
  readonly ticker: string | undefined;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(kind: MarketDataErrorKind, message: string, details: MarketDataErrorDetails) {
    super(message, { cause: details.cause });
    this.name = 'MarketDataError';
    this.kind = kind;
    this.provider = details.provider;
    this.ticker = details.ticker;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }

  /** 'rate-limit' y 'network' merecen reintento; el resto no se arregla solo. */
  get retryable(): boolean {
    return this.kind === 'rate-limit' || this.kind === 'network';
  }
}

export function isMarketDataError(error: unknown): error is MarketDataError;
export function isMarketDataError(
  error: unknown,
  kind: MarketDataErrorKind,
): error is MarketDataError;
export function isMarketDataError(error: unknown, kind?: MarketDataErrorKind): boolean {
  return error instanceof MarketDataError && (kind === undefined || error.kind === kind);
}

/**
 * Motivo fijo de «la clave guardada no es válida»: pide volver a pegarla
 * y nunca la contiene (la clave no aparece en ningún texto).
 */
export const INVALID_STORED_KEY_MESSAGE =
  'La clave guardada tiene caracteres no válidos; vuelve a pegarla en Ajustes';

/**
 * La clave guardada no sirve como credencial (controles o espacios dentro,
 * p. ej. pegada desde un documento antes de la validación de `setKey`).
 * Sigue siendo 'auth' —quien la clasifica la trata como problema de
 * clave—, pero se distingue por la clase: no es «sin clave», no es un 401
 * remoto y nunca llegó a la red.
 */
export class InvalidStoredKeyError extends MarketDataError {
  constructor(details: MarketDataErrorDetails) {
    super('auth', `[${details.provider}] ${INVALID_STORED_KEY_MESSAGE}`, details);
    this.name = 'InvalidStoredKeyError';
  }
}

export function isInvalidStoredKeyError(error: unknown): error is InvalidStoredKeyError {
  return error instanceof InvalidStoredKeyError;
}

// ---------------------------------------------------------------------------
// Validación de entrada (los adaptadores la aplican antes de llamar a la API)
// ---------------------------------------------------------------------------

export function assertValidTicker(ticker: string, provider: string): void {
  if (typeof ticker !== 'string' || !TICKER_PATTERN.test(ticker)) {
    throw new MarketDataError('bad-data', `ticker inválido: ${JSON.stringify(ticker)}`, {
      provider,
      ticker: typeof ticker === 'string' ? ticker : undefined,
    });
  }
}

export function assertValidDateRange(
  desde: SessionDate,
  hasta: SessionDate,
  provider: string,
): void {
  for (const [label, value] of [
    ['desde', desde],
    ['hasta', hasta],
  ] as const) {
    // Date.parse hace rollover de fechas imposibles ('2020-02-30' → 01-03);
    // la comprobación de ida y vuelta las rechaza.
    const parsed = new Date(`${value}T00:00:00.000Z`);
    const isRealDate =
      !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    if (!ISO_DATE_PATTERN.test(value) || !isRealDate) {
      throw new MarketDataError(
        'bad-data',
        `fecha '${label}' inválida: ${JSON.stringify(value)} (se espera 'YYYY-MM-DD')`,
        { provider },
      );
    }
  }
  if (desde > hasta) {
    throw new MarketDataError('bad-data', `rango de fechas invertido: ${desde} > ${hasta}`, {
      provider,
    });
  }
}
