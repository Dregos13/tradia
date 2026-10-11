/**
 * Pruebas de `registerPrediction` (index.ts): registra `ai:predictions`
 * y `ai:model-card`, se engancha a `market.onBarsStored`, carga el
 * bundle real de `resources/models` y degrada sin tumbar la app cuando
 * los artefactos no están.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS, IpcValidationError, type MarketUpdatedEvent } from '../../../shared/ipc';
import type { JournalRecordInput } from '../../../shared/journal';
import type { ModelCard, Prediction } from '../../../shared/ai';
import { openDatabase } from '../../db/database';
import { createMarketRepository } from '../../market/repository';
import type { ServiceContext } from '../../services';
import { registerPrediction } from './index';

// electron solo aporta app/ipcMain a registerPrediction; mismo patrón que
// las demás pruebas de servicios del proceso principal.
const electron = vi.hoisted(() => ({
  isPackaged: true,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
    getAppPath: () => '/tmp',
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
}));

const MODELS_DIR = fileURLToPath(new URL('../../../../resources/models', import.meta.url));
// Reloj de mercado fijado antes de la serie sembrada (que empieza el
// 02-01-2024): la guarda de frescura ve los datos como vigentes.
const PREDICTION_CLOCK = { clock: { now: () => Date.parse('2024-01-01T21:00:00.000Z') } };

function seedBars(ticker: string, n: number, source = 'simulado'): void {
  const market = createMarketRepository(db);
  const batch = market.createBatch({
    version: 1,
    hash: `h-${ticker}-${n}`,
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
    const next = close * (1 + 0.01 * Math.sin(i * 0.9) + 0.004);
    bars.push({
      date: new Date(ms).toISOString().slice(0, 10),
      open: close,
      high: Math.max(close, next) * 1.01,
      low: Math.min(close, next) * 0.99,
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
let watchlist: { ticker: string }[];
let tmpDirs: string[];

beforeEach(() => {
  electron.handlers.clear();
  electron.isPackaged = true;
  db = openDatabase(':memory:');
  journalEntries = [];
  broadcasted = [];
  barsStoredListener = null;
  watchlist = [];
  tmpDirs = [];
});

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  db.close();
});

const makeCtx = (): ServiceContext =>
  ({
    broadcast: (channel: string, payload: unknown) => broadcasted.push({ channel, payload }),
    services: {
      storage: { getDb: () => db },
      journal: { record: (input: JournalRecordInput) => journalEntries.push(input) },
      market: {
        listWatchlist: () =>
          watchlist.map((w, i) => ({ ...w, addedAt: '2026-01-01', position: i })),
        onBarsStored: (listener: (event: MarketUpdatedEvent) => void) => {
          barsStoredListener = listener;
          return () => {
            barsStoredListener = null;
          };
        },
        onWatchlistChanged: () => () => undefined,
      },
    },
  }) as unknown as ServiceContext;

const invoke = (channel: string, ...args: unknown[]): unknown =>
  electron.handlers.get(channel)!({}, ...args);

describe('registerPrediction', () => {
  it('registra ai:predictions y ai:model-card, carga el bundle real y predice sobre velas guardadas', async () => {
    seedBars('AAPL', 70);
    watchlist = [{ ticker: 'AAPL' }];
    const registered = registerPrediction(makeCtx(), { modelsDir: MODELS_DIR, ...PREDICTION_CLOCK });
    await registered.service.ready();

    expect(electron.handlers.has(IPC_CHANNELS.ai.predictions)).toBe(true);
    expect(electron.handlers.has(IPC_CHANNELS.ai.modelCard)).toBe(true);

    const card = invoke(IPC_CHANNELS.ai.modelCard) as ModelCard;
    expect(card.version).toBe('0.1.0');
    expect(card.horizonDays).toBe(5);
    expect(card.eligible).toBe(false); // datos sintéticos: solo informa
    expect(card.ineligibleReason).toBe('Datos sintéticos · no apto');

    const predictions = invoke(IPC_CHANNELS.ai.predictions, {
      ticker: 'AAPL',
    }) as Prediction[];
    expect(predictions.length).toBeGreaterThan(0);
    const first = predictions[0]!;
    expect(first).toMatchObject({
      ticker: 'AAPL',
      horizonDays: 5,
      modelVersion: '0.1.0',
      modelCardId: card.id,
    });
    expect(first.probUp).toBeGreaterThan(0);
    expect(first.probUp).toBeLessThan(1);
    expect(first.probUp + first.probDown).toBeCloseTo(1, 12);
    expect(first.expectedVolatility).toBeGreaterThan(0);
    expect(first.modelHash).toMatch(/^[0-9a-f]{64}$/);

    // El estado del sistema refleja la ficha tal cual: el modelo sirve
    // pero no es apto para señales (datos sintéticos), nunca 'fiable'.
    const status = createMarketRepository(db).getDataStatus('modelo:0.1.0');
    expect(status?.state).toBe('desactualizado');
    expect(status?.reason).toContain('no apto');
    await registered.stop();
  });

  it('un lote guardado dispara la predicción a través de onBarsStored', async () => {
    seedBars('AAPL', 55);
    watchlist = [{ ticker: 'AAPL' }];
    const registered = registerPrediction(makeCtx(), { modelsDir: MODELS_DIR, ...PREDICTION_CLOCK });
    await registered.service.ready();
    expect(barsStoredListener).not.toBeNull();
    const before = (invoke(IPC_CHANNELS.ai.predictions, { ticker: 'AAPL' }) as Prediction[]).length;

    // Velas de sesiones nuevas: dos fechas posteriores a las sembradas.
    const market = createMarketRepository(db);
    const batch = market.createBatch({
      version: 1,
      hash: 'h-nuevas',
      provider: 'simulado',
      scope: 'bars',
      ticker: 'AAPL',
      rangeStart: '2025-01-01',
      rangeEnd: '2025-01-10',
    });
    market.upsertBars('AAPL', 'simulado', batch.id, [
      { date: '2025-01-01', open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
      { date: '2025-01-02', open: 1.5, high: 2.5, low: 1, close: 2, volume: 1 },
    ]);
    barsStoredListener!({
      ticker: 'AAPL',
      source: 'simulado',
      lastDate: '2025-01-02',
      updatedAt: '2026-10-10T00:00:00.000Z',
    });
    await registered.service.ready();

    expect(
      (invoke(IPC_CHANNELS.ai.predictions, { ticker: 'AAPL' }) as Prediction[]).length,
    ).toBeGreaterThan(before);
    await registered.stop();
  });

  it('una serie por detrás de la sesión esperada no genera predicciones nuevas', async () => {
    seedBars('AAPL', 70);
    watchlist = [{ ticker: 'AAPL' }];
    // Domingo 11-10-2026: la sesión esperada es el viernes 09-10, muy por
    // delante de la última vela sembrada → no se predice nada nuevo.
    const registered = registerPrediction(makeCtx(), {
      modelsDir: MODELS_DIR,
      clock: { now: () => Date.parse('2026-10-11T12:00:00.000Z') },
    });
    await registered.service.ready();
    expect(invoke(IPC_CHANNELS.ai.predictions, { ticker: 'AAPL' })).toEqual([]);
    await registered.stop();
  });

  it('valida la entrada de ai:predictions', async () => {
    const registered = registerPrediction(makeCtx(), { modelsDir: MODELS_DIR, ...PREDICTION_CLOCK });
    await registered.service.ready();
    expect(() => invoke(IPC_CHANNELS.ai.predictions, { limit: 0 })).toThrow(IpcValidationError);
    expect(() => invoke(IPC_CHANNELS.ai.predictions, { fuera: 1 })).toThrow(IpcValidationError);
    await registered.stop();
  });

  it('degrada sin tumbar la app cuando los artefactos no están', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'tradia-models-empty-'));
    tmpDirs.push(empty);
    writeFileSync(join(empty, 'current.json'), JSON.stringify({ version: '9.9.9' }));

    const registered = registerPrediction(makeCtx(), { modelsDir: empty, ...PREDICTION_CLOCK });
    await registered.service.ready();

    expect(registered.service.status().state).toBe('degradado');
    // El IPC sigue respondiendo: sin ficha y sin predicciones, sin caída.
    expect(invoke(IPC_CHANNELS.ai.modelCard)).toBeNull();
    expect(invoke(IPC_CHANNELS.ai.predictions, {})).toEqual([]);
    // Y el estado del sistema lo notifica.
    const status = createMarketRepository(db).getDataStatus('modelo:9.9.9');
    expect(status?.state).toBe('no-fiable');
    expect(journalEntries.some((e) => e.type === 'error')).toBe(true);
    await registered.stop();
  });
});
