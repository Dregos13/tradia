import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { INITIAL_UNIVERSE_TICKERS, WATCHLIST_MAX_ITEMS } from '../../shared/ipc';
import { MIGRATIONS } from '../db/migrations';
import { migrate } from '../db/migrator';
import { createMarketRepository, MarketRepositoryError, type MarketRepository } from './repository';

let db: Database.Database;
let repo: MarketRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  repo = createMarketRepository(db);
});

describe('watchlist', () => {
  it('empieza vacía, añade con orden y normaliza el ticker', () => {
    expect(repo.listWatchlist()).toEqual([]);

    const first = repo.addWatchlistTicker(' aapl ');
    expect(first).toMatchObject({ ticker: 'AAPL', position: 0 });
    repo.addWatchlistTicker('MSFT');

    expect(repo.listWatchlist().map((w) => w.ticker)).toEqual(['AAPL', 'MSFT']);
  });

  it('es idempotente ante duplicados y compacta el orden al quitar', () => {
    repo.addWatchlistTicker('AAPL');
    repo.addWatchlistTicker('MSFT');
    repo.addWatchlistTicker('NVDA');

    expect(repo.addWatchlistTicker('aapl').position).toBe(0);
    expect(repo.listWatchlist()).toHaveLength(3);

    expect(repo.removeWatchlistTicker('msft')).toBe(true);
    expect(repo.listWatchlist().map((w) => [w.ticker, w.position])).toEqual([
      ['AAPL', 0],
      ['NVDA', 1],
    ]);
    expect(repo.removeWatchlistTicker('KO')).toBe(false);
  });

  it('añade el universo inicial y respeta el límite de 25', () => {
    const added = repo.addWatchlistUniverse(INITIAL_UNIVERSE_TICKERS);
    expect(added).toHaveLength(INITIAL_UNIVERSE_TICKERS.length);
    expect(repo.listWatchlist()).toHaveLength(WATCHLIST_MAX_ITEMS);

    // Repetir no duplica y el límite bloquea tickers ajenos al universo.
    expect(repo.addWatchlistUniverse(INITIAL_UNIVERSE_TICKERS)).toHaveLength(25);
    expect(() => repo.addWatchlistTicker('ZZZZ')).toThrowError(MarketRepositoryError);
    expect(() => repo.addWatchlistTicker('ZZZZ')).toThrowError(/máximo de 25/);
  });
});

describe('lotes, velas y acciones corporativas', () => {
  const createBatch = () =>
    repo.createBatch({
      version: 1,
      hash: 'abc123',
      provider: 'tiingo',
      scope: 'bars',
      ticker: 'AAPL',
      rangeStart: '2026-10-05',
      rangeEnd: '2026-10-07',
      qualitySummary: { received: 3, stored: 3 },
    });

  it('crea lotes con versión, hash, rango y resumen de calidad', () => {
    const batch = createBatch();
    expect(batch).toMatchObject({
      version: 1,
      hash: 'abc123',
      provider: 'tiingo',
      scope: 'bars',
      ticker: 'AAPL',
      seriesId: null,
      rangeStart: '2026-10-05',
      rangeEnd: '2026-10-07',
    });
    expect(batch.qualitySummary).toEqual({ received: 3, stored: 3 });
    expect(repo.getBatch(batch.id)?.hash).toBe('abc123');
    expect(repo.latestBatch('bars', 'tiingo', 'aapl')?.id).toBe(batch.id);
    expect(repo.latestBatch('bars', 'tiingo', 'MSFT')).toBeNull();
  });

  it('guarda velas crudas y ajustadas, únicas por ticker/fecha/fuente', () => {
    const batch = createBatch();
    const written = repo.upsertBars('aapl', 'tiingo', batch.id, [
      { date: '2026-10-05', open: 10, high: 11, low: 9, close: 10.5, volume: 1000 },
      {
        date: '2026-10-06',
        open: 10.5,
        high: 12,
        low: 10,
        close: 11.5,
        volume: 1200,
        adjClose: 11.49,
      },
      { date: '2026-10-07', open: 11.5, high: 12, low: 11, close: 11.8, volume: 900 },
    ]);
    expect(written).toBe(3);

    const bars = repo.getBars('AAPL');
    expect(bars.map((b) => b.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
    expect(bars[0]?.adjClose).toBeNull();
    expect(bars[1]?.adjClose).toBe(11.49);
    expect(bars[1]?.batchId).toBe(batch.id);
    expect(repo.lastBarDate('aapl')).toBe('2026-10-07');
    expect(repo.lastBarDate('aapl', 'otra')).toBeNull();
  });

  it('un lote crudo nuevo no borra los ajustes ya calculados', () => {
    const batch = createBatch();
    repo.upsertBars('AAPL', 'tiingo', batch.id, [
      {
        date: '2026-10-06',
        open: 10.5,
        high: 12,
        low: 10,
        close: 11.5,
        volume: 1200,
        adjOpen: 10.4,
        adjClose: 11.49,
      },
    ]);
    // Reproceso crudo sin ajustados: los valores ajustados se conservan.
    repo.upsertBars('AAPL', 'tiingo', batch.id, [
      { date: '2026-10-06', open: 10.5, high: 12, low: 10, close: 11.5, volume: 999 },
    ]);

    const [bar] = repo.getBars('AAPL');
    expect(bar?.volume).toBe(999);
    expect(bar?.adjClose).toBe(11.49);
    expect(bar?.adjOpen).toBe(10.4);
  });

  it('filtra velas por rango de fechas', () => {
    const batch = createBatch();
    repo.upsertBars('AAPL', 'tiingo', batch.id, [
      { date: '2026-10-05', open: 1, high: 2, low: 1, close: 1.5, volume: 10 },
      { date: '2026-10-06', open: 1.5, high: 2, low: 1, close: 1.8, volume: 10 },
      { date: '2026-10-07', open: 1.8, high: 2, low: 1, close: 1.9, volume: 10 },
    ]);

    expect(repo.getBars('AAPL', { desde: '2026-10-06' }).map((b) => b.date)).toEqual([
      '2026-10-06',
      '2026-10-07',
    ]);
    expect(
      repo.getBars('AAPL', { desde: '2026-10-05', hasta: '2026-10-06' }).map((b) => b.date),
    ).toEqual(['2026-10-05', '2026-10-06']);
  });

  it('guarda acciones corporativas y las devuelve ordenadas', () => {
    repo.upsertCorporateActions([
      { ticker: 'nvda', date: '2024-06-10', kind: 'split', value: 10, source: 'tiingo' },
      { ticker: 'NVDA', date: '2024-06-14', kind: 'dividend', value: 0.01, source: 'tiingo' },
      { ticker: 'AAPL', date: '2020-08-31', kind: 'split', value: 4, source: 'tiingo' },
    ]);

    const actions = repo.getCorporateActions('NVDA');
    expect(actions.map((a) => [a.date, a.kind, a.value])).toEqual([
      ['2024-06-10', 'split', 10],
      ['2024-06-14', 'dividend', 0.01],
    ]);
    expect(repo.getCorporateActions('NVDA', '2024-06-11')).toHaveLength(1);

    // La misma acción reenviada actualiza, no duplica.
    repo.upsertCorporateActions([
      { ticker: 'NVDA', date: '2024-06-10', kind: 'split', value: 10, source: 'tiingo' },
    ]);
    expect(repo.getCorporateActions('NVDA')).toHaveLength(2);
  });

  it('registra marcas de calidad por lote y las consulta', () => {
    const batch = createBatch();
    repo.addQualityFlags([
      {
        batchId: batch.id,
        ticker: 'AAPL',
        date: '2026-10-06',
        kind: 'anomalo',
        detail: 'high<low',
      },
      { batchId: batch.id, ticker: 'AAPL', date: '2026-10-03', kind: 'hueco' },
      { batchId: batch.id, kind: 'duplicado', detail: 'fecha repetida' },
    ]);

    expect(repo.getQualityFlags({ batchId: batch.id })).toHaveLength(3);
    expect(repo.getQualityFlags({ kind: 'anomalo' })).toHaveLength(1);
    expect(() => repo.addQualityFlags([{ batchId: batch.id, kind: 'otro' as never }])).toThrowError(
      MarketRepositoryError,
    );
  });
});

describe('macro', () => {
  it('guarda series y observaciones con su lote', () => {
    repo.upsertMacroSeries([
      { id: 'VIXCLS', source: 'fred', name: 'VIX', unit: 'índice', frequency: 'daily' },
      { id: 'DGS10', source: 'fred', name: 'Tesoro 10 años', unit: '%', frequency: 'daily' },
    ]);
    expect(repo.listMacroSeries().map((s) => s.id)).toEqual(['DGS10', 'VIXCLS']);
    expect(repo.getMacroSeries('VIXCLS')?.source).toBe('fred');

    const batch = repo.createBatch({
      version: 1,
      hash: 'fred1',
      provider: 'fred',
      scope: 'macro',
      seriesId: 'VIXCLS',
      rangeStart: '2026-10-05',
      rangeEnd: '2026-10-07',
    });
    repo.upsertMacroObservations('VIXCLS', batch.id, [
      { date: '2026-10-05', value: 16.2 },
      { date: '2026-10-06', value: 16.8 },
      { date: '2026-10-07', value: 15.9 },
    ]);

    const obs = repo.getMacroObservations('VIXCLS');
    expect(obs.map((o) => [o.date, o.value, o.batchId])).toEqual([
      ['2026-10-05', 16.2, batch.id],
      ['2026-10-06', 16.8, batch.id],
      ['2026-10-07', 15.9, batch.id],
    ]);
    expect(repo.lastMacroObservationDate('VIXCLS')).toBe('2026-10-07');
    expect(repo.lastMacroObservationDate('DGS10')).toBeNull();

    // Reenvío actualiza el valor conservando el lote si el nuevo es null.
    repo.upsertMacroObservations('VIXCLS', null, [{ date: '2026-10-07', value: 15.5 }]);
    expect(repo.getMacroObservations('VIXCLS', '2026-10-07')).toMatchObject([
      { value: 15.5, batchId: batch.id },
    ]);
  });
});

describe('salud del dato', () => {
  it('crea, fusiona y lista estados por clave', () => {
    const created = repo.setDataStatus({ key: 'ticker:AAPL', state: 'fiable' });
    expect(created).toMatchObject({
      key: 'ticker:AAPL',
      state: 'fiable',
      lastOkAt: null,
      consecutiveFailures: 0,
      reason: null,
    });

    // undefined conserva; null borra.
    repo.setDataStatus({
      key: 'ticker:AAPL',
      state: 'no-fiable',
      lastOkAt: '2026-10-07T22:00:00Z',
      consecutiveFailures: 3,
      reason: 'HTTP 503',
    });
    const merged = repo.setDataStatus({ key: 'ticker:AAPL', state: 'fiable', reason: null });
    expect(merged).toMatchObject({
      state: 'fiable',
      lastOkAt: '2026-10-07T22:00:00Z',
      consecutiveFailures: 3,
      reason: null,
    });

    repo.setDataStatus({ key: 'provider:tiingo', state: 'desactualizado' });
    expect(repo.listDataStatus().map((s) => s.key)).toEqual(['provider:tiingo', 'ticker:AAPL']);
    expect(repo.getDataStatus('macro:DFF')).toBeNull();
  });
});
