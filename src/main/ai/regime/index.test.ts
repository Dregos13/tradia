import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS, IpcValidationError, type MarketUpdatedEvent } from '../../../shared/ipc';
import type { JournalRecordInput } from '../../../shared/journal';
import type { WatchlistItem } from '../../../shared/ipc';
import { openDatabase } from '../../db/database';
import { createMarketRepository } from '../../market/repository';
import type { ServiceContext } from '../../services';
import { registerRegime } from './index';

// electron solo aporta app/ipcMain a registerRegime; mismo patrón que las
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

const NOW = '2026-10-09T21:00:00.000Z';
// Reloj de mercado fijado antes de la serie sembrada (que empieza el
// 02-01-2024): la guarda de frescura ve los datos como vigentes.
const REGIME_CLOCK = { clock: { now: () => Date.parse('2024-01-01T21:00:00.000Z') } };

/** Serie lateral sintética: seno amplio que se calma las 40 últimas. */
function seedBars(ticker: string, n: number, source = 'simulado'): void {
  const market = createMarketRepository(db);
  const batch = market.createBatch({
    version: 1,
    hash: `h-${ticker}`,
    provider: source,
    scope: 'bars',
    ticker,
    rangeStart: '2024-01-02',
    rangeEnd: '2024-12-31',
  });
  let close = 100;
  let ms = Date.parse('2024-01-02T00:00:00.000Z');
  const bars = [];
  for (let i = 0; i < n; i++) {
    const amp = i < n - 40 ? 0.03 : 0.002;
    const next = close * (1 + amp * Math.sin(i * 0.7));
    bars.push({
      date: new Date(ms).toISOString().slice(0, 10),
      open: close,
      high: Math.max(close, next) * 1.001,
      low: Math.min(close, next) * 0.999,
      close: next,
      volume: 1_000_000,
    });
    close = next;
    ms += 86_400_000;
  }
  market.upsertBars(ticker, source, batch.id, bars);
}

let db: Database.Database;
let journalEntries: JournalRecordInput[];
let broadcasted: { channel: string; payload: unknown }[];
let barsStoredListener: ((event: MarketUpdatedEvent) => void) | null;
let watchlistListener: ((items: WatchlistItem[]) => void) | null;
let watchlist: { ticker: string }[];

beforeEach(() => {
  electron.handlers.clear();
  electron.isPackaged = true;
  electron.e2e = '0';
  vi.stubEnv('TRADIA_E2E', '0');
  db = openDatabase(':memory:');
  journalEntries = [];
  broadcasted = [];
  barsStoredListener = null;
  watchlistListener = null;
  watchlist = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

const makeCtx = (): ServiceContext =>
  ({
    broadcast: (channel: string, payload: unknown) => broadcasted.push({ channel, payload }),
    services: {
      storage: { getDb: () => db },
      journal: { record: (input: JournalRecordInput) => journalEntries.push(input) },
      strategies: { list: () => [] },
      market: {
        listWatchlist: () =>
          watchlist.map((w, i) => ({
            ...w,
            assetClass: 'equity' as const,
            addedAt: NOW,
            position: i,
          })),
        onBarsStored: (listener: (event: MarketUpdatedEvent) => void) => {
          barsStoredListener = listener;
          return () => {
            barsStoredListener = null;
          };
        },
        onWatchlistChanged: (listener: (items: WatchlistItem[]) => void) => {
          watchlistListener = listener;
          return () => {
            watchlistListener = null;
          };
        },
      },
    },
  }) as unknown as ServiceContext;

describe('registerRegime', () => {
  it('registra ai:regime-overview y calcula el régimen inicial con datos ya guardados', () => {
    seedBars('SPY', 300);
    seedBars('AAPL', 300);
    watchlist = [{ ticker: 'SPY' }, { ticker: 'AAPL' }];
    registerRegime(makeCtx(), REGIME_CLOCK);

    expect(electron.handlers.has(IPC_CHANNELS.ai.regimeOverview)).toBe(true);
    const overview = electron.handlers.get(IPC_CHANNELS.ai.regimeOverview)!({}) as Awaited<
      ReturnType<typeof Promise.resolve>
    >;
    const view = overview as {
      market: { ticker: string; direction: string } | null;
      assets: { ticker: string }[];
    };
    expect(view.market).toMatchObject({ ticker: 'SPY', direction: 'lateral' });
    expect(view.assets.map((a) => a.ticker).sort()).toEqual(['AAPL', 'SPY']);
  });

  it('un lote guardado dispara el recálculo a través de onBarsStored', () => {
    seedBars('SPY', 300);
    watchlist = [{ ticker: 'SPY' }];
    registerRegime(makeCtx(), REGIME_CLOCK);
    expect(barsStoredListener).not.toBeNull();

    const market = createMarketRepository(db);
    market.upsertBars(
      'SPY',
      'simulado',
      market.createBatch({
        version: 1,
        hash: 'h2',
        provider: 'simulado',
        scope: 'bars',
        ticker: 'SPY',
        rangeStart: '2025-01-01',
        rangeEnd: '2025-01-10',
      }).id,
      [
        { date: '2025-01-01', open: 400, high: 405, low: 395, close: 402, volume: 1 },
        { date: '2025-01-02', open: 402, high: 407, low: 397, close: 405, volume: 1 },
      ],
    );
    barsStoredListener!({
      ticker: 'SPY',
      source: 'simulado',
      lastDate: '2025-01-02',
      updatedAt: NOW,
    });
    expect(broadcasted.some((b) => b.channel === IPC_CHANNELS.ai.changed)).toBe(true);
  });

  it('un alta en el seguimiento dispara el recálculo con datos ya guardados', () => {
    seedBars('MSFT', 300);
    registerRegime(makeCtx(), REGIME_CLOCK);
    expect(watchlistListener).not.toBeNull();

    watchlist = [{ ticker: 'MSFT' }];
    watchlistListener!(watchlist as WatchlistItem[]);
    const handler = electron.handlers.get(IPC_CHANNELS.ai.regimeOverview)!;
    const view = handler({}) as { assets: { ticker: string }[] };
    expect(view.assets.map((a) => a.ticker)).toEqual(['MSFT']);
  });

  it('una serie por detrás de la sesión esperada no recalcula y el overview lo expone', () => {
    seedBars('SPY', 300);
    watchlist = [{ ticker: 'SPY' }];
    // Domingo 11-10-2026: la sesión esperada es el viernes 09-10, muy por
    // delante de la última vela sembrada → nada se recalcula.
    registerRegime(makeCtx(), { clock: { now: () => Date.parse('2026-10-11T12:00:00.000Z') } });
    const handler = electron.handlers.get(IPC_CHANNELS.ai.regimeOverview)!;
    const view = handler({}) as {
      market: { sessionDate: string } | null;
      stale: boolean;
      expectedSessionDate: string | null;
    };
    expect(view.market).toBeNull();
    expect(view.stale).toBe(false); // no hay instantánea que marcar
    expect(view.expectedSessionDate).toBe('2026-10-09');
  });

  it('ai:simulate-regime solo existe en modo E2E sin empaquetar', () => {
    seedBars('SPY', 300);
    watchlist = [{ ticker: 'SPY' }];
    registerRegime(makeCtx(), REGIME_CLOCK);
    expect(electron.handlers.has(IPC_CHANNELS.ai.simulateRegime)).toBe(false);

    electron.isPackaged = false;
    vi.stubEnv('TRADIA_E2E', '1');
    electron.handlers.clear();
    registerRegime(makeCtx(), REGIME_CLOCK);
    const handler = electron.handlers.get(IPC_CHANNELS.ai.simulateRegime);
    expect(handler).toBeDefined();
    expect(() => handler!({}, { direction: 'norte' })).toThrow(IpcValidationError);
    const snapshot = handler!({}, { direction: 'tendencia' }) as { direction: string };
    expect(snapshot.direction).toBe('tendencia');
  });
});
