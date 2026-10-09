/**
 * Pruebas de estrés históricas 2008, 2020 y 2022 — Fase 2.
 *
 * Ejecuta una estrategia sobre las tres ventanas de crisis de los supuestos
 * del plan y devuelve, por cada una, la rentabilidad, el drawdown máximo,
 * el número de operaciones y la comparación con comprar y mantener el
 * benchmark (SPY), con la minicurva de capital que muestra la ficha.
 *
 * Datos: `StressDataSource` abstrae el origen de las velas (un
 * `MarketDataProvider`, el repositorio de mercado o cualquier función que
 * entregue velas ordenadas). `resolveStressSource` reproduce la regla del
 * plan: Tiingo si hay clave guardada en secrets y, si no, el proveedor
 * simulado determinista, que tiene historia desde el 2000-01-03.
 *
 * Calentamiento: cada ventana se alimenta con `warmupSessions` sesiones de
 * mercado anteriores a su inicio (def. 300, suficiente para la SMA(200) y
 * el lookback de momentum). El motor marca esas sesiones como
 * `warmup === true`: la estrategia ceba sus indicadores pero sus órdenes se
 * descartan, así que ninguna operación ni punto de la curva cae antes del
 * inicio oficial de la ventana.
 */
import { isTradingDay } from '../market/calendar';
import {
  createSimulatedProvider,
  createTiingoProvider,
  SIMULATED_PROVIDER_ID,
  TIINGO_SECRETS_KEY,
  type MarketDataProvider,
  type SessionDate,
  type SimulatedProviderOptions,
} from '../market/providers';
import type { StrategyCosts } from '../../shared/strategy';
import { runBacktest } from './engine';
import { computeMetrics } from './metrics';
import type { CostConfig, EngineBar, EquityPoint, Strategy, StrategyParams } from './types';

// ---------------------------------------------------------------------------
// Ventanas de crisis (supuestos del plan de fase)
// ---------------------------------------------------------------------------

/** Una ventana de estrés: periodo oficial de la crisis, ambas fechas inclusive. */
export interface CrisisWindow {
  /** Identificador estable ('2008' | '2020' | '2022'). */
  id: string;
  /** Nombre para mostrar en la ficha. */
  name: string;
  /** Primera fecha operable (el calentamiento llega antes). */
  desde: SessionDate;
  /** Última fecha de la ventana. */
  hasta: SessionDate;
}

/**
 * Las tres crisis de los supuestos:
 * - 2008: del máximo previo al colapso (2007-10-09) al suelo (2009-03-09).
 * - 2020: del máximo previo al covid (2020-02-19) al final del trimestre.
 * - 2022: todo el mercado bajista de la inflación (2022-01-03 → 2022-10-12).
 */
export const CRISIS_WINDOWS: readonly CrisisWindow[] = [
  { id: '2008', name: 'Crisis financiera 2008', desde: '2007-10-09', hasta: '2009-03-09' },
  { id: '2020', name: 'Choque del covid 2020', desde: '2020-02-19', hasta: '2020-06-30' },
  { id: '2022', name: 'Mercado bajista 2022', desde: '2022-01-03', hasta: '2022-10-12' },
];

/** Sesiones de calentamiento antes de cada ventana (cubre SMA(200) y el lookback de momentum). */
export const DEFAULT_STRESS_WARMUP_SESSIONS = 300;

/** Benchmark de la comparación comprar-y-mantener. */
export const DEFAULT_BENCHMARK_TICKER = 'SPY';

// ---------------------------------------------------------------------------
// Fuente de datos
// ---------------------------------------------------------------------------

/** Etiqueta de la fuente que muestra la ficha: datos simulados o reales. */
export type StressDataKind = 'simulated' | 'real';

/**
 * Origen de velas para las pruebas de estrés. Lo implementa un
 * `MarketDataProvider` (vía `stressSourceFromProvider`), el repositorio de
 * mercado o cualquier función que entregue velas diarias ordenadas.
 */
export interface StressDataSource {
  /** Identificador del origen ('tiingo', 'simulated', 'market-repository'…). */
  readonly id: string;
  /** 'real' con datos de mercado de verdad; 'simulated' con el proveedor simulado. */
  readonly kind: StressDataKind;
  /**
   * Velas diarias entre `desde` y `hasta` (ambas inclusive), ordenadas de
   * forma ascendente por fecha. Devuelve [] si no hay datos del ticker.
   */
  getBars(ticker: string, desde: SessionDate, hasta: SessionDate): Promise<EngineBar[]>;
}

/** Adapta un `MarketDataProvider` a `StressDataSource`; el id 'simulated' etiqueta datos simulados. */
export function stressSourceFromProvider(provider: MarketDataProvider): StressDataSource {
  return {
    id: provider.id,
    kind: provider.id === SIMULATED_PROVIDER_ID ? 'simulated' : 'real',
    getBars: (ticker, desde, hasta) => provider.getBars(ticker, desde, hasta),
  };
}

/** Fuente explícita para orígenes que no son un `MarketDataProvider` (p. ej. el repositorio). */
export function stressSourceFromGetter(
  id: string,
  kind: StressDataKind,
  getBars: (ticker: string, desde: SessionDate, hasta: SessionDate) => Promise<EngineBar[]>,
): StressDataSource {
  return { id, kind, getBars };
}

/** Mínimo del servicio secrets que necesita la resolución de la fuente. */
export interface StressSecretsLike {
  hasKey(provider: string): Promise<boolean>;
  getKey(provider: string): Promise<string | null>;
}

export interface StressSourceDeps {
  /** Servicio secrets del proceso principal; sin él siempre se usa el simulado. */
  secrets?: StressSecretsLike | null;
  /** fetch para Tiingo (def. la global del proceso principal). */
  fetch?: typeof globalThis.fetch;
  /** Reloj inyectable para ambos proveedores (def. Date.now). */
  now?: () => number;
  /** Opciones extra del proveedor simulado de reserva (p. ej. `seed`). */
  simulated?: SimulatedProviderOptions;
}

/**
 * La regla del plan: Tiingo si hay clave guardada en secrets (fuente
 * 'real') y, si no, el proveedor simulado (fuente 'simulated'), cuya
 * historia empieza en 2000-01-03 y cubre las tres crisis.
 */
export async function resolveStressSource(deps: StressSourceDeps = {}): Promise<StressDataSource> {
  const now = deps.now;
  if (deps.secrets && (await deps.secrets.hasKey(TIINGO_SECRETS_KEY))) {
    const secrets = deps.secrets;
    return stressSourceFromProvider(
      createTiingoProvider({
        fetch: deps.fetch ?? globalThis.fetch,
        getApiKey: () => secrets.getKey(TIINGO_SECRETS_KEY),
        now,
      }),
    );
  }
  return stressSourceFromProvider(
    createSimulatedProvider({ ...deps.simulated, now: deps.simulated?.now ?? now }),
  );
}

// ---------------------------------------------------------------------------
// Costes: de la ficha (en %) al motor (en fracción)
// ---------------------------------------------------------------------------

/**
 * Traduce los `assumedCosts` de la ficha (`StrategyCosts`, comisión en %)
 * a los `CostConfig` del motor (comisión en fracción): 0,05 % → 0,0005.
 * `slippageBps`/`spreadBps` y la comisión mínima viajan tal cual.
 */
export function costConfigFromAssumed(costs: Partial<StrategyCosts>): Partial<CostConfig> {
  const mapped: Partial<CostConfig> = {};
  if (costs.commissionPct !== undefined) mapped.commissionPct = costs.commissionPct / 100;
  if (costs.commissionMin !== undefined) mapped.commissionMin = costs.commissionMin;
  if (costs.slippageBps !== undefined) mapped.slippageBp = costs.slippageBps;
  if (costs.spreadBps !== undefined) mapped.spreadBp = costs.spreadBps;
  return mapped;
}

// ---------------------------------------------------------------------------
// Calentamiento
// ---------------------------------------------------------------------------

/**
 * Fecha de descarga que deja `sessions` sesiones de mercado antes de
 * `desde` como calentamiento (la propia `desde` no cuenta). Retrocede día a
 * día sobre el calendario NYSE, el mismo que usa el proveedor simulado.
 */
export function warmupStartDate(desde: SessionDate, sessions: number): SessionDate {
  if (!Number.isInteger(sessions) || sessions < 0) {
    throw new RangeError(`stress: 'warmupSessions' debe ser un entero >= 0 (${sessions})`);
  }
  let remaining = sessions;
  const day = new Date(`${desde}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime())) {
    throw new RangeError(`stress: fecha 'desde' inválida (${JSON.stringify(desde)})`);
  }
  while (remaining > 0) {
    day.setUTCDate(day.getUTCDate() - 1);
    if (isTradingDay(day.toISOString().slice(0, 10))) remaining--;
  }
  return day.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Ejecución
// ---------------------------------------------------------------------------

export interface StressTestInput {
  /** Factoría de la estrategia: cada crisis ejecuta una instancia nueva. */
  strategy: () => Strategy;
  /** Parámetros para `strategy.init` (la versión de la ficha). */
  params?: StrategyParams;
  /**
   * Mercados de la ficha: el universo del backtest. Vacío lanza RangeError.
   */
  markets: readonly string[];
  /** Origen de las velas (proveedor, repositorio o función). */
  source: StressDataSource;
  /** Ticker del benchmark comprar-y-mantener (def. 'SPY'). */
  benchmarkTicker?: string;
  /** Costes del motor (ya en fracción; usar `costConfigFromAssumed` para la ficha). */
  costs?: Partial<CostConfig>;
  initialCash?: number;
  riskPerTrade?: number;
  /** Máximo de posiciones (def. la del motor; momentum debe recibir topN). */
  maxPositions?: number;
  /** Sesiones de calentamiento antes de cada ventana (def. 300). */
  warmupSessions?: number;
  /** Ventanas a ejecutar (def. las tres crisis oficiales). */
  windows?: readonly CrisisWindow[];
}

/** Resultado de una estrategia en una ventana de crisis. */
export interface CrisisStressResult {
  /** La ventana oficial ejecutada (id, nombre y fechas). */
  crisis: CrisisWindow;
  /** Sesiones simuladas dentro de la ventana (puntos de la curva). */
  sessions: number;
  /** Rentabilidad total de la ventana en tanto por uno; null sin curva. */
  totalReturn: number | null;
  /** Drawdown máximo en tanto por uno (positivo); null si la curva nunca cae. */
  maxDrawdown: number | null;
  /** Operaciones cerradas en la ventana. */
  trades: number;
  /** Ticker del benchmark comprar-y-mantener. */
  benchmarkTicker: string;
  /**
   * Rentabilidad de comprar y mantener el benchmark en la ventana, en
   * tanto por uno (primer cierre → último cierre); null sin datos.
   */
  benchmarkReturn: number | null;
  /** Etiqueta de la fuente: 'simulated' o 'real'. */
  dataSource: StressDataKind;
  /** Identificador del origen concreto ('tiingo', 'simulated', 'market-repository'…). */
  providerId: string;
  /** Minicurva de capital de la ventana (sin puntos de calentamiento). */
  equityCurve: EquityPoint[];
}

export interface StressTestRun {
  benchmarkTicker: string;
  /** Fuente común a todas las ventanas de la ejecución. */
  dataSource: StressDataKind;
  providerId: string;
  /** Un resultado por ventana, en el orden de `windows`. */
  results: CrisisStressResult[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeWindows(windows: readonly CrisisWindow[] | undefined): CrisisWindow[] {
  const list = windows ?? CRISIS_WINDOWS;
  if (list.length === 0) {
    throw new RangeError('stress: hace falta al menos una ventana de crisis');
  }
  const seen = new Set<string>();
  for (const window of list) {
    for (const [field, value] of [
      ['desde', window.desde],
      ['hasta', window.hasta],
    ] as const) {
      if (typeof value !== 'string' || !ISO_DATE.test(value)) {
        throw new RangeError(
          `stress: '${field}' de la ventana '${window.id}' inválida (${String(value)})`,
        );
      }
    }
    if (window.desde > window.hasta) {
      throw new RangeError(
        `stress: ventana '${window.id}' invertida (${window.desde} > ${window.hasta})`,
      );
    }
    if (seen.has(window.id)) {
      throw new RangeError(`stress: ventana de crisis duplicada ('${window.id}')`);
    }
    seen.add(window.id);
  }
  return [...list];
}

/**
 * Rentabilidad de comprar y mantener en la ventana: del primer cierre
 * disponible en [desde, hasta] al último. Null si no hay ninguna vela.
 */
function buyAndHoldReturn(bars: readonly EngineBar[], window: CrisisWindow): number | null {
  const inside = bars.filter((b) => b.date >= window.desde && b.date <= window.hasta);
  if (inside.length === 0) return null;
  const first = inside[0]!.close;
  const last = inside[inside.length - 1]!.close;
  return first > 0 ? last / first - 1 : null;
}

/**
 * Ejecuta la estrategia sobre cada ventana de crisis. Las velas se piden
 * desde `warmupStartDate(window.desde)` para que los indicadores lleguen
 * cebados al inicio oficial: ninguna operación ni punto de la curva cae
 * antes de `window.desde` (lo garantiza el motor).
 *
 * Devuelve siempre un resultado por ventana, aunque la fuente no tenga
 * datos de ella (métricas a null y `sessions` a 0), para que la ficha
 * pueda mostrar la crisis como no ejecutable.
 */
export async function runStressTests(input: StressTestInput): Promise<StressTestRun> {
  if (typeof input?.strategy !== 'function') {
    throw new TypeError('stress: se espera una factoría de estrategia `strategy: () => Strategy`');
  }
  if (
    input.source === null ||
    typeof input.source !== 'object' ||
    typeof input.source.getBars !== 'function'
  ) {
    throw new TypeError('stress: se espera una fuente con getBars(ticker, desde, hasta)');
  }
  const markets = (input.markets ?? []).map((t) => t.trim().toUpperCase());
  if (markets.length === 0) {
    throw new RangeError('stress: hace falta al menos un mercado en `markets`');
  }
  const windows = normalizeWindows(input.windows);
  const benchmarkTicker = (input.benchmarkTicker ?? DEFAULT_BENCHMARK_TICKER).trim().toUpperCase();
  const warmupSessions = input.warmupSessions ?? DEFAULT_STRESS_WARMUP_SESSIONS;
  const { source } = input;

  const results: CrisisStressResult[] = [];
  for (const window of windows) {
    const desde = warmupStartDate(window.desde, warmupSessions);
    // Universo + benchmark (deduplicado): el benchmark puede no estar en
    // los mercados de la ficha y, si está, no se descarga dos veces.
    const tickers = [...new Set([...markets, benchmarkTicker])];
    const fetched = new Map<string, EngineBar[]>();
    for (const ticker of tickers) {
      fetched.set(ticker, await source.getBars(ticker, desde, window.hasta));
    }

    const bars: Record<string, readonly EngineBar[]> = {};
    const universe = markets.map((ticker) => {
      const barsOf = fetched.get(ticker) ?? [];
      bars[ticker] = barsOf;
      return { ticker };
    });

    const result = runBacktest({
      strategy: input.strategy(),
      params: input.params,
      bars,
      universe,
      initialCash: input.initialCash,
      costs: input.costs,
      riskPerTrade: input.riskPerTrade,
      maxPositions: input.maxPositions,
      startDate: window.desde,
      endDate: window.hasta,
    });
    const metrics = computeMetrics(result.equityCurve, result.trades);

    results.push({
      crisis: { ...window },
      sessions: result.equityCurve.length,
      totalReturn: metrics.totalReturn,
      maxDrawdown: metrics.maxDrawdown?.pct ?? (result.equityCurve.length ? 0 : null),
      trades: metrics.tradeCount,
      benchmarkTicker,
      benchmarkReturn: buyAndHoldReturn(fetched.get(benchmarkTicker) ?? [], window),
      dataSource: source.kind,
      providerId: source.id,
      equityCurve: result.equityCurve,
    });
  }

  return {
    benchmarkTicker,
    dataSource: source.kind,
    providerId: source.id,
    results,
  };
}
