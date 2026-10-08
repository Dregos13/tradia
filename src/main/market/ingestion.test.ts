import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dataStatusKey, IPC_CHANNELS, type MarketUpdatedEvent } from '../../shared/ipc';
import { MIGRATIONS } from '../db/migrations';
import { migrate } from '../db/migrator';
import * as nyseCalendar from './calendar';
import {
  createMarketClock,
  createMarketIngestionService,
  MARKET_MAX_RETRIES,
  MARKET_RETRY_INTERVAL_MS,
  type MarketIngestionDeps,
  type MarketIngestionService,
  type MarketPowerMonitorLike,
} from './ingestion';
import { createSimulatedProvider, type SimulatedProvider } from './providers/simulated';
import type { MarketDataProvider } from './providers/types';
import { createMarketRepository, type MarketRepository } from './repository';

/**
 * Jueves 08-10-2026 a las 19:00 UTC (15:00 ET, mercado abierto): la última
 * sesión cerrada es el miércoles 07-10; la actualización de hoy sale a las
 * 21:15 UTC (cierre 20:00 UTC + 75 min).
 */
const NOW = Date.parse('2026-10-08T19:00:00.000Z');
const LAST_SESSION = '2026-10-07';
const NEW_SESSION = '2026-10-08';

class FakePowerMonitor implements MarketPowerMonitorLike {
  private listeners = new Set<() => void>();

  on(_event: 'resume', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeListener(_event: 'resume', listener: () => void): void {
    this.listeners.delete(listener);
  }

  emitResume(): void {
    for (const listener of this.listeners) listener();
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

interface Sent {
  channel: string;
  payload: unknown;
}

let db: Database.Database;
let repo: MarketRepository;
let provider: SimulatedProvider;
let service: MarketIngestionService;
let sent: Sent[];
let online: boolean;
let powerMonitor: FakePowerMonitor;
let getBarsSpy: ReturnType<typeof vi.spyOn>;

const setup = (deps: Partial<MarketIngestionDeps> = {}): MarketIngestionService =>
  createMarketIngestionService({
    repo,
    resolveProvider: async () => provider,
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    isOnline: () => online,
    powerMonitor,
    ...deps,
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  repo = createMarketRepository(db);
  provider = createSimulatedProvider({ seed: 'ingesta', now: () => Date.now() });
  sent = [];
  online = true;
  powerMonitor = new FakePowerMonitor();
  service = setup();
  getBarsSpy = vi.spyOn(provider, 'getBars');
});

afterEach(() => {
  service.stop();
  db.close();
  vi.useRealTimers();
});

const updatedEvents = (): MarketUpdatedEvent[] =>
  sent
    .filter((s) => s.channel === IPC_CHANNELS.market.updated)
    .map((s) => s.payload as MarketUpdatedEvent);

const tickerStatus = (ticker: string) => repo.getDataStatus(dataStatusKey.ticker(ticker));

/** Milisegundos que faltan para el siguiente instante de actualización. */
const msToNextUpdate = (): number =>
  Date.parse(nyseCalendar.nextUpdateAt(Date.now()).utc) - Date.now();

/**
 * Drena la cola de microtareas: la cadena async de una evaluación (resolver
 * proveedor → getBars → limpieza → escrituras) necesita varios turnos.
 */
const flushAsync = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe('ingesta histórica al añadir un ticker', () => {
  it('descarga ~5 años de velas, las ajusta y las guarda como lote versionado', async () => {
    const list = await service.addTicker('aapl');

    expect(list.map((w) => w.ticker)).toEqual(['AAPL']);
    const bars = repo.getBars('AAPL');
    expect(bars.length).toBeGreaterThan(1200);
    expect(bars[0]!.date).toBe('2021-10-07');
    expect(bars[bars.length - 1]!.date).toBe(LAST_SESSION);
    // La limpieza ya rellenó la familia ajustada.
    expect(bars[0]!.adjClose).not.toBeNull();
    expect(repo.lastBarDate('AAPL')).toBe(LAST_SESSION);

    const batch = repo.latestBatch('bars', 'simulated', 'AAPL');
    expect(batch).toMatchObject({ version: 1, scope: 'bars', ticker: 'AAPL' });
    expect(batch!.hash).toMatch(/^[0-9a-f]{64}$/);

    expect(tickerStatus('AAPL')).toMatchObject({ state: 'fiable', consecutiveFailures: 0 });
    expect(updatedEvents().at(-1)).toMatchObject({
      ticker: 'AAPL',
      source: 'simulated',
      lastDate: LAST_SESSION,
    });
  });

  it('guarda las acciones corporativas y reajusta la serie completa tras un split', async () => {
    provider.injectSplit('TEST', '2026-10-09', 4);
    await service.addTicker('TEST');
    await service.start();

    // El split llega con la vela del viernes 09-10.
    vi.setSystemTime('2026-10-10T01:00:00.000Z');
    await service.refreshNow();

    const actions = repo.getCorporateActions('TEST');
    expect(actions).toContainEqual(
      expect.objectContaining({ date: '2026-10-09', kind: 'split', value: 4 }),
    );
    // Las velas anteriores al split se reajustaron: adjClose ≈ crudo / 4.
    const before = repo.getBars('TEST').find((b) => b.date === NEW_SESSION)!;
    expect(before.adjClose).toBeCloseTo(before.close / 4, 4);
    // Y la serie ajustada es continua a través del split.
    const after = repo.getBars('TEST').find((b) => b.date === '2026-10-09')!;
    const ratio = after.adjClose! / before.adjClose!;
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });
});

describe('actualización diaria programada', () => {
  it('al cruzar la hora de actualización aparece la vela nueva y se emite market:updated', async () => {
    await service.addTicker('AAPL');
    expect(repo.lastBarDate('AAPL')).toBe(LAST_SESSION);

    await service.start();
    updatedEvents().length = 0;

    await vi.advanceTimersByTimeAsync(msToNextUpdate());
    await flushAsync();

    expect(repo.lastBarDate('AAPL')).toBe(NEW_SESSION);
    const events = updatedEvents();
    expect(events.at(-1)).toMatchObject({ ticker: 'AAPL', lastDate: NEW_SESSION });
    // El lote del día es una versión nueva del mismo historial.
    expect(repo.latestBatch('bars', 'simulated', 'AAPL')).toMatchObject({ version: 2 });
  });

  it('también funciona la semana de desfase de horario de finales de octubre', async () => {
    // 26-10-2026: EE. UU. sigue en verano y Europa ya está en invierno;
    // la actualización sigue siendo cierre +75 min, solo cambia la hora local.
    vi.setSystemTime('2026-10-26T19:00:00.000Z');
    await service.addTicker('AAPL');
    expect(repo.lastBarDate('AAPL')).toBe('2026-10-23');
    await service.start();

    await vi.advanceTimersByTimeAsync(msToNextUpdate());
    await flushAsync();

    expect(repo.lastBarDate('AAPL')).toBe('2026-10-26');
    expect(updatedEvents().at(-1)).toMatchObject({ ticker: 'AAPL', lastDate: '2026-10-26' });
  });

  it('reintenta cada 30 minutos hasta 4 veces y luego espera al próximo horario', async () => {
    await service.addTicker('AAPL');
    await service.start();
    getBarsSpy.mockClear();
    provider.setFailing('network');

    // Primer intento en la hora programada.
    await vi.advanceTimersByTimeAsync(msToNextUpdate());
    await flushAsync();
    expect(getBarsSpy).toHaveBeenCalledTimes(1);
    expect(repo.lastBarDate('AAPL')).toBe(LAST_SESSION);

    // Los 4 reintentos, uno cada 30 minutos.
    for (let i = 1; i <= MARKET_MAX_RETRIES; i++) {
      await vi.advanceTimersByTimeAsync(MARKET_RETRY_INTERVAL_MS);
      await flushAsync();
      expect(getBarsSpy).toHaveBeenCalledTimes(1 + i);
    }

    // Agotados los reintentos no hay más llamadas hasta el próximo horario.
    await vi.advanceTimersByTimeAsync(MARKET_RETRY_INTERVAL_MS * 4);
    await flushAsync();
    expect(getBarsSpy).toHaveBeenCalledTimes(1 + MARKET_MAX_RETRIES);
    expect(tickerStatus('AAPL')).toMatchObject({ state: 'desactualizado' });
    expect(tickerStatus('AAPL')!.consecutiveFailures).toBeGreaterThanOrEqual(
      1 + MARKET_MAX_RETRIES,
    );

    // Al día siguiente, con el proveedor de vuelta, se recupera solo.
    provider.setFailing(null);
    await vi.advanceTimersByTimeAsync(msToNextUpdate());
    await flushAsync();
    expect(repo.lastBarDate('AAPL')).toBe('2026-10-09');
    expect(tickerStatus('AAPL')).toMatchObject({ state: 'fiable', consecutiveFailures: 0 });
  });

  it('una sesión aún no publicada se reintenta como pendiente', async () => {
    await service.addTicker('AAPL');
    await service.start();
    // El proveedor se queda sin la vela nueva: el rango pedido no devuelve nada.
    provider.injectGap('AAPL', NEW_SESSION);

    await vi.advanceTimersByTimeAsync(msToNextUpdate());
    await flushAsync();

    expect(repo.lastBarDate('AAPL')).toBe(LAST_SESSION);
    expect(getBarsSpy).toHaveBeenCalled();
    expect(tickerStatus('AAPL')!.reason).toContain(NEW_SESSION);
  });

  it('no llama al proveedor sin conexión y retoma al volver', async () => {
    online = false;
    await service.addTicker('AAPL');
    expect(getBarsSpy).not.toHaveBeenCalled();
    expect(tickerStatus('AAPL')).toMatchObject({ state: 'desactualizado' });

    await service.start();
    await vi.advanceTimersByTimeAsync(MARKET_RETRY_INTERVAL_MS * 2);
    await flushAsync();
    expect(getBarsSpy).not.toHaveBeenCalled();

    online = true;
    await vi.advanceTimersByTimeAsync(MARKET_RETRY_INTERVAL_MS);
    await flushAsync();
    expect(repo.lastBarDate('AAPL')).toBe(LAST_SESSION);
  });

  it('powerMonitor resume recupera los cierres perdidos aunque no haya saltado el timer', async () => {
    await service.addTicker('AAPL');
    await service.start();

    // El equipo se suspende y despierta pasada la hora de actualización;
    // el temporizador sigue armado con la hora antigua y no ha saltado.
    vi.setSystemTime('2026-10-08T21:30:00.000Z');
    powerMonitor.emitResume();
    await flushAsync();
    await flushAsync();

    expect(repo.lastBarDate('AAPL')).toBe(NEW_SESSION);
    expect(updatedEvents().at(-1)).toMatchObject({ ticker: 'AAPL', lastDate: NEW_SESSION });
  });

  it('al arrancar recupera las sesiones que quedaron pendientes', async () => {
    await service.addTicker('AAPL');
    service.stop();

    // La app estuvo cerrada durante el jueves y el viernes: faltan dos velas.
    vi.setSystemTime('2026-10-10T12:00:00.000Z');
    service = setup();
    await service.start();

    expect(repo.lastBarDate('AAPL')).toBe('2026-10-09');
  });

  it('el gancho de desarrollo avanza el reloj y dispara la actualización', async () => {
    // El proveedor simulado comparte el reloj del servicio para que la
    // sesión nueva exista al avanzar (como hace registerMarket).
    const clock = createMarketClock();
    provider = createSimulatedProvider({ seed: 'ingesta', now: clock.now });
    service = setup({ clock, resolveProvider: async () => provider });
    await service.addTicker('AAPL');
    await service.start();
    expect(service.advanceClock).toBeTypeOf('function');

    const result = service.advanceClock!(3 * 3_600_000); // 19:00 → 22:00 UTC
    await flushAsync();
    await flushAsync();

    expect(Date.parse(result.now)).toBe(NOW + 3 * 3_600_000);
    expect(repo.lastBarDate('AAPL')).toBe(NEW_SESSION);
  });
});

describe('actualización incremental', () => {
  it('solo pide desde la última vela guardada', async () => {
    await service.addTicker('AAPL');
    getBarsSpy.mockClear();

    vi.setSystemTime('2026-10-10T12:00:00.000Z');
    await service.refreshNow();

    // La petición cubre solo las sesiones nuevas, no los 5 años de nuevo.
    expect(getBarsSpy).toHaveBeenCalledWith('AAPL', '2026-10-08', '2026-10-09');
    expect(repo.lastBarDate('AAPL')).toBe('2026-10-09');
  });

  it('refreshNow rechaza sin-activos, sin-proveedor, sin-conexion y en-curso', async () => {
    const withoutProvider = setup({ resolveProvider: async () => null });
    expect(await service.refreshNow()).toEqual({ accepted: false, reason: 'sin-activos' });

    repo.addWatchlistTicker('AAPL');
    expect(await withoutProvider.refreshNow()).toEqual({
      accepted: false,
      reason: 'sin-proveedor',
    });

    online = false;
    expect(await service.refreshNow()).toEqual({ accepted: false, reason: 'sin-conexion' });
    online = true;

    // Un proveedor lento deja la pasada en vuelo: el segundo refreshNow se rechaza.
    let release!: () => void;
    const slow: MarketDataProvider = {
      id: provider.id,
      rateLimits: provider.rateLimits,
      getBars: (t, desde, hasta) =>
        new Promise((resolve) => {
          release = () => void provider.getBars(t, desde, hasta).then(resolve);
        }),
      getQuote: (t) => provider.getQuote(t),
      getCorporateActions: (t, desde, hasta) => provider.getCorporateActions(t, desde, hasta),
    };
    const slowService = setup({ resolveProvider: async () => slow });
    const first = slowService.refreshNow();
    expect(await slowService.refreshNow()).toEqual({ accepted: false, reason: 'en-curso' });
    release();
    expect(await first).toEqual({ accepted: true, reason: null });
  });

  it('getBars devuelve las velas guardadas con su fuente y filtra por rango', async () => {
    await service.addTicker('AAPL');

    const all = await service.getBars({ ticker: 'aapl' });
    expect(all.source).toBe('simulated');
    expect(all.ticker).toBe('AAPL');
    expect(all.bars.length).toBeGreaterThan(1200);
    expect(all.bars[0]).toMatchObject({ date: '2021-10-07' });
    expect(all.bars[0]!.adjClose).not.toBeNull();

    const ranged = await service.getBars({
      ticker: 'AAPL',
      desde: '2026-10-01',
      hasta: '2026-10-05',
    });
    expect(ranged.bars.map((b) => b.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-05']);
  });
});

describe('salud del dato', () => {
  it('marca no-fiable un lote con huecos y deja la marca de calidad', async () => {
    provider.injectGap('AAPL', '2026-10-05');
    await service.addTicker('AAPL');

    const status = tickerStatus('AAPL');
    expect(status).toMatchObject({ state: 'no-fiable' });
    expect(status!.reason).toContain('huecos');

    const flags = repo.getQualityFlags({ ticker: 'AAPL', kind: 'hueco' });
    expect(flags.some((f) => f.date === '2026-10-05')).toBe(true);
  });

  it('un ticker desconocido queda no-fiable sin reintentos de 30 minutos', async () => {
    provider.markUnknown('ZZZZ');
    await service.addTicker('ZZZZ');
    await service.start();
    getBarsSpy.mockClear();

    // En la hora programada se intenta una vez; al no ser reintentable no
    // hay más llamadas en las 2 horas siguientes.
    await vi.advanceTimersByTimeAsync(msToNextUpdate());
    await flushAsync();
    expect(getBarsSpy.mock.calls.filter((call: unknown[]) => call[0] === 'ZZZZ')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MARKET_RETRY_INTERVAL_MS * 4);
    await flushAsync();
    expect(getBarsSpy.mock.calls.filter((call: unknown[]) => call[0] === 'ZZZZ')).toHaveLength(1);

    expect(tickerStatus('ZZZZ')).toMatchObject({ state: 'no-fiable' });
  });

  it('los fallos del proveedor suman fallos seguidos y emite data-status:changed', async () => {
    await service.addTicker('AAPL');
    provider.queueFailures(1, 'network');

    vi.setSystemTime('2026-10-10T12:00:00.000Z');
    await service.refreshNow();

    const status = tickerStatus('AAPL');
    expect(status).toMatchObject({ state: 'desactualizado', consecutiveFailures: 1 });
    const providerStatus = repo.getDataStatus(dataStatusKey.provider('simulated'));
    expect(providerStatus).toMatchObject({ consecutiveFailures: 1 });
    const changes = sent.filter((s) => s.channel === IPC_CHANNELS.dataStatus.changed);
    expect(changes.length).toBeGreaterThan(0);
  });

  it('watchlist remove quita el ticker de la lista', async () => {
    await service.addTicker('AAPL');
    const list = service.removeTicker('aapl');
    expect(list).toEqual([]);
    // Las velas guardadas se conservan (historial del activo).
    expect(repo.getBars('AAPL').length).toBeGreaterThan(0);
  });
});
