/**
 * Servicio del informe de desviación real frente a backtest — Fase 5.
 *
 * `report()` es el punto de recálculo: lee las órdenes ejecutadas de
 * `broker_orders`, empareja las operaciones cerradas, construye las filas
 * del periodo pedido con `deviation.ts` y, por cada periodo cerrado
 * fuera de margen (de los dos tipos, no solo el consultado), deja su
 * rastro la primera vez: una fila de `deviation_alerts` —UNIQUE por
 * (estrategia, periodo, inicio), así recalcular nunca duplica—, una
 * entrada 'limite' en el Diario enlazada por `journal_id` y una
 * notificación de escritorio que abre «Real vs backtest».
 *
 * Dependencias inyectables: el repositorio del broker (órdenes y
 * alertas), la expectativa por estrategia (el cableado la resuelve con
 * `expectationFromReport` sobre el último run del servicio de backtest),
 * los márgenes (settings: `deviationMarginPp`, `deviationSlippageBps`),
 * el diario, las notificaciones y el reloj. El registro IPC
 * (`deviation:report` y el gancho `broker:seed-weeks`) lo monta la tarea
 * del servicio del broker; todo lo que necesita está aquí.
 */
import {
  BROKER_ORDERS_MAX_LIMIT,
  DEVIATION_PERIODS,
  type BrokerOrder,
  type BrokerSeedWeeksRequest,
  type BrokerSeedWeeksResult,
  type DeviationPeriod,
  type DeviationReport,
  type DeviationReportQuery,
  type DeviationReportRow,
  type NotificationPayload,
} from '../../shared/ipc';
import type { JournalEntry, JournalRecordInput } from '../../shared/journal';
import { buildSeedWeeksOrders } from './__fixtures__/weeks';
import {
  NO_EXPECTATION,
  buildDeviationRows,
  closedTradesFromOrders,
  nyToday,
  type DeviationRowContext,
  type StrategyExpectation,
} from './deviation';
import type { BrokerRepository } from './repository';

// ---------------------------------------------------------------------------
// Dependencias y superficie
// ---------------------------------------------------------------------------

/** Datos de la ficha que enriquecen el informe y el Diario. */
export interface StrategyInfo {
  name: string;
  /** Versión vigente; null si no consta. */
  version: number | null;
}

export interface DeviationMargins {
  /** Margen de desviación (± puntos porcentuales). */
  marginPp: number;
  /** Slippage medio máximo admitido (puntos básicos). */
  maxSlippageBps: number;
}

export interface DeviationServiceDeps {
  /** Órdenes y alertas del dominio broker (migración 010). */
  repo: Pick<
    BrokerRepository,
    'listOrders' | 'insertOrder' | 'listDeviationAlerts' | 'insertDeviationAlert'
  >;
  /** Expectativa del último backtest de la estrategia (ver expectationFromReport). */
  expectationFor(strategyId: number): StrategyExpectation;
  /** Nombre y versión vigente de la estrategia; null si no consta. */
  strategyInfo?(strategyId: number): StrategyInfo | null;
  /** Márgenes vigentes (settings). */
  margins(): DeviationMargins;
  /** `journal.record` del servicio de diario; opcional en pruebas. */
  recordJournal?(input: JournalRecordInput): JournalEntry;
  /** `notifications.notify`; opcional en pruebas. */
  notify?(payload: NotificationPayload): void;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
  logger?: Partial<{
    warn(message: string): void;
    error(message: string): void;
  }>;
}

export interface DeviationService {
  /**
   * Informe del periodo pedido. También dispara las alertas de todos los
   * periodos cerrados fuera de margen (semanal y mensual): cada uno se
   * anota una única vez aunque se recalcule.
   */
  report(query: DeviationReportQuery): DeviationReport;
  /**
   * Gancho E2E `broker:seed-weeks`: inserta las semanas de operaciones
   * del fixture determinista (idempotente por `client_order_id`).
   */
  seedWeeks(request?: BrokerSeedWeeksRequest): BrokerSeedWeeksResult;
}

// ---------------------------------------------------------------------------
// Formato legible (español, como el resto del diario y los avisos)
// ---------------------------------------------------------------------------

const fmtNum = (value: number, decimals = 2): string =>
  value.toFixed(decimals).replace('.', ',');

const fmtSignedPct = (value: number): string =>
  `${value < 0 ? '−' : '+'}${fmtNum(Math.abs(value))} %`;

const fmtSignedPp = (value: number): string =>
  `${value < 0 ? '−' : '+'}${fmtNum(Math.abs(value))} pp`;

const periodLabel = (period: DeviationPeriod, row: DeviationReportRow): string =>
  `${period === 'semanal' ? 'la semana' : 'el mes'} ${row.desde} → ${row.hasta}`;

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export function createDeviationService(deps: DeviationServiceDeps): DeviationService {
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? console;

  /** Todas las órdenes ejecutadas (paginado por el tope del contrato). */
  const listExecutedOrders = (): BrokerOrder[] => {
    const orders: BrokerOrder[] = [];
    let offset = 0;
    for (;;) {
      const page = deps.repo.listOrders({
        status: 'ejecutada',
        limit: BROKER_ORDERS_MAX_LIMIT,
        offset,
      });
      orders.push(...page);
      if (page.length < BROKER_ORDERS_MAX_LIMIT) return orders;
      offset += BROKER_ORDERS_MAX_LIMIT;
    }
  };

  /** Entrada del Diario de una fila fuera de margen. */
  const journalInputFor = (
    row: DeviationReportRow,
    period: DeviationPeriod,
    expectation: StrategyExpectation,
    margins: DeviationMargins,
  ): JournalRecordInput => {
    const reasons: string[] = [];
    if (row.deviationPp !== null && Math.abs(row.deviationPp) > margins.marginPp) {
      reasons.push(`desviación ${fmtSignedPp(row.deviationPp)} (margen ±${fmtNum(margins.marginPp, 1)} pp)`);
    }
    if (row.avgSlippageBps !== null && row.avgSlippageBps > margins.maxSlippageBps) {
      reasons.push(
        `slippage medio ${fmtNum(row.avgSlippageBps)} pb (máx. ${fmtNum(margins.maxSlippageBps)} pb)`,
      );
    }
    const expected =
      row.expectedReturnPct === null ? 'sin backtest de referencia' : fmtSignedPct(row.expectedReturnPct);
    return {
      type: 'limite',
      result: 'alcanzado',
      strategies: [
        {
          strategyId: row.strategyId,
          name: row.strategyName,
          version: expectation.backtestVersion ?? deps.strategyInfo?.(row.strategyId)?.version ?? 0,
        },
      ],
      reason:
        `«${row.strategyName}» fuera de margen en ${periodLabel(period, row)}: ` +
        `real ${fmtSignedPct(row.realReturnPct)} frente a ${expected} esperado; ${reasons.join('; ')}.`,
      dataUsed: {
        periodo: period,
        desde: row.desde,
        hasta: row.hasta,
        operaciones: row.trades,
        esperadoPct: row.expectedReturnPct,
        realPct: row.realReturnPct,
        desviacionPp: row.deviationPp,
        aciertoEsperado: row.expectedWinRate,
        aciertoReal: row.realWinRate,
        slippageMedioPb: row.avgSlippageBps,
        margenPp: margins.marginPp,
        margenSlippagePb: margins.maxSlippageBps,
        backtestRunId: expectation.backtestRunId,
      },
      ruleChecks: [
        {
          code: 'DEVIATION_RETURN_PP',
          label: 'Desviación de rentabilidad frente a backtest',
          cumplida: row.deviationPp === null || Math.abs(row.deviationPp) <= margins.marginPp,
          observed: row.deviationPp === null ? null : fmtSignedPp(row.deviationPp),
          limit: `±${fmtNum(margins.marginPp, 1)} pp`,
        },
        {
          code: 'DEVIATION_SLIPPAGE_BPS',
          label: 'Slippage medio de las ejecuciones',
          cumplida:
            row.avgSlippageBps === null || row.avgSlippageBps <= margins.maxSlippageBps,
          observed: row.avgSlippageBps === null ? null : `${fmtNum(row.avgSlippageBps)} pb`,
          limit: `máx. ${fmtNum(margins.maxSlippageBps)} pb`,
        },
      ],
    };
  };

  /** Notificación de escritorio de una fila fuera de margen. */
  const notificationFor = (
    row: DeviationReportRow,
    period: DeviationPeriod,
    margins: DeviationMargins,
  ): NotificationPayload => {
    const parts: string[] = [];
    if (row.deviationPp !== null) {
      parts.push(`desviación ${fmtSignedPp(row.deviationPp)} (margen ±${fmtNum(margins.marginPp, 1)} pp)`);
    }
    if (row.avgSlippageBps !== null) {
      parts.push(`slippage medio ${fmtNum(row.avgSlippageBps)} pb (máx. ${fmtNum(margins.maxSlippageBps)} pb)`);
    }
    return {
      level: 'alerta',
      title: `Desviación real vs backtest · ${row.strategyName}`,
      body: `${periodLabel(period, row).replace(/^./, (c) => c.toUpperCase())}: ${parts.join('; ')}.`,
      navigateTo: 'real-vs-backtest',
    };
  };

  /**
   * Persiste la alerta de cada fila fuera de margen que aún no la tenga:
   * Diario primero (para enlazar journal_id), después la fila UNIQUE y la
   * notificación solo si la fila se insertó de verdad. Las filas sin
   * expectativa no pueden alertar (esperado_pct es NOT NULL): se anota.
   */
  const alertOutOfMargin = (
    period: DeviationPeriod,
    rows: readonly DeviationReportRow[],
    margins: DeviationMargins,
    expectationFor: (strategyId: number) => StrategyExpectation,
  ): void => {
    const existing = new Set(
      deps.repo
        .listDeviationAlerts({ period })
        .map((alert) => `${alert.strategyId}|${alert.desde}`),
    );
    for (const row of rows) {
      if (!row.outOfMargin) continue;
      const key = `${row.strategyId}|${row.desde}`;
      if (existing.has(key)) continue;
      const expectation = expectationFor(row.strategyId);
      if (row.expectedReturnPct === null || row.deviationPp === null) {
        logger.warn?.(
          `[deviation] ${row.strategyName} en ${row.desde}: fuera de margen sin ` +
            'backtest de referencia; no se puede persistir la alerta',
        );
        continue;
      }
      const journal = deps.recordJournal?.(
        journalInputFor(row, period, expectation, margins),
      );
      const { inserted } = deps.repo.insertDeviationAlert({
        strategyId: row.strategyId,
        strategyName: row.strategyName,
        period,
        desde: row.desde,
        hasta: row.hasta,
        expectedReturnPct: row.expectedReturnPct,
        realReturnPct: row.realReturnPct,
        deviationPp: row.deviationPp,
        avgSlippageBps: row.avgSlippageBps,
        marginPp: margins.marginPp,
        maxSlippageBps: margins.maxSlippageBps,
        journalId: journal?.id ?? null,
      });
      if (inserted) deps.notify?.(notificationFor(row, period, margins));
      existing.add(key);
    }
  };

  return {
    report: (query) => {
      const margins = deps.margins();
      const todayNy = nyToday(now());
      const trades = closedTradesFromOrders(listExecutedOrders());

      // La expectativa de cada estrategia se resuelve una vez por pasada.
      const expectationCache = new Map<number, StrategyExpectation>();
      const expectationFor = (strategyId: number): StrategyExpectation => {
        let cached = expectationCache.get(strategyId);
        if (cached === undefined) {
          cached = deps.expectationFor(strategyId) ?? NO_EXPECTATION;
          expectationCache.set(strategyId, cached);
        }
        return cached;
      };
      const ctx: DeviationRowContext = {
        ...margins,
        expectationFor,
        strategyNameFor: (strategyId) =>
          deps.strategyInfo?.(strategyId)?.name ?? `Estrategia ${strategyId}`,
      };

      // Cada periodo cerrado fuera de margen genera su alerta aunque la
      // consulta pida solo uno de los dos informes.
      let rows: DeviationReportRow[] = [];
      for (const period of DEVIATION_PERIODS) {
        const periodRows = buildDeviationRows(trades, period, todayNy, ctx);
        alertOutOfMargin(period, periodRows, margins, expectationFor);
        if (period === query.period) rows = periodRows;
      }

      return {
        period: query.period,
        marginPp: margins.marginPp,
        maxSlippageBps: margins.maxSlippageBps,
        generatedAt: new Date(now()).toISOString(),
        rows,
      };
    },

    seedWeeks: (request = {}) => {
      const orders = buildSeedWeeksOrders({ now: now(), weeks: request.weeks });
      for (const order of orders) {
        deps.repo.insertOrder(order);
      }
      return { orders: orders.length };
    },
  };
}
