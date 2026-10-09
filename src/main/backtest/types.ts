/**
 * Contratos del motor de backtest vela a vela — Fase 2.
 *
 * El motor (`engine.ts`) es un módulo puro: recibe las velas por ticker, la
 * estrategia y la configuración de costes, y devuelve la lista de operaciones
 * y la curva de capital diaria. Sin Electron, sin Node, sin estado global.
 *
 * Garantías del modelo de ejecución (ver docs/alcance.md y el plan de fase):
 * - La señal se calcula con el cierre de la vela t y la orden se llena en la
 *   apertura de la siguiente vela del activo; nunca en la misma vela.
 * - La estrategia solo ve las velas hasta t: la vista (`BarWindow`) lanza
 *   `LookAheadError` si se pide un índice fuera del historial visible.
 * - Stop y objetivo se evalúan con el high/low intrabarra; si en la misma
 *   vela se tocan los dos, cuenta primero el stop (supuesto conservador).
 * - Solo posiciones largas, sin apalancamiento y sin piramidación.
 * - Cada activo cotiza solo dentro de su ventana [listedFrom, listedUntil];
 *   fuera de ella no recibe señales y una posición abierta se cierra cuando
 *   el activo deja de cotizar (sesgo de supervivencia mitigado).
 */
import type { SessionDate } from '../market/providers/types';

/** Vela diaria mínima que consume el motor. `Bar`/`AdjustedBar` del dominio de mercado son asignables. */
export interface EngineBar {
  /** Fecha de la sesión, 'YYYY-MM-DD'. */
  date: SessionDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Costes de ejecución, configurables por backtest. */
export interface CostConfig {
  /** Comisión proporcional sobre el nominal, en fracción (0,0005 = 0,05 %). */
  commissionPct: number;
  /** Comisión mínima por ejecución, en la moneda de la cuenta. */
  commissionMin: number;
  /** Slippage en puntos básicos, siempre en contra del operador. */
  slippageBp: number;
  /** Spread en puntos básicos, siempre en contra del operador. */
  spreadBp: number;
}

/** Costes por defecto del plan: 0,05 % (mín. 1 USD), 5 pb de slippage, 2 pb de spread. */
export const DEFAULT_COSTS: CostConfig = {
  commissionPct: 0.0005,
  commissionMin: 1,
  slippageBp: 5,
  spreadBp: 2,
};

/** Capital inicial por defecto: 10 000 USD. */
export const DEFAULT_INITIAL_CASH = 10_000;

/** Riesgo por operación por defecto: 1 % del capital (rango admitido 0,5–1 %). */
export const DEFAULT_RISK_PER_TRADE = 0.01;
export const MIN_RISK_PER_TRADE = 0.005;
export const MAX_RISK_PER_TRADE = 0.01;

/** Máximo de posiciones simultáneas por defecto. */
export const DEFAULT_MAX_POSITIONS = 5;

/** Miembro del universo con su ventana de cotización. */
export interface UniverseMember {
  ticker: string;
  /** Primera sesión cotizada (inclusive). Sin límite si se omite. */
  listedFrom?: SessionDate;
  /**
   * Última sesión cotizada (inclusive). Pasada esta fecha el activo está
   * dado de baja: deja de recibir señales y una posición abierta se cierra
   * en el cierre de su última vela disponible.
   */
  listedUntil?: SessionDate;
}

/** Parámetros numéricos de una estrategia (los mismos que explora la rejilla de sensibilidad). */
export type StrategyParams = Record<string, number>;

/**
 * Vista truncada de las velas de un activo: solo las visibles hasta la vela
 * actual (inclusive). Cualquier acceso fuera de [0, length) lanza
 * `LookAheadError`: es la barrera anti look-ahead del motor.
 */
export interface BarWindow {
  /** Número de velas visibles; los índices válidos son 0..length-1. */
  readonly length: number;
  /** Fecha de la última vela visible, o null si el activo aún no ha cotizado. */
  readonly lastDate: SessionDate | null;
  /** Vela i-ésima (0 = la más antigua visible). Lanza `LookAheadError` si i >= length. */
  at(index: number): EngineBar;
  /** Vela `offset` posiciones atrás desde la última (0 = última visible). */
  back(offset?: number): EngineBar;
  /** Última vela visible. Equivale a `back(0)`. */
  last(): EngineBar;
  /** Copia de las velas visibles, de antigua a reciente. */
  slice(): EngineBar[];
}

/** Error que lanza `BarWindow` ante un índice fuera del historial visible. */
export class LookAheadError extends RangeError {
  constructor(message: string) {
    super(message);
    this.name = 'LookAheadError';
  }
}

/** Opciones de una orden de compra emitida por la estrategia. */
export interface BuyOptions {
  /**
   * Precio de stop de protección. Si es válido (< precio de ejecución),
   * dimensiona la posición por riesgo: acciones = capital × riesgo /
   * (precio de ejecución − stop).
   */
  stop?: number;
  /** Objetivo de beneficios (take-profit). */
  target?: number;
}

/** Vista de solo lectura de una posición abierta, tal como la ve la estrategia. */
export interface PositionView {
  ticker: string;
  shares: number;
  /** Precio de ejecución de la entrada (ya incluye slippage y spread). */
  entryPrice: number;
  entryDate: SessionDate;
  stopPrice: number | null;
  targetPrice: number | null;
}

/**
 * Contexto que recibe `Strategy.onBar` en el cierre de cada sesión.
 * Solo expone información disponible hasta esa fecha.
 */
export interface StrategyContext {
  /** Fecha de la vela cuyo cierre se está procesando. */
  readonly date: SessionDate;
  /** Índice de la fecha en la línea temporal completa, incluido el calentamiento (0 = primera sesión). */
  readonly index: number;
  /**
   * true durante el calentamiento (fechas anteriores a `startDate`): la
   * estrategia recibe las velas para cebar sus indicadores pero las órdenes
   * que emita se descartan y no se abre ninguna posición.
   */
  readonly warmup: boolean;
  /** Efectivo disponible tras las operaciones del día. */
  readonly cash: number;
  /** Capital total (efectivo + valor de mercado de las posiciones) al cierre. */
  readonly equity: number;
  /** Tickers del universo que cotizan en esta fecha (orden alfabético). */
  tickers(): string[];
  /** Todos los tickers del universo, coticen hoy o no (orden alfabético). */
  universeTickers(): string[];
  /** true si el ticker forma parte del universo y cotiza en esta fecha. */
  isListed(ticker: string): boolean;
  /**
   * Velas del ticker hasta hoy inclusive. Para un miembro del universo que
   * aún no cotiza (o ya no) la vista está vacía. Lanza si el ticker no es
   * del universo.
   */
  bars(ticker: string): BarWindow;
  /** Posición abierta en el ticker, o null. */
  position(ticker: string): PositionView | null;
  /** Posiciones abiertas (copia de las vistas). */
  positions(): PositionView[];
  /**
   * Orden de compra a mercado para la próxima apertura del activo. Se
   * descarta si el ticker no cotiza en esta fecha, si ya hay posición
   * abierta en él o si se alcanzó el máximo de posiciones al ejecutarla.
   */
  buy(ticker: string, options?: BuyOptions): void;
  /** Orden de venta de toda la posición para la próxima apertura del activo. */
  sell(ticker: string): void;
  /** Mueve el stop de la posición abierta; efectivo desde la próxima vela. */
  setStop(ticker: string, price: number): void;
  /** Mueve el objetivo de la posición abierta; efectivo desde la próxima vela. */
  setTarget(ticker: string, price: number): void;
}

/** Estrategia ejecutable por el motor. */
export interface Strategy {
  /** Se llama una vez antes de la primera vela, con los parámetros del run. */
  init(params: StrategyParams): void;
  /** Se llama en el cierre de cada sesión, con las velas visibles hasta ella. */
  onBar(context: StrategyContext): void;
}

/** Motivo de cierre de una operación. */
export type ExitReason =
  /** Orden de venta de la estrategia, ejecutada en la siguiente apertura. */
  | 'signal'
  /** Stop de protección tocado intrabarra (prioritario si también se tocó el objetivo). */
  | 'stop'
  /** Objetivo de beneficios tocado intrabarra. */
  | 'target'
  /** El activo dejó de cotizar o sus datos terminan a mitad de la simulación. */
  | 'delisted'
  /** Cierre forzoso en la última vela de la simulación. */
  | 'end-of-data';

export const EXIT_REASONS: readonly ExitReason[] = [
  'signal',
  'stop',
  'target',
  'delisted',
  'end-of-data',
];

/** Una operación cerrada, con sus precios de ejecución y costes. */
export interface Trade {
  ticker: string;
  /** Fecha de la señal de entrada (cierre que generó la orden). */
  signalDate: SessionDate;
  /** Fecha de ejecución de la entrada (apertura de la vela siguiente). */
  entryDate: SessionDate;
  /** Precio de ejecución de la entrada (apertura + slippage + spread). */
  entryPrice: number;
  exitDate: SessionDate;
  /** Precio de ejecución de la salida (base − slippage − spread). */
  exitPrice: number;
  shares: number;
  /** Comisión total pagada (entrada + salida), en la moneda de la cuenta. */
  commission: number;
  /** Coste monetario del slippage y el spread (entrada + salida). */
  slippage: number;
  /** (exitPrice − entryPrice) × shares, antes de comisiones. */
  grossPnl: number;
  /** grossPnl − commission. */
  pnl: number;
  exitReason: ExitReason;
}

/** Punto diario de la curva de capital, marcado al cierre de cada sesión. */
export interface EquityPoint {
  date: SessionDate;
  /** Efectivo tras las operaciones del día. */
  cash: number;
  /** cash + valor de mercado de las posiciones a cierre conocido. */
  equity: number;
  /** Número de posiciones abiertas al cierre. */
  positions: number;
}

/** Entrada del motor de backtest. */
export interface BacktestInput {
  strategy: Strategy;
  /** Parámetros para `strategy.init`. */
  params?: StrategyParams;
  /**
   * Velas por ticker, en orden ascendente de fecha. El motor las copia y
   * valida (orden, unicidad, precios finitos positivos, high >= low); las
   * anteriores a `startDate` sirven de calentamiento visible para la
   * estrategia, las posteriores a `endDate` se descartan.
   */
  bars: Record<string, readonly EngineBar[]>;
  /**
   * Universo con ventanas de cotización. Si se omite, cada ticker de `bars`
   * cotiza durante todo el periodo. Los tickers de `bars` que no estén en
   * el universo se ignoran.
   */
  universe?: readonly UniverseMember[];
  /** Capital inicial en la moneda de la cuenta (def. 10 000). */
  initialCash?: number;
  /** Costes de ejecución (se fusionan con `DEFAULT_COSTS`). */
  costs?: Partial<CostConfig>;
  /**
   * Fracción del capital arriesgada por operación, entre 0,005 y 0,01
   * (def. 0,01). Solo aplica a órdenes con stop válido; sin stop la
   * posición se dimensiona como un slot de `equity / maxPositions`.
   */
  riskPerTrade?: number;
  /** Máximo de posiciones simultáneas (def. 5). */
  maxPositions?: number;
  /**
   * Primera fecha operable (inclusive). Las sesiones anteriores son de
   * calentamiento: la estrategia las ve (`context.warmup === true`) pero
   * no puede abrir operaciones ni aparecen en la curva de capital.
   */
  startDate?: SessionDate;
  /** Última fecha de la simulación (inclusive); las velas posteriores se descartan. */
  endDate?: SessionDate;
}

/** Resultado del backtest: operaciones cerradas y curva de capital diaria. */
export interface BacktestResult {
  /** Operaciones cerradas en orden de salida. */
  trades: Trade[];
  /** Curva de capital diaria desde `startDate` (o la primera sesión). */
  equityCurve: EquityPoint[];
  initialCash: number;
  /** Último valor de la curva (igual al capital inicial si no hubo sesiones). */
  finalEquity: number;
}
