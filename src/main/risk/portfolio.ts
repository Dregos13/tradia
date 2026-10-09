/**
 * Instantánea de la cartera simulada y medidas derivadas — Fase 3 (motor
 * de riesgo).
 *
 * Módulo puro sin dependencias de Electron ni de la base de datos: quien
 * evalúa señales (la pasarela del motor de riesgo) construye una
 * `PortfolioSnapshot` a partir de `risk_portfolio_positions`,
 * `risk_equity_history` y los metadatos de mercado, y las reglas de
 * `portfolioLimits.ts` operan solo sobre ella. La IA y las estrategias
 * ven una copia de solo lectura: nada de aquí escribe estado.
 *
 * Convenciones:
 * - Todos los porcentajes son puntos porcentuales del capital (2 = 2 %),
 *   en línea con `RiskLimits`.
 * - Las exposiciones son brutas (valor absoluto del nominal): un corto
 *   expone igual que un largo del mismo tamaño.
 * - Los periodos se computan en UTC: día natural, semana ISO que empieza
 *   en lunes y mes natural. La pérdida de un periodo se mide contra el
 *   último punto de capital registrado en el inicio del periodo o antes;
 *   si no hay ninguno previo, se usa el punto más antiguo disponible
 *   dentro del periodo (no se puede medir lo que no se registró).
 * - La correlación es Pearson sobre rendimientos diarios, en la ventana
 *   de `CORRELATION_WINDOW_DAYS` (60) días del contrato, alineando las
 *   colas de ambas series (los últimos valores son los más recientes).
 */

import { CORRELATION_WINDOW_DAYS, type SignalDirection } from '../../shared/risk';

// ---------------------------------------------------------------------------
// Universo de activos (docs/alcance.md §1)
// ---------------------------------------------------------------------------

/**
 * Tabla local de sectores del universo inicial (10 ETF + 15 acciones de
 * EE. UU. de docs/alcance.md §1). La guarda el módulo porque es dato
 * estático del dominio, no configurable por el usuario ni por la IA.
 * Todo el universo cotiza en USD.
 */
export const TRADIA_UNIVERSE_SECTORS: Readonly<Record<string, string>> = {
  // ETF de índice amplio.
  SPY: 'indice',
  QQQ: 'indice',
  DIA: 'indice',
  IWM: 'indice',
  VTI: 'indice',
  // ETF sectoriales.
  XLF: 'finanzas',
  XLK: 'tecnologia',
  XLE: 'energia',
  XLV: 'salud',
  // Renta fija.
  TLT: 'renta-fija',
  // Acciones de gran capitalización (sector GICS aproximado).
  AAPL: 'tecnologia',
  MSFT: 'tecnologia',
  NVDA: 'tecnologia',
  GOOGL: 'tecnologia',
  META: 'tecnologia',
  AVGO: 'tecnologia',
  AMD: 'tecnologia',
  AMZN: 'consumo-discrecional',
  HD: 'consumo-discrecional',
  JPM: 'finanzas',
  V: 'finanzas',
  XOM: 'energia',
  JNJ: 'salud',
  PG: 'consumo-basico',
  KO: 'consumo-basico',
};

/** Divisa de cotización de todo el universo inicial. */
export const UNIVERSE_CURRENCY = 'USD';

/** Clave de agrupación para posiciones sin sector conocido. */
export const UNKNOWN_SECTOR = 'desconocido';

// ---------------------------------------------------------------------------
// Tipos de la instantánea
// ---------------------------------------------------------------------------

/** Posición abierta de la cartera simulada. */
export interface PortfolioPosition {
  ticker: string;
  direction: SignalDirection;
  /** Precio de entrada (> 0). */
  entry: number;
  /** Tamaño en unidades (> 0). */
  size: number;
  /**
   * Precio actual de mercado para valorar el nominal; si falta se usa la
   * entrada (posición recién abierta o sin cotización fresca).
   */
  markPrice?: number;
  /** Sector y divisa; si faltan se resuelven contra el universo local. */
  sector?: string;
  currency?: string;
}

/** Punto de la curva de capital (`risk_equity_history`), instante ISO 8601. */
export interface EquityHistoryPoint {
  at: string;
  equity: number;
}

// ---------------------------------------------------------------------------
// Cartera simulada: filas persistidas (migraciones 007 y 009)
// ---------------------------------------------------------------------------

/** Por qué se cerró la posición simulada: 'stop' (protección) u 'objetivo'. */
export type PaperExitReason = 'stop' | 'objetivo';

/** Datos de apertura de una posición simulada (los fija la señal aprobada). */
export interface NewPaperPosition {
  ticker: string;
  direction: SignalDirection;
  /** Precio de entrada (> 0); el de la señal. */
  entry: number;
  stop: number | null;
  target: number | null;
  /** Tamaño en unidades que asignó la pasarela (`decision.size`). */
  size: number;
  /** Sector para la exposición; null = desconocido. */
  sector: string | null;
  currency: string;
  /** Señal que la abrió; null en las sembradas a mano (E2E). */
  signalId: number | null;
  /** Vela cuyo cierre emitió la señal ('YYYY-MM-DD'); null en las sembradas. */
  openedOnBar: string | null;
  openedAt: string;
}

/** Fila de `risk_portfolio_positions` ya leída. */
export interface PaperPositionRecord {
  id: number;
  ticker: string;
  direction: SignalDirection;
  entry: number;
  stop: number | null;
  target: number | null;
  size: number;
  sector: string | null;
  currency: string;
  signalId: number | null;
  openedOnBar: string | null;
  openedAt: string;
  closedAt: string | null;
  exit: number | null;
  exitReason: PaperExitReason | null;
}

/** Resultado de liquidar una posición: P&L realizado y capital resultante. */
export interface PaperCloseResult {
  position: PaperPositionRecord;
  exit: number;
  exitReason: PaperExitReason;
  /** Resultado realizado en la divisa de la cuenta. */
  pnl: number;
  /** Capital de la cartera tras anotar el resultado. */
  equity: number;
}

/** Petición de cierre simulado de una posición abierta. */
export interface PaperCloseRequest {
  positionId: number;
  exit: number;
  exitReason: PaperExitReason;
  /** Instante del cierre (ISO 8601); fija el punto de la curva de capital. */
  closedAt: string;
}

/**
 * Medidas de pérdida y drawdown de la cartera en el instante actual, ya
 * calculadas sobre la curva de capital: las compara el seguimiento de
 * posiciones (`signals/paper.ts`) con los límites vigentes.
 */
export interface PaperRiskState {
  equity: number;
  /** Pérdidas realizadas del día/semana/mes en % del capital (0 si va en positivo). */
  dailyLossPct: number;
  weeklyLossPct: number;
  monthlyLossPct: number;
  /** Caída del capital frente a su máximo histórico, en %. */
  drawdownPct: number;
}

/** Metadatos de un activo para los límites de exposición y liquidez. */
export interface InstrumentInfo {
  /** Sector para el límite sectorial; null = desconocido. */
  sector: string | null;
  /** Divisa de cotización (ISO 4217). */
  currency: string;
  /** Volumen medio diario de 20 días en unidades; null si no se conoce. */
  avgDailyVolume20d: number | null;
}

/**
 * Todo lo que necesitan las reglas de cartera para decidir sobre una
 * señal: posiciones abiertas, curva de capital, metadatos de activos y
 * rendimientos diarios recientes. La construye la pasarela; las reglas
 * no leen nada más.
 */
export interface PortfolioSnapshot {
  /** Instante de la evaluación (ISO 8601); fija los periodos día/semana/mes. */
  now: string;
  /** Capital actual de la cartera en la divisa de la cuenta. */
  equity: number;
  /** Posiciones abiertas (las cerradas no entran en la instantánea). */
  positions: PortfolioPosition[];
  /** Curva de capital histórica; se tolera cualquier orden. */
  equityHistory: EquityHistoryPoint[];
  /** Metadatos por ticker, incluido el de la señal si se conoce. */
  instruments: Record<string, InstrumentInfo>;
  /** Rendimientos diarios por ticker (más recientes al final). */
  dailyReturns: Record<string, readonly number[]>;
}

// ---------------------------------------------------------------------------
// Resolución de metadatos
// ---------------------------------------------------------------------------

/**
 * Metadatos de un ticker: primero los de la instantánea (dato fresco del
 * mercado), después la tabla local del universo y por último los valores
 * neutros (sector desconocido, USD, volumen desconocido).
 */
export function resolveInstrument(snapshot: PortfolioSnapshot, ticker: string): InstrumentInfo {
  const provided = snapshot.instruments[ticker];
  return {
    sector: provided?.sector ?? TRADIA_UNIVERSE_SECTORS[ticker] ?? null,
    currency: provided?.currency ?? UNIVERSE_CURRENCY,
    avgDailyVolume20d: provided?.avgDailyVolume20d ?? null,
  };
}

/** Sector efectivo de una posición (el suyo, el del universo o 'desconocido'). */
export function positionSector(snapshot: PortfolioSnapshot, position: PortfolioPosition): string {
  return position.sector ?? resolveInstrument(snapshot, position.ticker).sector ?? UNKNOWN_SECTOR;
}

/** Divisa efectiva de una posición (la suya o la del activo). */
export function positionCurrency(snapshot: PortfolioSnapshot, position: PortfolioPosition): string {
  return position.currency ?? resolveInstrument(snapshot, position.ticker).currency;
}

// ---------------------------------------------------------------------------
// Nominales y exposición
// ---------------------------------------------------------------------------

/** Nominal bruto de una posición (siempre ≥ 0 con entradas válidas). */
export function positionNotional(position: PortfolioPosition): number {
  const price = position.markPrice ?? position.entry;
  return Math.abs(position.size * price);
}

/** Suma de nominales brutos de las posiciones dadas. */
export function grossNotional(positions: readonly PortfolioPosition[]): number {
  return positions.reduce((total, p) => total + positionNotional(p), 0);
}

/**
 * Convierte un importe a % de un capital base. Con base no positiva, un
 * importe positivo equivale a exposición infinita (siempre supera el
 * límite) y uno nulo a 0 %.
 */
export function pctOfEquity(amount: number, equity: number): number {
  if (!Number.isFinite(amount)) return amount;
  if (equity > 0) return (amount / equity) * 100;
  return amount > 0 ? Infinity : 0;
}

/** Exposición bruta por clave (activo, sector o divisa), en % del capital. */
export function exposurePctBy(
  snapshot: PortfolioSnapshot,
  keyOf: (position: PortfolioPosition) => string,
): Map<string, number> {
  const exposure = new Map<string, number>();
  for (const position of snapshot.positions) {
    const key = keyOf(position);
    exposure.set(key, (exposure.get(key) ?? 0) + positionNotional(position));
  }
  for (const [key, amount] of exposure) {
    exposure.set(key, pctOfEquity(amount, snapshot.equity));
  }
  return exposure;
}

// ---------------------------------------------------------------------------
// Curva de capital: pérdidas por periodo y drawdown
// ---------------------------------------------------------------------------

export type LossPeriod = 'day' | 'week' | 'month';

const MS_PER_DAY = 86_400_000;

/**
 * Inicio UTC del periodo que contiene `iso`: medianoche del día, lunes de
 * la semana ISO o día 1 del mes. Devuelve null si la fecha no se parsea.
 */
export function periodStartUtc(iso: string, period: LossPeriod): Date | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), period === 'month' ? 1 : date.getUTCDate()),
  );
  if (period === 'week') {
    // ISO: lunes = 1 … domingo = 7; getUTCDay(): domingo = 0.
    const daysSinceMonday = (start.getUTCDay() + 6) % 7;
    start.setTime(start.getTime() - daysSinceMonday * MS_PER_DAY);
  }
  return start;
}

/**
 * Capital de referencia en un instante: el último punto registrado en él
 * o antes; si no hay ninguno, el más antiguo posterior (aproximación del
 * capital al inicio cuando la historia empieza tarde). null si la curva
 * está vacía.
 */
export function equityAtInstant(
  history: readonly EquityHistoryPoint[],
  iso: string,
): number | null {
  const instant = new Date(iso).getTime();
  if (Number.isNaN(instant)) return null;
  let before: EquityHistoryPoint | null = null;
  let earliest: EquityHistoryPoint | null = null;
  for (const point of history) {
    const at = new Date(point.at).getTime();
    if (Number.isNaN(at) || !Number.isFinite(point.equity)) continue;
    if (earliest === null || at < new Date(earliest.at).getTime()) earliest = point;
    if (at <= instant && (before === null || at > new Date(before.at).getTime())) before = point;
  }
  return (before ?? earliest)?.equity ?? null;
}

/**
 * Pérdida en % del capital de referencia desde el inicio del periodo
 * hasta el capital actual. Devuelve 0 cuando no hay referencia o el
 * capital no cayó (los límites vetan pérdidas, no ganancias).
 */
export function lossPctSince(
  history: readonly EquityHistoryPoint[],
  currentEquity: number,
  periodStartIso: string,
): number {
  const baseline = equityAtInstant(history, periodStartIso);
  if (baseline === null || baseline <= 0 || currentEquity >= baseline) return 0;
  return ((baseline - currentEquity) / baseline) * 100;
}

/**
 * Drawdown actual en %: caída del capital actual respecto al máximo
 * histórico de la curva (incluido el propio capital actual). 0 si no hay
 * historia válida.
 */
export function drawdownPct(history: readonly EquityHistoryPoint[], currentEquity: number): number {
  let peak = Number.isFinite(currentEquity) ? currentEquity : 0;
  for (const point of history) {
    if (Number.isFinite(point.equity) && point.equity > peak) peak = point.equity;
  }
  if (peak <= 0 || currentEquity >= peak) return 0;
  return ((peak - currentEquity) / peak) * 100;
}

// ---------------------------------------------------------------------------
// Correlación de Pearson
// ---------------------------------------------------------------------------

/** Muestras mínimas para que un coeficiente de Pearson sea significativo. */
export const CORRELATION_MIN_SAMPLES = 10;

/**
 * Coeficiente de Pearson entre las colas de dos series de rendimientos
 * (los últimos `window` valores, alineados por el más reciente).
 * Devuelve null cuando hay menos de `CORRELATION_MIN_SAMPLES` pares, la
 * ventana es menor de 2 o alguna serie tiene varianza cero: en esos casos
 * no hay evidencia para vetar por correlación.
 */
export function pearsonCorrelation(
  a: readonly number[],
  b: readonly number[],
  window: number = CORRELATION_WINDOW_DAYS,
): number | null {
  const n = Math.min(a.length, b.length, window);
  if (n < CORRELATION_MIN_SAMPLES) return null;
  const xs = a.slice(a.length - n);
  const ys = b.slice(b.length - n);

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    const x = xs[i]!;
    const y = ys[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    sumX += x;
    sumY += y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx <= 0 || syy <= 0) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  // Numericalmente puede quedar un pelo fuera de [-1, 1].
  return Math.max(-1, Math.min(1, r));
}

/**
 * Correlación «alineada» entre la candidata y una posición abierta: la de
 * Pearson con el signo ajustado por la dirección. Dos posiciones en la
 * misma dirección con rendimientos muy correlados suman riesgo (+r); en
 * direcciones opuestas una correlación alta diversifica (−r). Devuelve
 * null sin datos suficientes.
 */
export function alignedCorrelation(
  snapshot: PortfolioSnapshot,
  candidateTicker: string,
  candidateDirection: SignalDirection,
  position: PortfolioPosition,
): number | null {
  const candidateReturns = snapshot.dailyReturns[candidateTicker];
  const positionReturns = snapshot.dailyReturns[position.ticker];
  if (!candidateReturns || !positionReturns) return null;
  const r = pearsonCorrelation(candidateReturns, positionReturns);
  if (r === null) return null;
  return candidateDirection === position.direction ? r : -r;
}
