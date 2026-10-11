/**
 * Pruebas del servicio de degradación: PSI sostenido, Brier móvil,
 * revisión mensual de estrategias, transición a «degradada» con sus
 * efectos (registro, Diario, notificación crítica y propuesta
 * trimestral) y el simulador E2E. Reglas del contrato:
 * una racha mala aislada nunca degrada nada.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEGRADE_MIN_TRADES,
  DRIFT_BRIER_WINDOW,
  DRIFT_PSI_THRESHOLD,
  DRIFT_SUSTAIN_SESSIONS,
  driftPsiKey,
  type FeatureReference,
  type ModelCard,
} from '../../../shared/ai';
import type { NotificationPayload } from '../../../shared/ipc';
import { IPC_CHANNELS } from '../../../shared/ipc';
import type { JournalRecordInput } from '../../../shared/journal';
import type { StrategyStatus, StrategySummary } from '../../../shared/strategy';
import type { ClosedTrade, StrategyExpectation } from '../../broker/deviation';
import { openDatabase } from '../../db/database';
import { createStrategiesRepository } from '../../strategies/repository';
import { parseModelCard } from '../prediction/modelCard';
import { createPredictionsRepository } from '../prediction/repository';
import {
  FEATURE_NAMES,
  featureRowAt,
  precomputeFeatures,
  type PredictionCandle,
} from '../prediction/features';
import { createDriftRepository, type DriftRepository } from './repository';
import { createDriftService, MODEL_DEGRADED_MARK, type DriftService } from './service';

const HASH = 'a'.repeat(64);
const NOW_MS = Date.parse('2026-10-10T17:30:00.000Z');
const NEXT_MONTH_MS = Date.parse('2026-11-10T17:30:00.000Z');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Referencia PSI derivada de la propia muestra estable (cuartiles con
 * proporciones reales): con los mismos datos el PSI sale 0 por
 * construcción y cualquier desplazamiento lo dispara de verdad.
 */
const referenceFromCandles = (candles: PredictionCandle[]): FeatureReference[] => {
  const series = precomputeFeatures(candles);
  const rows: number[][] = [];
  for (let t = Math.max(0, candles.length - 20); t < candles.length; t += 1) {
    const row = featureRowAt(series, candles, t);
    if (row !== null) rows.push(row);
  }
  const refFor = (name: string): FeatureReference => {
    const index = FEATURE_NAMES.indexOf(name as (typeof FEATURE_NAMES)[number]);
    const sorted = rows.map((row) => row[index]!).sort((a, b) => a - b);
    const n = sorted.length;
    const edges = [...new Set([n >> 2, n >> 1, (3 * n) >> 2].map((i) => sorted[i]!))];
    const bins: FeatureReference['bins'] = [];
    let prev: number | null = null;
    let used = 0;
    for (const edge of edges) {
      const count = sorted.filter((v) => (prev === null || v >= prev) && v < edge).length;
      used += count;
      bins.push({ from: prev, to: edge, proportion: count / n });
      prev = edge;
    }
    bins.push({ from: prev, to: null, proportion: (n - used) / n });
    return { name, mean: null, std: null, bins };
  };
  return ['ret_1', 'ret_5'].map(refFor);
};

let referenceDistribution: FeatureReference[] = [];

const cardJson = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: '0.1.0',
  hash: HASH,
  horizonDays: 5,
  trainingPeriod: { startDate: '2020-01-01', endDate: '2021-12-31' },
  calibrationPeriod: { startDate: '2022-01-01', endDate: '2022-06-30' },
  testPeriod: { startDate: '2022-07-01', endDate: '2022-12-31' },
  dataOrigin: 'real',
  metrics: { brierOos: 0.18, logLossOos: 0.55, brierBaseline: 0.25 },
  calibration: [],
  referenceDistribution,
  trainedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

/** 90 sesiones con variación suave; con `shift`, las 20 últimas suben +2 %/día. */
function makeCandles(shift: boolean, days = 90): PredictionCandle[] {
  const candles: PredictionCandle[] = [];
  let close = 100;
  const start = Date.parse('2026-06-01T00:00:00.000Z');
  for (let i = 0; i < days; i += 1) {
    const drifted = shift && i >= days - 20;
    const ret = drifted ? 0.02 : 0.001 + 0.004 * Math.sin(i * 0.9);
    const open = close;
    close *= 1 + ret;
    candles.push({
      date: new Date(start + i * 86_400_000).toISOString().slice(0, 10),
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 1_000_000,
    });
  }
  return candles;
}

/** Ficha real en `strategies` (la propuesta referencia su id por FK). */
const seedFicha = (
  name: string,
  status: StrategyStatus = 'activa',
  maxLosingStreak = 6,
): StrategySummary => {
  const strategies = createStrategiesRepository(db);
  const created = strategies.create({
    name,
    hypothesis: 'hipótesis de prueba',
    rules: { entry: 'e', exit: 'x', stop: 's', target: 't' },
    parameters: {},
    markets: ['SPY'],
    regime: 'tendencia',
  });
  if (status !== 'investigacion') strategies.setStatus({ id: created.id, status });
  strategies.setVersionMetrics(created.id, {
    totalReturnPct: 12,
    maxDrawdownPct: 8,
    sharpe: 1,
    profitFactor: 1.4,
    winRatePct: 55,
    expectancy: 30,
    maxLosingStreak,
    trades: 120,
  });
  return strategies.list().find((item) => item.id === created.id)!;
};

const trade = (strategyId: number, returnPct: number, i: number): ClosedTrade => ({
  strategyId,
  signalKey: `s${i}`,
  ticker: 'SPY',
  entryOrderId: i * 2,
  exitOrderId: i * 2 + 1,
  returnPct,
  closedAtNy: '2026-10-09',
  slippageBps: [],
});

// ---------------------------------------------------------------------------
// Montaje del servicio con espías
// ---------------------------------------------------------------------------

let db: Database.Database;
let repo: DriftRepository;
let nowMs: number;
let trades: ClosedTrade[];
let expectations: Record<number, StrategyExpectation>;
let fichas: StrategySummary[];
let journal: JournalRecordInput[];
let notices: NotificationPayload[];
let emitted: { channel: string; payload: unknown }[];
let statusCalls: { id: number; status: string; note?: string }[];
let bars: PredictionCandle[];
let online: boolean;

const makeService = (): DriftService =>
  createDriftService({
    repo,
    listWatchlistTickers: () => ['AAPL'],
    barsFor: () => bars,
    listStrategies: () => fichas,
    setStrategyStatus: (request) => {
      statusCalls.push({ id: request.id, status: request.status, note: request.note });
      const ficha = fichas.find((f) => f.id === request.id);
      if (ficha !== undefined) ficha.status = request.status;
    },
    closedTrades: () => trades,
    expectationFor: (id) =>
      expectations[id] ?? {
        perTradeReturnPct: null,
        winRate: null,
        backtestVersion: null,
        backtestRunId: null,
      },
    recordJournal: (input) => journal.push(input),
    notify: (payload) => notices.push(payload),
    broadcast: (channel, payload) => emitted.push({ channel, payload }),
    isOnline: () => online,
    now: () => nowMs,
  });

const registerCard = (): ModelCard =>
  createPredictionsRepository(db).registerModelCard(parseModelCard(cardJson()));

beforeEach(() => {
  db = openDatabase(':memory:');
  repo = createDriftRepository(db);
  nowMs = NOW_MS;
  trades = [];
  expectations = {};
  fichas = [];
  journal = [];
  notices = [];
  emitted = [];
  statusCalls = [];
  bars = [];
  online = true;
  referenceDistribution = referenceFromCandles(makeCandles(false));
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Drift de datos (PSI)
// ---------------------------------------------------------------------------

describe('drift de datos (PSI por variable)', () => {
  it('sin desplazamiento no hay alerta ni falsas alarmas', () => {
    registerCard();
    bars = makeCandles(false);
    const checks = makeService().evaluate();
    const datos = checks.find((c) => c.kind === 'datos');
    expect(datos).toBeDefined();
    expect(datos!.drifted).toBe(false);
    expect(datos!.streak).toBe(0);
    expect(datos!.detail[driftPsiKey('ret_1')]).toBeLessThanOrEqual(DRIFT_PSI_THRESHOLD);
    expect(notices).toHaveLength(0);
    expect(journal).toHaveLength(0);
  });

  it('un desplazamiento de 2 variables marca la revisión como alerta', () => {
    registerCard();
    bars = makeCandles(true);
    const datos = makeService()
      .evaluate()
      .find((c) => c.kind === 'datos')!;
    expect(datos.drifted).toBe(true);
    expect(datos.streak).toBe(1);
    expect(datos.detail[driftPsiKey('ret_1')]).toBeGreaterThan(DRIFT_PSI_THRESHOLD);
    expect(datos.detail[driftPsiKey('ret_5')]).toBeGreaterThan(DRIFT_PSI_THRESHOLD);
  });

  it('20 sesiones sostenidas degradan la ficha y dejan todos los efectos', () => {
    const card = registerCard();
    bars = makeCandles(true);
    // 19 revisiones previas ya en alerta: la de hoy cruza el umbral.
    for (let i = DRIFT_SUSTAIN_SESSIONS - 1; i >= 1; i -= 1) {
      repo.insertCheck({
        subject: 'modelo',
        subjectId: card.id,
        subjectName: 'modelo',
        kind: 'datos',
        streak: DRIFT_SUSTAIN_SESSIONS - i,
        detail: { [driftPsiKey('ret_1')]: 0.4, [driftPsiKey('ret_5')]: 0.4 },
        drifted: true,
        evaluatedAt: new Date(NOW_MS - i * 86_400_000).toISOString(),
      });
    }
    const service = makeService();
    service.evaluate();

    const marked = createPredictionsRepository(db).modelCard(card.version, card.hash)!;
    expect(marked.eligible).toBe(false);
    expect(marked.ineligibleReason).toContain(MODEL_DEGRADED_MARK);
    expect(journal.some((e) => e.type === 'limite' && e.result === 'alcanzado')).toBe(true);
    expect(notices.some((n) => n.level === 'critica' && n.navigateTo === 'salud-modelos')).toBe(
      true,
    );
    expect(repo.listProposals()).toHaveLength(1);
    expect(repo.listProposals()[0]).toMatchObject({
      modelCardId: card.id,
      strategyId: null,
      quarter: '2026-Q4',
      status: 'pendiente',
    });
    expect(emitted.some((b) => b.channel === IPC_CHANNELS.ai.changed)).toBe(true);

    const row = service.overview().subjects.find((s) => s.subject === 'modelo')!;
    expect(row.state).toBe('degradada');
    expect(row.dataDrift?.driftSince).not.toBeNull();
  });

  it('la persistencia solo avanza con sesiones nuevas: los mismos datos congelan la racha', () => {
    registerCard();
    bars = makeCandles(true);
    const service = makeService();
    const first = service.evaluate().find((c) => c.kind === 'datos')!;
    expect(first.drifted).toBe(true);
    expect(first.streak).toBe(1);
    expect(first.detail.ultimaVela).toBe(bars.at(-1)!.date);

    // La revisión del día siguiente ve los mismos datos: la racha no
    // suma una sesión fantasma y queda marcada «sin datos nuevos».
    nowMs += 86_400_000;
    const second = service.evaluate().find((c) => c.kind === 'datos')!;
    expect(second.drifted).toBe(true);
    expect(second.streak).toBe(1);
    expect(second.detail.sinDatosNuevos).toBe('si');

    // Cuando llega una vela nueva la racha retoma su avance.
    nowMs += 86_400_000;
    const last = bars.at(-1)!;
    bars = [
      ...bars,
      {
        date: '2026-08-30',
        open: last.close,
        high: last.close * 1.001,
        low: last.close * 0.999,
        close: last.close * 1.02,
        volume: 1_000_000,
      },
    ];
    const third = service.evaluate().find((c) => c.kind === 'datos')!;
    expect(third.streak).toBe(2);
  });

  it('una segunda evaluación el mismo día no duplica revisiones', () => {
    registerCard();
    bars = makeCandles(true);
    const service = makeService();
    const first = service.evaluate();
    const second = service.evaluate();
    expect(first.length).toBeGreaterThan(0);
    expect(second.filter((c) => c.kind === 'datos')).toHaveLength(0);
  });

  it('sin conexión la revisión queda en pausa', () => {
    registerCard();
    bars = makeCandles(true);
    online = false;
    expect(makeService().evaluate()).toHaveLength(0);
    expect(repo.latestCheck('modelo', 1, 'datos')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Drift de resultados (Brier móvil)
// ---------------------------------------------------------------------------

const seedResolvedPredictions = (cardId: number, count: number, brier: number): void => {
  const predictions = createPredictionsRepository(db);
  for (let i = 0; i < count; i += 1) {
    const { prediction } = predictions.upsertPrediction({
      ticker: 'AAPL',
      session: `2026-08-${String(i + 1).padStart(2, '0')}`,
      horizonDays: 5,
      probUp: 0.6,
      expectedVolatility: null,
      modelVersion: '0.1.0',
      modelHash: HASH,
      modelCardId: cardId,
    });
    predictions.resolvePrediction(prediction.id, {
      session: '2026-09-01',
      outcomeUp: true,
      realizedBrier: brier,
    });
  }
};

describe('drift de resultados (Brier móvil)', () => {
  it('sin ventana completa no hay delta ni alerta', () => {
    const card = registerCard();
    seedResolvedPredictions(card.id, 10, 0.5);
    const check = makeService()
      .evaluate()
      .find((c) => c.kind === 'resultados')!;
    expect(check.drifted).toBe(false);
    expect(check.detail.delta).toBeUndefined();
    const row = makeService().overview().subjects[0]!;
    expect(row.resultsDrift?.resolvedCount).toBe(10);
  });

  it('ventana móvil por encima de la ficha alerta; sostenida degrada el modelo', () => {
    const card = registerCard();
    seedResolvedPredictions(card.id, DRIFT_BRIER_WINDOW, 0.5); // delta ≈ +0,32
    for (let i = DRIFT_SUSTAIN_SESSIONS - 1; i >= 1; i -= 1) {
      repo.insertCheck({
        subject: 'modelo',
        subjectId: card.id,
        subjectName: 'modelo',
        kind: 'resultados',
        streak: DRIFT_SUSTAIN_SESSIONS - i,
        detail: { rollingBrier: 0.5, cardBrier: 0.18, delta: 0.32, resolvedCount: 59 },
        drifted: true,
        evaluatedAt: new Date(NOW_MS - i * 86_400_000).toISOString(),
      });
    }
    makeService().evaluate();
    const check = repo.latestCheck('modelo', card.id, 'resultados')!;
    expect(check.streak).toBe(DRIFT_SUSTAIN_SESSIONS);
    const marked = createPredictionsRepository(db).modelCard(card.version, card.hash)!;
    expect(marked.ineligibleReason).toContain(MODEL_DEGRADED_MARK);
    expect(notices.some((n) => n.level === 'critica')).toBe(true);
    expect(repo.listProposals()).toHaveLength(1);
  });

  it('sin resoluciones nuevas el drift de resultados tampoco suma sesión', () => {
    const card = registerCard();
    seedResolvedPredictions(card.id, DRIFT_BRIER_WINDOW, 0.5); // delta ≈ +0,32
    const service = makeService();
    const first = service.evaluate().find((c) => c.kind === 'resultados')!;
    expect(first.drifted).toBe(true);
    expect(first.streak).toBe(1);

    nowMs += 86_400_000;
    const second = service.evaluate().find((c) => c.kind === 'resultados')!;
    expect(second.streak).toBe(1);
    expect(second.detail.sinDatosNuevos).toBe('si');
  });

  it('un Brier móvil en línea con la ficha no alerta', () => {
    const card = registerCard();
    seedResolvedPredictions(card.id, DRIFT_BRIER_WINDOW, 0.18);
    const check = makeService()
      .evaluate()
      .find((c) => c.kind === 'resultados')!;
    expect(check.drifted).toBe(false);
    expect(check.streak).toBe(0);
  });

  it('con la ventana resuelta, Brier móvil y diferencia llegan en número aunque la revisión sea vieja', () => {
    const card = registerCard();
    // Reproduce el caso de QA: la revisión diaria corrió cuando aún no
    // había resoluciones; el resolvedCount en vivo ya dice 60 pero la
    // revisión guardada no tiene rollingBrier. La vista debe dar los
    // números en vivo, no «Sin referencia».
    makeService().evaluate();
    expect(repo.latestCheck('modelo', card.id, 'resultados')!.detail.rollingBrier).toBeUndefined();

    seedResolvedPredictions(card.id, DRIFT_BRIER_WINDOW, 0.22);
    const row = makeService()
      .overview()
      .subjects.find((s) => s.subject === 'modelo')!;
    expect(row.resultsDrift?.resolvedCount).toBe(DRIFT_BRIER_WINDOW);
    expect(row.resultsDrift?.rollingBrier).toBeCloseTo(0.22, 4);
    expect(row.resultsDrift?.delta).toBeCloseTo(0.04, 4);
    expect(row.resultsDrift?.missingReason ?? null).toBeNull();
  });

  it('sin resueltas el Brier móvil es null con el motivo; con ventana incompleta, la diferencia', () => {
    const card = registerCard();
    const empty = makeService()
      .overview()
      .subjects.find((s) => s.subject === 'modelo')!;
    expect(empty.resultsDrift?.rollingBrier).toBeNull();
    expect(empty.resultsDrift?.delta).toBeNull();
    expect(empty.resultsDrift?.missingReason).toContain('predicciones resueltas');

    seedResolvedPredictions(card.id, 10, 0.22);
    const partial = makeService()
      .overview()
      .subjects.find((s) => s.subject === 'modelo')!;
    expect(partial.resultsDrift?.rollingBrier).toBeCloseTo(0.22, 4);
    expect(partial.resultsDrift?.delta).toBeNull();
    expect(partial.resultsDrift?.missingReason).toContain('Ventana incompleta');
  });

  it('el motivo de degradación del modelo se compone sin puntuación duplicada', () => {
    const card = registerCard();
    repo.markModelCardDegraded(
      card.id,
      `${MODEL_DEGRADED_MARK}: Drift de datos sostenido: PSI > 0.25 en ret_1 durante 20 sesiones.`,
    );
    const row = makeService()
      .overview()
      .subjects.find((s) => s.subject === 'modelo')!;
    expect(row.state).toBe('degradada');
    expect(row.reason).toBe(
      'Degradada por drift sostenido: Drift de datos sostenido: PSI > 0.25 en ret_1 ' +
        'durante 20 sesiones. No se debe a una sola racha perdedora.',
    );
    expect(row.reason!).not.toMatch(/\.\.|:\./);
  });
});

// ---------------------------------------------------------------------------
// Rendimiento de estrategias (revisión mensual)
// ---------------------------------------------------------------------------

describe('revisión mensual de estrategias', () => {
  it('dos revisiones mensuales seguidas fuera del ±30 % degradan la ficha', () => {
    fichas = [seedFicha('Cruce de medias')];
    const strategyId = fichas[0]!.id;
    // 34 operaciones perdiendo de media mucho más que la expectativa.
    trades = Array.from({ length: DEGRADE_MIN_TRADES + 4 }, (_, i) => trade(strategyId, -1, i));
    expectations = {
      [strategyId]: {
        perTradeReturnPct: 0.2,
        winRate: 0.55,
        backtestVersion: 2,
        backtestRunId: 3,
      },
    };
    const service = makeService();

    const monthOne = service.evaluate().find((c) => c.kind === 'rendimiento')!;
    expect(monthOne.drifted).toBe(true);
    expect(monthOne.streak).toBe(1);
    expect(statusCalls).toHaveLength(0);
    expect(service.overview().subjects.find((s) => s.subject === 'estrategia')!.state).toBe(
      'observacion',
    );

    nowMs = NEXT_MONTH_MS;
    service.evaluate();
    expect(statusCalls).toEqual([expect.objectContaining({ id: strategyId, status: 'degradada' })]);
    expect(statusCalls[0]!.note).toContain('Degradada por drift sostenido');
    expect(
      journal.some((e) => e.type === 'limite' && e.strategies?.[0]?.strategyId === strategyId),
    ).toBe(true);
    expect(notices.some((n) => n.level === 'critica' && n.title.includes('Cruce de medias'))).toBe(
      true,
    );
    const proposals = repo.listProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ strategyId, status: 'pendiente' });

    const row = service.overview().subjects.find((s) => s.subject === 'estrategia')!;
    expect(row.state).toBe('degradada');
    expect(row.strategyEval?.consecutiveReviews).toBe(2);
  });

  it('una racha perdedora dentro del máximo del backtest queda en observación', () => {
    fichas = [seedFicha('Cruce de medias')];
    const strategyId = fichas[0]!.id;
    // 30 ganadoras + 4 perdedoras al final: racha de 4 < máximo 6 del backtest.
    trades = [
      ...Array.from({ length: DEGRADE_MIN_TRADES }, (_, i) => trade(strategyId, 0.8, i)),
      ...Array.from({ length: 4 }, (_, i) => trade(strategyId, -1, 100 + i)),
    ];
    expectations = {
      [strategyId]: {
        perTradeReturnPct: 0.75,
        winRate: 0.55,
        backtestVersion: 2,
        backtestRunId: 3,
      },
    };
    const service = makeService();
    service.evaluate();
    const check = repo.latestCheck('estrategia', strategyId, 'rendimiento')!;
    expect(check.drifted).toBe(false);
    expect(check.detail.losingStreak).toBe(4);
    expect(statusCalls).toHaveLength(0);
    expect(repo.listProposals()).toHaveLength(0);
    const row = service.overview().subjects.find((s) => s.subject === 'estrategia')!;
    expect(row.state).toBe('observacion');
    expect(row.reason).toContain('racha de 4 pérdidas dentro del máximo de backtest (6)');
    expect(row.strategyEval?.maxLosingStreakBacktest).toBe(6);
  });

  it('con menos de 30 operaciones la ficha queda «insuficiente»', () => {
    fichas = [seedFicha('Cruce de medias', 'paper')];
    const strategyId = fichas[0]!.id;
    trades = Array.from({ length: 12 }, (_, i) => trade(strategyId, -5, i));
    expectations = {
      [strategyId]: {
        perTradeReturnPct: 0.2,
        winRate: 0.55,
        backtestVersion: null,
        backtestRunId: null,
      },
    };
    const service = makeService();
    service.evaluate();
    const check = repo.latestCheck('estrategia', strategyId, 'rendimiento')!;
    expect(check.drifted).toBe(false);
    const row = service.overview().subjects.find((s) => s.subject === 'estrategia')!;
    expect(row.state).toBe('insuficiente');
    expect(row.reason).toContain('12 de 30 operaciones');
  });

  it('la segunda revisión del mismo mes no duplica la comprobación', () => {
    fichas = [seedFicha('Cruce de medias')];
    const strategyId = fichas[0]!.id;
    const service = makeService();
    service.evaluate();
    const again = service.evaluate().filter((c) => c.kind === 'rendimiento');
    expect(again).toHaveLength(0);
    expect(repo.listChecks('estrategia', strategyId, 'rendimiento')).toHaveLength(1);
  });

  it('dos revisiones a un día a caballo de fin de mes no cuentan como dos meses', () => {
    fichas = [seedFicha('Cruce de medias')];
    const strategyId = fichas[0]!.id;
    // Desviación de −40,8 pp sostenida: en alerta desde la primera revisión.
    trades = Array.from({ length: DEGRADE_MIN_TRADES + 4 }, (_, i) => trade(strategyId, -1, i));
    expectations = {
      [strategyId]: {
        perTradeReturnPct: 0.2,
        winRate: 0.55,
        backtestVersion: 2,
        backtestRunId: 3,
      },
    };
    const service = makeService();

    nowMs = Date.parse('2026-09-30T21:00:00.000Z');
    const first = service.evaluate().find((c) => c.kind === 'rendimiento')!;
    expect(first.drifted).toBe(true);
    expect(first.streak).toBe(1);
    expect(first.detail.ultimaOperacionCierre).toBe('2026-10-09');

    // 24 h después, mes nuevo pero mismas operaciones: la racha se
    // congela marcada «sinMesReal» en lugar de sumar una segunda.
    nowMs = Date.parse('2026-10-01T21:00:00.000Z');
    const second = service.evaluate().find((c) => c.kind === 'rendimiento')!;
    expect(second.drifted).toBe(true);
    expect(second.streak).toBe(1);
    expect(second.detail.sinMesReal).toBe('si');
    expect(statusCalls).toHaveLength(0);

    // Un mes real después la revisión sí cuenta y la racha retoma.
    nowMs = Date.parse('2026-11-02T21:00:00.000Z');
    service.evaluate();
    expect(statusCalls).toEqual([expect.objectContaining({ id: strategyId, status: 'degradada' })]);
  });

  it('con operaciones nuevas la segunda revisión sí cuenta aunque no haya pasado un mes', () => {
    fichas = [seedFicha('Cruce de medias')];
    const strategyId = fichas[0]!.id;
    trades = Array.from({ length: DEGRADE_MIN_TRADES + 4 }, (_, i) => trade(strategyId, -1, i));
    expectations = {
      [strategyId]: {
        perTradeReturnPct: 0.2,
        winRate: 0.55,
        backtestVersion: 2,
        backtestRunId: 3,
      },
    };
    const service = makeService();

    nowMs = Date.parse('2026-09-30T21:00:00.000Z');
    service.evaluate();
    expect(statusCalls).toHaveLength(0);

    // Al día siguiente hay una operación nueva: la revisión es evidencia
    // nueva y sí cuenta como segunda mensual.
    trades = [...trades, trade(strategyId, -2, 500)];
    nowMs = Date.parse('2026-10-01T21:00:00.000Z');
    const second = service.evaluate().find((c) => c.kind === 'rendimiento')!;
    expect(second.streak).toBe(2);
    expect(second.detail.sinMesReal).toBeUndefined();
    expect(statusCalls).toEqual([expect.objectContaining({ id: strategyId, status: 'degradada' })]);
  });

  it('la desviación llega en vivo aunque la revisión sea vieja; sin backtest, null con motivo', () => {
    fichas = [seedFicha('Cruce de medias'), seedFicha('Sin backtest', 'paper')];
    const conBacktest = fichas[0]!;
    const sinBacktest = fichas[1]!;
    trades = Array.from({ length: 10 }, (_, i) => trade(conBacktest.id, 0.4, i));
    expectations = {
      [conBacktest.id]: {
        perTradeReturnPct: 0.5,
        winRate: 0.55,
        backtestVersion: 2,
        backtestRunId: 3,
      },
    };
    // Sin ninguna revisión todavía, la vista da los números en vivo
    // (10 × 0,4 − 10 × 0,5 = −1 pp) en lugar de «0 · Sin referencia».
    const rows = makeService()
      .overview()
      .subjects.filter((s) => s.subject === 'estrategia');
    const evaluada = rows.find((s) => s.subjectId === conBacktest.id)!;
    expect(evaluada.strategyEval?.trades).toBe(10);
    expect(evaluada.strategyEval?.deviationPct).toBeCloseTo(-1, 4);
    expect(evaluada.strategyEval?.missingReason ?? null).toBeNull();

    const sinReferencia = rows.find((s) => s.subjectId === sinBacktest.id)!;
    expect(sinReferencia.strategyEval?.deviationPct).toBeNull();
    expect(sinReferencia.strategyEval?.missingReason).toContain('backtest');
  });
});

// ---------------------------------------------------------------------------
// Propuestas de reentrenamiento
// ---------------------------------------------------------------------------

describe('propuestas de reentrenamiento', () => {
  it('una segunda degradación el mismo trimestre no crea otra propuesta', () => {
    fichas = [seedFicha('Cruce de medias'), seedFicha('Reversión RSI', 'paper')];
    const service = makeService();
    service.simulateDrift({ kind: 'rendimiento', subjectId: fichas[0]!.id, streak: 2 });
    service.simulateDrift({ kind: 'rendimiento', subjectId: fichas[1]!.id, streak: 2 });
    const proposals = repo.listProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.quarter).toBe('2026-Q4');
  });

  it('aprobar deja constancia y entrega las instrucciones del pipeline', () => {
    fichas = [seedFicha('Cruce de medias')];
    const service = makeService();
    service.simulateDrift({ kind: 'rendimiento', subjectId: fichas[0]!.id, streak: 2 });
    const proposal = repo.listProposals()[0]!;
    const result = service.resolve({ id: proposal.id, action: 'aprobar' });
    expect(result.proposal.status).toBe('aprobada');
    expect(result.proposal.resolvedAt).not.toBeNull();
    expect(result.instructions).toContain('ml/export_candles.py');
    expect(result.instructions).toContain('ml/train.py');
    expect(result.instructions).toContain('--origin real');
    expect(journal.some((e) => e.reason.includes('Propuesta de reentrenamiento'))).toBe(true);
    // Resolverla otra vez falla: ya no está pendiente.
    expect(() => service.resolve({ id: proposal.id, action: 'aprobar' })).toThrow();
  });

  it('posponer exige fecha futura y la guarda con el motivo', () => {
    fichas = [seedFicha('Cruce de medias')];
    const service = makeService();
    service.simulateDrift({ kind: 'rendimiento', subjectId: fichas[0]!.id, streak: 2 });
    const proposal = repo.listProposals()[0]!;
    expect(() =>
      service.resolve({ id: proposal.id, action: 'posponer', postponeUntil: '2026-10-01' }),
    ).toThrow();
    const result = service.resolve({
      id: proposal.id,
      action: 'posponer',
      postponeUntil: '2027-03-01',
      note: 'esperar a más datos',
    });
    expect(result.proposal.status).toBe('pospuesta');
    expect(result.proposal.postponedUntil).toBe('2027-03-01');
    expect(result.proposal.note).toBe('esperar a más datos');
    expect(result.proposal.nextAllowedAt).toBe('2027-03-01');
    expect(result.instructions).toBeNull();
    // La decisión queda en el Diario con la fecha y el motivo, como al aprobar.
    const entry = journal.find((e) => e.reason.includes('pospuesta'));
    expect(entry).toBeDefined();
    expect(entry!.type).toBe('resumen');
    expect(entry!.reason).toContain('2027-03-01');
    expect(entry!.reason).toContain('esperar a más datos');
    expect(entry!.dataUsed?.['propuestaId']).toBe(proposal.id);
  });

  it('posponer con un motivo acabado en punto no deja «..» en el Diario', () => {
    fichas = [seedFicha('Cruce de medias')];
    const service = makeService();
    service.simulateDrift({ kind: 'rendimiento', subjectId: fichas[0]!.id, streak: 2 });
    const proposal = repo.listProposals()[0]!;
    service.resolve({
      id: proposal.id,
      action: 'posponer',
      postponeUntil: '2027-03-01',
      note: 'esperar al próximo trimestre.',
    });
    const entry = journal.find((e) => e.reason.includes('pospuesta'));
    expect(entry).toBeDefined();
    expect(entry!.reason).not.toContain('..');
    expect(entry!.reason).toContain('esperar al próximo trimestre.');
  });
});

// ---------------------------------------------------------------------------
// Simulador E2E
// ---------------------------------------------------------------------------

describe('simulateDrift', () => {
  it('datos con persistencia suficiente degrada el modelo', () => {
    registerCard();
    const service = makeService();
    const view = service.simulateDrift({ kind: 'datos', streak: DRIFT_SUSTAIN_SESSIONS });
    const row = view.subjects.find((s) => s.subject === 'modelo')!;
    expect(row.state).toBe('degradada');
    expect(view.proposals).toHaveLength(1);
    expect(repo.latestCheck('modelo', row.subjectId, 'datos')!.streak).toBe(DRIFT_SUSTAIN_SESSIONS);
  });

  it('datos con persistencia corta solo pone en observación', () => {
    registerCard();
    const view = makeService().simulateDrift({
      kind: 'datos',
      streak: 5,
    });
    const row = view.subjects.find((s) => s.subject === 'modelo')!;
    expect(row.state).toBe('observacion');
    expect(view.proposals).toHaveLength(0);
  });

  it('rendimiento sostenido degrada la estrategia y la saca de evaluables', () => {
    fichas = [seedFicha('Cruce de medias')];
    const service = makeService();
    service.simulateDrift({ kind: 'rendimiento', streak: 2 });
    expect(fichas[0]!.status).toBe('degradada');
    expect(notices.some((n) => n.level === 'critica')).toBe(true);
  });
});
