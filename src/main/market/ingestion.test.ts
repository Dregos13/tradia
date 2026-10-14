import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dataStatusKey, IPC_CHANNELS, type MarketUpdatedEvent } from '../../shared/ipc';
import { sessionDateLabel } from '../../shared/dates';
import { MIGRATIONS } from '../db/migrations';
import { migrate } from '../db/migrator';
import * as nyseCalendar from './calendar';
import {
  createMarketClock,
  createMarketIngestionService,
  e2eMarketClockBase,
  MARKET_MAX_RETRIES,
  MARKET_RETRY_INTERVAL_MS,
  type MarketIngestionDeps,
  type MarketIngestionService,
  type MarketPowerMonitorLike,
} from './ingestion';
import { createSimulatedProvider, type SimulatedProvider } from './providers/simulated';
import { InvalidStoredKeyError, type MarketDataProvider } from './providers/types';
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
    expect(tickerStatus('AAPL')!.reason).toContain(sessionDateLabel(NEW_SESSION));
    expect(tickerStatus('AAPL')!.reason).not.toContain(NEW_SESSION);
  });

  it('los motivos de «actualizando» escriben las fechas en formato local, nunca AAAA-MM-DD', async () => {
    await service.addTicker('AAPL');
    await service.start();
    // La segunda pasada deja la vela esperada pendiente: además del motivo
    // «descargando velas del … al …» se publica «esperando la vela del …».
    provider.injectGap('AAPL', NEW_SESSION);

    await vi.advanceTimersByTimeAsync(msToNextUpdate());
    await flushAsync();

    const actualizando = sent
      .filter((s) => s.channel === IPC_CHANNELS.dataStatus.changed)
      .map((s) => s.payload as { state: string; reason?: string | null })
      .filter((entry) => entry.state === 'actualizando');
    expect(actualizando.length).toBeGreaterThanOrEqual(2);
    for (const entry of actualizando) {
      expect(entry.reason ?? '').not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
    const reasons = actualizando.map((entry) => entry.reason ?? '');
    expect(reasons.some((reason) => reason.includes('descargando velas'))).toBe(true);
    expect(reasons.some((reason) => reason.includes(sessionDateLabel(NEW_SESSION)))).toBe(true);
  });

  it('una clave guardada no válida marca el activo con el motivo de clave, no «sin conexión»', async () => {
    // El proveedor rechaza la clave guardada antes de la petición (R1):
    // la ingesta lo refleja como problema de clave, reintento inútil fuera.
    provider = {
      id: 'tiingo',
      rateLimits: { perHour: 50, perDay: 1000 },
      getBars: async () => {
        throw new InvalidStoredKeyError({ provider: 'tiingo', ticker: 'AAPL' });
      },
      getQuote: async () => {
        throw new InvalidStoredKeyError({ provider: 'tiingo' });
      },
      getCorporateActions: async () => [],
    } as unknown as SimulatedProvider;

    await service.addTicker('AAPL');

    expect(tickerStatus('AAPL')).toMatchObject({ state: 'desactualizado' });
    expect(tickerStatus('AAPL')!.reason).toContain('vuelve a pegarla');
    expect(tickerStatus('AAPL')!.reason).not.toContain('Sin conexión');
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
    // A las 20:30 UTC ya pasó el cierre real de verano (20:00 UTC).
    expect(repo.lastBarDate('AAPL')).toBe(NEW_SESSION);
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
    expect(await first).toEqual({ accepted: true, reason: null, ok: true, detail: null });
  });

  it('refreshNow con la pasada fallida devuelve ok:false y el motivo real, no un «solicitado»', async () => {
    await service.addTicker('AAPL');
    provider.setFailing('network');
    // Ya hay una sesión nueva esperada (viernes 09): la pasada intenta traerla.
    vi.setSystemTime('2026-10-10T12:00:00.000Z');

    const result = await service.refreshNow();

    expect(result).toMatchObject({ accepted: true, ok: false });
    expect(result.detail).toContain('fallo simulado del proveedor');
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

  it('una sola caída del proveedor cuenta una vez por pasada, no por activo', async () => {
    await service.addTicker('AAPL');
    await service.addTicker('MSFT');
    await service.addTicker('NVDA');
    await service.addTicker('JNJ');
    await service.start();
    provider.setFailing('network');

    // Una pasada con los 4 activos fallando suma 1 fallo del proveedor,
    // no 4: una sola caída de red no puede llegar a «no fiable».
    vi.setSystemTime('2026-10-10T12:00:00.000Z');
    await service.refreshNow();
    const firstPass = repo.getDataStatus(dataStatusKey.provider('simulated'));
    expect(firstPass).toMatchObject({ state: 'desactualizado', consecutiveFailures: 1 });
    for (const ticker of ['AAPL', 'MSFT', 'NVDA', 'JNJ']) {
      expect(tickerStatus(ticker)!.consecutiveFailures).toBe(1);
    }

    // La regla de los 3 fallos sigue midiendo pasadas, no activos.
    await service.refreshNow();
    await service.refreshNow();
    expect(repo.getDataStatus(dataStatusKey.provider('simulated'))).toMatchObject({
      state: 'no-fiable',
      consecutiveFailures: 3,
    });
  });

  it('watchlist remove quita el ticker de la lista', async () => {
    await service.addTicker('AAPL');
    const list = service.removeTicker('aapl');
    expect(list).toEqual([]);
    // Las velas guardadas se conservan (historial del activo).
    expect(repo.getBars('AAPL').length).toBeGreaterThan(0);
  });
});

describe('ingesta de divisas', () => {
  it('añade EUR/USD en cualquier forma escrita y la guarda como EURUSD fx', async () => {
    for (const written of ['EUR/USD', 'eurusd', 'EUR-USD']) {
      const list = await service.addTicker(written);
      expect(list[0]).toMatchObject({ ticker: 'EURUSD', assetClass: 'fx' });
      service.removeTicker('EURUSD');
    }

    const list = await service.addTicker('EURUSD');
    expect(list).toEqual([expect.objectContaining({ ticker: 'EURUSD', assetClass: 'fx' })]);

    // El histórico de ~5 años son velas diarias del calendario 24/5
    // (lunes a viernes, sin festivos de NYSE), cotización en torno a 1,1
    // y sin volumen: el mercado de divisas no lo publica.
    const bars = repo.getBars('EURUSD');
    expect(bars.length).toBeGreaterThan(1200);
    for (const bar of bars) {
      const day = new Date(`${bar.date}T00:00:00.000Z`).getUTCDay();
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(5);
      expect(bar.volume).toBe(0);
      expect(bar.close).toBeGreaterThan(0.8);
      expect(bar.close).toBeLessThan(1.4);
    }
    expect(repo.lastBarDate('EURUSD')).toBe(LAST_SESSION);
    expect(tickerStatus('EURUSD')).toMatchObject({ state: 'fiable', consecutiveFailures: 0 });
  });

  it('el par sigue al día en un festivo de NYSE (calendario 24/5)', async () => {
    // Sábado 04-07-2026: el viernes 03-07 fue festivo observado de NYSE
    // (Independence Day cayó en sábado) pero sesión normal de divisas.
    vi.setSystemTime('2026-07-04T12:00:00.000Z');

    await service.addTicker('AAPL');
    await service.addTicker('EURUSD');

    // La acción espera la última sesión de NYSE (jueves 02); el par, la
    // de divisas del viernes 03 — el proveedor simulado la tiene.
    expect(repo.lastBarDate('AAPL')).toBe('2026-07-02');
    expect(repo.lastBarDate('EURUSD')).toBe('2026-07-03');
    expect(repo.getBars('EURUSD').some((b) => b.date === '2026-07-03')).toBe(true);
    expect(tickerStatus('EURUSD')).toMatchObject({ state: 'fiable' });
  });

  it('con el proveedor Tiingo el par pide el endpoint FX y queda al día', async () => {
    // Sábado 17-10-2026 12:00 UTC: la última vela de divisas esperada es
    // la del viernes 16 (cierra a las 00:00 UTC del sábado).
    vi.setSystemTime('2026-10-17T12:00:00.000Z');
    const fxRows = Array.from({ length: 10 }, (_, i) => {
      const day = ['05', '06', '07', '08', '09', '12', '13', '14', '15', '16'][i];
      return {
        date: `2026-10-${day}T00:00:00.000Z`,
        open: 1.102 + i * 0.001,
        high: 1.105 + i * 0.001,
        low: 1.1 + i * 0.001,
        close: 1.104 + i * 0.001,
      };
    });
    const calls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify(fxRows), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const { createTiingoProvider } = await import('./providers/tiingo');
    const tiingo = createTiingoProvider({ fetch, getApiKey: async () => 'TEST-KEY' });
    service = setup({ resolveProvider: async () => tiingo });

    const list = await service.addTicker('eur/usd');

    expect(list[0]).toMatchObject({ ticker: 'EURUSD', assetClass: 'fx' });
    // La petición va al endpoint FX, no al diario de acciones.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('/tiingo/fx/eurusd/prices');
    expect(calls[0]).toContain('resampleFreq=1day');

    const stored = repo.getBars('EURUSD');
    expect(stored.map((b) => b.date)).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
    ]);
    expect(repo.lastBarDate('EURUSD')).toBe('2026-10-16');
    expect(tickerStatus('EURUSD')).toMatchObject({ state: 'fiable', consecutiveFailures: 0 });
  });

  it('un par que el proveedor no cubre queda no-fiable sin tumbarlo a él', async () => {
    vi.setSystemTime('2026-10-17T12:00:00.000Z');
    const { createTiingoProvider } = await import('./providers/tiingo');
    const tiingo = createTiingoProvider({
      fetch: async () =>
        new Response(JSON.stringify({ detail: 'not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }),
      getApiKey: async () => 'TEST-KEY',
    });
    service = setup({ resolveProvider: async () => tiingo });

    await service.addTicker('USDCHF');

    // Un par sin datos del proveedor queda aislado como fallo suyo,
    // reintentable solo en la siguiente pasada diaria (no es 'network').
    expect(tickerStatus('USDCHF')).toMatchObject({ state: 'no-fiable' });
    // Y no es un fallo del proveedor: ni siquiera hay fila de
    // `provider:tiingo`, que solo se escribe con un fallo de proveedor.
    expect(repo.getDataStatus(dataStatusKey.provider('tiingo'))).toBeNull();
  });
});

describe('e2eMarketClockBase (TRADIA_E2E_MARKET_NOW)', () => {
  const PINNED = '2026-10-06T22:00:00.000Z';

  it('solo existe en E2E sin empaquetar y con una fecha válida', () => {
    expect(
      e2eMarketClockBase(true, { TRADIA_E2E: '1', TRADIA_E2E_MARKET_NOW: PINNED }),
    ).toBeUndefined();
    expect(e2eMarketClockBase(false, { TRADIA_E2E_MARKET_NOW: PINNED })).toBeUndefined();
    expect(e2eMarketClockBase(false, { TRADIA_E2E: '1' })).toBeUndefined();
    expect(
      e2eMarketClockBase(false, { TRADIA_E2E: '1', TRADIA_E2E_MARKET_NOW: 'no-es-fecha' }),
    ).toBeUndefined();
  });

  it('ancla el arranque del reloj al instante pedido y sigue el tiempo real', () => {
    let real = 1_000_000_000_000;
    const base = e2eMarketClockBase(
      false,
      { TRADIA_E2E: '1', TRADIA_E2E_MARKET_NOW: PINNED },
      () => real,
    );
    const clock = createMarketClock(base);
    const pinnedMs = Date.parse(PINNED);

    expect(clock.now()).toBe(pinnedMs);
    // El reloj sigue avanzando con el tiempo real…
    real += 5_000;
    expect(clock.now()).toBe(pinnedMs + 5_000);
    // …y con el avance manual del gancho de desarrollo.
    expect(clock.advance(24 * 3_600_000)).toBe(pinnedMs + 5_000 + 24 * 3_600_000);
  });
});
