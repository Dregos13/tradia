/**
 * Divisas en la cartera simulada, de punta a punta (sin Electron).
 *
 * Cablea sobre una base en memoria los servicios reales: velas 24/5 en
 * `bars`, régimen (`ai/regime`), predicción con un modelo simulado
 * determinista (`ai/prediction`), motor de señales y seguidor paper
 * (`registerSignals`), pasarela de riesgo con parada real y diario. Cubre:
 *
 * - EURUSD en largo y en corto: la vela del 4 de julio (festivo de NYSE,
 *   sesión de divisas) genera régimen, predicción y una señal aprobada
 *   que abre posición en la cartera simulada con el tamaño en euros; la
 *   vela siguiente toca el stop, la cierra con el P&L en USD y deja la
 *   operación en el diario.
 * - USDJPY: la señal sale con destino 'solo-analisis', vetada con el
 *   motivo «par no cotizado en USD: solo análisis por ahora», y no abre.
 * - La parada de emergencia activa impide abrir posiciones de divisas.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  app: { isPackaged: true },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
}));

import { FX_ANALYSIS_ONLY_REASON } from '../../../shared/fxTrading';
import { IPC_CHANNELS, type MarketUpdatedEvent } from '../../../shared/ipc';
import type { Signal } from '../../../shared/signals';
import { createRegimeRepository } from '../../ai/regime/repository';
import { createRegimeService, type RegimeService } from '../../ai/regime/service';
import type { PredictionCandle } from '../../ai/prediction/features';
import type { ModelPrediction, PredictionModel } from '../../ai/prediction/model';
import { createPredictionsRepository } from '../../ai/prediction/repository';
import { createPredictionService, type PredictionService } from '../../ai/prediction/service';
import { createBacktestRepository } from '../../backtest/repository';
import { openDatabase } from '../../db/database';
import { createJournalService, type JournalService } from '../../journal';
import { createJournalRepository } from '../../journal/repository';
import { expectedSessionDateFor } from '../../market/assetCalendar';
import { createMarketRepository, type StoredBar } from '../../market/repository';
import { createCautionContextSource } from '../../risk/caution';
import {
  createKillSwitchService,
  createKillSwitchStore,
  type KillSwitchService,
} from '../../risk/killSwitch';
import { createRiskRepository, RISK_PAPER_EQUITY_DEFAULT } from '../../risk/repository';
import { createRiskService, type RiskService } from '../../risk/service';
import type { ServiceContext } from '../../services';
import { createStrategiesRepository } from '../../strategies/repository';
import { registerSignals, type SignalsService } from '../../signals/index';
import { createSignalsRepository } from '../../signals/repository';

// ---------------------------------------------------------------------------
// Banco de pruebas
// ---------------------------------------------------------------------------

/**
 * Sábado 5 de julio de 2025, 02:00 UTC: la vela de divisas del viernes 4
 * (festivo de NYSE) ya es la sesión esperada en el 24/5, mientras que en
 * NYSE la última sesión es el jueves 3.
 */
const OPEN_CLOCK = Date.parse('2025-07-05T02:00:00.000Z');
const SIGNAL_BAR = '2025-07-04';
/** Martes 8 de julio, 02:00 UTC: ya llegó la vela del lunes 7. */
const CLOSE_CLOCK = Date.parse('2025-07-08T02:00:00.000Z');
const STOP_BAR = '2025-07-07';
const HASH = 'a'.repeat(64);

let db: Database.Database;
let clockMs: number;
let probUp: number;
let killSwitch: KillSwitchService;
let risk: RiskService;
let journal: JournalService;
let regime: RegimeService;
let prediction: PredictionService;
let signals: SignalsService | null;
let barsStoredListener: ((event: MarketUpdatedEvent) => void) | null;
let watchlist: string[];

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Días de lunes a viernes entre dos fechas UTC, sin 25-12 ni 01-01 (sesiones 24/5). */
function fxSessionDays(desde: string, hasta: string): string[] {
  const days: string[] = [];
  for (
    let ms = Date.parse(`${desde}T00:00:00.000Z`);
    ms <= Date.parse(`${hasta}T00:00:00.000Z`);
    ms += 86_400_000
  ) {
    const date = new Date(ms);
    const day = date.toISOString().slice(0, 10);
    const dow = date.getUTCDay();
    if (dow === 0 || dow === 6 || day.endsWith('-12-25') || day.endsWith('-01-01')) continue;
    days.push(day);
  }
  return days;
}

interface Ohlc {
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Historia de divisas casi plana alrededor de `base` (sin volumen, como
 * Tiingo FX): ningún cierre supera el máximo ni cae del mínimo de las
 * velas anteriores, así la ruptura solo ocurre en la vela de la señal.
 */
function seedFxHistory(ticker: string, base: number, lastBar: Ohlc): void {
  const days = fxSessionDays('2025-01-02', '2025-07-03');
  const rows = days.map((date, i) => {
    const close = base * (1 + 0.0008 * Math.sin(i * 0.7));
    return {
      date,
      open: base,
      high: base * 1.0015,
      low: base * 0.9985,
      close,
      volume: 0,
    };
  });
  rows.push({ date: SIGNAL_BAR, ...lastBar, volume: 0 });
  storeBars(ticker, rows);
}

function storeBars(
  ticker: string,
  rows: { date: string; open: number; high: number; low: number; close: number; volume: number }[],
): void {
  const market = createMarketRepository(db);
  const batch = market.createBatch({
    version: 1,
    hash: `h-${ticker}-${rows[0]!.date}`,
    provider: 'simulado',
    scope: 'bars',
    ticker,
    rangeStart: rows[0]!.date,
    rangeEnd: rows[rows.length - 1]!.date,
  });
  market.upsertBars(ticker, 'simulado', batch.id, rows);
}

const toCandle = (bar: StoredBar): PredictionCandle => ({
  date: bar.date,
  open: bar.adjOpen ?? bar.open,
  high: bar.adjHigh ?? bar.high,
  low: bar.adjLow ?? bar.low,
  close: bar.adjClose ?? bar.close,
  volume: bar.adjVolume ?? bar.volume,
});

/** Modelo simulado: probabilidad de subida fija (`probUp`) en cada sesión. */
function fakeModel(): PredictionModel {
  return {
    version: '0.1.0',
    horizonDays: 5,
    modelHash: HASH,
    volHash: 'b'.repeat(64),
    predictBatch: async (vectors) =>
      vectors.map((): ModelPrediction => ({
        rawProbUp: probUp,
        probUp,
        probDown: 1 - probUp,
        expectedVolatility: 0.005,
      })),
    release: async () => undefined,
  };
}

const cardJson = (): Record<string, unknown> => ({
  version: '0.1.0',
  hash: HASH,
  horizonDays: 5,
  trainingPeriod: { startDate: '2020-01-01', endDate: '2021-12-31' },
  calibrationPeriod: { startDate: '2022-01-01', endDate: '2022-06-30' },
  testPeriod: { startDate: '2022-07-01', endDate: '2022-12-31' },
  dataOrigin: 'real',
  metrics: { brierOos: 0.18, logLossOos: 0.55, brierBaseline: 0.25 },
  calibration: [],
  referenceDistribution: [],
  trainedAt: '2025-01-01T00:00:00.000Z',
});

/**
 * Estrategia propia 'activa' de ruptura de canal de 20 sesiones, en
 * largo y en corto, con stop al 4 % y objetivo al 10 % (ratio 2,5).
 */
function seedBreakoutStrategy(markets: string[]): number {
  const runs = createBacktestRepository(db);
  const strategies = createStrategiesRepository(db, (id) => runs.implementationKey(id) !== null);
  const created = strategies.create({
    name: 'Ruptura de canal FX',
    hypothesis: 'Una ruptura del canal de 20 sesiones continúa.',
    rules: {
      entry: 'cierre > maximo(20)',
      exit: 'cruza_abajo(cierre, sma(5))',
      entryShort: 'cierre < minimo(20)',
      exitShort: 'cruza_arriba(cierre, sma(5))',
      stop: '4%',
      target: '10%',
    },
    parameters: {},
    markets,
    regime: 'tendencial',
    worksIn: [],
    failsIn: [],
  });
  strategies.setStatus({ id: created.id, status: 'activa' });
  return created.id;
}

const makeCtx = (): ServiceContext => {
  const runs = createBacktestRepository(db);
  const strategies = createStrategiesRepository(db, (id) => runs.implementationKey(id) !== null);
  const settings = new Map<string, string>();
  return {
    broadcast: () => undefined,
    services: {
      storage: { getDb: () => db },
      strategies,
      market: {
        listWatchlist: () =>
          watchlist.map((ticker, position) => ({ ticker, addedAt: '', position })),
        onBarsStored: (listener: (event: MarketUpdatedEvent) => void) => {
          barsStoredListener = listener;
          return () => {
            barsStoredListener = null;
          };
        },
      },
      risk,
      journal,
      killSwitch,
      aiRegime: { service: regime },
      aiPrediction: { service: prediction },
      scheduler: { getState: () => ({ paused: false, pauseReason: null, lastHeartbeatAt: null }) },
      connectivity: {
        getState: () => ({ status: 'online', lastCheckedAt: null, nextRetryAt: null, attempt: 0 }),
      },
      settings: {
        getValue: (key: string) => settings.get(key) ?? null,
        setValue: (key: string, value: string) => void settings.set(key, value),
      },
    } as unknown as ServiceContext['services'],
  };
};

/** Recalcula régimen y predicción del seguimiento (lo que hace la app al guardar velas). */
async function refreshAi(): Promise<void> {
  regime.recalculateAll();
  await prediction.recalculateAll();
  await prediction.ready();
}

const fireBarStored = (ticker: string, lastDate: string): void => {
  barsStoredListener?.({
    ticker,
    source: 'simulado',
    lastDate,
    updatedAt: new Date(clockMs).toISOString(),
  });
};

const listSignals = (): Signal[] =>
  electron.handlers.get(IPC_CHANNELS.signals.list)!({}, {}) as Signal[];

const operations = () => journal.list({ type: 'operacion' }).entries;

beforeEach(async () => {
  electron.handlers.clear();
  db = openDatabase(':memory:');
  clockMs = OPEN_CLOCK;
  probUp = 0.7;
  watchlist = ['EURUSD'];
  barsStoredListener = null;
  signals = null;

  killSwitch = createKillSwitchService({
    store: createKillSwitchStore(db),
    broadcast: () => undefined,
    pauseAgents: () => undefined,
    resumeAgents: () => undefined,
    getConnectivityState: () => ({
      status: 'online',
      lastCheckedAt: null,
      nextRetryAt: null,
      attempt: 0,
    }),
    now: () => clockMs,
    logger: quietLogger,
  });
  const riskRepo = createRiskRepository(db);
  risk = createRiskService({
    repo: riskRepo,
    cautionSource: createCautionContextSource({
      listEvents: () => [],
      getPortfolioTickers: () => riskRepo.openTickers(),
      getVix: () => null,
    }),
    killSwitch,
    broadcast: () => undefined,
    now: () => clockMs,
  });
  journal = createJournalService({
    repo: createJournalRepository(db),
    broadcast: () => undefined,
    now: () => clockMs,
  });
  const market = createMarketRepository(db);
  const barsFor = (ticker: string): PredictionCandle[] => market.getBars(ticker).map(toCandle);
  regime = createRegimeService({
    repo: createRegimeRepository(db),
    barsFor,
    lastBarDate: (ticker) => market.lastBarDate(ticker),
    listWatchlistTickers: () => watchlist,
    listStrategies: () => [],
    recordJournal: (input) => void journal.record(input),
    broadcast: () => undefined,
    // El mismo cableado que ai/regime/index.ts: calendario del activo.
    expectedSessionDate: (_nowMs, ticker) => expectedSessionDateFor(ticker ?? 'SPY', clockMs),
    now: () => clockMs,
    logger: quietLogger,
  });
  prediction = createPredictionService({
    repo: createPredictionsRepository(db),
    barsFor,
    listWatchlistTickers: () => watchlist,
    loadModel: async () => fakeModel(),
    loadCardJson: () => cardJson(),
    recordJournal: (input) => void journal.record(input),
    broadcast: () => undefined,
    expectedSessionDate: (_nowMs, ticker) => expectedSessionDateFor(ticker, clockMs),
    now: () => clockMs,
    logger: quietLogger,
  });
  await prediction.ready();
});

afterEach(async () => {
  signals?.stop();
  await prediction.stop();
  killSwitch.stop();
  risk.stop();
  db.close();
});

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------

describe('EURUSD en la cartera simulada (velas 24/5)', () => {
  it('largo: régimen, predicción y señal aprobada abren la posición; el stop la cierra con P&L en USD y diario', async () => {
    // Ruptura al alza del canal el 4 de julio (festivo de NYSE).
    seedFxHistory('EURUSD', 1.08, { open: 1.08, high: 1.095, low: 1.0795, close: 1.09 });
    seedBreakoutStrategy(['EURUSD']);
    probUp = 0.7;
    await refreshAi();

    // Régimen y predicción del propio par sobre la vela del festivo.
    const pairRegime = regime.regimeFor('EURUSD');
    expect(pairRegime?.sessionDate).toBe(SIGNAL_BAR);
    const latest = prediction.latestPrediction('EURUSD');
    expect(latest?.sessionDate).toBe(SIGNAL_BAR);
    expect(latest?.probUp).toBeCloseTo(0.7, 6);

    signals = registerSignals(makeCtx(), { clock: { now: () => clockMs } });
    fireBarStored('EURUSD', SIGNAL_BAR);

    // Señal aprobada con destino 'cartera-simulada', apoyada por la IA del par.
    const [signal] = listSignals();
    expect(signal).toBeDefined();
    expect(signal!).toMatchObject({
      ticker: 'EURUSD',
      direction: 'largo',
      entry: 1.09,
      destination: 'cartera-simulada',
      destinationReason: null,
    });
    expect(signal!.decision.status).toBe('aprobada');
    expect(signal!.dataUsed.barDate).toBe(SIGNAL_BAR);
    expect(signal!.dataUsed.ai?.probability).toBeCloseTo(0.7, 6);
    expect(signal!.dataUsed.ai?.regime).toEqual({
      direction: pairRegime!.direction,
      volatility: pairRegime!.volatility,
    });

    // Tamaño en euros: 0,5 % de 100 000 USD entre la distancia al stop.
    const stop = signal!.stop!;
    expect(stop).toBeCloseTo(1.09 * 0.96, 10);
    const expectedSize = Math.floor((RISK_PAPER_EQUITY_DEFAULT * 0.005) / (1.09 - stop));
    expect(signal!.decision.size).toBe(expectedSize);
    expect(signal!.decision.notional).toBeCloseTo(expectedSize * 1.09, 6);

    // La posición simulada: euros de tamaño, expone a EUR, sector divisas.
    const [position] = risk.listPaperPositions('EURUSD');
    expect(position).toMatchObject({
      ticker: 'EURUSD',
      direction: 'largo',
      entry: 1.09,
      size: expectedSize,
      currency: 'EUR',
      sector: 'divisas',
      signalId: signal!.id,
      openedOnBar: SIGNAL_BAR,
    });
    const portfolio = risk.getPortfolio();
    expect(portfolio.currency).toBe('USD');
    expect(portfolio.exposureBySector.map((slice) => slice.key)).toEqual(['divisas']);

    // El lunes 7 la vela cae por debajo del stop: cierre al stop.
    clockMs = CLOSE_CLOCK;
    storeBars('EURUSD', [
      { date: STOP_BAR, open: 1.07, high: 1.072, low: 1.04, close: 1.045, volume: 0 },
    ]);
    fireBarStored('EURUSD', STOP_BAR);

    expect(risk.listPaperPositions('EURUSD')).toEqual([]);
    // Hueco por debajo del stop: ejecuta a la apertura (1,07 > stop 1,0464).
    const exit = Math.min(1.07, stop);
    const pnl = Math.round((exit - 1.09) * expectedSize * 100) / 100;
    expect(pnl).toBeLessThan(0);
    // Pérdida acotada: ~0,5 % del capital (el riesgo asignado), en USD.
    expect(pnl).toBeGreaterThanOrEqual(-RISK_PAPER_EQUITY_DEFAULT * 0.005 - 0.01);
    expect(risk.getPaperRiskState().equity).toBeCloseTo(RISK_PAPER_EQUITY_DEFAULT + pnl, 2);

    const [operation] = operations();
    expect(operation).toMatchObject({
      type: 'operacion',
      mode: 'paper',
      ticker: 'EURUSD',
      result: 'perdida',
      signalId: signal!.id,
    });
    expect(operation!.dataUsed).toMatchObject({
      posicionId: position!.id,
      motivoSalida: 'stop',
      pnl,
      divisaPnl: 'USD',
      divisa: 'EUR',
      tamano: expectedSize,
      velaCierre: STOP_BAR,
    });
    expect(operation!.reason).toContain(`${expectedSize} EUR largo`);
    expect(operation!.reason).toContain('USD');
  });

  it('corto: la ruptura a la baja abre un corto en euros y el stop por encima lo cierra con P&L en USD', async () => {
    seedFxHistory('EURUSD', 1.08, { open: 1.08, high: 1.0805, low: 1.065, close: 1.07 });
    seedBreakoutStrategy(['EURUSD']);
    probUp = 0.3; // el modelo confirma la bajada
    await refreshAi();
    expect(regime.regimeFor('EURUSD')?.sessionDate).toBe(SIGNAL_BAR);

    signals = registerSignals(makeCtx(), { clock: { now: () => clockMs } });
    fireBarStored('EURUSD', SIGNAL_BAR);

    const [signal] = listSignals();
    expect(signal).toMatchObject({
      ticker: 'EURUSD',
      direction: 'corto',
      entry: 1.07,
      destination: 'cartera-simulada',
    });
    expect(signal!.decision.status).toBe('aprobada');
    const stop = signal!.stop!;
    expect(stop).toBeGreaterThan(1.07);
    const expectedSize = Math.floor((RISK_PAPER_EQUITY_DEFAULT * 0.005) / (stop - 1.07));
    expect(signal!.decision.size).toBe(expectedSize);

    const [position] = risk.listPaperPositions('EURUSD');
    expect(position).toMatchObject({
      direction: 'corto',
      size: expectedSize,
      currency: 'EUR',
      sector: 'divisas',
    });

    // El lunes la vela abre por debajo del stop y lo toca intrabarra.
    clockMs = CLOSE_CLOCK;
    storeBars('EURUSD', [
      { date: STOP_BAR, open: 1.075, high: 1.12, low: 1.074, close: 1.11, volume: 0 },
    ]);
    fireBarStored('EURUSD', STOP_BAR);

    expect(risk.listPaperPositions('EURUSD')).toEqual([]);
    const exit = Math.max(1.075, stop);
    const pnl = Math.round((1.07 - exit) * expectedSize * 100) / 100;
    expect(exit).toBe(stop);
    expect(pnl).toBeLessThan(0);
    expect(pnl).toBeGreaterThanOrEqual(-RISK_PAPER_EQUITY_DEFAULT * 0.005 - 0.01);
    expect(risk.getPaperRiskState().equity).toBeCloseTo(RISK_PAPER_EQUITY_DEFAULT + pnl, 2);

    const [operation] = operations();
    expect(operation).toMatchObject({ ticker: 'EURUSD', result: 'perdida', signalId: signal!.id });
    expect(operation!.dataUsed).toMatchObject({
      direccion: 'corto',
      motivoSalida: 'stop',
      pnl,
      divisaPnl: 'USD',
    });
  });

  it('con la vela del festivo, una vela 24/5 anterior ya no se evalúa (frescura por calendario del par)', async () => {
    seedFxHistory('EURUSD', 1.08, { open: 1.08, high: 1.095, low: 1.0795, close: 1.09 });
    seedBreakoutStrategy(['EURUSD']);
    await refreshAi();
    signals = registerSignals(makeCtx(), { clock: { now: () => clockMs } });

    // El jueves 3 es la última sesión de NYSE, pero para el par ya se
    // espera la del viernes 4: la del 3 llega atrasada.
    expect(signals.engine.evaluateTicker('EURUSD', '2025-07-03', 'simulado')).toBe('stale-data');
    expect(signals.engine.evaluateTicker('EURUSD', SIGNAL_BAR, 'simulado')).toBe('emitted');
  });
});

describe('pares no cotizados en USD', () => {
  it('USDJPY: la señal sale con destino solo-analisis, vetada con su motivo, y no abre posición', async () => {
    watchlist = ['USDJPY'];
    seedFxHistory('USDJPY', 145, { open: 145, high: 146.5, low: 144.9, close: 146 });
    seedBreakoutStrategy(['USDJPY']);
    await refreshAi();
    expect(regime.regimeFor('USDJPY')?.sessionDate).toBe(SIGNAL_BAR);
    expect(prediction.latestPrediction('USDJPY')?.sessionDate).toBe(SIGNAL_BAR);

    signals = registerSignals(makeCtx(), { clock: { now: () => clockMs } });
    fireBarStored('USDJPY', SIGNAL_BAR);

    const [signal] = listSignals();
    expect(signal).toMatchObject({
      ticker: 'USDJPY',
      direction: 'largo',
      destination: 'solo-analisis',
      destinationReason: FX_ANALYSIS_ONLY_REASON,
    });
    expect(signal!.decision.status).toBe('vetada');
    expect(signal!.decision.size).toBe(0);
    expect(signal!.decision.reasons.map((r) => r.code)).toEqual(['ANALYSIS_ONLY']);
    expect(signal!.decision.reasons[0]!.message).toBe(
      'Par no cotizado en USD: solo análisis por ahora',
    );
    expect(risk.listPaperPositions()).toEqual([]);
    // Ni la petición directa a la cartera lo abre.
    expect(() =>
      risk.openPaperPosition({
        ticker: 'USDJPY',
        direction: 'largo',
        entry: 146,
        stop: 140,
        target: 160,
        size: 100,
        sector: null,
        currency: 'USD',
        signalId: null,
        openedOnBar: null,
        openedAt: new Date(clockMs).toISOString(),
      }),
    ).toThrow(FX_ANALYSIS_ONLY_REASON);
  });
});

describe('parada de emergencia y divisas', () => {
  it('con la parada activa no se evalúa ni se abre ninguna posición de divisas', async () => {
    seedFxHistory('EURUSD', 1.08, { open: 1.08, high: 1.095, low: 1.0795, close: 1.09 });
    seedBreakoutStrategy(['EURUSD']);
    await refreshAi();
    signals = registerSignals(makeCtx(), { clock: { now: () => clockMs } });

    killSwitch.activate('manual', 'usuario');
    fireBarStored('EURUSD', SIGNAL_BAR);

    expect(listSignals()).toEqual([]);
    expect(risk.listPaperPositions()).toEqual([]);
  });

  it('una señal aprobada antes de activarse la parada tampoco abre la posición', async () => {
    seedFxHistory('EURUSD', 1.08, { open: 1.08, high: 1.095, low: 1.0795, close: 1.09 });
    seedBreakoutStrategy(['EURUSD']);
    await refreshAi();
    signals = registerSignals(makeCtx(), { clock: { now: () => clockMs } });

    // La pasarela la aprueba; la parada se activa entre la decisión y la
    // apertura (el evento signals:new llega después).
    const decision = risk.submitSignal({
      ticker: 'EURUSD',
      direction: 'largo',
      entry: 1.09,
      stop: 1.0464,
      target: 1.199,
      confidence: 0.7,
      origin: 'estrategia',
    });
    expect(decision.status).toBe('aprobada');
    killSwitch.activate('manual', 'usuario');
    const { signal } = createSignalsRepository(db).insertSignal({
      ticker: 'EURUSD',
      direction: 'largo',
      entry: 1.09,
      stop: 1.0464,
      target: 1.199,
      confidence: 0.7,
      reason: 'ruptura',
      strategies: [],
      dataUsed: {
        barDate: SIGNAL_BAR,
        desde: SIGNAL_BAR,
        hasta: SIGNAL_BAR,
        barCount: 1,
        batchId: null,
        batchVersion: null,
        source: 'simulado',
      },
      decision,
      barDate: SIGNAL_BAR,
    });
    expect(signal.destination).toBe('cartera-simulada');
    signals.paper.handleSignalEvent({ signal });

    expect(risk.listPaperPositions()).toEqual([]);
    expect(journal.list({ type: 'veto' }).entries[0]?.reason).toContain('parada activa');
    // La cartera tampoco la acepta por la vía directa.
    expect(() =>
      risk.openPaperPosition({
        ticker: 'EURUSD',
        direction: 'largo',
        entry: 1.09,
        stop: 1.0464,
        target: 1.199,
        size: 1000,
        sector: null,
        currency: 'EUR',
        signalId: null,
        openedOnBar: null,
        openedAt: new Date(clockMs).toISOString(),
      }),
    ).toThrow('[parada-activa]');
  });
});
