/**
 * Ficha de estrategia — Fase 2 («Estrategias y backtest honesto»).
 *
 * Modelo compartido entre el proceso principal (repositorio sobre la
 * migración 005), el preload y el renderer. La ficha es versionable: cada
 * edición crea la versión N+1 y conserva las anteriores; el estado vive
 * fuera de la versión porque cambiarlo solo anota el registro de cambios.
 *
 * Los guardas de entrada IPC que usan estos tipos están en
 * `src/shared/ipc.ts` junto al resto del contrato.
 */

/** Estados del ciclo de vida; coincide con el CHECK de `strategies.estado`. */
export const STRATEGY_STATUSES = [
  'investigacion',
  'paper',
  'activa',
  'degradada',
  'retirada',
] as const;
export type StrategyStatus = (typeof STRATEGY_STATUSES)[number];

/** Toda estrategia nueva nace «en investigación» (no hay transiciones automáticas). */
export const STRATEGY_INITIAL_STATUS: StrategyStatus = 'investigacion';

/** Tipos de entrada del registro de cambios. */
export const STRATEGY_CHANGELOG_KINDS = ['version', 'estado'] as const;
export type StrategyChangelogKind = (typeof STRATEGY_CHANGELOG_KINDS)[number];

export const STRATEGY_NAME_MAX_LENGTH = 120;
/** Tope por campo de texto largo (hipótesis y cada regla). */
export const STRATEGY_TEXT_MAX_LENGTH = 4_000;
export const STRATEGY_REGIME_MAX_LENGTH = 500;
export const STRATEGY_NOTE_MAX_LENGTH = 1_000;
export const STRATEGY_MAX_PARAMETERS = 32;
export const STRATEGY_MAX_MARKETS = 64;
export const STRATEGY_MARKET_MAX_LENGTH = 64;

/**
 * Reglas exactas de la ficha en texto legible. Lo que ejecuta el motor es
 * `parameters`; estos campos documentan la lógica para la biblioteca.
 * Son obligatorios los cuatro: si la estrategia no usa stop u objetivo se
 * dice explícitamente («Sin stop: sale solo por señal»).
 */
export interface StrategyRules {
  entry: string;
  exit: string;
  stop: string;
  target: string;
}

/** Rango de un parámetro para el mapa de sensibilidad del informe. */
export interface StrategyParameterRange {
  min: number;
  max: number;
  step: number;
}

/** Periodo de datos, ambos inclusive ('YYYY-MM-DD'). */
export interface StrategyPeriod {
  desde: string;
  hasta: string;
}

/**
 * Costes asumidos por la ficha. Los valores por defecto son los del plan:
 * comisión del 0,05 % del nominal con mínimo de 1 USD, slippage de 5 pb y
 * spread de 2 pb. Todos configurables al lanzar un backtest.
 */
export interface StrategyCosts {
  /** Comisión en % del nominal (0,05 = 0,05 %). */
  commissionPct: number;
  /** Comisión mínima por operación, en USD. */
  commissionMin: number;
  /** Deslizamiento en puntos básicos. */
  slippageBps: number;
  /** Spread en puntos básicos. */
  spreadBps: number;
}

export const DEFAULT_STRATEGY_COSTS: StrategyCosts = {
  commissionPct: 0.05,
  commissionMin: 1,
  slippageBps: 5,
  spreadBps: 2,
};

/**
 * Métricas resumen del backtest representativo de la versión. Las escribe
 * el servicio de backtest, nunca el usuario: es null hasta que haya una
 * ejecución guardada.
 */
export interface StrategyMetricsSummary {
  /** Rentabilidad total del periodo, en %. */
  totalReturnPct: number;
  /** Drawdown máximo, en % (número positivo). */
  maxDrawdownPct: number;
  /** Sharpe anualizado (√252 sobre rendimientos diarios); null si no aplica. */
  sharpe: number | null;
  /** Factor de beneficio; null representa ∞ (sin operaciones perdedoras). */
  profitFactor: number | null;
  /** Tasa de acierto en %; null si no hay operaciones. */
  winRatePct: number | null;
  /** Expectativa por operación en USD; null si no hay operaciones. */
  expectancy: number | null;
  maxLosingStreak: number;
  trades: number;
}

/** Ficha completa: la estrategia en una versión concreta. */
export interface Strategy {
  id: number;
  /** Hay una implementación registrada para ejecutar esta estrategia. */
  executable: boolean;
  /** Número de la versión mostrada (1, 2…). */
  version: number;
  name: string;
  /** Hipótesis económica: por qué debería funcionar. */
  hypothesis: string;
  rules: StrategyRules;
  /** Parámetros ejecutables de la versión (p. ej. { fast: 50, slow: 200 }). */
  parameters: Record<string, number>;
  /** Rangos por parámetro para el mapa de sensibilidad; puede ir vacío. */
  parameterRanges: Record<string, StrategyParameterRange>;
  /** Mercados o activos en los que se probó ('SPY', 'ETF sectoriales US'…). */
  markets: string[];
  /** Datos usados: periodo de entrenamiento y fuera de muestra. */
  trainingPeriod: StrategyPeriod | null;
  outOfSamplePeriod: StrategyPeriod | null;
  metricsSummary: StrategyMetricsSummary | null;
  /** Régimen de mercado en el que funciona ('tendencial', 'lateral'…). */
  regime: string;
  assumedCosts: StrategyCosts;
  status: StrategyStatus;
  /** Nota del cambio que creó esta versión (en v1, la del alta). */
  changeNote: string;
  /** Alta de la estrategia (ISO 8601). */
  createdAt: string;
  /** Último cambio de estado o de versión (ISO 8601). */
  updatedAt: string;
  /** Creación de la versión mostrada (ISO 8601). */
  versionCreatedAt: string;
}

/** Fila de la biblioteca: la versión vigente de cada estrategia. */
export interface StrategySummary {
  id: number;
  name: string;
  version: number;
  status: StrategyStatus;
  regime: string;
  markets: string[];
  metricsSummary: StrategyMetricsSummary | null;
  updatedAt: string;
}

/**
 * Entrada del registro de cambios. Hay una por cada versión creada
 * (kind 'version', con `version` rellena) y una por cada cambio de estado
 * (kind 'estado', con `fromStatus`/`toStatus` y `version` a null).
 */
export interface StrategyChangelogEntry {
  id: number;
  strategyId: number;
  kind: StrategyChangelogKind;
  version: number | null;
  fromStatus: StrategyStatus | null;
  toStatus: StrategyStatus | null;
  note: string;
  /** ISO 8601. */
  createdAt: string;
}

/**
 * Campos versionables de la ficha: cualquier cambio de estos crea una
 * versión nueva. `assumedCosts`, `parameterRanges` y los periodos son
 * opcionales en la entrada; los costes toman `DEFAULT_STRATEGY_COSTS`.
 */
export interface StrategyDraft {
  name: string;
  hypothesis: string;
  rules: StrategyRules;
  parameters: Record<string, number>;
  parameterRanges?: Record<string, StrategyParameterRange>;
  markets: string[];
  trainingPeriod?: StrategyPeriod | null;
  outOfSamplePeriod?: StrategyPeriod | null;
  regime: string;
  assumedCosts?: StrategyCosts;
}

/** Alta de estrategia: siempre crea la versión 1 en estado 'investigacion'. */
export interface CreateStrategyRequest extends StrategyDraft {
  /** Nota del alta en el registro; por defecto «Alta de la estrategia». */
  note?: string;
}

/**
 * Edición: `id` + `note` (obligatoria, explica qué cambió y por qué) más al
 * menos un campo versionable. Crea la versión N+1 y conserva las anteriores.
 */
export interface UpdateStrategyRequest extends Partial<StrategyDraft> {
  id: number;
  note: string;
}

/** Lectura de una ficha: la versión vigente o una concreta. */
export interface GetStrategyRequest {
  id: number;
  version?: number;
}

/**
 * Cambio de estado: anota el registro sin crear versión nueva. La nota es
 * opcional; si falta se genera «Cambio de estado: X → Y».
 */
export interface SetStrategyStatusRequest {
  id: number;
  status: StrategyStatus;
  note?: string;
}
