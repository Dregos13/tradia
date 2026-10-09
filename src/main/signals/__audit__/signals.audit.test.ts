import { describe, expect, it } from 'vitest';

import type { SignalIntent, RiskDecision } from '../../../shared/risk';
import type { Signal } from '../../../shared/signals';
import type { Strategy as StrategyCard } from '../../../shared/strategy';
import type { Strategy as ExecutableStrategy } from '../../backtest/types';
import type { SignalEngineDeps, SignalSourceBar } from '../engine';
import { createSignalEngine } from '../engine';
import { createPaperTracker, evaluatePaperExit } from '../paper';
import type { InsertSignalResult, NewSignal, SignalsRepository } from '../repository';

const BAR_DATE = '2026-10-08';
const NOW = Date.parse('2026-10-09T21:00:00.000Z');
const bar: SignalSourceBar = {
  date: BAR_DATE,
  open: 100,
  high: 102,
  low: 98,
  close: 100,
  volume: 1_000,
  batchId: 9,
  source: 'simulado',
};

const strategyCard = (id: number, patch: Partial<StrategyCard> = {}): StrategyCard => ({
  id,
  executable: true,
  version: 4,
  name: `Estrategia ${id}`,
  hypothesis: 'Cruce de medias de confirmación',
  rules: {
    entry: `Cruce alcista confirmado por estrategia ${id}`,
    exit: 'Cruce bajista',
    stop: 'Stop 95',
    target: 'Objetivo 110',
  },
  parameters: {},
  parameterRanges: {},
  markets: ['AAPL'],
  trainingPeriod: null,
  outOfSamplePeriod: null,
  metricsSummary: null,
  regime: 'tendencial',
  assumedCosts: { commissionPct: 0.05, commissionMin: 1, slippageBps: 5, spreadBps: 2 },
  status: 'activa',
  changeNote: '',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  versionCreatedAt: '2026-10-01T00:00:00.000Z',
  ...patch,
});

const buyStrategy = (ticker: string, stop = 95, target = 110): ExecutableStrategy => ({
  init: () => undefined,
  onBar: (context) => context.buy(ticker, { stop, target }),
});

const sellStrategy = (ticker: string): ExecutableStrategy => ({
  init: () => undefined,
  onBar: (context) => context.sell(ticker),
});

const riskDecision = (
  status: RiskDecision['status'] = 'aprobada',
  size = 3,
): RiskDecision => ({
  status,
  size,
  sizeFactor: 1,
  riskAmount: 15,
  notional: 300,
  reasons: [],
  decidedAt: new Date(NOW).toISOString(),
});

const makeSignal = (input: NewSignal, id: number): Signal => ({
  id,
  ticker: input.ticker,
  direction: input.direction,
  entry: input.entry,
  stop: input.stop,
  target: input.target,
  confidence: input.confidence,
  reason: input.reason,
  strategies: input.strategies,
  dataUsed: input.dataUsed,
  decision: input.decision,
  createdAt: new Date(NOW).toISOString(),
});

const memoryRepository = (): SignalsRepository => {
  const signals: Signal[] = [];
  const dates = new Set<string>();
  return {
    insertSignal(input: NewSignal): InsertSignalResult {
      const key = `${input.ticker}|${input.barDate}`;
      const old = signals.find((signal) => dates.has(`${signal.ticker}|${input.barDate}`));
      if (old) return { signal: old, inserted: false };
      const signal = makeSignal(input, signals.length + 1);
      signals.push(signal);
      dates.add(key);
      return { signal, inserted: true };
    },
    signalExists: (ticker, date) => dates.has(`${ticker}|${date}`),
    getSignal: (id) => signals.find((signal) => signal.id === id) ?? null,
    listSignals: () => [...signals],
  };
};

interface Harness {
  engine: ReturnType<typeof createSignalEngine>;
  repo: SignalsRepository;
  decision: RiskDecision;
  setSubmitFailure(error: Error | null): void;
  setPaused(paused: boolean): void;
  setKillSwitch(active: boolean): void;
  setStrategies(strategies: { card: StrategyCard; create: () => ExecutableStrategy }[]): void;
  submitted: SignalIntent[];
  journal: { type: string }[];
  strategyCalls: Map<number, number>;
}

const makeHarness = (): Harness => {
  const repo = memoryRepository();
  let strategies: { card: StrategyCard; create: () => ExecutableStrategy }[] = [];
  let paused = false;
  let killSwitch = false;
  let decision = riskDecision();
  let submitFailure: Error | null = null;
  const submitted: SignalIntent[] = [];
  const journal: { type: string }[] = [];
  const strategyCalls = new Map<number, number>();
  const deps: SignalEngineDeps = {
    repo,
    listEvaluables: () =>
      strategies.map(({ card, create }) => ({
        ficha: card,
        create: () => {
          const strategy = create();
          return {
            ...strategy,
            onBar: (context) => {
              strategyCalls.set(card.id, (strategyCalls.get(card.id) ?? 0) + 1);
              strategy.onBar(context);
            },
          };
        },
      })),
    listStrategies: () =>
      strategies.map(({ card }) => ({
        id: card.id,
        name: card.name,
        version: card.version,
        status: card.status,
      })),
    listWatchlistTickers: () => ['AAPL'],
    barsFor: (ticker, until, preferredSource) =>
      ticker === 'AAPL' && BAR_DATE <= until && preferredSource !== 'unavailable'
        ? [bar]
        : [],
    lastBarDate: () => BAR_DATE,
    getBatchVersion: (id) => (id === bar.batchId ? 2 : null),
    submitSignal: (intent) => {
      if (submitFailure !== null) throw submitFailure;
      submitted.push(intent);
      return decision;
    },
    recordJournal: (entry) => journal.push({ type: entry.type }),
    broadcast: () => undefined,
    isAgentsPaused: () => paused,
    isOffline: () => false,
    isKillSwitchActive: () => killSwitch,
    wasProcessed: (ticker, date) => processed.has(`${ticker}|${date}`),
    markProcessed: (ticker, date) => {
      processed.add(`${ticker}|${date}`);
    },
    now: () => NOW,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const processed = new Set<string>();
  const engine = createSignalEngine(deps);
  return {
    engine,
    repo,
    get decision() {
      return decision;
    },
    set decision(next) {
      decision = next;
    },
    setSubmitFailure: (error) => {
      submitFailure = error;
    },
    setPaused: (value) => {
      paused = value;
    },
    setKillSwitch: (value) => {
      killSwitch = value;
    },
    setStrategies: (next) => {
      strategies = next;
    },
    submitted,
    journal,
    strategyCalls,
  };
};

describe('auditoría de invariantes del motor de señales', () => {
  it('reproduce la pérdida de una vela al fallar la pasarela de riesgo', () => {
    const harness = makeHarness();
    harness.setStrategies([{ card: strategyCard(1), create: () => buyStrategy('AAPL') }]);
    harness.setSubmitFailure(new Error('riesgo temporalmente no disponible'));

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('error');
    expect(harness.repo.listSignals()).toHaveLength(0);
    expect(harness.submitted).toHaveLength(0);

    harness.setSubmitFailure(null);
    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('already-processed');
    expect(harness.repo.listSignals()).toHaveLength(0);
    expect(harness.submitted).toHaveLength(0);
  });

  it('no emite ni persiste señal cuando las estrategias activas se contradicen', () => {
    const harness = makeHarness();
    harness.setStrategies([
      { card: strategyCard(1), create: () => buyStrategy('AAPL') },
      { card: strategyCard(2), create: () => sellStrategy('AAPL') },
    ]);

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('contradiction');
    expect(harness.submitted).toHaveLength(0);
    expect(harness.repo.listSignals()).toHaveLength(0);
    expect(harness.journal).toContainEqual({ type: 'contradiccion' });
  });

  it('una misma vela repetida produce una sola evaluación y una sola decisión', () => {
    const harness = makeHarness();
    harness.setStrategies([{ card: strategyCard(1), create: () => buyStrategy('AAPL') }]);

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('emitted');
    const evaluationsAfterFirstCall = harness.strategyCalls.get(1);
    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('already-processed');

    expect(harness.strategyCalls.get(1)).toBe(evaluationsAfterFirstCall);
    expect(harness.submitted).toHaveLength(1);
    expect(harness.repo.listSignals()).toHaveLength(1);
  });

  it.each([
    ['pausa de agentes', 'pause'],
    ['parada de emergencia', 'kill'],
  ] as const)('con %s activa no crea señales', (_label, guard) => {
    const harness = makeHarness();
    harness.setStrategies([{ card: strategyCard(1), create: () => buyStrategy('AAPL') }]);
    if (guard === 'pause') harness.setPaused(true);
    else harness.setKillSwitch(true);

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('blocked');
    expect(harness.submitted).toHaveLength(0);
    expect(harness.repo.listSignals()).toHaveLength(0);
  });

  it.each([0, 0.25, 0.5, 0.99, 1])(
    'persiste trazabilidad completa con confianza válida (%s)',
    (confidence) => {
      const harness = makeHarness();
      harness.setStrategies([
        {
          card: strategyCard(1, {
            version: 8,
            metricsSummary: {
              totalReturnPct: 1,
              maxDrawdownPct: 1,
              sharpe: 1,
              profitFactor: 1,
              winRatePct: confidence * 100,
              expectancy: 1,
              maxLosingStreak: 1,
              trades: 1,
            },
          }),
          create: () => buyStrategy('AAPL'),
        },
      ]);

      expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('emitted');
      const [signal] = harness.repo.listSignals();
      expect(signal).toBeDefined();
      expect(signal?.decision).toEqual(harness.decision);
      expect(signal?.dataUsed).toMatchObject({
        barDate: BAR_DATE,
        desde: BAR_DATE,
        hasta: BAR_DATE,
        barCount: 1,
        batchId: 9,
        batchVersion: 2,
        source: 'simulado',
      });
      expect(signal?.strategies).toEqual([
        expect.objectContaining({ strategyId: 1, name: 'Estrategia 1', version: 8 }),
      ]);
      expect(signal?.reason).toContain('Cruce alcista confirmado');
      expect(signal?.confidence).toBe(confidence);
      expect(signal?.confidence).toBeGreaterThanOrEqual(0);
      expect(signal?.confidence).toBeLessThanOrEqual(1);
      expect(harness.submitted).toHaveLength(1);
    },
  );

  it('usa el tamaño asignado por riesgo en paper y nunca lo amplía', () => {
    const openedSizes: number[] = [];
    const tracker = createPaperTracker({
      gateway: {
        listPaperPositions: () => [],
        openPaperPosition: (position) => {
          openedSizes.push(position.size);
          return {
            ...position,
            id: openedSizes.length,
            closedAt: null,
            exit: null,
            exitReason: null,
          };
        },
        closePaperPosition: () => null,
        getPaperRiskState: () => ({
          equity: 10_000,
          dailyLossPct: 0,
          weeklyLossPct: 0,
          monthlyLossPct: 0,
          drawdownPct: 0,
        }),
        getLimits: () => ({
          riskPerTradePct: 0.5,
          minRewardRiskRatio: 2,
          maxDailyLossPct: 2,
          maxWeeklyLossPct: 4,
          maxMonthlyLossPct: 6,
          maxDrawdownPct: 10,
          maxOpenPositions: 5,
          maxAssetExposurePct: 20,
          maxSectorExposurePct: 30,
          maxCurrencyExposurePct: 25,
          maxCorrelation: 0.7,
          maxLeverage: 1,
          maxLiquidityPct: 1,
        }),
      },
      barAt: () => null,
      getSignal: () => null,
      now: () => NOW,
    });

    for (const size of [0.1, 1, 3.75, 25]) {
      tracker.handleSignalEvent({
        signal: {
          id: openedSizes.length + 1,
          ticker: 'AAPL',
          direction: 'largo',
          entry: 100,
          stop: 95,
          target: 110,
          confidence: 0.5,
          reason: 'Señal de auditoría',
          strategies: [],
          dataUsed: {
            barDate: BAR_DATE,
            desde: BAR_DATE,
            hasta: BAR_DATE,
            barCount: 1,
            batchId: 9,
            batchVersion: 2,
            source: 'simulado',
          },
          decision: riskDecision('reducida', size),
          createdAt: new Date(NOW).toISOString(),
        },
      });
      expect(openedSizes.at(-1)).toBe(size);
      expect(openedSizes.at(-1)).toBeLessThanOrEqual(size);
    }
    tracker.stop();
  });

  it('si stop y objetivo se tocan en la misma vela, prevalece el stop', () => {
    expect(
      evaluatePaperExit(
        { direction: 'largo', stop: 95, target: 105 },
        { open: 100, high: 106, low: 94 },
      ),
    ).toEqual({ exit: 95, reason: 'stop', level: 95 });
    expect(
      evaluatePaperExit(
        { direction: 'corto', stop: 105, target: 95 },
        { open: 100, high: 106, low: 94 },
      ),
    ).toEqual({ exit: 105, reason: 'stop', level: 105 });
  });
});
