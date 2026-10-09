import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IPC_CHANNELS } from '../../shared/ipc';
import type { JournalRecordInput } from '../../shared/journal';
import type { RiskDecision, RiskDecisionReason, SignalIntent } from '../../shared/risk';
import type { SignalNewEvent } from '../../shared/signals';
import type { Strategy } from '../../shared/strategy';
import type { Strategy as ExecutableStrategy } from '../backtest/types';
import { openDatabase } from '../db/database';
import {
  createSignalEngine,
  SIGNAL_DEFAULT_CONFIDENCE,
  voteConfidence,
  type EvaluableStrategy,
  type SignalEngineDeps,
  type SignalSourceBar,
} from './engine';
import { createSignalsRepository, type SignalsRepository } from './repository';

// ---------------------------------------------------------------------------
// Banco de pruebas
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-10-09T21:00:00.000Z');
const BAR_DATE = '2026-10-08';

const srcBar = (date: string, close: number): SignalSourceBar => ({
  date,
  open: close,
  high: close + 2,
  low: close - 2,
  close,
  volume: 1_000,
  batchId: 7,
  source: 'simulado',
});

const BARS: Record<string, SignalSourceBar[]> = {
  AAPL: [srcBar('2026-10-06', 190), srcBar('2026-10-07', 195), srcBar(BAR_DATE, 200)],
  MSFT: [srcBar('2026-10-06', 400), srcBar('2026-10-07', 405), srcBar(BAR_DATE, 410)],
};

const makeFicha = (id: number, patch: Partial<Strategy> = {}): Strategy => ({
  id,
  executable: true,
  version: 3,
  name: `Estrategia ${id}`,
  hypothesis: 'hipótesis',
  rules: {
    entry: `regla de entrada de la estrategia ${id}`,
    exit: `regla de salida de la estrategia ${id}`,
    stop: 'stop obligatorio',
    target: 'objetivo 2:1',
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

/** Estrategia sintética que compra el activo al cierre de la última vela. */
const buyer = (ticker: string, stop?: number, target?: number): ExecutableStrategy => ({
  init: () => undefined,
  onBar: (ctx) =>
    ctx.buy(ticker, {
      ...(stop !== undefined ? { stop } : {}),
      ...(target !== undefined ? { target } : {}),
    }),
});

/** Estrategia sintética que vende el activo al cierre de la última vela. */
const seller = (ticker: string): ExecutableStrategy => ({
  init: () => undefined,
  onBar: (ctx) => ctx.sell(ticker),
});

const quiet = (): ExecutableStrategy => ({ init: () => undefined, onBar: () => undefined });

const evaluable = (
  id: number,
  create: () => ExecutableStrategy,
  fichaPatch: Partial<Strategy> = {},
): EvaluableStrategy => ({ ficha: makeFicha(id, fichaPatch), create });

const decision = (
  status: RiskDecision['status'],
  reasons: RiskDecisionReason[] = [],
): RiskDecision => ({
  status,
  size: status === 'vetada' ? 0 : 12,
  sizeFactor: 1,
  riskAmount: 60,
  notional: 2400,
  reasons,
  decidedAt: new Date(NOW).toISOString(),
});

let db: Database.Database;
let repo: SignalsRepository;
let evaluables: EvaluableStrategy[];
let journalEntries: JournalRecordInput[];
let broadcasted: { channel: string; payload: unknown }[];
let submitted: SignalIntent[];
let decisionToReturn: RiskDecision;
let flags: { paused: boolean; offline: boolean; killSwitch: boolean };
let processedMarks: Set<string>;

const makeDeps = (): SignalEngineDeps => ({
  repo,
  listEvaluables: () => evaluables,
  listStrategies: () =>
    evaluables.map((e) => ({
      id: e.ficha.id,
      name: e.ficha.name,
      version: e.ficha.version,
      status: e.ficha.status,
    })),
  listWatchlistTickers: () => Object.keys(BARS),
  barsFor: (ticker, hasta, preferSource) =>
    (BARS[ticker] ?? [])
      .filter((bar) => bar.date <= hasta)
      .filter((bar) => preferSource === null || bar.source === preferSource),
  lastBarDate: (ticker) => BARS[ticker]?.at(-1)?.date ?? null,
  getBatchVersion: (batchId) => (batchId === 7 ? 3 : null),
  submitSignal: (intent) => {
    submitted.push(intent);
    return decisionToReturn;
  },
  recordJournal: (input) => {
    journalEntries.push(input);
  },
  broadcast: (channel, payload) => {
    broadcasted.push({ channel, payload });
  },
  isAgentsPaused: () => flags.paused,
  isOffline: () => flags.offline,
  isKillSwitchActive: () => flags.killSwitch,
  wasProcessed: (ticker, barDate) => processedMarks.has(`${ticker}|${barDate}`),
  markProcessed: (ticker, barDate) => {
    processedMarks.add(`${ticker}|${barDate}`);
  },
  now: () => NOW,
  logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
});

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createSignalsRepository(db);
  evaluables = [];
  journalEntries = [];
  broadcasted = [];
  submitted = [];
  decisionToReturn = decision('aprobada');
  flags = { paused: false, offline: false, killSwitch: false };
  processedMarks = new Set();
});

afterEach(() => {
  db.close();
});

describe('motor de señales al cierre de vela', () => {
  it('coincidencia: dos estrategias en largo emiten una señal con la confianza media', () => {
    evaluables = [
      evaluable(1, () => buyer('AAPL', 190, 230), {
        metricsSummary: metrics(60),
      }),
      evaluable(2, () => buyer('AAPL', 185, 220), {
        metricsSummary: metrics(80),
      }),
    ];
    const engine = createSignalEngine(makeDeps());

    expect(engine.evaluateTicker('aapl', BAR_DATE, 'simulado')).toBe('emitted');

    // La señal pasó por la pasarela con la forma agregada.
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      ticker: 'AAPL',
      direction: 'largo',
      entry: 200,
      // Stop prudente: el más bajo de los propuestos (190, 185).
      stop: 185,
      // Objetivo prudente: el más cercano (230, 220).
      target: 220,
      confidence: 0.7,
      origin: 'estrategia',
    });

    // Persistencia completa: votos con versión, datos usados, motivo, decisión.
    const signal = repo.getSignal(1)!;
    expect(signal.direction).toBe('largo');
    expect(signal.confidence).toBeCloseTo(0.7);
    expect(signal.reason).toContain('regla de entrada');
    expect(signal.strategies).toHaveLength(2);
    expect(signal.strategies[0]).toMatchObject({
      strategyId: 1,
      name: 'Estrategia 1',
      version: 3,
      direction: 'largo',
    });
    expect(signal.dataUsed).toMatchObject({
      barDate: BAR_DATE,
      desde: '2026-10-06',
      hasta: BAR_DATE,
      barCount: 3,
      batchId: 7,
      batchVersion: 3,
      source: 'simulado',
    });
    expect(signal.decision.status).toBe('aprobada');

    // Evento signals:new y entrada 'senal' en el diario enlazada.
    const emitted = broadcasted.filter((e) => e.channel === IPC_CHANNELS.signals.new);
    expect(emitted).toHaveLength(1);
    expect((emitted[0]!.payload as SignalNewEvent).signal.id).toBe(signal.id);
    expect(journalEntries).toHaveLength(1);
    expect(journalEntries[0]).toMatchObject({
      type: 'senal',
      ticker: 'AAPL',
      result: 'aprobada',
      signalId: signal.id,
    });

    // Estado por estrategia para el panel.
    const states = engine.listStrategyStates();
    expect(states.map((s) => s.lastOutcome)).toEqual(['senal', 'senal']);
    expect(states[0]!.lastSignalId).toBe(signal.id);
    expect(states[0]!.lastBarDate).toBe(BAR_DATE);
  });

  it('contradicción: largo y corto sobre el mismo activo no emiten señal', () => {
    evaluables = [evaluable(1, () => buyer('AAPL', 190)), evaluable(2, () => seller('AAPL'))];
    const engine = createSignalEngine(makeDeps());

    expect(engine.evaluateTicker('AAPL', BAR_DATE)).toBe('contradiction');

    // Nada por la pasarela ni en signals: el desacuerdo solo va al diario.
    expect(submitted).toHaveLength(0);
    expect(repo.listSignals()).toHaveLength(0);
    expect(broadcasted.filter((e) => e.channel === IPC_CHANNELS.signals.new)).toHaveLength(0);

    const entry = journalEntries.find((e) => e.type === 'contradiccion');
    expect(entry).toMatchObject({ ticker: 'AAPL', result: 'sin-senal' });
    expect(entry!.reason).toContain('desacuerdo');
    const data = entry!.dataUsed as { propuestas: { direction: string }[] };
    expect(data.propuestas.map((p) => p.direction).sort()).toEqual(['corto', 'largo']);
    expect(engine.listStrategyStates().every((s) => s.lastOutcome === 'sin-senal')).toBe(true);
  });

  it('veto: la señal vetada se persiste con la decisión y sus reglas incumplidas', () => {
    decisionToReturn = decision('vetada', [
      { code: 'STOP_MISSING', message: 'La señal no tiene stop de protección', details: {} },
    ]);
    evaluables = [evaluable(1, () => buyer('AAPL'))]; // sin stop
    const engine = createSignalEngine(makeDeps());

    expect(engine.evaluateTicker('AAPL', BAR_DATE)).toBe('emitted');

    const signal = repo.getSignal(1)!;
    expect(signal.decision.status).toBe('vetada');
    expect(signal.decision.reasons[0]!.code).toBe('STOP_MISSING');

    const entry = journalEntries.find((e) => e.type === 'senal')!;
    expect(entry.result).toBe('vetada');
    expect(entry.ruleChecks).toEqual([
      {
        code: 'STOP_MISSING',
        label: 'La señal no tiene stop de protección',
        cumplida: false,
        observed: null,
        limit: null,
      },
    ]);
    expect(engine.listStrategyStates()[0]!.lastOutcome).toBe('vetada');
  });

  it.each([
    ['los agentes en pausa', { paused: true, offline: false, killSwitch: false }],
    ['sin conexión', { paused: false, offline: true, killSwitch: false }],
    ['la parada activa', { paused: false, offline: false, killSwitch: true }],
  ])('no evalúa con %s', (_label, patch) => {
    Object.assign(flags, patch);
    evaluables = [evaluable(1, () => buyer('AAPL', 190))];
    const engine = createSignalEngine(makeDeps());

    expect(engine.evaluateTicker('AAPL', BAR_DATE)).toBe('blocked');
    expect(submitted).toHaveLength(0);
    expect(repo.listSignals()).toHaveLength(0);
    expect(journalEntries).toHaveLength(0);
    // La vela no queda marcada: al reanudarse puede evaluarse.
    expect(processedMarks.size).toBe(0);
  });

  it('es idempotente: la misma vela no genera dos señales ni repite la evaluación', () => {
    evaluables = [evaluable(1, () => buyer('AAPL', 190))];
    const engine = createSignalEngine(makeDeps());

    expect(engine.evaluateTicker('AAPL', BAR_DATE)).toBe('emitted');
    expect(engine.evaluateTicker('AAPL', BAR_DATE)).toBe('already-processed');
    expect(repo.listSignals()).toHaveLength(1);
    expect(broadcasted.filter((e) => e.channel === IPC_CHANNELS.signals.new)).toHaveLength(1);
    expect(submitted).toHaveLength(1);
  });

  it('idempotencia por la tabla: una señal ya persistida bloquea la reevaluación', () => {
    repo.insertSignal({
      ticker: 'AAPL',
      direction: 'largo',
      entry: 199,
      stop: 190,
      target: null,
      confidence: 0.5,
      reason: 'previa',
      strategies: [],
      dataUsed: {
        barDate: BAR_DATE,
        desde: BAR_DATE,
        hasta: BAR_DATE,
        barCount: 1,
        batchId: null,
        batchVersion: null,
        source: null,
      },
      decision: decision('aprobada'),
      barDate: BAR_DATE,
    });
    evaluables = [evaluable(1, () => buyer('AAPL', 190))];
    const engine = createSignalEngine(makeDeps());

    expect(engine.evaluateTicker('AAPL', BAR_DATE)).toBe('already-processed');
    expect(submitted).toHaveLength(0);
  });

  it('sin votos no emite ni ensucia el diario, pero marca la vela y el estado', () => {
    evaluables = [evaluable(1, quiet)];
    const engine = createSignalEngine(makeDeps());

    expect(engine.evaluateTicker('AAPL', BAR_DATE)).toBe('no-votes');
    expect(repo.listSignals()).toHaveLength(0);
    expect(journalEntries).toHaveLength(0);
    expect(processedMarks.has(`AAPL|${BAR_DATE}`)).toBe(true);
    expect(engine.listStrategyStates()[0]!.lastOutcome).toBe('sin-senal');
  });

  it('una estrategia que no cubre el activo no evalúa', () => {
    evaluables = [evaluable(1, () => buyer('MSFT'), { markets: ['MSFT'] })];
    const engine = createSignalEngine(makeDeps());

    expect(engine.evaluateTicker('AAPL', BAR_DATE)).toBe('no-votes');
    expect(engine.listStrategyStates()[0]!.lastOutcome).toBeNull();
  });

  it('un error de evaluación no detiene a las demás estrategias', () => {
    evaluables = [
      evaluable(1, () => ({
        init: () => undefined,
        onBar: () => {
          throw new Error('indicador roto');
        },
      })),
      evaluable(2, () => buyer('AAPL', 190)),
    ];
    const engine = createSignalEngine(makeDeps());

    expect(engine.evaluateTicker('AAPL', BAR_DATE)).toBe('emitted');

    const error = journalEntries.find((e) => e.type === 'error')!;
    expect(error.ticker).toBe('AAPL');
    expect(error.errors).toEqual(['indicador roto']);
    const states = engine.listStrategyStates();
    expect(states[0]!.lastOutcome).toBe('error');
    expect(states[1]!.lastOutcome).toBe('senal');
  });

  it('una venda (sell) propone dirección corto y entra en la pasarela como tal', () => {
    evaluables = [evaluable(1, () => seller('AAPL'))];
    const engine = createSignalEngine(makeDeps());

    expect(engine.evaluateTicker('AAPL', BAR_DATE)).toBe('emitted');
    expect(submitted[0]).toMatchObject({ direction: 'corto', stop: null, target: null });
  });

  it('handleBarStored dispara la evaluación del activo de la vela guardada', () => {
    evaluables = [evaluable(1, () => buyer('AAPL', 190))];
    const engine = createSignalEngine(makeDeps());

    engine.handleBarStored({
      ticker: 'AAPL',
      source: 'simulado',
      lastDate: BAR_DATE,
      updatedAt: new Date(NOW).toISOString(),
    });
    expect(repo.listSignals()).toHaveLength(1);

    // Evento sin fecha: no evalúa nada.
    engine.handleBarStored({
      ticker: 'MSFT',
      source: 'simulado',
      lastDate: null,
      updatedAt: new Date(NOW).toISOString(),
    });
    expect(repo.listSignals()).toHaveLength(1);
  });

  it('evaluateNow recorre la lista de seguimiento y resume la pasada', () => {
    evaluables = [
      evaluable(1, () => buyer('AAPL', 190), { markets: ['AAPL'] }),
      evaluable(2, () => seller('MSFT'), { markets: ['MSFT'] }),
    ];
    const engine = createSignalEngine(makeDeps());

    const result = engine.evaluateNow();
    expect(result).toMatchObject({ tickers: 2, emitted: 2, contradictions: 0 });
    expect(
      repo
        .listSignals()
        .map((s) => s.ticker)
        .sort(),
    ).toEqual(['AAPL', 'MSFT']);

    // Segunda pasada: todo ya procesado.
    expect(engine.evaluateNow()).toMatchObject({ tickers: 0, emitted: 0, contradictions: 0 });
  });

  it('evaluateNow no hace nada con las guardas activas', () => {
    flags.paused = true;
    evaluables = [evaluable(1, () => buyer('AAPL', 190))];
    const engine = createSignalEngine(makeDeps());

    expect(engine.evaluateNow()).toMatchObject({ tickers: 0, emitted: 0, contradictions: 0 });
  });

  it('stop() bloquea evaluaciones posteriores', () => {
    evaluables = [evaluable(1, () => buyer('AAPL', 190))];
    const engine = createSignalEngine(makeDeps());
    engine.stop();
    expect(engine.evaluateTicker('AAPL', BAR_DATE)).toBe('blocked');
  });
});

describe('confianza de los votos', () => {
  it('usa la tasa de acierto del backtest de la versión, acotada a 0–1', () => {
    expect(voteConfidence(makeFicha(1, { metricsSummary: metrics(64) }))).toBeCloseTo(0.64);
    expect(voteConfidence(makeFicha(1, { metricsSummary: metrics(150) }))).toBe(1);
    expect(voteConfidence(makeFicha(1, { metricsSummary: metrics(-5) }))).toBe(0);
  });

  it('sin métricas de la versión usa la confianza neutral', () => {
    expect(voteConfidence(makeFicha(1))).toBe(SIGNAL_DEFAULT_CONFIDENCE);
    expect(
      voteConfidence(makeFicha(1, { metricsSummary: { ...metrics(0), winRatePct: null } })),
    ).toBe(SIGNAL_DEFAULT_CONFIDENCE);
  });
});

function metrics(winRatePct: number) {
  return {
    totalReturnPct: 10,
    maxDrawdownPct: 5,
    sharpe: 1.2,
    profitFactor: 1.8,
    winRatePct,
    expectancy: 50,
    maxLosingStreak: 3,
    trades: 40,
  };
}
