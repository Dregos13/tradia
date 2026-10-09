import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS, IpcValidationError, type MarketUpdatedEvent } from '../../shared/ipc';
import type { JournalRecordInput } from '../../shared/journal';
import type { RiskDecision } from '../../shared/risk';
import { createBacktestRepository } from '../backtest/repository';
import { openDatabase } from '../db/database';
import { createMarketRepository } from '../market/repository';
import type { ServiceContext } from '../services';
import { createStrategiesRepository } from '../strategies/repository';
import { registerSignals } from './index';

// electron solo aporta app/ipcMain a registerSignals; mismo patrón que las
// demás pruebas de servicios del proceso principal.
const electron = vi.hoisted(() => ({
  isPackaged: true,
  e2e: '0' as string | undefined,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
}));

const NOW = Date.parse('2026-10-09T21:00:00.000Z');

const DECISION: RiskDecision = {
  status: 'aprobada',
  size: 8,
  sizeFactor: 1,
  riskAmount: 40,
  notional: 1600,
  reasons: [],
  decidedAt: new Date(NOW).toISOString(),
};

let db: Database.Database;
let journalEntries: JournalRecordInput[];
let broadcasted: { channel: string; payload: unknown }[];
let submitted: unknown[];
let barsStoredListener: ((event: MarketUpdatedEvent) => void) | null;
let settingsStore: Map<string, string>;
let flags: { paused: boolean; offline: boolean; killSwitch: boolean };

/** Serie con cruce al alza justo en la última vela para SMA(2)/SMA(3). */
const seedAaplBars = (): void => {
  const market = createMarketRepository(db);
  const batch = market.createBatch({
    version: 1,
    hash: 'h',
    provider: 'simulado',
    scope: 'bars',
    ticker: 'AAPL',
    rangeStart: '2026-10-01',
    rangeEnd: '2026-10-08',
  });
  market.upsertBars(
    'AAPL',
    'simulado',
    batch.id,
    [
      ['2026-10-01', 10],
      ['2026-10-02', 10],
      ['2026-10-05', 9],
      ['2026-10-06', 9],
      ['2026-10-07', 9],
      ['2026-10-08', 12],
    ].map(([date, close]) => ({
      date: date as string,
      open: close as number,
      high: (close as number) + 1,
      low: (close as number) - 1,
      close: close as number,
      volume: 1_000,
    })),
  );
};

/** Ficha ejecutable 'activa' de cruce de medias sobre AAPL. */
const seedStrategy = (): number => {
  const runs = createBacktestRepository(db);
  const strategies = createStrategiesRepository(db, (id) => runs.implementationKey(id) !== null);
  const created = strategies.create({
    name: 'Cruce rápido',
    hypothesis: 'La tendencia corta persiste.',
    rules: {
      entry: 'Compra cuando SMA(2) cruza al alza a SMA(3).',
      exit: 'Vende en el cruce a la baja.',
      stop: 'Stop a 1 × ATR(2) bajo el cierre.',
      target: 'Sin objetivo fijo.',
    },
    parameters: { fastPeriod: 2, slowPeriod: 3, atrPeriod: 2, stopAtr: 1 },
    markets: ['AAPL'],
    regime: 'tendencial',
  });
  runs.setImplementation(created.id, 'sma-cross');
  strategies.setStatus({ id: created.id, status: 'activa' });
  return created.id;
};

const makeCtx = (): ServiceContext => {
  const runs = createBacktestRepository(db);
  const strategies = createStrategiesRepository(db, (id) => runs.implementationKey(id) !== null);
  return {
    broadcast: (channel, payload) => {
      broadcasted.push({ channel, payload });
    },
    services: {
      storage: { getDb: () => db },
      strategies,
      market: {
        listWatchlist: () => [{ ticker: 'AAPL', addedAt: '', position: 0 }],
        onBarsStored: (listener: (event: MarketUpdatedEvent) => void) => {
          barsStoredListener = listener;
          return () => {
            barsStoredListener = null;
          };
        },
      },
      risk: { submitSignal: (intent: unknown) => (submitted.push(intent), DECISION) },
      journal: { record: (input: JournalRecordInput) => journalEntries.push(input) },
      scheduler: {
        getState: () => ({ paused: flags.paused, pauseReason: null, lastHeartbeatAt: null }),
      },
      connectivity: {
        getState: () => ({
          status: flags.offline ? 'offline' : 'online',
          lastCheckedAt: null,
          nextRetryAt: null,
          attempt: 0,
        }),
      },
      killSwitch: {
        getState: () => ({
          active: flags.killSwitch,
          cause: null,
          actor: null,
          activatedAt: null,
          detail: null,
        }),
      },
      settings: {
        getValue: (key: string) => settingsStore.get(key) ?? null,
        setValue: (key: string, value: string) => void settingsStore.set(key, value),
      },
    } as unknown as ServiceContext['services'],
  };
};

const fireBarStored = (ticker = 'AAPL', lastDate = '2026-10-08'): void => {
  barsStoredListener?.({
    ticker,
    source: 'simulado',
    lastDate,
    updatedAt: new Date(NOW).toISOString(),
  });
};

const invoke = (channel: string, ...args: unknown[]): unknown => {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`handler no registrado: ${channel}`);
  return handler({}, ...args);
};

beforeEach(() => {
  electron.handlers.clear();
  electron.isPackaged = true;
  electron.e2e = undefined;
  db = openDatabase(':memory:');
  journalEntries = [];
  broadcasted = [];
  submitted = [];
  barsStoredListener = null;
  settingsStore = new Map();
  flags = { paused: false, offline: false, killSwitch: false };
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
});

describe('registerSignals: cableado en la app', () => {
  it('al guardarse una vela nueva se evalúa la estrategia activa y se emite la señal', () => {
    seedAaplBars();
    const strategyId = seedStrategy();
    const service = registerSignals(makeCtx());

    fireBarStored();

    const signals = invoke(IPC_CHANNELS.signals.list, {}) as { id: number; ticker: string }[];
    expect(signals).toHaveLength(1);
    expect(signals[0]!.ticker).toBe('AAPL');
    // Pasó por la pasarela única con origen 'estrategia'.
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      ticker: 'AAPL',
      direction: 'largo',
      origin: 'estrategia',
    });
    // Aviso signals:new al renderer (delivery lo intercepta a través de broadcast).
    expect(broadcasted.filter((e) => e.channel === IPC_CHANNELS.signals.new)).toHaveLength(1);
    // Diario automático.
    expect(journalEntries[0]).toMatchObject({ type: 'senal', ticker: 'AAPL', result: 'aprobada' });
    // Estado por estrategia.
    const states = invoke(IPC_CHANNELS.signals.strategies) as {
      strategyId: number;
      lastOutcome: string | null;
      lastSignalId: number | null;
    }[];
    expect(states[0]).toMatchObject({
      strategyId,
      lastOutcome: 'senal',
      lastSignalId: signals[0]!.id,
      lastBarDate: '2026-10-08',
    });
    service.stop();
  });

  it('es idempotente: la misma vela no genera dos señales (ni con la marca, ni sin ella)', () => {
    seedAaplBars();
    seedStrategy();
    const service = registerSignals(makeCtx());

    fireBarStored();
    fireBarStored();
    expect(invoke(IPC_CHANNELS.signals.list, {})).toHaveLength(1);
    expect(submitted).toHaveLength(1);

    // Las marcas persisten en settings: un «reinicio» (servicio nuevo sobre
    // la misma base) tampoco reevalúa la vela.
    const service2 = registerSignals(makeCtx());
    fireBarStored();
    expect(invoke(IPC_CHANNELS.signals.list, {})).toHaveLength(1);
    service2.stop();
    service.stop();
  });

  it('no evalúa con los agentes en pausa, sin conexión ni con la parada activa', () => {
    seedAaplBars();
    seedStrategy();
    const service = registerSignals(makeCtx());

    flags.paused = true;
    fireBarStored();
    flags.paused = false;
    flags.offline = true;
    fireBarStored('AAPL', '2026-10-09');
    flags.offline = false;
    flags.killSwitch = true;
    fireBarStored('AAPL', '2026-10-10');

    expect(invoke(IPC_CHANNELS.signals.list, {})).toHaveLength(0);
    expect(submitted).toHaveLength(0);
    service.stop();
  });

  it('signals:get devuelve el detalle y rechaza ids inválidos', () => {
    seedAaplBars();
    seedStrategy();
    const service = registerSignals(makeCtx());
    fireBarStored();

    const detail = invoke(IPC_CHANNELS.signals.get, 1) as { ticker: string; dataUsed: unknown };
    expect(detail.ticker).toBe('AAPL');
    expect(detail.dataUsed).toMatchObject({
      barDate: '2026-10-08',
      batchVersion: 1,
      source: 'simulado',
    });
    expect(invoke(IPC_CHANNELS.signals.get, 999)).toBeNull();
    expect(() => invoke(IPC_CHANNELS.signals.get, 'x')).toThrowError(IpcValidationError);
    expect(() => invoke(IPC_CHANNELS.signals.list, { limit: 0 })).toThrowError(IpcValidationError);
    service.stop();
  });

  it('signals:evaluate-now solo existe en modo E2E sin empaquetar', () => {
    seedAaplBars();
    seedStrategy();

    electron.isPackaged = true;
    vi.stubEnv('TRADIA_E2E', '1');
    const prod = registerSignals(makeCtx());
    expect(electron.handlers.has(IPC_CHANNELS.signals.evaluateNow)).toBe(false);
    prod.stop();

    electron.handlers.clear();
    electron.isPackaged = false;
    const dev = registerSignals(makeCtx());
    expect(electron.handlers.has(IPC_CHANNELS.signals.evaluateNow)).toBe(true);
    const result = invoke(IPC_CHANNELS.signals.evaluateNow) as { emitted: number };
    expect(result.emitted).toBe(1);
    dev.stop();
  });

  it('stop() desuscribe del evento de velas guardadas', () => {
    seedAaplBars();
    seedStrategy();
    const service = registerSignals(makeCtx());
    service.stop();
    fireBarStored();
    expect(invoke(IPC_CHANNELS.signals.list, {})).toHaveLength(0);
  });
});
