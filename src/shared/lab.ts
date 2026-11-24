/**
 * Laboratorio de estrategias — contrato compartido.
 *
 * Dos piezas que cierran el recorrido «idea → backtest → prueba en vivo»:
 *
 * 1. Generador con IA: el usuario describe una idea en lenguaje natural y
 *    la CLI de IA que ya tiene instalada (Claude Code, Codex…) la traduce
 *    al lenguaje de reglas seguro (`strategyRules.ts`). El proceso
 *    principal valida el resultado con el mismo analizador que usa el
 *    motor: una regla que no compila nunca llega a la interfaz como válida.
 * 2. Prueba en vivo (forward test): una versión congelada de la estrategia
 *    corre con capital ficticio desde una fecha fija sobre las velas
 *    reales que van llegando. El resultado se recalcula repitiendo el
 *    motor desde esa fecha, así no hay forma de ver el futuro ni de
 *    retocar las reglas a posteriori.
 */
type SessionDate = string;
import type { StrategyMetricsSummary, StrategyParameterRange, StrategyRules } from './strategy';

// ---------------------------------------------------------------------------
// Generador con IA
// ---------------------------------------------------------------------------

export const LAB_IDEA_MIN_LENGTH = 8;
export const LAB_IDEA_MAX_LENGTH = 2_000;
export const LAB_FEEDBACK_MAX_LENGTH = 1_000;
export const LAB_MAX_MARKETS = 12;

/** Borrador de estrategia propuesto por la IA (aún no guardado). */
export interface GeneratedStrategy {
  name: string;
  hypothesis: string;
  markets: string[];
  rules: StrategyRules;
  parameters: Record<string, number>;
  parameterRanges: Record<string, StrategyParameterRange>;
  /** Régimen en el que debería funcionar, en texto libre. */
  regime: string;
  /** Explicación breve en lenguaje llano de qué hace y por qué. */
  explanation: string;
  /** Riesgos o casos en que fallará. */
  risks: string[];
}

export interface LabGenerateRequest {
  /** La idea del usuario en lenguaje natural. */
  idea: string;
  /** Velas con que operará: '1h' admite reglas por sesión. Por defecto '1d'. */
  timeframe?: '1d' | '1h';
  /** Borrador anterior cuando se pide una iteración. */
  previous?: GeneratedStrategy;
  /** Lo que el usuario quiere cambiar del borrador anterior. */
  feedback?: string;
}

export type LabGenerateFailure =
  /** No hay ninguna CLI de IA instalada y con sesión. */
  | 'sin-motor'
  /** La CLI falló (sesión, cuota, tiempo de espera…). */
  | 'motor-error'
  /** La IA respondió pero no con reglas válidas tras los reintentos. */
  | 'respuesta-invalida';

export type LabGenerateResult =
  | {
      ok: true;
      draft: GeneratedStrategy;
      /** Motor que generó el borrador ('Claude Code', 'OpenAI Codex'…). */
      engine: string;
      /** Intentos usados (1 si salió válido a la primera). */
      attempts: number;
    }
  | { ok: false; reason: LabGenerateFailure; message: string; engine: string | null };

/** Motor de IA que usará el laboratorio. */
export interface LabEngineStatus {
  available: boolean;
  /** Nombre visible del motor elegido; null si no hay ninguno. */
  label: string | null;
  /** Qué hacer si no hay motor. */
  hint: string | null;
}

// ---------------------------------------------------------------------------
// Prueba histórica de 1 hora
// ---------------------------------------------------------------------------

export const LAB_HISTORY_DAYS = [365, 730] as const;
export type LabHistoryDays = (typeof LAB_HISTORY_DAYS)[number];

export interface LabBacktestRequest {
  strategyId: number;
  /** Histórico en días (1 o 2 años). */
  days: LabHistoryDays;
}

export type LabSessionId = 'tokio' | 'londres' | 'nueva-york' | 'fuera';

export interface LabSessionStats {
  session: LabSessionId;
  trades: number;
  /** Resultado sumado de las operaciones que entraron en esa sesión. */
  pnl: number;
  winRate: number | null;
}

export interface LabBacktestResult {
  timeframe: '1h';
  ticker: string;
  /** Primera y última vela operables (ISO UTC). */
  desde: string;
  hasta: string;
  bars: number;
  initialCash: number;
  totalReturn: number;
  annualizedReturn: number | null;
  /** Peor caída desde máximos, en fracción positiva. */
  maxDrawdown: number;
  tradeCount: number;
  winRate: number | null;
  /** Comprar y mantener el mismo activo en el mismo periodo. */
  buyAndHold: number | null;
  bySession: LabSessionStats[];
  /** Curva muestreada para dibujar (capital y comprar y esperar). */
  curve: { date: string; equity: number; benchmark: number | null }[];
  /** Avisos honestos (pocas operaciones, poco histórico…). */
  warnings: string[];
  /** Resumen que se guarda en la ficha de la estrategia. */
  summary: StrategyMetricsSummary;
}

// ---------------------------------------------------------------------------
// Veredicto en una frase
// ---------------------------------------------------------------------------

export type LabVerdictLevel = 'sin-operaciones' | 'pierde' | 'peor' | 'dudosa' | 'prometedora';

export interface LabVerdict {
  level: LabVerdictLevel;
  /** 'bad' no conviene lanzarla, 'warn' con cautela, 'good' merece la prueba en vivo. */
  tone: 'bad' | 'warn' | 'good';
  title: string;
  text: string;
}

export interface LabVerdictInput {
  /** Resultado total del periodo, en fracción. */
  total: number | null;
  /** Comprar y esperar el mismo activo, en fracción. */
  benchmark: number | null;
  trades: number;
  /** Activo legible («EUR/USD»). */
  asset: string;
}

const pctText = (v: number): string =>
  `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v * 100)
    .toFixed(1)
    .replace('.', ',')} %`;

/**
 * Traduce las cifras de una prueba histórica a una conclusión para alguien
 * que empieza: ¿gana?, ¿gana más que no hacer nada?, ¿es suerte?
 */
export function labVerdict(input: LabVerdictInput): LabVerdict {
  const { total, benchmark, trades, asset } = input;
  if (trades === 0 || total === null) {
    return {
      level: 'sin-operaciones',
      tone: 'bad',
      title: 'No ha hecho ninguna operación',
      text: 'Sus condiciones casi nunca se cumplen. Cambia la idea o pide reglas menos estrictas.',
    };
  }
  if (total < 0) {
    return {
      level: 'pierde',
      tone: 'bad',
      title: 'Esta idea pierde dinero',
      text: `Habría perdido ${pctText(total).replace('−', '')}${
        benchmark !== null ? ` (comprar ${asset} y esperar: ${pctText(benchmark)})` : ''
      }. No la lances: prueba otra idea o pide cambios.`,
    };
  }
  if (benchmark !== null && total < benchmark) {
    return {
      level: 'peor',
      tone: 'warn',
      title: 'Gana, pero menos que no hacer nada',
      text: `Gana ${pctText(total)}, pero comprar ${asset} y esperar daba ${pctText(benchmark)}. Así no compensa el esfuerzo.`,
    };
  }
  if (trades < 30) {
    return {
      level: 'dudosa',
      tone: 'warn',
      title: 'Gana, pero puede ser suerte',
      text: `Gana ${pctText(total)} con solo ${trades} operaciones. Pruébala en vivo para ver si se repite.`,
    };
  }
  return {
    level: 'prometedora',
    tone: 'good',
    title: 'Esta idea gana',
    text: `Gana ${pctText(total)} en ${trades} operaciones${
      benchmark !== null ? `, más que comprar ${asset} y esperar (${pctText(benchmark)})` : ''
    }. Siguiente paso: pruébala en vivo con dinero ficticio.`,
  };
}

export function isLabBacktestRequest(v: unknown): v is LabBacktestRequest {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== 'strategyId' && k !== 'days')) return false;
  return (
    typeof o.strategyId === 'number' &&
    Number.isInteger(o.strategyId) &&
    o.strategyId > 0 &&
    (o.days === 365 || o.days === 730)
  );
}

// ---------------------------------------------------------------------------
// Prueba en vivo
// ---------------------------------------------------------------------------

export const FORWARD_STATUSES = ['activa', 'detenida'] as const;
export type ForwardStatus = (typeof FORWARD_STATUSES)[number];

export const FORWARD_DEFAULT_CASH = 10_000;
export const FORWARD_MIN_CASH = 1_000;
export const FORWARD_MAX_CASH = 10_000_000;

export interface ForwardTest {
  id: number;
  strategyId: number;
  strategyName: string;
  /** Versión congelada al lanzar. */
  version: number;
  /** Primera sesión que cuenta (las órdenes se ejecutan desde su apertura). */
  startDate: SessionDate;
  initialCash: number;
  benchmark: string;
  markets: string[];
  status: ForwardStatus;
  stoppedAt: string | null;
  createdAt: string;
}

export interface ForwardTrade {
  ticker: string;
  side: 'largo' | 'corto';
  entryDate: SessionDate;
  entryPrice: number;
  exitDate: SessionDate;
  exitPrice: number;
  shares: number;
  pnl: number;
  exitReason: string;
}

export interface ForwardPosition {
  ticker: string;
  side: 'largo' | 'corto';
  shares: number;
  entryDate: SessionDate;
  entryPrice: number;
  lastClose: number;
  unrealizedPnl: number;
  stopPrice: number | null;
  targetPrice: number | null;
}

export interface ForwardPendingOrder {
  ticker: string;
  kind: 'buy' | 'sell' | 'short' | 'cover';
}

export interface ForwardCurvePoint {
  date: SessionDate;
  /** Capital de la estrategia al cierre. */
  equity: number;
  /** Mismo capital invertido en el benchmark el día de inicio; null sin datos. */
  benchmark: number | null;
}

/** Fila del tablero de pruebas en vivo. */
export interface ForwardSummary {
  test: ForwardTest;
  /** Último cierre evaluado; null si todavía no hay ninguna sesión. */
  asOf: SessionDate | null;
  sessions: number;
  equity: number;
  /** Rentabilidad desde el inicio, en fracción (0,05 = 5 %). */
  returnPct: number;
  benchmarkReturnPct: number | null;
  /** Peor caída desde máximos, en fracción positiva. */
  maxDrawdownPct: number;
  tradeCount: number;
  winRate: number | null;
  openPositions: number;
  /** Curva normalizada para la miniatura (capital / inicial). */
  spark: number[];
  /** Rentabilidad anual que prometía el último backtest; null si no hay. */
  backtestAnnualPct: number | null;
  /** 'real' con velas de mercado; 'simulated' con el proveedor simulado. */
  dataKind: 'real' | 'simulated';
  /** Motivo si no se pudo calcular (sin datos, reglas inválidas…). */
  error: string | null;
}

/** Detalle completo de una prueba en vivo. */
export interface ForwardDetail extends ForwardSummary {
  curve: ForwardCurvePoint[];
  trades: ForwardTrade[];
  positions: ForwardPosition[];
  pendingOrders: ForwardPendingOrder[];
}

export interface ForwardStartRequest {
  strategyId: number;
  initialCash?: number;
}

// ---------------------------------------------------------------------------
// Guardas de entrada IPC
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isText = (v: unknown, min: number, max: number): v is string =>
  typeof v === 'string' && v.trim().length >= min && v.length <= max;

const isNumberRecord = (v: unknown): v is Record<string, number> =>
  isRecord(v) && Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n));

export function isGeneratedStrategy(v: unknown): v is GeneratedStrategy {
  if (!isRecord(v)) return false;
  if (!isText(v.name, 1, 120) || !isText(v.hypothesis, 0, 4_000)) return false;
  if (!Array.isArray(v.markets) || v.markets.length > LAB_MAX_MARKETS) return false;
  if (!v.markets.every((m) => isText(m, 1, 64))) return false;
  if (!isRecord(v.rules)) return false;
  for (const key of ['entry', 'exit', 'stop', 'target'] as const) {
    if (!isText(v.rules[key], 0, 500)) return false;
  }
  for (const key of ['entryShort', 'exitShort'] as const) {
    if (key in v.rules && v.rules[key] !== undefined && !isText(v.rules[key], 0, 500)) {
      return false;
    }
  }
  if (!isNumberRecord(v.parameters)) return false;
  if (!isRecord(v.parameterRanges)) return false;
  for (const range of Object.values(v.parameterRanges)) {
    if (!isNumberRecord(range)) return false;
  }
  if (!isText(v.regime, 0, 500) || !isText(v.explanation, 0, 4_000)) return false;
  if (!Array.isArray(v.risks) || !v.risks.every((r) => isText(r, 0, 500))) return false;
  return true;
}

export function isLabGenerateRequest(v: unknown): v is LabGenerateRequest {
  if (!isRecord(v)) return false;
  if (
    Object.keys(v).some(
      (k) => k !== 'idea' && k !== 'previous' && k !== 'feedback' && k !== 'timeframe',
    )
  ) {
    return false;
  }
  if (v.timeframe !== undefined && v.timeframe !== '1d' && v.timeframe !== '1h') return false;
  if (!isText(v.idea, LAB_IDEA_MIN_LENGTH, LAB_IDEA_MAX_LENGTH)) return false;
  if (v.previous !== undefined && !isGeneratedStrategy(v.previous)) return false;
  if (v.feedback !== undefined && !isText(v.feedback, 1, LAB_FEEDBACK_MAX_LENGTH)) return false;
  return true;
}

export function isForwardId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

export function isForwardStartRequest(v: unknown): v is ForwardStartRequest {
  if (!isRecord(v)) return false;
  if (Object.keys(v).some((k) => k !== 'strategyId' && k !== 'initialCash')) return false;
  if (!isForwardId(v.strategyId)) return false;
  if (v.initialCash !== undefined) {
    if (typeof v.initialCash !== 'number' || !Number.isFinite(v.initialCash)) return false;
    if (v.initialCash < FORWARD_MIN_CASH || v.initialCash > FORWARD_MAX_CASH) return false;
  }
  return true;
}
