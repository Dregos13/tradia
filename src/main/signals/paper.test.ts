import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JournalRecordInput } from '../../shared/journal';
import type { MarketUpdatedEvent } from '../../shared/ipc';
import { RISK_DEFAULTS, type RiskLimits } from '../../shared/risk';
import type { Signal, SignalNewEvent } from '../../shared/signals';
// Los evaluadores puros de portfolio sí son importables (regla eslint);
// los escritores del motor de riesgo no: la pasarela del test es memoria.
import {
  drawdownPct,
  lossPctSince,
  periodStartUtc,
  type LossPeriod,
  type NewPaperPosition,
  type PaperCloseRequest,
  type PaperCloseResult,
  type PaperPositionRecord,
  type PaperRiskState,
} from '../risk/portfolio';
import type { SignalSourceBar } from './engine';
import {
  createPaperTracker,
  evaluatePaperExit,
  type PaperPositionGateway,
  type PaperTracker,
} from './paper';

const NOW = Date.parse('2026-10-09T21:00:00.000Z');

let tracker: PaperTracker;
let journal: JournalRecordInput[];
let alerts: { title: string; body: string }[];
let observedLosses: number[];
let observedDrawdowns: number[];
let bars: Map<string, SignalSourceBar>;
let signalsById: Map<number, Signal>;
let limits: RiskLimits;
let positions: Map<number, PaperPositionRecord>;
let equityHistory: { at: string; equity: number }[];
let nextPositionId: number;

const equity = (): number => equityHistory[equityHistory.length - 1]!.equity;

const fakeRiskState = (): PaperRiskState => {
  const nowIso = new Date(NOW).toISOString();
  const points = equityHistory.map((p) => ({ at: p.at, equity: p.equity }));
  const loss = (period: LossPeriod): number => {
    const start = periodStartUtc(nowIso, period);
    return start === null ? 0 : lossPctSince(points, equity(), start.toISOString());
  };
  return {
    equity: equity(),
    dailyLossPct: loss('day'),
    weeklyLossPct: loss('week'),
    monthlyLossPct: loss('month'),
    drawdownPct: drawdownPct(points, equity()),
  };
};

/** Pasarela de la cartera en memoria (la real es services.risk sobre SQLite). */
const fakeGateway = (): PaperPositionGateway => ({
  listPaperPositions: (ticker) =>
    [...positions.values()].filter(
      (p) => p.closedAt === null && (ticker === undefined || p.ticker === ticker),
    ),
  openPaperPosition: (input: NewPaperPosition) => {
    const position: PaperPositionRecord = {
      ...input,
      id: nextPositionId++,
      closedAt: null,
      exit: null,
      exitReason: null,
    };
    positions.set(position.id, position);
    return position;
  },
  closePaperPosition: (request: PaperCloseRequest): PaperCloseResult | null => {
    const position = positions.get(request.positionId);
    if (position === undefined || position.closedAt !== null) return null;
    const sign = position.direction === 'largo' ? 1 : -1;
    const pnl = (request.exit - position.entry) * position.size * sign;
    const next = equity() + pnl;
    equityHistory.push({ at: request.closedAt, equity: next });
    position.closedAt = request.closedAt;
    position.exit = request.exit;
    position.exitReason = request.exitReason;
    return { position, exit: request.exit, exitReason: request.exitReason, pnl, equity: next };
  },
  getPaperRiskState: fakeRiskState,
  getLimits: () => limits,
});

const approvedSignal = (patch: Partial<Signal> = {}): Signal => ({
  id: 1,
  ticker: 'AAPL',
  direction: 'largo',
  entry: 100,
  stop: 95,
  target: 120,
  confidence: 0.7,
  reason: 'Cruce 50/200 alcista',
  strategies: [
    {
      strategyId: 3,
      name: 'Cruce',
      version: 2,
      direction: 'largo',
      confidence: 0.7,
      reason: 'Cruce 50/200 alcista',
    },
  ],
  dataUsed: {
    barDate: '2026-10-08',
    desde: '2026-01-01',
    hasta: '2026-10-08',
    barCount: 200,
    batchId: 1,
    batchVersion: 1,
    source: 'simulado',
  },
  decision: {
    status: 'aprobada',
    size: 10,
    sizeFactor: 1,
    riskAmount: 50,
    notional: 1000,
    reasons: [],
    decidedAt: new Date(NOW).toISOString(),
  },
  createdAt: new Date(NOW).toISOString(),
  ...patch,
});

const emitSignal = (signal: Signal): void => {
  signalsById.set(signal.id, signal);
  const event: SignalNewEvent = { signal };
  tracker.handleSignalEvent(event);
};

/** Vela que dispara el seguimiento para el ticker dado. */
const fireBar = (
  ticker: string,
  bar: Omit<SignalSourceBar, 'batchId' | 'source' | 'volume'>,
): void => {
  bars.set(`${ticker}|${bar.date}`, { volume: 0, batchId: 1, source: 'simulado', ...bar });
  const event: MarketUpdatedEvent = {
    ticker,
    source: 'simulado',
    lastDate: bar.date,
    updatedAt: new Date(NOW).toISOString(),
  };
  tracker.handleBarStored(event);
};

const openPositions = (): PaperPositionRecord[] =>
  [...positions.values()].filter((p) => p.closedAt === null);

beforeEach(() => {
  journal = [];
  alerts = [];
  observedLosses = [];
  observedDrawdowns = [];
  bars = new Map();
  signalsById = new Map();
  positions = new Map();
  nextPositionId = 1;
  equityHistory = [{ at: '2026-10-08T00:00:00.000Z', equity: 100_000 }];
  limits = { ...RISK_DEFAULTS };
  tracker = createPaperTracker({
    gateway: fakeGateway(),
    barAt: (ticker, date) => bars.get(`${ticker}|${date}`) ?? null,
    getSignal: (id) => signalsById.get(id) ?? null,
    recordJournal: (input) => journal.push(input),
    sendLimitAlert: (message) => alerts.push(message),
    observeDailyLoss: (pct) => observedLosses.push(pct),
    observeDrawdown: (pct) => observedDrawdowns.push(pct),
    now: () => NOW,
  });
});

afterEach(() => {
  tracker.stop();
});

describe('evaluatePaperExit · semántica del backtest', () => {
  const largo = { direction: 'largo' as const, stop: 95, target: 120 };
  const corto = { direction: 'corto' as const, stop: 110, target: 90 };

  it('largo: el stop se evalúa antes que el objetivo en la misma vela', () => {
    // La vela toca los dos niveles: cuenta el stop.
    const hit = evaluatePaperExit(largo, { open: 100, high: 125, low: 90 });
    expect(hit).toMatchObject({ reason: 'stop', exit: 95 });
  });

  it('largo: un hueco por debajo del stop ejecuta a la apertura', () => {
    const hit = evaluatePaperExit(largo, { open: 90, high: 92, low: 88 });
    expect(hit).toMatchObject({ reason: 'stop', exit: 90 });
  });

  it('largo: el objetivo se ejecuta a su nivel (o a la apertura si hay hueco al alza)', () => {
    expect(evaluatePaperExit(largo, { open: 100, high: 121, low: 99 })).toMatchObject({
      reason: 'objetivo',
      exit: 120,
    });
    expect(evaluatePaperExit(largo, { open: 125, high: 126, low: 119 })).toMatchObject({
      reason: 'objetivo',
      exit: 125,
    });
  });

  it('corto: simetría — stop arriba con hueco a la apertura, objetivo abajo', () => {
    expect(evaluatePaperExit(corto, { open: 112, high: 113, low: 105 })).toMatchObject({
      reason: 'stop',
      exit: 112,
    });
    expect(evaluatePaperExit(corto, { open: 100, high: 108, low: 85 })).toMatchObject({
      reason: 'objetivo',
      exit: 90,
    });
  });

  it('devuelve null si la vela no toca ningún nivel', () => {
    expect(evaluatePaperExit(largo, { open: 100, high: 110, low: 96 })).toBeNull();
    expect(evaluatePaperExit(corto, { open: 100, high: 108, low: 92 })).toBeNull();
  });
});

describe('seguimiento de posiciones simuladas', () => {
  it('una señal aprobada abre la posición con el tamaño de la pasarela', () => {
    emitSignal(approvedSignal());

    const [position] = openPositions();
    expect(position).toMatchObject({
      ticker: 'AAPL',
      direction: 'largo',
      entry: 100,
      stop: 95,
      target: 120,
      size: 10,
      signalId: 1,
      openedOnBar: '2026-10-08',
    });
  });

  it('una señal vetada o de tamaño cero no abre posición', () => {
    emitSignal(
      approvedSignal({ decision: { ...approvedSignal().decision, status: 'vetada', size: 0 } }),
    );
    emitSignal(approvedSignal({ id: 2, decision: { ...approvedSignal().decision, size: 0 } }));
    expect(openPositions()).toHaveLength(0);
  });

  it('la vela de la señal no cierra la posición recién abierta', () => {
    emitSignal(approvedSignal());
    // La vela de apertura ('2026-10-08') toca el stop: no debe evaluarse.
    fireBar('AAPL', { date: '2026-10-08', open: 100, high: 101, low: 90, close: 100 });
    expect(openPositions()).toHaveLength(1);
    expect(journal.filter((e) => e.type === 'operacion')).toHaveLength(0);
  });

  it('cierra por stop en la vela posterior y anota pérdida, capital y diario', () => {
    emitSignal(approvedSignal());
    fireBar('AAPL', { date: '2026-10-09', open: 99, high: 100, low: 94, close: 96 });

    expect(openPositions()).toHaveLength(0);
    // 10 uds × (95 − 100) = −50 sobre los 100 000 iniciales.
    expect(equity()).toBeCloseTo(99_950);

    const entry = journal.find((e) => e.type === 'operacion');
    expect(entry).toMatchObject({ ticker: 'AAPL', result: 'perdida', signalId: 1 });
    expect(entry?.dataUsed).toMatchObject({
      entrada: 100,
      salida: 95,
      motivoSalida: 'stop',
      pnl: -50,
      velaCierre: '2026-10-09',
    });
    expect(entry?.strategies).toEqual([{ strategyId: 3, name: 'Cruce', version: 2 }]);
    expect(entry?.ruleChecks?.every((r) => r.cumplida) ?? false).toBe(true);
  });

  it('cierra por objetivo con resultado ganancia', () => {
    emitSignal(approvedSignal());
    fireBar('AAPL', { date: '2026-10-09', open: 105, high: 122, low: 104, close: 121 });

    const entry = journal.find((e) => e.type === 'operacion');
    expect(entry).toMatchObject({ result: 'ganancia' });
    expect(entry?.dataUsed).toMatchObject({ salida: 120, motivoSalida: 'objetivo', pnl: 200 });
    expect(equity()).toBeCloseTo(100_200);
  });

  it('un hueco que salta el stop ejecuta a la apertura de la vela', () => {
    emitSignal(approvedSignal());
    // Abre a 90, por debajo del stop (95): ejecuta a 90, no al stop.
    fireBar('AAPL', { date: '2026-10-09', open: 90, high: 92, low: 88, close: 91 });

    const entry = journal.find((e) => e.type === 'operacion');
    expect(entry?.dataUsed).toMatchObject({ salida: 90, motivoSalida: 'stop', pnl: -100 });
  });

  it('una posición corta cierra por su stop al alza', () => {
    emitSignal(approvedSignal({ direction: 'corto', stop: 110, target: 90 }));
    fireBar('AAPL', { date: '2026-10-09', open: 108, high: 111, low: 107, close: 110 });

    const entry = journal.find((e) => e.type === 'operacion');
    // Corto: pnl = (100 − 110) × 10 = −100.
    expect(entry).toMatchObject({ result: 'perdida' });
    expect(entry?.dataUsed).toMatchObject({ salida: 110, pnl: -100 });
  });

  it('la misma vela no cierra dos veces la posición', () => {
    emitSignal(approvedSignal());
    fireBar('AAPL', { date: '2026-10-09', open: 99, high: 100, low: 94, close: 96 });
    fireBar('AAPL', { date: '2026-10-09', open: 99, high: 100, low: 94, close: 96 });

    expect(journal.filter((e) => e.type === 'operacion')).toHaveLength(1);
    expect(equityHistory).toHaveLength(2);
  });

  it('al alcanzar un límite emite el aviso, el diario limite y alimenta la parada', () => {
    limits = { ...limits, maxDrawdownPct: 10, maxDailyLossPct: 2 };
    // Pico histórico 100 000; el cierre deja el capital en 85 000:
    // drawdown del 15 % y pérdida del periodo del 15 %.
    equityHistory = [
      { at: '2026-10-01T00:00:00.000Z', equity: 100_000 },
      { at: '2026-10-08T00:00:00.000Z', equity: 100_000 },
    ];
    // 1 000 uds × (85 − 100) = −15 000 realizados.
    emitSignal(approvedSignal({ decision: { ...approvedSignal().decision, size: 1_000 } }));
    fireBar('AAPL', { date: '2026-10-09', open: 85, high: 86, low: 84, close: 85 });

    const limitEntries = journal.filter((e) => e.type === 'limite');
    const codes = limitEntries.map((e) => e.ruleChecks?.[0]?.code);
    expect(codes).toContain('MAX_DRAWDOWN');
    expect(codes).toContain('DAILY_LOSS');
    expect(limitEntries.every((e) => e.result === 'alcanzado')).toBe(true);

    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]!.title).toContain('Límites alcanzados');
    expect(observedDrawdowns.at(-1)).toBeCloseTo(15, 0);

    // No repite el aviso mientras el límite siga violado.
    const count = limitEntries.length;
    fireBar('AAPL', { date: '2026-10-12', open: 86, high: 87, low: 85, close: 86 });
    fireBar('AAPL', { date: '2026-10-13', open: 86, high: 87, low: 85, close: 86 });
    expect(journal.filter((e) => e.type === 'limite')).toHaveLength(count);
  });

  it('la pérdida por debajo del límite no emite aviso pero alimenta la parada', () => {
    emitSignal(approvedSignal());
    fireBar('AAPL', { date: '2026-10-09', open: 99, high: 100, low: 94, close: 96 });

    expect(journal.filter((e) => e.type === 'limite')).toHaveLength(0);
    expect(alerts).toHaveLength(0);
    // 0,05 % de pérdida: llega al observador (su umbral es 1,5 × límite).
    expect(observedLosses.at(-1)).toBeCloseTo(0.05, 1);
  });
});
