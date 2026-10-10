/**
 * Pruebas del núcleo del servicio de predicción (`service.ts`): modelo
 * ONNX simulado determinista y velas sembradas en memoria. Cubre la
 * predicción diaria al guardar velas, la resolución a t+N (acierto y
 * Brier realizado), la idempotencia, la aptitud de la ficha y la
 * degradación cuando el modelo no carga.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JournalRecordInput } from '../../../shared/journal';
import { openDatabase } from '../../db/database';
import type { PredictionCandle } from './features';
import type { ModelPrediction, PredictionModel } from './model';
import { createPredictionsRepository } from './repository';
import {
  createPredictionService,
  type PredictionService,
  type PredictionServiceDeps,
} from './service';

const HASH = 'a'.repeat(64);

/** Paseo determinista para las velas sembradas (sin aleatoriedad). */
function makeCandles(n: number, start = '2024-01-02', firstClose = 100): PredictionCandle[] {
  const candles: PredictionCandle[] = [];
  let close = firstClose;
  let ms = Date.parse(`${start}T00:00:00.000Z`);
  for (let i = 0; i < n; i++) {
    const drift = 1 + 0.01 * Math.sin(i * 0.9) + 0.004;
    const next = close * drift;
    candles.push({
      date: new Date(ms).toISOString().slice(0, 10),
      open: close,
      high: Math.max(close, next) * 1.01,
      low: Math.min(close, next) * 0.99,
      close: next,
      volume: 1_000_000 + i * 1000,
    });
    close = next;
    ms += 86_400_000;
  }
  return candles;
}

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
  referenceDistribution: [],
  trainedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

/**
 * Modelo simulado determinista: la probabilidad depende de `ret_1`
 * (primera variable del vector), así una vela corregida produce una
 * predicción distinta.
 */
function fakeModel(over: Partial<PredictionModel> = {}): PredictionModel {
  return {
    version: '0.1.0',
    horizonDays: 5,
    modelHash: HASH,
    volHash: 'b'.repeat(64),
    predictBatch: async (vectors) =>
      vectors.map((vector): ModelPrediction => ({
        rawProbUp: vector[0]!,
        probUp: Math.min(1, Math.max(0, 0.5 + vector[0]!)),
        probDown: Math.min(1, Math.max(0, 0.5 - vector[0]!)),
        expectedVolatility: 0.02,
      })),
    release: async () => undefined,
    ...over,
  };
}

let db: Database.Database;
let candlesByTicker: Map<string, PredictionCandle[]>;
let journalEntries: JournalRecordInput[];
let broadcasted: { channel: string; payload: unknown }[];
let statusWrites: { state: string; reason: string | null }[];

const makeService = (over: Partial<PredictionServiceDeps> = {}): { service: PredictionService } => {
  const repo = createPredictionsRepository(db);
  const service = createPredictionService({
    repo,
    barsFor: (ticker) => candlesByTicker.get(ticker.trim().toUpperCase()) ?? [],
    listWatchlistTickers: () => [...candlesByTicker.keys()],
    loadModel: async () => fakeModel(),
    loadCardJson: () => cardJson(),
    reportStatus: (patch) => statusWrites.push(patch),
    recordJournal: (input) => journalEntries.push(input),
    broadcast: (channel, payload) => broadcasted.push({ channel, payload }),
    ...over,
  });
  return { service };
};

const barEvent = (ticker: string) => ({
  ticker,
  source: 'simulado',
  lastDate: null,
  updatedAt: '2026-10-10T00:00:00.000Z',
});

beforeEach(() => {
  db = openDatabase(':memory:');
  candlesByTicker = new Map();
  journalEntries = [];
  broadcasted = [];
  statusWrites = [];
});

afterEach(() => {
  db.close();
});

describe('predicción diaria al guardar velas', () => {
  it('la pasada inicial predice cada sesión con variables y registra la ficha', async () => {
    const candles = makeCandles(60);
    candlesByTicker.set('AAPL', candles);
    const { service } = makeService();
    await service.ready();

    // Sesiones 49..59 con variables definidas; todas ya resueltas hasta
    // la 54 (la vela t+5 ya existe en la serie).
    const predictions = service.predictions({ ticker: 'AAPL' });
    expect(predictions).toHaveLength(11);
    expect(predictions[0]!.sessionDate).toBe(candles[59]!.date);
    for (const prediction of predictions) {
      expect(prediction).toMatchObject({
        ticker: 'AAPL',
        horizonDays: 5,
        modelVersion: '0.1.0',
        modelHash: HASH,
        expectedVolatility: 0.02,
      });
      expect(prediction.modelCardId).toBe(service.modelCard()!.id);
    }

    const card = service.modelCard()!;
    expect(card.version).toBe('0.1.0');
    expect(card.hash).toBe(HASH);
    expect(card.eligible).toBe(true);
    expect(service.eligibleModel()).toEqual({ version: '0.1.0', hash: HASH, horizonDays: 5 });
    expect(service.status().state).toBe('listo');
    expect(statusWrites.some((w) => w.state === 'fiable')).toBe(true);
  });

  it('un lote guardado predice solo las sesiones pendientes y emite ai:changed', async () => {
    const candles = makeCandles(55);
    candlesByTicker.set('AAPL', candles);
    const { service } = makeService();
    await service.ready();
    expect(service.predictions({ ticker: 'AAPL' })).toHaveLength(6);
    broadcasted = [];

    // Cinco velas nuevas: se predice cada sesión nueva, no se repiten.
    const extra = makeCandles(60).slice(55);
    candlesByTicker.set('AAPL', [...candles, ...extra]);
    service.handleBarStored(barEvent('AAPL'));
    await service.ready();

    expect(service.predictions({ ticker: 'AAPL' })).toHaveLength(11);
    expect(
      broadcasted.some(
        (b) => b.channel === 'ai:changed' && (b.payload as { kind?: string }).kind === 'prediccion',
      ),
    ).toBe(true);
  });

  it('series cortas sin variables definidas no generan predicciones', async () => {
    candlesByTicker.set('AAPL', makeCandles(30));
    const { service } = makeService();
    await service.ready();
    expect(service.predictions({ ticker: 'AAPL' })).toHaveLength(0);
  });
});

describe('resolución a t+N', () => {
  it('resuelve al llegar la vela del horizonte con acierto y Brier realizado', async () => {
    const candles = makeCandles(60);
    candlesByTicker.set('AAPL', candles);
    const { service } = makeService();
    await service.ready();

    const bySession = new Map(candles.map((candle, index) => [candle.date, index]));
    for (const prediction of service.predictions({ ticker: 'AAPL' })) {
      const i = bySession.get(prediction.sessionDate)!;
      if (i + 5 < candles.length) {
        // Resuelta: la vela t+5 ya existe.
        const expectedUp = candles[i + 5]!.close > candles[i]!.close;
        expect(prediction.resolvedSession).toBe(candles[i + 5]!.date);
        expect(prediction.outcomeUp).toBe(expectedUp);
        expect(prediction.realizedBrier).toBeCloseTo(
          (prediction.probUp - (expectedUp ? 1 : 0)) ** 2,
          10,
        );
      } else {
        expect(prediction.resolvedSession).toBeNull();
        expect(prediction.outcomeUp).toBeNull();
      }
    }
  });

  it('una vela corregida repredice la sesión y re-resuelve el horizonte', async () => {
    const candles = makeCandles(60);
    candlesByTicker.set('AAPL', candles);
    const { service } = makeService();
    await service.ready();

    const last = service.predictions({ ticker: 'AAPL' })[0]!;
    // La última vela sube de golpe: cambian las variables de la sesión 59
    // y el resultado de las que la usan dentro de su horizonte.
    const corrected = [...candles];
    corrected[59] = { ...corrected[59]!, close: corrected[59]!.close * 1.2 };
    candlesByTicker.set('AAPL', corrected);
    service.handleBarStored(barEvent('AAPL'));
    await service.ready();

    const now = service.predictions({ ticker: 'AAPL' })[0]!;
    expect(now.sessionDate).toBe(last.sessionDate);
    expect(now.probUp).not.toBe(last.probUp);
    // Las resueltas que incluían la vela corregida en t..t+5 se re-evaluaron.
    const resolved = service
      .predictions({ ticker: 'AAPL' })
      .filter((p) => p.resolvedSession === corrected[59]!.date);
    for (const prediction of resolved) {
      expect(prediction.outcomeUp).toBe(true); // el cierre corregido sube más
    }
  });

  it('la resolución no depende del modelo: sigue funcionando degradado', async () => {
    const candles = makeCandles(58);
    candlesByTicker.set('AAPL', candles);
    const { service } = makeService();
    await service.ready();
    const pendingBefore = service
      .predictions({ ticker: 'AAPL' })
      .filter((p) => p.resolvedSession === null).length;
    expect(pendingBefore).toBeGreaterThan(0);

    // El modelo deja de cargar; al guardarse velas solo se resuelve.
    const failing = makeService({
      loadModel: async () => {
        throw new Error('runtime nativo ausente');
      },
    });
    const extra = makeCandles(63).slice(58);
    candlesByTicker.set('AAPL', [...candles, ...extra]);
    await failing.service.ready();
    failing.service.handleBarStored(barEvent('AAPL'));
    await failing.service.ready();

    const predictions = failing.service.predictions({ ticker: 'AAPL' });
    // No hay predicciones nuevas (sigue habiendo las de la 49..57 de
    // antes) pero las pendientes alcanzadas por t+5 se resolvieron.
    expect(predictions.filter((p) => p.resolvedSession === null)).toHaveLength(0);
    expect(failing.service.status().state).toBe('degradado');
  });
});

describe('degradación sin tumbar la app', () => {
  it('si el modelo no carga degrada, notifica el estado y lo anota en el Diario', async () => {
    const { service } = makeService({
      loadModel: async () => {
        throw new Error('ENOENT: model.onnx');
      },
    });
    await service.ready();

    const status = service.status();
    expect(status.state).toBe('degradado');
    expect(status.reason).toContain('ENOENT');
    expect(statusWrites).toEqual([
      { state: 'no-fiable', reason: 'el modelo no se pudo cargar: ENOENT: model.onnx' },
    ]);
    expect(journalEntries).toHaveLength(1);
    expect(journalEntries[0]).toMatchObject({ type: 'error', result: 'error' });
    // El IPC sigue respondiendo y la ficha se registró igualmente.
    expect(service.predictions()).toEqual([]);
    expect(service.modelCard()?.version).toBe('0.1.0');
    expect(service.eligibleModel()).toBeNull();
  });

  it('una ficha inválida no impide predecir pero marca el estado', async () => {
    candlesByTicker.set('AAPL', makeCandles(55));
    const { service } = makeService({
      loadCardJson: () => ({ version: 42 }),
    });
    await service.ready();

    expect(service.predictions({ ticker: 'AAPL' }).length).toBeGreaterThan(0);
    expect(service.modelCard()).toBeNull();
    expect(statusWrites.some((w) => w.state === 'desactualizado')).toBe(true);
  });

  it('ficha y modelo con hash distinto no se sirven juntos', async () => {
    const { service } = makeService({
      loadCardJson: () => cardJson({ hash: 'f'.repeat(64) }),
    });
    await service.ready();

    expect(service.status().state).toBe('degradado');
    expect(service.status().reason).toContain('ficha no coincide');
    // La ficha inconsistente se registra para que la página la muestre.
    expect(service.modelCard()?.hash).toBe('f'.repeat(64));
  });
});

describe('aptitud para señales', () => {
  it('una ficha sintética informa pero nunca es apta para señales', async () => {
    const { service } = makeService({
      loadCardJson: () => cardJson({ dataOrigin: 'sintetico' }),
    });
    await service.ready();
    expect(service.modelCard()!.eligible).toBe(false);
    expect(service.modelCard()!.ineligibleReason).toBe('Datos sintéticos · no apto');
    expect(service.eligibleModel()).toBeNull();
  });
});
