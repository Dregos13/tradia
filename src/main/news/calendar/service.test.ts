import type Database from 'better-sqlite3';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS, IpcValidationError, type CalendarUpdatedEvent } from '../../../shared/ipc';
import { openDatabase } from '../../db/database';
import type { ServiceContext } from '../../services';
import type { EarningsProvider } from './earnings';
import type { GeneratedCalendarEvent } from './generate';
import {
  createCalendarRepository,
  createCalendarService,
  registerCalendar,
  type CalendarClock,
} from './service';

// electron solo aporta ipcMain/app/powerMonitor; se captura el mapa de handlers.
const env = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  isPackaged: true,
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      env.handlers.set(channel, handler),
  },
  app: {
    get isPackaged() {
      return env.isPackaged;
    },
  },
  powerMonitor: { on: () => undefined, removeListener: () => undefined },
}));

const FIXED_NOW = Date.parse('2026-10-08T12:00:00.000Z');

const dbs: Database.Database[] = [];
const db = (): Database.Database => {
  const instance = openDatabase(':memory:');
  dbs.push(instance);
  return instance;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const instance of dbs.splice(0)) {
    if (instance.open) instance.close();
  }
});

const makeClock = (base = FIXED_NOW): CalendarClock & { offset(): number } => {
  let offset = 0;
  return {
    now: () => base + offset,
    advance: (ms) => {
      offset += ms;
      return base + offset;
    },
    offset: () => offset,
  };
};

const macroEvent = (overrides: Partial<GeneratedCalendarEvent> = {}): GeneratedCalendarEvent => ({
  clave: 'nfp:2026-11-06',
  kind: 'nfp',
  title: 'Nóminas no agrícolas de EE. UU. (NFP)',
  dateUtc: '2026-11-06T13:30:00.000Z',
  impact: 'alto',
  country: 'US',
  asset: null,
  origin: 'oficial',
  ...overrides,
});

const makeService = (deps: {
  sent?: Array<{ channel: string; payload: unknown }>;
  tickers?: () => string[];
  earnings?: EarningsProvider | null;
  clock?: CalendarClock & { offset(): number };
  online?: () => boolean;
}) => {
  const sent = deps.sent ?? [];
  const clock = deps.clock ?? makeClock();
  const service = createCalendarService({
    repo: createCalendarRepository(db()),
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    getWatchedTickers: deps.tickers ?? (() => []),
    resolveEarnings: async () => deps.earnings ?? null,
    isOnline: deps.online ?? (() => true),
    clock,
  });
  return { service, sent, clock };
};

const updatedEvents = (sent: Array<{ channel: string; payload: unknown }>) =>
  sent.filter((e) => e.channel === IPC_CHANNELS.calendar.updated);

// ---------------------------------------------------------------------------

describe('repositorio del calendario (calendar_events)', () => {
  it('upsert inserta, conserva el id y solo reescribe si algo cambió', () => {
    const repo = createCalendarRepository(db());
    const event = macroEvent();
    expect(repo.upsert([event])).toBe(1);
    const first = repo.listInRange('2026-11-01', '2026-11-30')[0]!;
    expect(first).toMatchObject({ kind: 'nfp', impact: 'alto', origin: 'oficial' });

    // Misma pasada otra vez: cero cambios y el mismo id.
    expect(repo.upsert([event])).toBe(0);
    // Cambio real (otra hora publicada): 1 cambio, mismo id.
    expect(repo.upsert([{ ...event, dateUtc: '2026-11-06T14:30:00.000Z' }])).toBe(1);
    const second = repo.listInRange('2026-11-01', '2026-11-30')[0]!;
    expect(second.id).toBe(first.id);
    expect(second.dateUtc).toBe('2026-11-06T14:30:00.000Z');
  });

  it('pruneStale borra lo que ya no se genera y respeta los tipos preservados', () => {
    const repo = createCalendarRepository(db());
    const eia = macroEvent({
      clave: 'eia:2026-10-07',
      kind: 'eia',
      impact: 'medio',
      dateUtc: '2026-10-07T14:30:00.000Z',
      origin: 'regla',
    });
    const earnings = macroEvent({
      clave: 'resultados:AAPL:2026-10-22',
      kind: 'resultados',
      impact: 'medio',
      dateUtc: '2026-10-22T20:00:00.000Z',
      asset: 'AAPL',
      origin: 'finnhub',
    });
    repo.upsert([eia, earnings]);
    const removed = repo.pruneStale(
      '2026-10-01T00:00:00.000Z',
      '2026-10-31T23:59:59.999Z',
      new Set([eia.clave]),
      ['resultados'],
    );
    expect(removed).toBe(0); // eia se conserva y resultados está preservado
    const removed2 = repo.pruneStale(
      '2026-10-01T00:00:00.000Z',
      '2026-10-31T23:59:59.999Z',
      new Set(),
    );
    expect(removed2).toBe(2);
    expect(repo.listInRange('2026-10-01', '2026-10-31')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('servicio del calendario', () => {
  it('la semana en curso devuelve los eventos con su impacto (calendar:list)', async () => {
    const { service } = makeService({});
    await service.refresh();
    const week = service.list({ desde: '2026-10-05', hasta: '2026-10-11' });
    const eia = week.find((e) => e.kind === 'eia');
    expect(eia).toMatchObject({ dateUtc: '2026-10-07T14:30:00.000Z', impact: 'medio' });
    const pmi = week.find((e) => e.kind === 'pmi');
    expect(pmi).toMatchObject({ dateUtc: '2026-10-05T14:00:00.000Z', impact: 'medio' });
    // Ordenados por instante.
    const instants = week.map((e) => e.dateUtc);
    expect([...instants].sort()).toEqual(instants);
  });

  it('emite calendar:updated cuando cambia la tabla, no en pasadas vacías', async () => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const { service } = makeService({ sent });
    const first = await service.refresh();
    expect(first.changed).toBe(true);
    expect(updatedEvents(sent)).toHaveLength(1);
    expect((updatedEvents(sent)[0]!.payload as CalendarUpdatedEvent).updatedAt).toBe(
      '2026-10-08T12:00:00.000Z',
    );

    const second = await service.refresh();
    expect(second.changed).toBe(false);
    expect(updatedEvents(sent)).toHaveLength(1);
  });

  it('los ids de los eventos se conservan entre refrescos (notification_log)', async () => {
    const { service } = makeService({});
    await service.refresh();
    const before = service.list({ desde: '2026-10-05', hasta: '2026-10-11' });
    await service.refresh();
    const after = service.list({ desde: '2026-10-05', hasta: '2026-10-11' });
    expect(after.map((e) => e.id)).toEqual(before.map((e) => e.id));
  });

  it('mete los resultados de los activos seguidos y los poda al quitar el ticker', async () => {
    const entries = [
      { symbol: 'AAPL', date: '2026-10-22', session: 'amc' as const, epsEstimate: 1.6 },
    ];
    let tickers = ['AAPL'];
    const provider: EarningsProvider = {
      id: 'finnhub',
      fetch: async (watched) =>
        entries.filter((e) => watched.map((t) => t.toUpperCase()).includes(e.symbol)),
    };
    const { service } = makeService({ tickers: () => tickers, earnings: provider });
    const first = await service.refresh();
    expect(first.earningsOrigin).toBe('finnhub');
    const results = service.list({ desde: '2026-10-01', hasta: '2026-10-31' });
    const earnings = results.find((e) => e.kind === 'resultados');
    expect(earnings).toMatchObject({ asset: 'AAPL', origin: 'finnhub', impact: 'medio' });

    // El usuario quita AAPL: el refresco borra sus resultados de la ventana.
    tickers = [];
    await service.refresh();
    expect(
      service
        .list({ desde: '2026-10-01', hasta: '2026-10-31' })
        .filter((e) => e.kind === 'resultados'),
    ).toHaveLength(0);
    // Pero los eventos macro siguen ahí.
    expect(service.list({ desde: '2026-10-01', hasta: '2026-10-31' }).length).toBeGreaterThan(0);
  });

  it('si el proveedor de resultados falla, conserva los que ya estaban', async () => {
    let failing = false;
    const provider: EarningsProvider = {
      id: 'finnhub',
      fetch: async () => {
        if (failing) throw new Error('429');
        return [{ symbol: 'AAPL', date: '2026-10-22', session: 'amc', epsEstimate: null }];
      },
    };
    const { service } = makeService({ tickers: () => ['AAPL'], earnings: provider });
    await service.refresh();
    expect(
      service
        .list({ desde: '2026-10-01', hasta: '2026-10-31' })
        .some((e) => e.kind === 'resultados'),
    ).toBe(true);

    failing = true;
    const result = await service.refresh();
    expect(result.earningsOrigin).toBeNull();
    expect(
      service
        .list({ desde: '2026-10-01', hasta: '2026-10-31' })
        .some((e) => e.kind === 'resultados' && e.asset === 'AAPL'),
    ).toBe(true);
  });

  it('sin conexión regenera lo macro pero preserva los resultados', async () => {
    const provider: EarningsProvider = {
      id: 'finnhub',
      fetch: async () => [
        { symbol: 'AAPL', date: '2026-10-22', session: 'bmo', epsEstimate: null },
      ],
    };
    let online = true;
    const { service } = makeService({
      tickers: () => ['AAPL'],
      earnings: provider,
      online: () => online,
    });
    await service.refresh();
    online = false;
    await service.refresh();
    const week = service.list({ desde: '2026-10-01', hasta: '2026-10-31' });
    expect(week.some((e) => e.kind === 'resultados' && e.asset === 'AAPL')).toBe(true);
    expect(week.some((e) => e.kind === 'eia')).toBe(true);
  });

  it('advanceClock mueve el reloj y reevalúa (gancho de desarrollo)', async () => {
    const { service, clock } = makeService({});
    await service.refresh();
    const moved = service.advanceClock!(7 * 86_400_000);
    expect(moved.now).toBe('2026-10-15T12:00:00.000Z');
    expect(clock.offset()).toBe(7 * 86_400_000);
  });
});

// ---------------------------------------------------------------------------

describe('registerCalendar (cableado IPC y servicios)', () => {
  const makeCtx = (database: Database.Database) => {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const watchlistListeners: Array<() => void> = [];
    let tickers = ['AAPL'];
    const pollerAdvance = vi.fn((ms: number) => ({
      now: new Date(FIXED_NOW + ms).toISOString(),
    }));
    const ctx = {
      broadcast: (channel: string, payload: unknown) => sent.push({ channel, payload }),
      services: {
        storage: { getDb: () => database },
        market: {
          listWatchlist: () => tickers.map((ticker) => ({ ticker })),
          onWatchlistChanged: (listener: () => void) => {
            watchlistListeners.push(listener);
            return () => undefined;
          },
        },
        poller: { advanceClock: pollerAdvance },
      },
    } as unknown as ServiceContext;
    return {
      ctx,
      sent,
      watchlistListeners,
      pollerAdvance,
      setTickers: (t: string[]) => {
        tickers = t;
      },
    };
  };

  it('registra calendar:list, valida el rango y sirve la semana en curso', async () => {
    env.isPackaged = true;
    const { ctx } = makeCtx(db());
    const service = registerCalendar(ctx);
    await service.refresh();

    const handler = env.handlers.get('calendar:list');
    expect(handler).toBeDefined();
    const week = (await handler!(null, { desde: '2026-10-05', hasta: '2026-10-11' })) as Array<{
      kind: string;
    }>;
    expect(week.some((e) => e.kind === 'eia')).toBe(true);
    expect(() => handler!(null, { desde: '2026-10-11', hasta: '2026-10-05' })).toThrow(
      IpcValidationError,
    );
    expect(() => handler!(null, { desde: 'nada' })).toThrow(IpcValidationError);
    service.stop();
  });

  it('refresca al cambiar la watchlist y emite calendar:updated', async () => {
    env.isPackaged = false;
    vi.stubEnv('TRADIA_E2E', '1');
    const { ctx, sent, watchlistListeners, setTickers } = makeCtx(db());
    const service = registerCalendar(ctx);
    await service.refresh();
    // Con TRADIA_E2E los resultados simulados cubren los activos seguidos.
    expect(
      service
        .list({ desde: '2026-10-01', hasta: '2026-10-31' })
        .some((e) => e.kind === 'resultados' && e.asset === 'AAPL'),
    ).toBe(true);

    const before = updatedEvents(sent).length;
    setTickers([]);
    for (const listener of watchlistListeners) listener();
    await service.refresh(); // espera a la pasada encadenada por el listener
    expect(updatedEvents(sent).length).toBeGreaterThan(before);
    expect(
      service
        .list({ desde: '2026-10-01', hasta: '2026-10-31' })
        .filter((e) => e.kind === 'resultados'),
    ).toHaveLength(0);
    vi.unstubAllEnvs();
    service.stop();
  });

  it('encadena news:advance-clock al reloj del calendario', async () => {
    env.isPackaged = true;
    const { ctx, pollerAdvance } = makeCtx(db());
    const service = registerCalendar(ctx);
    await service.refresh();

    const before = Date.parse(service.advanceClock!(0).now);
    // El handler del lector llama a poller.advanceClock: debe mover ambos.
    ctx.services.poller!.advanceClock!(60_000);
    expect(pollerAdvance).toHaveBeenCalledWith(60_000);
    const after = Date.parse(service.advanceClock!(0).now);
    expect(after - before).toBeGreaterThanOrEqual(60_000);
    service.stop();
  });
});
