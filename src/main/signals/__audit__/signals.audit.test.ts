import { describe, expect, it } from 'vitest';

import type { NewsSentiment } from '../../../shared/ai';
import type { JournalRecordInput } from '../../../shared/journal';
import type { SignalIntent, RiskDecision } from '../../../shared/risk';
import type { Signal } from '../../../shared/signals';
import type { Strategy as StrategyCard } from '../../../shared/strategy';
import type { ActiveRegime } from '../../ai/regime/enablement';
import type { Strategy as ExecutableStrategy } from '../../backtest/types';
import type {
  EligibleModelRef,
  SignalEngineDeps,
  SignalNewsRef,
  SignalPredictionRef,
  SignalSourceBar,
} from '../engine';
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
  worksIn: ['tendencia'],
  failsIn: [],
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

const riskDecision = (status: RiskDecision['status'] = 'aprobada', size = 3): RiskDecision => ({
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
  /** Fuentes de IA mutables; solo consultadas tras `enableAi(true)`. */
  ai: {
    marketRegime: ActiveRegime | null;
    eligible: EligibleModelRef | null;
    prediction: SignalPredictionRef | null;
    analyses: SignalNewsRef[];
  };
  enableAi(enabled: boolean): void;
  submitted: SignalIntent[];
  journal: { type: string }[];
  /** Entradas completas del diario (mismo orden que `journal`). */
  journalEntries: JournalRecordInput[];
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
  const journalEntries: Harness['journalEntries'] = [];
  const strategyCalls = new Map<number, number>();
  const ai: Harness['ai'] = {
    marketRegime: null,
    eligible: null,
    prediction: null,
    analyses: [],
  };
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
      ticker === 'AAPL' && BAR_DATE <= until && preferredSource !== 'unavailable' ? [bar] : [],
    lastBarDate: () => BAR_DATE,
    getBatchVersion: (id) => (id === bar.batchId ? 2 : null),
    submitSignal: (intent) => {
      if (submitFailure !== null) throw submitFailure;
      submitted.push(intent);
      return decision;
    },
    recordJournal: (entry) => {
      journal.push({ type: entry.type });
      journalEntries.push(entry);
    },
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
    ai,
    enableAi: (enabled) => {
      deps.ai = enabled
        ? {
            marketRegime: () => ai.marketRegime,
            eligibleModel: () => ai.eligible,
            latestPrediction: () => ai.prediction,
            newsAnalysesFor: () => ai.analyses,
          }
        : undefined;
    },
    submitted,
    journal,
    journalEntries,
    strategyCalls,
  };
};

describe('auditoría de invariantes del motor de señales', () => {
  it('reintenta la vela tras un fallo temporal de la pasarela de riesgo', () => {
    const harness = makeHarness();
    harness.setStrategies([{ card: strategyCard(1), create: () => buyStrategy('AAPL') }]);
    harness.setSubmitFailure(new Error('riesgo temporalmente no disponible'));

    // Sin decisión de riesgo no hay señal ni marca: la vela queda pendiente.
    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('error');
    expect(harness.repo.listSignals()).toHaveLength(0);
    expect(harness.submitted).toHaveLength(0);

    // Pasarela restablecida: la reentrega del mismo cierre se reevalúa.
    harness.setSubmitFailure(null);
    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('emitted');
    expect(harness.repo.listSignals()).toHaveLength(1);
    expect(harness.submitted).toHaveLength(1);
    expect(harness.journal.map((entry) => entry.type)).toEqual(['error', 'senal']);

    // La vela ya emitida sí queda deduplicada.
    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('already-processed');
    expect(harness.repo.listSignals()).toHaveLength(1);
    expect(harness.submitted).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// Integración de IA (fase 6): régimen, probabilidad del modelo apto y
// sentimiento de titulares confirmados. La IA solo confirma o rebaja la
// confianza de una señal que ya generan las estrategias: nunca la crea y
// siempre atraviesa la pasarela de riesgo.
// ---------------------------------------------------------------------------

const quietStrategy = (): ExecutableStrategy => ({
  init: () => undefined,
  onBar: () => undefined,
});

const ELIGIBLE: EligibleModelRef = { version: '1.0.0', hash: 'hash-modelo', horizonDays: 5 };

const prediction = (
  probUp: number,
  patch: Partial<SignalPredictionRef> = {},
): SignalPredictionRef => ({
  probUp,
  modelVersion: ELIGIBLE.version,
  modelHash: ELIGIBLE.hash,
  horizonDays: ELIGIBLE.horizonDays,
  ...patch,
});

const analysis = (
  newsItemId: number,
  sentiment: NewsSentiment,
  analyzedAt = '2026-10-08T10:00:00.000Z',
): SignalNewsRef => ({ newsItemId, sentiment, analyzedAt });

describe('auditoría de la integración de IA en el motor de señales', () => {
  it('una noticia, verificada o no, nunca crea una señal por sí sola', () => {
    const harness = makeHarness();
    harness.enableAi(true);
    // Titular sin verificar: no existe análisis, así que nada aporta.
    harness.ai.analyses = [];
    // Y aun con un análisis de sentimiento extremo confirmado, sin votos
    // de las estrategias no hay nada que combinar: la IA no crea señales.
    harness.setStrategies([{ card: strategyCard(1), create: quietStrategy }]);
    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('no-votes');

    harness.ai.analyses = [analysis(7, 'negativo'), analysis(8, 'negativo')];
    expect(harness.engine.evaluateTicker('AAPL', '2026-10-09')).toBe('no-votes');

    // Ni señal, ni pasarela, ni difusión en ninguno de los dos casos.
    expect(harness.submitted).toHaveLength(0);
    expect(harness.repo.listSignals()).toHaveLength(0);
  });

  it('el modelo apto y las noticias suben la confianza, que pasa por la pasarela y respeta su veto', () => {
    const harness = makeHarness();
    harness.enableAi(true);
    harness.decision = riskDecision('vetada', 0);
    harness.setStrategies([
      {
        card: strategyCard(1, {
          metricsSummary: {
            totalReturnPct: 1,
            maxDrawdownPct: 1,
            sharpe: 1,
            profitFactor: 1,
            winRatePct: 50,
            expectancy: 1,
            maxLosingStreak: 1,
            trades: 1,
          },
        }),
        create: () => buyStrategy('AAPL'),
      },
    ]);
    harness.ai.marketRegime = { direction: 'tendencia', volatility: 'volatilidad-baja' };
    harness.ai.eligible = ELIGIBLE;
    harness.ai.prediction = prediction(0.8); // ×1,6 sobre 0,5 → 0,80
    harness.ai.analyses = [analysis(7, 'positivo')]; // ×1,15 → 0,92

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('emitted');

    // La intención cruza la pasarela con la confianza combinada y el contexto.
    expect(harness.submitted).toHaveLength(1);
    const intent = harness.submitted[0]!;
    expect(intent.confidence).toBeCloseTo(0.5 * 1.6 * 1.15, 6);
    expect(intent.ai).toMatchObject({
      regime: { direction: 'tendencia', volatility: 'volatilidad-baja' },
      probability: 0.8,
      horizonDays: 5,
      modelVersion: '1.0.0',
      modelHash: 'hash-modelo',
      newsItemIds: [7],
    });

    // El veto del riesgo se respeta: la señal se persiste vetada.
    const signal = harness.repo.listSignals()[0]!;
    expect(signal.decision.status).toBe('vetada');
    expect(signal.dataUsed.ai).toMatchObject({
      modelVersion: '1.0.0',
      probability: 0.8,
      newsItemIds: [7],
    });
    expect(harness.journalEntries.find((e) => e.type === 'senal')).toMatchObject({
      result: 'vetada',
    });
  });

  it('un modelo no apto no cambia la confianza aunque su predicción sea extrema', () => {
    const harness = makeHarness();
    harness.enableAi(true);
    harness.setStrategies([{ card: strategyCard(1), create: () => buyStrategy('AAPL') }]);
    // Ficha no apta (o sin modelo): la predicción no participa ni puede vetar.
    harness.ai.eligible = null;
    harness.ai.prediction = prediction(0.95);

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('emitted');
    const intent = harness.submitted[0]!;
    expect(intent.confidence).toBeCloseTo(0.5);
    expect(intent.ai).toMatchObject({ probability: null, modelVersion: null, modelHash: null });
  });

  it('una predicción de otra versión o hash del modelo apto tampoco participa', () => {
    const harness = makeHarness();
    harness.enableAi(true);
    harness.setStrategies([{ card: strategyCard(1), create: () => buyStrategy('AAPL') }]);
    harness.ai.eligible = ELIGIBLE;
    harness.ai.prediction = prediction(0.95, { modelVersion: '0.9.0', modelHash: 'otro' });

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('emitted');
    expect(harness.submitted[0]!.confidence).toBeCloseTo(0.5);
    expect(harness.submitted[0]!.ai).toMatchObject({ probability: null });
  });

  it.each([
    ['largo', () => buyStrategy('AAPL'), 0.2],
    ['corto', () => sellStrategy('AAPL'), 0.8],
  ] as const)(
    'el modelo apto que contradice la dirección (%s) impide la señal y deja diario',
    (_direction, create, probUp) => {
      const harness = makeHarness();
      harness.enableAi(true);
      harness.setStrategies([{ card: strategyCard(1), create }]);
      harness.ai.eligible = ELIGIBLE;
      harness.ai.prediction = prediction(probUp);

      expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('contradiction');
      expect(harness.submitted).toHaveLength(0);
      expect(harness.repo.listSignals()).toHaveLength(0);

      const entry = harness.journalEntries.find((e) => e.type === 'contradiccion')!;
      expect(entry.result).toBe('sin-senal');
      expect(entry.reason).toContain('contradice');
      expect(entry.reason).toContain(probUp.toFixed(2));

      // Resultado definitivo: la vela queda marcada.
      expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('already-processed');
    },
  );

  it('una confianza combinada por debajo de 0,55 no opera y queda como confianza baja', () => {
    const harness = makeHarness();
    harness.enableAi(true);
    harness.setStrategies([{ card: strategyCard(1), create: () => buyStrategy('AAPL') }]);
    // 0,5 × 1,04 (prob. 0,52) = 0,52 < 0,55: el modelo confirma poco.
    harness.ai.eligible = ELIGIBLE;
    harness.ai.prediction = prediction(0.52);

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('low-confidence');
    expect(harness.submitted).toHaveLength(0);
    expect(harness.repo.listSignals()).toHaveLength(0);

    const entry = harness.journalEntries.find((e) => e.type === 'resumen')!;
    expect(entry.result).toBe('sin-senal');
    expect(entry.reason).toContain('Confianza baja');
    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('already-processed');
  });

  it('el sentimiento confirmado en contra puede rebajar la confianza por debajo del umbral', () => {
    const harness = makeHarness();
    harness.enableAi(true);
    harness.setStrategies([
      {
        card: strategyCard(1, {
          metricsSummary: {
            totalReturnPct: 1,
            maxDrawdownPct: 1,
            sharpe: 1,
            profitFactor: 1,
            winRatePct: 60,
            expectancy: 1,
            maxLosingStreak: 1,
            trades: 1,
          },
        }),
        create: () => buyStrategy('AAPL'),
      },
    ]);
    // 0,6 × 0,85 (tres titulares negativos para un largo) = 0,51 < 0,55.
    harness.ai.analyses = [
      analysis(7, 'negativo'),
      analysis(8, 'negativo'),
      analysis(9, 'negativo'),
    ];

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('low-confidence');
    expect(harness.submitted).toHaveLength(0);
    const entry = harness.journalEntries.find((e) => e.type === 'resumen')!;
    expect(entry.reason).toContain('Confianza baja');
  });

  it('un análisis fuera de la ventana de frescura no participa', () => {
    const harness = makeHarness();
    harness.enableAi(true);
    harness.setStrategies([{ card: strategyCard(1), create: () => buyStrategy('AAPL') }]);
    harness.ai.analyses = [analysis(7, 'negativo', '2026-09-01T10:00:00.000Z')];

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('emitted');
    expect(harness.submitted[0]!.confidence).toBeCloseTo(0.5);
    expect(harness.submitted[0]!.ai).toMatchObject({ newsItemIds: [] });
  });

  it('la estrategia desactivada por régimen no vota y queda en el Diario', () => {
    const harness = makeHarness();
    harness.enableAi(true);
    harness.ai.marketRegime = { direction: 'tendencia', volatility: 'volatilidad-baja' };
    harness.setStrategies([
      { card: strategyCard(1, { failsIn: ['tendencia'] }), create: () => buyStrategy('AAPL') },
      { card: strategyCard(2, { worksIn: ['lateral'] }), create: () => buyStrategy('AAPL') },
      { card: strategyCard(3), create: () => buyStrategy('AAPL') }, // habilitada
    ]);

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('emitted');

    // Solo votó la habilitada: una propuesta, una entrada por desactivada.
    expect(harness.submitted).toHaveLength(1);
    const signal = harness.repo.listSignals()[0]!;
    expect(signal.strategies.map((vote) => vote.strategyId)).toEqual([3]);

    const disabled = harness.journalEntries.filter((e) => e.type === 'resumen');
    expect(disabled).toHaveLength(2);
    expect(disabled.every((e) => e.result === 'sin-senal')).toBe(true);
    expect(disabled[0]!.reason).toContain('no vota');
    expect(harness.strategyCalls.get(1) ?? 0).toBe(0);
    expect(harness.strategyCalls.get(2) ?? 0).toBe(0);
  });

  it('si todas las estrategias quedan desactivadas por régimen no hay señal', () => {
    const harness = makeHarness();
    harness.enableAi(true);
    harness.ai.marketRegime = { direction: 'tendencia', volatility: 'volatilidad-baja' };
    harness.setStrategies([
      { card: strategyCard(1, { failsIn: ['tendencia'] }), create: () => buyStrategy('AAPL') },
    ]);

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('no-votes');
    expect(harness.submitted).toHaveLength(0);
    expect(harness.repo.listSignals()).toHaveLength(0);
    expect(harness.strategyCalls.get(1) ?? 0).toBe(0);
    expect(harness.journalEntries.some((e) => e.type === 'resumen')).toBe(true);
  });

  it('una estrategia degradada no vota y queda en el Diario', () => {
    const harness = makeHarness();
    harness.enableAi(true);
    harness.setStrategies([
      { card: strategyCard(1, { status: 'degradada' }), create: () => buyStrategy('AAPL') },
    ]);

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('no-votes');
    expect(harness.submitted).toHaveLength(0);
    const entry = harness.journalEntries.find((e) => e.type === 'resumen')!;
    expect(entry.reason).toContain('degradada');
    expect(harness.strategyCalls.get(1) ?? 0).toBe(0);
  });

  it('cada señal guarda el régimen, el modelo y las noticias con los que se evaluó', () => {
    const harness = makeHarness();
    harness.enableAi(true);
    harness.setStrategies([{ card: strategyCard(1), create: () => buyStrategy('AAPL') }]);
    harness.ai.marketRegime = { direction: 'tendencia', volatility: 'volatilidad-alta' };
    harness.ai.eligible = ELIGIBLE;
    harness.ai.prediction = prediction(0.7);
    harness.ai.analyses = [analysis(11, 'positivo'), analysis(12, 'neutro')];

    expect(harness.engine.evaluateTicker('AAPL', BAR_DATE)).toBe('emitted');
    const signal = harness.repo.listSignals()[0]!;
    expect(signal.dataUsed.ai).toEqual({
      regime: { direction: 'tendencia', volatility: 'volatilidad-alta' },
      probability: 0.7,
      horizonDays: 5,
      modelVersion: '1.0.0',
      modelHash: 'hash-modelo',
      newsItemIds: [11, 12],
    });
    expect(signal.reason).toContain('IA:');
  });
});
