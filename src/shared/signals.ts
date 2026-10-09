/**
 * Dominio de señales informativas (fase 4) — contrato compartido.
 *
 * El motor de `src/main/signals/` evalúa las estrategias 'activa' y 'paper'
 * al cerrarse cada vela, agrega sus propuestas por activo y pasa la
 * intención por la pasarela única del riesgo (`risk:submit-signal`). El
 * resultado se persiste en la tabla `signals` (migración 008) con la
 * trazabilidad completa: qué estrategias y versiones votaron, con qué
 * datos y qué decidió el motor. Si las estrategias se contradicen sobre el
 * mismo activo no hay señal: queda en el diario como 'contradiccion'.
 *
 * La app avisa pero no ejecuta: una señal aprobada solo abre una posición
 * en la cartera simulada (`risk_portfolio_positions`, fase 3).
 */

import type { RiskDecision, RiskDecisionStatus, SignalDirection } from './risk';
import type { StrategyStatus } from './strategy';

/** Estados de estrategia que emiten señal; el resto no se evalúa. */
export const SIGNAL_EMITTING_STRATEGY_STATUSES = [
  'activa',
  'paper',
] as const satisfies readonly StrategyStatus[];
export type SignalEmittingStrategyStatus = (typeof SIGNAL_EMITTING_STRATEGY_STATUSES)[number];

// ---------------------------------------------------------------------------
// Evaluación y agregación
// ---------------------------------------------------------------------------

/**
 * Propuesta de una estrategia sobre un activo al cierre de una vela. La
 * lista de votos se guarda con la señal (y con la entrada 'contradiccion'
 * del diario) para que cada señal sea auditable por versión.
 */
export interface SignalStrategyVote {
  strategyId: number;
  /** Nombre de la estrategia en el momento de la evaluación. */
  name: string;
  /** Versión vigente evaluada (las versiones son inmutables, fase 2). */
  version: number;
  direction: SignalDirection;
  /** Confianza declarada por la estrategia (0–1). */
  confidence: number;
  /** Motivo legible de la propuesta (p. ej. «cruce 50/200 alcista»). */
  reason: string;
}

/**
 * Datos con los que se evaluó: la ventana de velas y su procedencia, para
 * que cualquier señal se pueda reproducir contra el lote exacto que la
 * originó.
 */
export interface SignalDataUsed {
  /** Fecha de la vela cuyo cierre disparó la evaluación ('YYYY-MM-DD'). */
  barDate: string;
  /** Ventana de velas usada, ambos inclusive ('YYYY-MM-DD'). */
  desde: string;
  hasta: string;
  /** Número de velas de la ventana. */
  barCount: number;
  /** Lote del que proceden las velas (`data_batches.id`); null si no consta. */
  batchId: number | null;
  /** Versión limpia del lote (`data_batches.version`); null si va cruda. */
  batchVersion: number | null;
  /** Proveedor de las velas ('tiingo', 'simulado'…); null si no consta. */
  source: string | null;
}

// ---------------------------------------------------------------------------
// Señal persistida
// ---------------------------------------------------------------------------

/**
 * Señal emitida por el motor y guardada en `signals`. `decision` conserva
 * la respuesta completa de la pasarela (estado, tamaño, motivos); las
 * vetadas también se persisten: «sin señal» solo ocurre por contradicción
 * y va al diario, no a esta tabla.
 */
export interface Signal {
  id: number;
  ticker: string;
  direction: SignalDirection;
  /** Precio de entrada propuesto (> 0). */
  entry: number;
  stop: number | null;
  target: number | null;
  /**
   * Confianza agregada: la media de las estrategias que coinciden en la
   * dirección (0–1; los valores anómalos llegan vetados por el motor).
   */
  confidence: number;
  /** Motivo legible agregado de la señal. */
  reason: string;
  /** Estrategias y versiones que respaldan la señal. */
  strategies: SignalStrategyVote[];
  /** Ventana de datos con la que se evaluó. */
  dataUsed: SignalDataUsed;
  /** Decisión completa del motor de riesgo. */
  decision: RiskDecision;
  /** ISO 8601. */
  createdAt: string;
}

/** Tope del parámetro `limit` de `signals:list`. */
export const SIGNALS_LIST_MAX_LIMIT = 200;

/** Filtros de `signals:list`; todos opcionales y combinables. */
export interface SignalsListQuery {
  ticker?: string;
  /** Filtra por el estado de la decisión de riesgo. */
  decision?: RiskDecisionStatus;
  /** Señales respaldadas por una estrategia concreta. */
  strategyId?: number;
  /** Rango por fecha de la vela evaluada, ambos inclusive ('YYYY-MM-DD'). */
  desde?: string;
  hasta?: string;
  /** Máximo de resultados; tope `SIGNALS_LIST_MAX_LIMIT`. */
  limit?: number;
  /** Desplazamiento para paginar (≥ 0). */
  offset?: number;
}

/** Evento `signals:new`: se emitió una señal nueva (aprobada o vetada). */
export interface SignalNewEvent {
  signal: Signal;
}

/** Resultado del gancho de desarrollo `signals:evaluate-now`. */
export interface SignalEngineRunResult {
  /** Activos de la lista evaluados en la pasada. */
  tickers: number;
  /** Señales emitidas (aprobadas, reducidas o vetadas). */
  emitted: number;
  /** Activos sin señal por contradicción entre estrategias. */
  contradictions: number;
  /** ISO 8601. */
  at: string;
}

// ---------------------------------------------------------------------------
// Estado de evaluación por estrategia (panel, bloque «Estrategias»)
// ---------------------------------------------------------------------------

/** Resultado de la última evaluación de una estrategia sobre la vela. */
export const SIGNAL_STRATEGY_OUTCOMES = ['senal', 'sin-senal', 'vetada', 'error'] as const;
export type SignalStrategyOutcome = (typeof SIGNAL_STRATEGY_OUTCOMES)[number];

/** Fila del bloque «Estado por estrategia» del panel (`signals:strategies`). */
export interface SignalStrategyState {
  strategyId: number;
  name: string;
  /** Versión vigente evaluada. */
  version: number;
  status: StrategyStatus;
  /** Última vela evaluada ('YYYY-MM-DD'); null si nunca se evaluó. */
  lastBarDate: string | null;
  /** Instante de la última evaluación (ISO 8601). */
  lastEvaluatedAt: string | null;
  /** Resultado de la última evaluación; null si nunca se evaluó. */
  lastOutcome: SignalStrategyOutcome | null;
  /** Señal emitida en la última evaluación, si la hubo. */
  lastSignalId: number | null;
}

// ---------------------------------------------------------------------------
// Cartera simulada (panel: posiciones, drawdown y exposición)
// ---------------------------------------------------------------------------

/**
 * Posición de la cartera simulada con su marca de mercado. La abre una
 * señal aprobada con el tamaño que dio el motor de riesgo; nunca es una
 * posición real (`risk_portfolio_positions`, fase 3).
 */
export interface PaperPosition {
  id: number;
  ticker: string;
  direction: SignalDirection;
  /** Tamaño en unidades que asignó el motor de riesgo. */
  size: number;
  entry: number;
  /** Último cierre conocido; null si el activo no tiene velas. */
  markPrice: number | null;
  /** Resultado no realizado en la divisa de la cuenta; null sin marca. */
  pnl: number | null;
  /** Resultado no realizado en % sobre la entrada; null sin marca. */
  pnlPct: number | null;
  /** Sector para la exposición; null = desconocido. */
  sector: string | null;
  currency: string;
  /** Señal que abrió la posición; null si se sembró a mano (E2E). */
  signalId: number | null;
  /** Apertura (ISO 8601). */
  openedAt: string;
}

/** Una porción de exposición (por activo o por sector), en % del capital. */
export interface ExposureSlice {
  /** Ticker o nombre de sector ('desconocido' agrupa los sin clasificar). */
  key: string;
  /** Exposición nominal en la divisa de la cuenta. */
  notional: number;
  /** % del capital actual. */
  pct: number;
  /** Límite aplicable en % del capital (null cuando no hay). */
  limitPct: number | null;
}

/**
 * Vista de la cartera simulada para el panel (`risk:get-portfolio`):
 * posiciones abiertas con marca, drawdown frente a su límite y exposición
 * por activo y por sector.
 */
export interface PaperPortfolioOverview {
  /** Capital actual de la cartera simulada. */
  equity: number;
  /** Divisa de la cuenta (siempre 'USD' en esta fase). */
  currency: string;
  positions: PaperPosition[];
  /** Drawdown actual en % del capital (número positivo). */
  drawdownPct: number;
  /** Límite de drawdown configurado (%). */
  drawdownLimitPct: number;
  /** Pérdida del día en % del capital (0 si va en positivo). */
  dailyLossPct: number;
  dailyLossLimitPct: number;
  exposureByAsset: ExposureSlice[];
  exposureBySector: ExposureSlice[];
  /** Posiciones abiertas frente al máximo configurado. */
  openPositions: number;
  maxOpenPositions: number;
  /** Instante de la instantánea (ISO 8601). */
  updatedAt: string;
}
