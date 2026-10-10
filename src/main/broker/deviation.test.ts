import { describe, expect, it } from 'vitest';

import type { BrokerOrder, DeviationReportRow, OrderExecution } from '../../shared/broker';
import type { BacktestReport, BacktestRunConfig, TradeDto } from '../../shared/backtest';
import {
  NO_EXPECTATION,
  addDays,
  buildDeviationRows,
  closedTradesFromOrders,
  expectationFromReport,
  isClosedPeriod,
  monthRangeOf,
  nyDateOf,
  periodRangeOf,
  weekRangeOf,
  type ClosedTrade,
  type StrategyExpectation,
} from './deviation';

// ---------------------------------------------------------------------------
// Auxiliares
// ---------------------------------------------------------------------------

let orderSeq = 0;

const fakeExecution = (patch: Partial<OrderExecution> = {}): OrderExecution => ({
  requestedAt: '2026-10-05T14:00:00.000Z',
  requestedPrice: 100,
  executedAt: '2026-10-05T14:00:01.000Z',
  executedPrice: 100,
  slippageBps: 5,
  ...patch,
});

const fakeOrder = (patch: Partial<BrokerOrder> = {}): BrokerOrder => {
  const { execution, ...rest } = patch;
  return {
    id: ++orderSeq,
    clientOrderId: `tradia-${orderSeq}-entrada`,
    brokerOrderId: `sim-${orderSeq}`,
    signalId: null,
    strategyId: 1,
    leg: 'entrada',
    ticker: 'AAPL',
    type: 'market',
    side: 'buy',
    quantity: 10,
    filledQuantity: 10,
    limitPrice: null,
    stopPrice: null,
    ocoGroupId: null,
    execution: fakeExecution(execution),
    status: 'ejecutada',
    attempts: 1,
    rejectReason: null,
    createdAt: '2026-10-05T14:00:00.000Z',
    updatedAt: '2026-10-05T14:00:01.000Z',
    ...rest,
  };
};

const trade = (patch: Partial<ClosedTrade> = {}): ClosedTrade => ({
  strategyId: 1,
  signalKey: 's1',
  ticker: 'AAPL',
  entryOrderId: 1,
  exitOrderId: 2,
  returnPct: 1,
  closedAtNy: '2026-10-08',
  slippageBps: [4],
  ...patch,
});

const EXPECTATION: StrategyExpectation = {
  perTradeReturnPct: 1,
  winRate: 0.55,
  backtestVersion: 2,
  backtestRunId: 7,
};

const ctx = (patch: Partial<Parameters<typeof buildDeviationRows>[3]> = {}) => ({
  marginPp: 2,
  maxSlippageBps: 10,
  expectationFor: () => EXPECTATION,
  strategyNameFor: (id: number) => `Estrategia ${id}`,
  ...patch,
});

// ---------------------------------------------------------------------------
// Periodos en America/New_York
// ---------------------------------------------------------------------------

describe('periodos del informe', () => {
  it('la semana va de lunes a domingo en calendario de Nueva York', () => {
    expect(weekRangeOf('2026-10-14')).toEqual({ desde: '2026-10-12', hasta: '2026-10-18' });
    expect(weekRangeOf('2026-10-12')).toEqual({ desde: '2026-10-12', hasta: '2026-10-18' });
    expect(weekRangeOf('2026-10-11')).toEqual({ desde: '2026-10-05', hasta: '2026-10-11' });
    // Semana que cruza el cambio de mes.
    expect(weekRangeOf('2026-11-01')).toEqual({ desde: '2026-10-26', hasta: '2026-11-01' });
  });

  it('el mes es el mes natural', () => {
    expect(monthRangeOf('2026-10-14')).toEqual({ desde: '2026-10-01', hasta: '2026-10-31' });
    expect(monthRangeOf('2028-02-10')).toEqual({ desde: '2028-02-01', hasta: '2028-02-29' });
    expect(monthRangeOf('2026-12-31')).toEqual({ desde: '2026-12-01', hasta: '2026-12-31' });
    expect(periodRangeOf('mensual', '2026-10-14')).toEqual(monthRangeOf('2026-10-14'));
    expect(periodRangeOf('semanal', '2026-10-14')).toEqual(weekRangeOf('2026-10-14'));
  });

  it('un periodo solo informa cuando está cerrado (su fin ya pasó en NY)', () => {
    const week = weekRangeOf('2026-10-05'); // 5–11 oct
    expect(isClosedPeriod(week, '2026-10-12')).toBe(true);
    expect(isClosedPeriod(week, '2026-10-11')).toBe(false);
    expect(isClosedPeriod(week, '2026-10-10')).toBe(false);
  });

  it('la fecha NY de un instante respeta el huso horario (verano e invierno)', () => {
    // 03:30 UTC de octubre = 23:30 EDT del día anterior.
    expect(nyDateOf('2026-10-12T03:30:00.000Z')).toBe('2026-10-11');
    // En invierno el desfase es −5: 04:30 UTC = 23:30 EST del día anterior.
    expect(nyDateOf('2026-12-15T04:30:00.000Z')).toBe('2026-12-14');
    expect(nyDateOf('2026-12-15T05:30:00.000Z')).toBe('2026-12-15');
  });

  it('addDays suma días civiles', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

// ---------------------------------------------------------------------------
// Operaciones cerradas
// ---------------------------------------------------------------------------

describe('operaciones cerradas', () => {
  const pair = (patch: {
    signalId?: number | null;
    key?: string;
    entryPrice?: number;
    exitPrice?: number;
    exitAt?: string;
    entrySlip?: number | null;
    exitSlip?: number | null;
    entrySide?: 'buy' | 'sell';
    strategyId?: number | null;
  }): BrokerOrder[] => {
    const key = patch.key ?? 'tradia-9';
    const strategyId = patch.strategyId === undefined ? 3 : patch.strategyId;
    const signalId = patch.signalId === undefined ? null : patch.signalId;
    return [
      fakeOrder({
        clientOrderId: `${key}-entrada`,
        signalId,
        strategyId,
        leg: 'entrada',
        side: patch.entrySide ?? 'buy',
        execution: fakeExecution({
          requestedPrice: patch.entryPrice ?? 100,
          executedPrice: patch.entryPrice ?? 100,
          slippageBps: patch.entrySlip === undefined ? 5 : patch.entrySlip,
        }),
      }),
      fakeOrder({
        clientOrderId: `${key}-salida`,
        signalId,
        strategyId,
        leg: 'salida',
        type: 'oco',
        side: patch.entrySide === 'sell' ? 'buy' : 'sell',
        execution: fakeExecution({
          requestedPrice: null,
          executedPrice: patch.exitPrice ?? 101,
          executedAt: patch.exitAt ?? '2026-10-08T19:00:00.000Z',
          slippageBps: patch.exitSlip === undefined ? null : patch.exitSlip,
        }),
      }),
    ];
  };

  it('empareja entrada y salida ejecutadas de la misma señal por senal_id', () => {
    const orders = pair({ signalId: 9, entryPrice: 100, exitPrice: 102, exitSlip: 6 });
    const trades = closedTradesFromOrders(orders);
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({
      strategyId: 3,
      signalKey: 's9',
      returnPct: 2,
      closedAtNy: '2026-10-08',
      slippageBps: [5, 6],
    });
  });

  it('empareja por la raíz del client_order_id cuando no hay senal_id', () => {
    const orders = pair({ key: 'tradia-seed-w0-s1-t0', entryPrice: 100, exitPrice: 96 });
    const trades = closedTradesFromOrders(orders);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.signalKey).toBe('tradia-seed-w0-s1-t0');
    expect(trades[0]!.returnPct).toBe(-4);
  });

  it('la rentabilidad lleva el signo del lado de la entrada', () => {
    // Corto: vende a 100 y recompra a 96 → +4 %.
    const orders = pair({ entrySide: 'sell', entryPrice: 100, exitPrice: 96 });
    expect(closedTradesFromOrders(orders)[0]!.returnPct).toBe(4);
  });

  it('la fecha de cierre es el día NY de la ejecución de la salida', () => {
    // Salida ejecutada a las 02:30 UTC = 22:30 ET del día anterior.
    const orders = pair({ exitAt: '2026-10-09T02:30:00.000Z' });
    expect(closedTradesFromOrders(orders)[0]!.closedAtNy).toBe('2026-10-08');
  });

  it('ignora patas sueltas, abiertas, canceladas y órdenes sin estrategia', () => {
    const orders: BrokerOrder[] = [
      // Entrada sin salida.
      pair({ key: 'tradia-1' })[0]!,
      // Salida cancelada (OCO cancelado).
      fakeOrder({
        clientOrderId: 'tradia-2-salida',
        signalId: 2,
        strategyId: 3,
        leg: 'salida',
        type: 'oco',
        side: 'sell',
        status: 'cancelada',
        execution: fakeExecution({ executedAt: null, executedPrice: null, slippageBps: null }),
      }),
      // Orden manual ejecutada pero sin pata.
      fakeOrder({ clientOrderId: 'tradia-manual-1', leg: null, type: 'limit' }),
      // Par ejecutado pero sin estrategia.
      ...pair({ key: 'tradia-3', strategyId: null }),
      // Salida ejecutada sin entrada.
      pair({ key: 'tradia-4' })[1]!,
    ];
    expect(closedTradesFromOrders(orders)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Expectativa del último backtest
// ---------------------------------------------------------------------------

const fakeTrade = (patch: Partial<TradeDto> = {}): TradeDto => ({
  ticker: 'AAPL',
  signalDate: '2026-01-02',
  entryDate: '2026-01-05',
  entryPrice: 100,
  exitDate: '2026-01-08',
  exitPrice: 102,
  shares: 10,
  commission: 0,
  slippage: 0,
  grossPnl: 20,
  pnl: 20,
  exitReason: 'signal',
  ...patch,
});

const fakeConfig = (patch: Partial<BacktestRunConfig> = {}): BacktestRunConfig => ({
  desde: '2025-01-01',
  hasta: '2025-12-31',
  ejecutadoHasta: '2025-12-31',
  markets: ['AAPL'],
  initialCash: 10_000,
  riskPerTrade: 0.01,
  maxPositions: 5,
  parameters: {},
  warmupSessions: 300,
  split: { train: 0.6, validation: 0.2, test: 0.2 },
  walkForward: null,
  sensitivity: null,
  monteCarlo: null,
  ...patch,
});

const fakeReport = (patch: Partial<BacktestReport> = {}): BacktestReport => ({
  id: 7,
  strategyId: 3,
  version: 2,
  kind: 'completo',
  dataSource: 'simulated',
  providerId: 'simulado',
  totalReturn: 0.12,
  maxDrawdownPct: 0.05,
  sharpe: 1.1,
  tradeCount: 2,
  durationMs: 100,
  createdAt: '2026-10-01T00:00:00.000Z',
  config: fakeConfig(),
  costs: { commissionPct: 0, commissionMin: 0, slippageBps: 0, spreadBps: 0 },
  split: null,
  metrics: {
    totalReturn: 0.12,
    annualizedReturn: 0.12,
    maxDrawdown: null,
    sharpe: 1.1,
    sharpeInfinite: null,
    profitFactor: 2,
    profitFactorInfinite: false,
    winRate: 0.6,
    expectancy: 40,
    maxLosingStreak: 1,
    tradeCount: 2,
    winningTrades: 1,
    losingTrades: 1,
    grossProfit: 100,
    grossLoss: 60,
  },
  equityCurve: [],
  trades: [],
  walkForward: null,
  sensitivity: null,
  monteCarlo: null,
  warnings: [],
  benchmark: null,
  finalTest: { status: 'disponible', runId: null, executedAt: null },
  ...patch,
});

describe('expectativa del último backtest', () => {
  it('sin backtest no hay expectativa', () => {
    expect(expectationFromReport(null)).toEqual(NO_EXPECTATION);
  });

  it('la expectativa por operación es la media de las rentabilidades del run', () => {
    const report = fakeReport({
      trades: [
        fakeTrade({ entryPrice: 100, exitPrice: 102 }), // +2 %
        fakeTrade({ entryPrice: 50, exitPrice: 49 }), // −2 %
      ],
    });
    const expectation = expectationFromReport(report);
    expect(expectation.perTradeReturnPct).toBe(0); // media de +2 y −2
    expect(expectation.winRate).toBe(0.6); // de las métricas
    expect(expectation.backtestVersion).toBe(2);
    expect(expectation.backtestRunId).toBe(7);
  });

  it('sin operaciones recurre a expectancy sobre el capital inicial del run', () => {
    const report = fakeReport({ trades: [] }); // expectancy 40 sobre 10 000
    const expectation = expectationFromReport(report);
    expect(expectation.perTradeReturnPct).toBe(0.4);
  });

  it('la tasa de acierto sale de las operaciones si las métricas no la traen', () => {
    const report = fakeReport({
      metrics: { ...fakeReport().metrics, winRate: null },
      trades: [fakeTrade({ pnl: 10 }), fakeTrade({ pnl: -5 }), fakeTrade({ pnl: 2 })],
    });
    expect(expectationFromReport(report).winRate).toBeCloseTo(2 / 3, 6);
  });
});

// ---------------------------------------------------------------------------
// Filas del informe
// ---------------------------------------------------------------------------

const strategyOf = (row: DeviationReportRow): number => row.strategyId;

describe('filas del informe', () => {
  const today = '2026-10-14'; // miércoles: cierran las semanas hasta el 11 oct

  it('agrupa por estrategia y periodo cerrado, más reciente primero', () => {
    const trades = [
      trade({ closedAtNy: '2026-10-06', returnPct: 1 }),
      trade({ closedAtNy: '2026-10-08', returnPct: 1, exitOrderId: 3 }),
      trade({ closedAtNy: '2026-09-30', returnPct: -1, strategyId: 2, exitOrderId: 4 }),
      // Esta aún no informa: su semana (12–18 oct) sigue abierta.
      trade({ closedAtNy: '2026-10-13', returnPct: 9, exitOrderId: 5 }),
    ];
    const rows = buildDeviationRows(trades, 'semanal', today, ctx());
    expect(rows).toHaveLength(2);
    expect(rows.map(strategyOf)).toEqual([1, 2]);
    expect(rows[0]).toMatchObject({
      desde: '2026-10-05',
      hasta: '2026-10-11',
      trades: 2,
      realReturnPct: 2,
      expectedReturnPct: 2,
      deviationPp: 0,
      expectedWinRate: 0.55,
      realWinRate: 1,
      avgSlippageBps: 4,
      outOfMargin: false,
    });
    expect(rows[1]).toMatchObject({ desde: '2026-09-28', hasta: '2026-10-04', trades: 1 });
  });

  it('marca fuera de margen por desviación en pp y por slippage medio', () => {
    const trades = [
      trade({ returnPct: -5 }), // −5 % vs +1 % esperado → desviación −6 pp
      trade({ returnPct: 1, exitOrderId: 3, slippageBps: [14] }),
    ];
    const rows = buildDeviationRows(trades, 'semanal', today, ctx());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      trades: 2,
      realReturnPct: -4,
      expectedReturnPct: 2,
      deviationPp: -6,
      avgSlippageBps: 9, // media de 4 y 14
      outOfMargin: true,
    });
  });

  it('fuera de margen solo por slippage aunque la desviación cuadre', () => {
    const trades = [trade({ returnPct: 1, slippageBps: [11, 15] })];
    const rows = buildDeviationRows(trades, 'semanal', today, ctx());
    expect(rows[0]).toMatchObject({ deviationPp: 0, avgSlippageBps: 13, outOfMargin: true });
  });

  it('sin backtest el esperado y la desviación quedan en null', () => {
    const rows = buildDeviationRows(
      [trade({ returnPct: -9 })],
      'semanal',
      today,
      ctx({ expectationFor: () => NO_EXPECTATION }),
    );
    expect(rows[0]).toMatchObject({
      expectedReturnPct: null,
      deviationPp: null,
      expectedWinRate: null,
      realReturnPct: -9,
      outOfMargin: false,
    });
  });

  it('sin backtest el slippage por encima del tope sí saca del margen', () => {
    const rows = buildDeviationRows(
      [trade({ slippageBps: [12] })],
      'semanal',
      today,
      ctx({ expectationFor: () => NO_EXPECTATION }),
    );
    expect(rows[0]).toMatchObject({ deviationPp: null, outOfMargin: true });
  });

  it('el informe mensual agrupa por mes natural', () => {
    const trades = [
      trade({ closedAtNy: '2026-09-24' }),
      trade({ closedAtNy: '2026-10-01', exitOrderId: 3 }),
    ];
    const rows = buildDeviationRows(trades, 'mensual', '2026-11-05', ctx());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ desde: '2026-10-01', hasta: '2026-10-31' });
    expect(rows[1]).toMatchObject({ desde: '2026-09-01', hasta: '2026-09-30' });
  });
});
