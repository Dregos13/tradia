/**
 * Estado del escalado del dinero real (fase 7) — evaluación informativa.
 *
 * `live:scaling` responde con datos si los resultados reales respaldan
 * el backtest: las semanas cerradas dentro del margen del informe real
 * vs backtest (misma definición que `deviation.ts`, calculada sobre las
 * operaciones de `broker_orders_live`) y las operaciones reales
 * conciliadas. Umbrales del contrato: `LIVE_SCALING_MIN_WEEKS` (8) y
 * `LIVE_SCALING_MIN_TRADES` (30).
 *
 * En esta fase el estado NUNCA es accionable: 'elegible' solo marca la
 * evidencia para la evaluación de la fase 8; no existe ninguna vía para
 * subir los techos desde aquí.
 */
import { BROKER_ORDERS_MAX_LIMIT, type BrokerOrder } from '../../shared/broker';
import {
  LIVE_SCALING_MIN_TRADES,
  LIVE_SCALING_MIN_WEEKS,
  type LiveScalingStatus,
} from '../../shared/live';
import {
  NO_EXPECTATION,
  buildDeviationRows,
  closedTradesFromOrders,
  nyToday,
  type StrategyExpectation,
} from '../broker/deviation';
import type { DeviationMargins } from '../broker/deviationService';
import type { BrokerRepository } from '../broker/repository';
import type { LiveStore } from './service';

// ---------------------------------------------------------------------------
// Dependencias y superficie
// ---------------------------------------------------------------------------

export interface LiveScalingDeps {
  /** Repositorio de las órdenes reales (`broker_orders_live`). */
  repository: Pick<BrokerRepository, 'listOrders'>;
  /** Almacén del modo real (activación y límites confirmados). */
  store: Pick<LiveStore, 'getMode' | 'getLimits'>;
  /** Expectativa del último backtest por estrategia (broker/deviation). */
  expectationFor(strategyId: number): StrategyExpectation;
  /** Nombre visible de la estrategia; por defecto «Estrategia <id>». */
  strategyNameFor?(strategyId: number): string;
  /** Márgenes vigentes del informe real vs backtest (settings). */
  margins(): DeviationMargins;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Estado del escalado calculado ahora. Es una lectura pura: no escribe
 * nada ni permite cambiar los techos, que solo podrían subir en la fase 8
 * tras una evaluación fuera de la app.
 */
export function computeLiveScalingStatus(deps: LiveScalingDeps): LiveScalingStatus {
  const now = deps.now ?? (() => Date.now());
  const evaluatedAt = new Date(now()).toISOString();

  // Todas las órdenes reales ejecutadas (paginado por el tope del contrato).
  const orders: BrokerOrder[] = [];
  for (let offset = 0; ; offset += BROKER_ORDERS_MAX_LIMIT) {
    const page = deps.repository.listOrders({
      status: 'ejecutada',
      limit: BROKER_ORDERS_MAX_LIMIT,
      offset,
    });
    orders.push(...page);
    if (page.length < BROKER_ORDERS_MAX_LIMIT) break;
  }
  const trades = closedTradesFromOrders(orders);
  const liveTrades = trades.length;

  const activatedAt = deps.store.getMode().activado_en;
  const activatedMs = activatedAt === null ? Number.NaN : Date.parse(activatedAt);
  const liveWeeks = Number.isFinite(activatedMs)
    ? Math.max(0, Math.floor((now() - activatedMs) / WEEK_MS))
    : 0;

  // Semanas cerradas dentro del margen del informe real vs backtest: la
  // misma comparación por estrategia y periodo (semana NY, lunes a
  // domingo) que sirve a `deviation:report`, pero sobre la tabla live.
  const margins = deps.margins();
  const expectationCache = new Map<number, StrategyExpectation>();
  const rows = buildDeviationRows(trades, 'semanal', nyToday(now()), {
    marginPp: margins.marginPp,
    maxSlippageBps: margins.maxSlippageBps,
    expectationFor: (strategyId) => {
      let cached = expectationCache.get(strategyId);
      if (cached === undefined) {
        cached = deps.expectationFor(strategyId) ?? NO_EXPECTATION;
        expectationCache.set(strategyId, cached);
      }
      return cached;
    },
    strategyNameFor: (strategyId) =>
      deps.strategyNameFor?.(strategyId) ?? `Estrategia ${strategyId}`,
  });
  const rowsWithBase = rows.filter((row) => row.deviationPp !== null);
  const weeksInMargin = rowsWithBase.filter((row) => !row.outOfMargin).length;
  const deviationPct =
    rowsWithBase.length === 0
      ? null
      : round2(
          rowsWithBase.reduce((sum, row) => sum + row.realReturnPct, 0) -
            rowsWithBase.reduce((sum, row) => sum + (row.expectedReturnPct ?? 0), 0),
        );

  // Drawdown real: pico a valle del PnL acumulado en USD sobre el capital
  // escrito confirmado; null sin base (sin límites o sin operaciones).
  const limitsRow = deps.store.getLimits();
  const capitalUsd =
    limitsRow !== null && limitsRow.confirmados === 1 ? limitsRow.capital_usd : null;
  let drawdownPct: number | null = null;
  if (capitalUsd !== null && capitalUsd > 0 && liveTrades > 0) {
    const byId = new Map(orders.map((order) => [order.id, order]));
    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;
    for (const trade of trades) {
      const entry = byId.get(trade.entryOrderId);
      const entryNotional =
        entry === undefined ? 0 : entry.filledQuantity * (entry.execution.executedPrice ?? 0);
      cumulative += (trade.returnPct / 100) * entryNotional;
      peak = Math.max(peak, cumulative);
      maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
    }
    drawdownPct = round2((maxDrawdown / capitalUsd) * 100);
  }

  let state: LiveScalingStatus['state'];
  let reason: string;
  if (liveTrades === 0) {
    state = 'bloqueado';
    reason =
      'Escalado bloqueado · aún no hay operaciones reales conciliadas; ' +
      'esta fase limita el capital a los techos confirmados.';
  } else if (liveTrades >= LIVE_SCALING_MIN_TRADES && weeksInMargin >= LIVE_SCALING_MIN_WEEKS) {
    state = 'elegible';
    reason =
      `Elegible para evaluación en fase 8 · los resultados reales respaldan el ` +
      `backtest (${weeksInMargin} semanas dentro del margen, ${liveTrades} ` +
      'operaciones reales). Tradia no aumenta límites automáticamente.';
  } else {
    state = 'en-evidencia';
    const missing: string[] = [];
    if (liveTrades < LIVE_SCALING_MIN_TRADES) {
      missing.push(`${LIVE_SCALING_MIN_TRADES - liveTrades} operaciones reales`);
    }
    if (weeksInMargin < LIVE_SCALING_MIN_WEEKS) {
      missing.push(`${LIVE_SCALING_MIN_WEEKS - weeksInMargin} semanas dentro del margen`);
    }
    reason =
      `Evidencia en curso · ${liveTrades} de ${LIVE_SCALING_MIN_TRADES} ` +
      `operaciones reales y ${weeksInMargin} de ${LIVE_SCALING_MIN_WEEKS} ` +
      `semanas dentro del margen. Faltan ${missing.join(' y ')}. ` +
      'El escalado no se plantea en esta fase.';
  }

  return {
    state,
    liveWeeks,
    liveTrades,
    weeksInMargin,
    deviationPct,
    drawdownPct,
    reason,
    evaluatedAt,
  };
}
