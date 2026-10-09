/**
 * Informe de desviación real frente a backtest — Fase 5. Funciones puras.
 *
 * Compara lo que el paper trading hizo de verdad (`broker_orders`, migración
 * 010) con lo que el último backtest de cada estrategia prometía, por
 * periodo cerrado: semana de lunes a domingo o mes natural, siempre en el
 * calendario de America/New_York (las fechas 'YYYY-MM-DD' de la superficie
 * son días civiles de Nueva York, igual que las sesiones del mercado).
 *
 * Definiciones (las mismas en el lado real y en el esperado):
 * - Una «operación cerrada» es una señal con sus dos patas ejecutadas: la
 *   'entrada' (compra/venta de apertura) y la 'salida' (el OCO). Se
 *   atribuye al periodo que contiene la ejecución de la salida.
 * - Rentabilidad de una operación: (salida − entrada) / entrada × 100 con
 *   el signo del lado de la entrada (en un corto se invierte). La del
 *   periodo es la SUMA de las de sus operaciones: es la forma «por
 *   operación» que se compara con la expectativa.
 * - Esperado: `expectationFromReport` deriva la expectativa por operación
 *   en % (media de las rentabilidades por operación del backtest) y la
 *   tasa de acierto; esperado del periodo = expectativa × operaciones
 *   reales, tal como pide el plan.
 * - Desviación = real − esperado (puntos porcentuales). Fuera de margen
 *   cuando |desviación| > margenPp o el slippage medio de las patas
 *   ejecutadas supera maxSlippageBps.
 * - Un periodo solo informa cuando está CERRADO (su `hasta` ya pasó en
 *   Nueva York): el mes/semana en curso nunca genera fila ni alerta.
 */
import type {
  BrokerOrder,
  DeviationPeriod,
  DeviationReportRow,
} from '../../shared/broker';
import type { BacktestReport } from '../../shared/backtest';
import { nySessionDate } from '../market/calendar';

// ---------------------------------------------------------------------------
// Aritmética de periodos (días civiles de America/New_York)
// ---------------------------------------------------------------------------

/** Rango de fechas 'YYYY-MM-DD', ambas inclusive. */
export interface PeriodRange {
  desde: string;
  hasta: string;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad2 = (n: number): string => String(n).padStart(2, '0');

const isoDay = (utcMs: number): string => {
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
};

/** Día civil de Nueva York de un instante (ISO, ms o Date). */
export function nyDateOf(instant: string | number | Date): string {
  const ms =
    instant instanceof Date
      ? instant.getTime()
      : typeof instant === 'number'
        ? instant
        : Date.parse(instant);
  if (!Number.isFinite(ms)) throw new TypeError(`Instante no válido: ${String(instant)}`);
  return nySessionDate(ms);
}

/** Día civil de Nueva York de «ahora» en milisegundos epoch. */
export const nyToday = (nowMs: number): string => nySessionDate(nowMs);

const parseDay = (date: string): number => {
  const m = DATE_RE.exec(date);
  if (m === null) throw new TypeError(`Fecha inválida: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
};

/** Suma `delta` días civiles a una fecha 'YYYY-MM-DD'. */
export const addDays = (date: string, delta: number): string => isoDay(parseDay(date) + delta * DAY_MS);

const dayOfWeek = (date: string): number => new Date(parseDay(date)).getUTCDay();

/** Semana de lunes a domingo que contiene `nyDate`. */
export function weekRangeOf(nyDate: string): PeriodRange {
  const dow = dayOfWeek(nyDate); // 0 = domingo, 1 = lunes
  const desde = addDays(nyDate, dow === 0 ? -6 : 1 - dow);
  return { desde, hasta: addDays(desde, 6) };
}

/** Mes natural que contiene `nyDate`. */
export function monthRangeOf(nyDate: string): PeriodRange {
  const desde = `${nyDate.slice(0, 7)}-01`;
  // El último día del mes es el día 0 del mes siguiente.
  const year = Number(nyDate.slice(0, 4));
  const month = Number(nyDate.slice(5, 7));
  const hasta = isoDay(Date.UTC(year, month, 0));
  return { desde, hasta };
}

/** Rango del periodo ('semanal' | 'mensual') que contiene `nyDate`. */
export function periodRangeOf(period: DeviationPeriod, nyDate: string): PeriodRange {
  return period === 'semanal' ? weekRangeOf(nyDate) : monthRangeOf(nyDate);
}

/**
 * Un periodo solo informa cuando está cerrado: su último día es anterior
 * a hoy en Nueva York. La semana/mes en curso nunca genera fila ni alerta.
 */
export function isClosedPeriod(range: PeriodRange, todayNy: string): boolean {
  return range.hasta < todayNy;
}

// ---------------------------------------------------------------------------
// Operaciones cerradas a partir de broker_orders
// ---------------------------------------------------------------------------

/**
 * Una operación paper cerrada: entrada y salida ejecutadas de la misma
 * señal. La clave de emparejamiento es `senal_id` cuando consta y, si no,
 * la raíz del `clientOrderId` ('tradia-<señal>-<pata>'; en la semilla,
 * 'tradia-seed-…-<pata>').
 */
export interface ClosedTrade {
  /** `estrategia_id` de las patas; las órdenes sin estrategia no informan. */
  strategyId: number;
  /** Clave de la señal usada para emparejar ('s<id>' o raíz del client_order_id). */
  signalKey: string;
  ticker: string;
  /** Id local de la pata de entrada ejecutada. */
  entryOrderId: number;
  /** Id local de la pata de salida ejecutada. */
  exitOrderId: number;
  /** Rentabilidad de la operación en % con el signo del lado de entrada. */
  returnPct: number;
  /** Día civil de Nueva York de la ejecución de la salida (cierre). */
  closedAtNy: string;
  /** Slippage en pb de las patas que lo tienen (entradas y salidas). */
  slippageBps: number[];
}

const LEG_SUFFIX = /-(entrada|salida)$/;

const pairKey = (order: BrokerOrder): string =>
  order.signalId !== null ? `s${order.signalId}` : order.clientOrderId.replace(LEG_SUFFIX, '');

const isExecuted = (order: BrokerOrder): boolean =>
  order.status === 'ejecutada' &&
  order.execution.executedAt !== null &&
  order.execution.executedPrice !== null &&
  order.execution.executedPrice > 0;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Empareja las órdenes en operaciones cerradas. Solo cuentan pares
 * 'entrada'+'salida' ejecutados con precio; las patas sueltas, abiertas,
 * canceladas o rechazadas no son operaciones para el informe. Si una
 * señal tuviera más de una salida ejecutada se usa la más reciente.
 */
export function closedTradesFromOrders(orders: readonly BrokerOrder[]): ClosedTrade[] {
  const legs = new Map<string, { entry?: BrokerOrder; exit?: BrokerOrder }>();
  for (const order of orders) {
    if (order.leg === null || order.strategyId === null) continue;
    if (!isExecuted(order)) continue;
    const key = pairKey(order);
    const pair = legs.get(key) ?? {};
    if (order.leg === 'entrada') {
      if (pair.entry === undefined || order.id > pair.entry.id) pair.entry = order;
    } else if (pair.exit === undefined || order.id > pair.exit.id) {
      pair.exit = order;
    }
    legs.set(key, pair);
  }

  const trades: ClosedTrade[] = [];
  for (const [signalKey, pair] of legs) {
    const { entry, exit } = pair;
    if (entry === undefined || exit === undefined) continue;
    const entryPrice = entry.execution.executedPrice!;
    const exitPrice = exit.execution.executedPrice!;
    const sign = entry.side === 'buy' ? 1 : -1;
    const slippageBps = [entry.execution.slippageBps, exit.execution.slippageBps].filter(
      (v): v is number => v !== null,
    );
    trades.push({
      strategyId: entry.strategyId!,
      signalKey,
      ticker: entry.ticker,
      entryOrderId: entry.id,
      exitOrderId: exit.id,
      returnPct: ((exitPrice - entryPrice) / entryPrice) * 100 * sign,
      closedAtNy: nyDateOf(exit.execution.executedAt!),
      slippageBps,
    });
  }
  return trades.sort((a, b) => a.exitOrderId - b.exitOrderId);
}

// ---------------------------------------------------------------------------
// Expectativa desde el último backtest de la estrategia
// ---------------------------------------------------------------------------

/**
 * Lo que el último backtest promete por operación: la rentabilidad media
 * en % sobre el nominal de la posición y la tasa de acierto (0–1). Es la
 * base del «esperado» de cada periodo (expectativa × operaciones reales).
 */
export interface StrategyExpectation {
  /** Expectativa por operación en %; null si el backtest no la ofrece. */
  perTradeReturnPct: number | null;
  /** Tasa de acierto esperada (0–1); null si el backtest no la ofrece. */
  winRate: number | null;
  /** Versión de la ficha evaluada en el run (contexto); null si no consta. */
  backtestVersion: number | null;
  /** Id del run usado (contexto); null si no consta. */
  backtestRunId: number | null;
}

/** Expectativa vacía: se usa cuando la estrategia no tiene backtest. */
export const NO_EXPECTATION: StrategyExpectation = {
  perTradeReturnPct: null,
  winRate: null,
  backtestVersion: null,
  backtestRunId: null,
};

/**
 * Deriva la expectativa del último backtest. Con operaciones en el run,
 * la expectativa por operación es la media de sus rentabilidades en %
 * (misma definición que en el lado real: (salida − entrada)/entrada con
 * el signo de la entrada —en el backtest todo es largo—). Si el run no
 * trae la lista de operaciones se recurre a `metrics.expectancy`
 * normalizada por el capital inicial del run. La tasa de acierto sale de
 * las métricas y, si falta, de las operaciones. Null en todo si no hay run.
 */
export function expectationFromReport(report: BacktestReport | null): StrategyExpectation {
  if (report === null) return NO_EXPECTATION;

  let perTradeReturnPct: number | null = null;
  if (report.trades.length > 0) {
    const total = report.trades.reduce(
      (sum, trade) =>
        sum + ((trade.exitPrice - trade.entryPrice) / trade.entryPrice) * 100,
      0,
    );
    perTradeReturnPct = total / report.trades.length;
  } else if (
    report.metrics.expectancy !== null &&
    Number.isFinite(report.config.initialCash) &&
    report.config.initialCash > 0
  ) {
    perTradeReturnPct = (report.metrics.expectancy / report.config.initialCash) * 100;
  }

  let winRate = report.metrics.winRate;
  if (winRate === null && report.trades.length > 0) {
    winRate = report.trades.filter((trade) => trade.pnl > 0).length / report.trades.length;
  }

  return {
    perTradeReturnPct,
    winRate,
    backtestVersion: report.version,
    backtestRunId: report.id,
  };
}

// ---------------------------------------------------------------------------
// Construcción de las filas del informe
// ---------------------------------------------------------------------------

/** Márgenes y expectativas necesarios para una pasada del informe. */
export interface DeviationRowContext {
  /** Margen de desviación (± puntos porcentuales). */
  marginPp: number;
  /** Slippage medio máximo admitido (puntos básicos). */
  maxSlippageBps: number;
  /** Expectativa del último backtest por estrategia; NO_EXPECTATION si no hay. */
  expectationFor(strategyId: number): StrategyExpectation;
  /** Nombre visible de la estrategia (fallback razonable si no consta). */
  strategyNameFor(strategyId: number): string;
}

/**
 * Filas del informe: una por estrategia y periodo cerrado con al menos
 * una operación cerrada. Orden: `hasta` más reciente primero y, a igual
 * periodo, por estrategia. Sin operaciones cerradas no hay fila; sin
 * expectativa `expectedReturnPct`/`deviationPp`/`expectedWinRate` quedan
 * en null y el margen solo puede saltar por slippage.
 */
export function buildDeviationRows(
  trades: readonly ClosedTrade[],
  period: DeviationPeriod,
  todayNy: string,
  ctx: DeviationRowContext,
): DeviationReportRow[] {
  interface Bucket {
    range: PeriodRange;
    trades: number;
    returnPctSum: number;
    wins: number;
    slippage: number[];
  }
  const buckets = new Map<string, Bucket>();

  for (const trade of trades) {
    const range = periodRangeOf(period, trade.closedAtNy);
    if (!isClosedPeriod(range, todayNy)) continue;
    const key = `${trade.strategyId}|${range.desde}`;
    const bucket = buckets.get(key) ?? {
      range,
      trades: 0,
      returnPctSum: 0,
      wins: 0,
      slippage: [],
    };
    bucket.trades += 1;
    bucket.returnPctSum += trade.returnPct;
    if (trade.returnPct > 0) bucket.wins += 1;
    bucket.slippage.push(...trade.slippageBps);
    buckets.set(key, bucket);
  }

  const rows: DeviationReportRow[] = [];
  for (const [key, bucket] of buckets) {
    const strategyId = Number(key.slice(0, key.indexOf('|')));
    const expectation = ctx.expectationFor(strategyId);
    const realReturnPct = round2(bucket.returnPctSum);
    const realWinRate = round2(bucket.wins / bucket.trades);
    const avgSlippageBps =
      bucket.slippage.length === 0
        ? null
        : round2(bucket.slippage.reduce((a, b) => a + b, 0) / bucket.slippage.length);
    const expectedReturnPct =
      expectation.perTradeReturnPct === null
        ? null
        : round2(expectation.perTradeReturnPct * bucket.trades);
    const deviationPp =
      expectedReturnPct === null ? null : round2(realReturnPct - expectedReturnPct);
    const outOfMargin =
      (deviationPp !== null && Math.abs(deviationPp) > ctx.marginPp) ||
      (avgSlippageBps !== null && avgSlippageBps > ctx.maxSlippageBps);
    rows.push({
      strategyId,
      strategyName: ctx.strategyNameFor(strategyId),
      desde: bucket.range.desde,
      hasta: bucket.range.hasta,
      trades: bucket.trades,
      expectedReturnPct,
      realReturnPct,
      deviationPp,
      expectedWinRate: expectation.winRate,
      realWinRate,
      avgSlippageBps,
      outOfMargin,
    });
  }

  return rows.sort((a, b) => b.hasta.localeCompare(a.hasta) || a.strategyId - b.strategyId);
}
