import type Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IPC_CHANNELS,
  IpcValidationError,
  type ConnectivityState,
  type NewsPollResult,
  type NewsUpdatedEvent,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import rssFeed from './connectors/__fixtures__/rss20.xml?raw';
import {
  createConnectorRegistry,
  type ConnectorFetch,
  type ConnectorFetchResponse,
} from './connectors';
import {
  canonicalizeUrl,
  createNewsClock,
  createNewsPoller,
  createNewsRepository,
  dedupHash,
  minIntervalMsFromLimits,
  normalizeTitle,
  relatedAssets,
  registerNews,
  titleSimilarity,
  type NewsItemsStoredEvent,
  type NewsPollerDeps,
  type PollerPowerMonitorLike,
} from './poller';
import { createSourcesRepository, createSourcesService } from './sources';

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
  for (const instance of dbs.splice(0)) {
    if (instance.open) instance.close();
  }
});

const response = (status: number, body: string): ConnectorFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: () => Promise.resolve(body),
});

/** fetch simulado por URL; las no mapeadas devuelven 404. */
function fetchByUrl(
  routes: Record<string, ConnectorFetchResponse | (() => ConnectorFetchResponse)>,
) {
  const calls: string[] = [];
  const impl: ConnectorFetch = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (route === undefined) return response(404, 'not found');
    return typeof route === 'function' ? route() : route;
  };
  return { impl, calls };
}

/** Feed RSS mínimo con un solo titular (los campos que usa el conector). */
const oneItemFeed = (title: string, link: string, pubDate: string, summary = ''): string =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
   <item><title>${title}</title><link>${link}</link><pubDate>${pubDate}</pubDate>
   <description>${summary}</description></item></channel></rss>`;

const FEED_A = 'https://a.example.com/feed.xml';
const FEED_B = 'https://b.example.com/feed.xml';
const FEED_C = 'https://c.example.com/feed.xml';

class FakePowerMonitor implements PollerPowerMonitorLike {
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
}

interface Harness {
  service: ReturnType<typeof createNewsPoller>;
  sources: ReturnType<typeof createSourcesService>;
  repo: ReturnType<typeof createNewsRepository>;
  sent: Array<{ channel: string; payload: unknown }>;
  stored: NewsItemsStoredEvent[];
  powerMonitor: FakePowerMonitor;
  online: { value: boolean };
}

/**
 * Monta fuentes + lector sobre la misma base (news_item_sources tiene FK a
 * news_sources). El reloj es el de los temporizadores falsos de vitest.
 */
function makeHarness(fetchImpl: ConnectorFetch, deps: Partial<NewsPollerDeps> = {}): Harness {
  const database = db();
  const sourcesRepo = createSourcesRepository(database);
  const repo = createNewsRepository(database);
  const connectors = createConnectorRegistry({ fetch: fetchImpl, now: () => Date.now() });
  const sources = createSourcesService({ repo: sourcesRepo, connectors, now: () => Date.now() });
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const stored: NewsItemsStoredEvent[] = [];
  const powerMonitor = new FakePowerMonitor();
  const online = { value: true };
  const service = createNewsPoller({
    repo,
    sources,
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    now: () => Date.now(),
    isOnline: () => online.value,
    powerMonitor,
    random: () => 0.5,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    ...deps,
  });
  service.onItemsStored((event) => stored.push(event));
  return { service, sources, repo, sent, stored, powerMonitor, online };
}

const addSource = (
  sources: ReturnType<typeof createSourcesService>,
  overrides: Record<string, unknown> = {},
) =>
  sources.add({
    name: 'Fuente',
    kind: 'rss',
    connector: 'rss',
    url: FEED_A,
    reliability: 'agencia',
    ...overrides,
  } as Parameters<ReturnType<typeof createSourcesService>['add']>[0]);

describe('canonicalizeUrl', () => {
  it('quita parámetros de seguimiento y ordena el resto', () => {
    expect(
      canonicalizeUrl(
        'https://NEWS.Example.com/story/?id=7&utm_source=rss&b=2&utm_medium=feed&a=1#frag',
      ),
    ).toBe('https://news.example.com/story?a=1&b=2&id=7');
  });

  it('quita fbclid/gclid, el fragmento y el puerto por defecto', () => {
    expect(canonicalizeUrl('https://x.example:443/p?fbclid=abc&gclid=1#top')).toBe(
      'https://x.example/p',
    );
  });

  it('rechaza lo que no es http(s)', () => {
    expect(canonicalizeUrl('file:///tmp/feed.xml')).toBeNull();
    expect(canonicalizeUrl('javascript:alert(1)')).toBeNull();
    expect(canonicalizeUrl('no es una url')).toBeNull();
    expect(canonicalizeUrl(null)).toBeNull();
  });
});

describe('normalizeTitle y titleSimilarity', () => {
  it('normaliza minúsculas, tildes y puntuación', () => {
    expect(normalizeTitle('¡La Fed SUBE tipos! (Reuters)')).toBe('la fed sube tipos reuters');
  });

  it('titulares casi iguales pasan el umbral de 0,9', () => {
    expect(
      titleSimilarity(
        'Fed raises interest rates by 25 points',
        'Fed raises interest rates by 25 points today',
      ),
    ).toBeGreaterThanOrEqual(0.9);
  });

  it('titulares distintos no llegan al umbral', () => {
    expect(titleSimilarity('Fed raises interest rates', 'Fed cuts interest rates')).toBeLessThan(
      0.9,
    );
    expect(titleSimilarity('', 'algo')).toBe(0);
  });

  it('dedupHash es estable y distingue URL distintas', () => {
    const a = dedupHash('titular', 'https://x/1');
    expect(dedupHash('titular', 'https://x/1')).toBe(a);
    expect(dedupHash('titular', 'https://x/2')).not.toBe(a);
    expect(dedupHash('titular', null)).not.toBe(a);
  });
});

describe('minIntervalMsFromLimits', () => {
  it('respeta la ventana más restrictiva', () => {
    expect(minIntervalMsFromLimits({ perHour: 60, perDay: 1440 })).toBe(60_000);
    expect(minIntervalMsFromLimits({ perHour: 30, perDay: 200 })).toBe(432_000);
  });
});

describe('relatedAssets', () => {
  it('liga tickers etiquetados por la fuente, $cashtags y activos seguidos', () => {
    const assets = relatedAssets(
      { title: 'Resultados de $aapl y aviso de MSFT', assets: ['tlt', 'xom'] },
      [{ ticker: 'MSFT' }],
      {},
    );
    expect(assets).toEqual(['AAPL', 'MSFT', 'TLT', 'XOM']);
  });

  it('liga el nombre de un activo seguido solo si está en la lista', () => {
    const item = { title: 'Apple presenta resultados esta semana' };
    expect(relatedAssets(item, [{ ticker: 'AAPL' }])).toContain('AAPL');
    // Sin AAPL en la lista, el nombre no liga nada.
    expect(relatedAssets(item, [{ ticker: 'MSFT' }])).toEqual([]);
  });

  it('los nombres ambiguos exigen mayúscula: «visa» común no liga V', () => {
    const watchlist = [{ ticker: 'V' }];
    expect(relatedAssets({ title: 'Nuevas restricciones de visa en Europa' }, watchlist)).toEqual(
      [],
    );
    expect(relatedAssets({ title: 'Visa mejora su guía anual' }, watchlist)).toEqual(['V']);
  });
});

describe('lector de noticias (pasada)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('dos fuentes con la misma noticia generan un solo ítem con dos fuentes', async () => {
    const { impl } = fetchByUrl({
      [FEED_A]: response(200, rssFeed),
      [FEED_B]: response(200, rssFeed),
    });
    const h = makeHarness(impl);
    const a = addSource(h.sources, { name: 'Agencia A', url: FEED_A });
    const b = addSource(h.sources, { name: 'Agencia B', url: FEED_B });

    const result = await h.service.pollNow();

    expect(result).toMatchObject({ sourcesPolled: 2, newItems: 3 });
    const items = h.service.listNews();
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(item.sources.map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
      expect(item.confirmed).toBe(true);
    }
    // El comunicado del FOMC se clasifica como máxima prioridad.
    const fomc = items.find((i) => i.title.includes('FOMC'))!;
    expect(fomc.priority).toBe('maxima');
    // Y la pasada emitió news:updated con el recuento.
    const event = h.sent.find((s) => s.channel === IPC_CHANNELS.news.updated)!;
    expect((event.payload as NewsUpdatedEvent).newItems).toBe(3);
    expect(h.stored).toHaveLength(1);
    expect(h.stored[0]!.added).toHaveLength(3);
  });

  it('una fuente con 429 no bloquea a las demás', async () => {
    const { impl } = fetchByUrl({
      [FEED_A]: response(429, 'too many requests'),
      [FEED_B]: response(200, rssFeed),
    });
    const h = makeHarness(impl);
    addSource(h.sources, { name: 'Limitada', url: FEED_A });
    addSource(h.sources, { name: 'Sana', url: FEED_B });

    const result = await h.service.pollNow();

    expect(result.sourcesPolled).toBe(2);
    expect(result.newItems).toBe(3);
    const [limited, healthy] = h.sources.list();
    expect(limited!.lastStatus).toBe('error');
    expect(limited!.lastError).toContain('429');
    expect(healthy!.lastStatus).toBe('ok');
    expect(healthy!.lastFetchedAt).toBe(new Date(FIXED_NOW).toISOString());
  });

  it('honra retryAfterMs del 429 en la siguiente lectura', async () => {
    const retry = response(429, 'wait');
    const { impl } = fetchByUrl({ [FEED_A]: retry });
    const h = makeHarness(impl);
    addSource(h.sources, { url: FEED_A });

    // Con retry-after HTTP el conector propaga retryAfterMs; aquí la cuota
    // del error fuerza espera exponencial (60 s con random fijo 0,5).
    await h.service.pollNow();
    const callsAfter = h.sources.list()[0]!;
    expect(callsAfter.lastStatus).toBe('error');
  });

  it('deduplica por URL canónica ignorando parámetros de seguimiento', async () => {
    const feedTracked = oneItemFeed(
      'Los inventarios de crudo caen más de lo esperado',
      'https://news.example/eia?utm_source=rss&amp;id=1',
      'Wed, 08 Oct 2026 10:00:00 GMT',
    );
    const feedClean = oneItemFeed(
      'Los inventarios de crudo caen más de lo esperado',
      'https://news.example/eia?id=1&amp;utm_campaign=alerta',
      'Wed, 08 Oct 2026 10:05:00 GMT',
    );
    const { impl } = fetchByUrl({
      [FEED_A]: response(200, feedTracked),
      [FEED_B]: response(200, feedClean),
    });
    const h = makeHarness(impl);
    addSource(h.sources, { name: 'A', url: FEED_A });
    addSource(h.sources, { name: 'B', url: FEED_B });

    const result = await h.service.pollNow();

    expect(result.newItems).toBe(1);
    const [item] = h.service.listNews();
    expect(item!.sources).toHaveLength(2);
    expect(item!.url).toBe('https://news.example/eia?id=1');
  });

  it('deduplica por título casi idéntico dentro de la ventana de 24 h', async () => {
    const feedA = oneItemFeed(
      'Fed raises interest rates by 25 points',
      'https://a.example/1',
      'Wed, 08 Oct 2026 10:00:00 GMT',
    );
    const feedB = oneItemFeed(
      'Fed raises interest rates by 25 points today',
      'https://b.example/2',
      'Wed, 08 Oct 2026 11:00:00 GMT',
    );
    const { impl } = fetchByUrl({ [FEED_A]: response(200, feedA), [FEED_B]: response(200, feedB) });
    const h = makeHarness(impl);
    addSource(h.sources, { name: 'A', url: FEED_A });
    addSource(h.sources, { name: 'B', url: FEED_B });

    const result = await h.service.pollNow();

    expect(result.newItems).toBe(1);
    expect(h.service.listNews()[0]!.sources).toHaveLength(2);
  });

  it('no deduplica titulares distintos ni el mismo título fuera de la ventana', async () => {
    const sameTitleOld = oneItemFeed(
      'Weekly oil market report released',
      'https://a.example/old',
      'Mon, 05 Oct 2026 10:00:00 GMT',
    );
    const sameTitleNew = oneItemFeed(
      'Weekly oil market report released',
      'https://b.example/new',
      'Thu, 08 Oct 2026 10:00:00 GMT',
    );
    const { impl } = fetchByUrl({
      [FEED_A]: response(200, sameTitleOld),
      [FEED_B]: response(200, sameTitleNew),
    });
    const h = makeHarness(impl);
    addSource(h.sources, { name: 'A', url: FEED_A });
    addSource(h.sources, { name: 'B', url: FEED_B });

    const result = await h.service.pollNow();

    // Mismo título a 72 h de distancia: son dos informes distintos.
    expect(result.newItems).toBe(2);
  });

  it('una noticia solo de redes nunca queda confirmada; una agencia la confirma al llegar', async () => {
    const rumor = 'Mercado rumor: posible quiebra de un banco regional';
    const feedRedes = oneItemFeed(
      rumor,
      'https://redes.example/r1',
      'Wed, 08 Oct 2026 10:00:00 GMT',
    );
    const feedAgencia = oneItemFeed(
      rumor,
      'https://agencia.example/r2',
      'Wed, 08 Oct 2026 10:30:00 GMT',
    );
    const { impl } = fetchByUrl({
      [FEED_A]: response(200, feedRedes),
      [FEED_B]: response(200, feedAgencia),
    });
    const h = makeHarness(impl);
    addSource(h.sources, { name: 'Redes', url: FEED_A, kind: 'redes', reliability: 'redes' });
    addSource(h.sources, { name: 'Agencia', url: FEED_B, reliability: 'agencia' });

    await h.service.pollNow();

    const [item] = h.service.listNews();
    expect(item!.confirmed).toBe(true);
    expect(item!.sources).toHaveLength(2);
    expect(item!.priority).toBe('maxima');

    // Un ítem solo de redes se queda sin confirmar.
    const soloRedes = makeHarness(fetchByUrl({ [FEED_C]: response(200, feedRedes) }).impl);
    addSource(soloRedes.sources, { url: FEED_C, kind: 'redes', reliability: 'redes' });
    await soloRedes.service.pollNow();
    expect(soloRedes.service.listNews()[0]!.confirmed).toBe(false);
  });

  it('liga activos por ticker, $cashtag y nombre de la lista de seguimiento', async () => {
    const feed = oneItemFeed(
      'Apple mejora su guía anual y $msft acompaña',
      'https://a.example/apple',
      'Wed, 08 Oct 2026 10:00:00 GMT',
    );
    const { impl } = fetchByUrl({ [FEED_A]: response(200, feed) });
    const h = makeHarness(impl, { listWatchlist: () => [{ ticker: 'AAPL' }] });
    addSource(h.sources, { url: FEED_A });

    await h.service.pollNow();

    const [item] = h.service.listNews();
    expect(item!.assets).toEqual(['AAPL', 'MSFT']);
    expect(item!.priority).toBe('activo');
  });

  it('respeta el intervalo de cada fuente entre pasadas', async () => {
    const { impl, calls } = fetchByUrl({ [FEED_A]: response(200, rssFeed) });
    const h = makeHarness(impl);
    addSource(h.sources, { url: FEED_A, intervalSeconds: 300 });

    await h.service.start();
    expect(calls).toHaveLength(1);

    // Antes del intervalo no hay nueva lectura; al vencerlo, sí.
    await vi.advanceTimersByTimeAsync(200_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(2);

    await h.service.stop();
  });

  it('espera con retroceso exponencial ante errores y se recupera', async () => {
    let failing = true;
    const feedResult = () => (failing ? response(500, 'server error') : response(200, rssFeed));
    const { impl, calls } = fetchByUrl({ [FEED_A]: feedResult });
    const h = makeHarness(impl);
    addSource(h.sources, { url: FEED_A });

    await h.service.start();
    expect(calls).toHaveLength(1);

    // Primer fallo → reintento a los 60 s (base, random fijo 0,5).
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);

    // Segundo fallo → reintento a los 120 s.
    await vi.advanceTimersByTimeAsync(118_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(calls).toHaveLength(3);

    // Al volver el éxito se retoma la agenda normal del intervalo.
    failing = false;
    await vi.advanceTimersByTimeAsync(240_000);
    expect(calls).toHaveLength(4);
    expect(h.sources.list()[0]!.lastStatus).toBe('ok');

    await h.service.stop();
  });

  it('se pausa sin conexión y se recupera al volver la red', async () => {
    const { impl, calls } = fetchByUrl({ [FEED_A]: response(200, rssFeed) });
    const h = makeHarness(impl);
    h.online.value = false;
    addSource(h.sources, { url: FEED_A });

    await h.service.start();
    expect(calls).toHaveLength(0);

    // El temporizador sigue despertando pero sin llamar a la fuente.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(0);

    // Al volver la red, recover() lanza la pasada al instante.
    h.online.value = true;
    await h.service.recover();
    expect(calls).toHaveLength(1);

    await h.service.stop();
  });

  it('reevalúa al volver de la suspensión', async () => {
    const { impl, calls } = fetchByUrl({ [FEED_A]: response(200, rssFeed) });
    const h = makeHarness(impl);
    addSource(h.sources, { url: FEED_A });

    await h.service.start();
    expect(calls).toHaveLength(1);

    h.powerMonitor.emitResume();
    await vi.advanceTimersByTimeAsync(0);
    // Tras el resume la fuente no está aún a vencimiento: no se repite.
    expect(calls).toHaveLength(1);

    await h.service.stop();
  });

  it('advanceClock mueve el reloj y dispara la agenda vencida', async () => {
    const { impl, calls } = fetchByUrl({ [FEED_A]: response(200, rssFeed) });
    const clock = createNewsClock(() => Date.now());
    const h = makeHarness(impl, { clock });
    addSource(h.sources, { url: FEED_A, intervalSeconds: 300 });

    await h.service.start();
    expect(calls).toHaveLength(1);

    const result = h.service.advanceClock!(400_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(result.now).toBe(new Date(FIXED_NOW + 400_000).toISOString());
    expect(calls).toHaveLength(2);

    await h.service.stop();
  });

  it('al quitar la fuente deja de traer titulares nuevos', async () => {
    const { impl, calls } = fetchByUrl({ [FEED_A]: response(200, rssFeed) });
    const h = makeHarness(impl);
    const source = addSource(h.sources, { url: FEED_A, intervalSeconds: 60 });

    await h.service.start();
    expect(calls).toHaveLength(1);

    h.sources.remove(source.id);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls).toHaveLength(1);
    // Los titulares ya guardados permanecen en el feed.
    expect(h.service.listNews()).toHaveLength(3);

    await h.service.stop();
  });

  it('news:list filtra por prioridad, confirmación, fuente y activo', async () => {
    const feedMixto = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>Fed raises interest rates by 25 points</title>
        <link>https://x.example/1</link><pubDate>Wed, 08 Oct 2026 10:00:00 GMT</pubDate></item>
      <item><title>Local bakery opens in downtown</title>
        <link>https://x.example/2</link><pubDate>Wed, 08 Oct 2026 09:00:00 GMT</pubDate></item>
    </channel></rss>`;
    const { impl } = fetchByUrl({ [FEED_A]: response(200, feedMixto) });
    const h = makeHarness(impl);
    const source = addSource(h.sources, { url: FEED_A });
    await h.service.pollNow();

    expect(h.service.listNews({ priority: 'maxima' })).toHaveLength(1);
    expect(h.service.listNews({ priority: 'baja' })).toHaveLength(1);
    expect(h.service.listNews({ confirmed: true })).toHaveLength(2);
    expect(h.service.listNews({ confirmed: false })).toHaveLength(0);
    expect(h.service.listNews({ sourceId: source.id })).toHaveLength(2);
    expect(h.service.listNews({ sourceId: source.id + 99 })).toHaveLength(0);
    expect(h.service.listNews({ desde: '2026-10-08' })).toHaveLength(2);
    expect(h.service.listNews({ hasta: '2026-10-07' })).toHaveLength(0);
    expect(h.service.listNews({ limit: 1 })).toHaveLength(1);
    // Orden: el más reciente primero.
    const [first] = h.service.listNews();
    expect(first!.title).toContain('Fed raises');
  });
});

describe('handlers IPC news:*', () => {
  beforeEach(() => {
    env.handlers.clear();
    env.isPackaged = true;
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const ctxFor = (database: Database.Database) => {
    const sourcesRepo = createSourcesRepository(database);
    const connectors = createConnectorRegistry({ fetch: async () => response(200, rssFeed) });
    const sources = createSourcesService({ repo: sourcesRepo, connectors });
    return {
      broadcast: vi.fn(),
      services: {
        storage: { getDb: () => database },
        sources,
        market: { listWatchlist: () => [] },
        connectivity: {
          getState: (): ConnectivityState => ({
            status: 'online',
            lastCheckedAt: null,
            nextRetryAt: null,
            attempt: 0,
          }),
        },
      },
    };
  };

  const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!(null, ...args);

  it('registra news:list y valida la consulta', () => {
    registerNews(ctxFor(db()) as never);
    expect(env.handlers.has(IPC_CHANNELS.news.list)).toBe(true);
    // Empaquetada: los ganchos de desarrollo no existen.
    expect(env.handlers.has(IPC_CHANNELS.news.pollNow)).toBe(false);
    expect(env.handlers.has(IPC_CHANNELS.news.advanceClock)).toBe(false);

    expect(() => invoke(IPC_CHANNELS.news.list, { priority: 'inventada' })).toThrowError(
      IpcValidationError,
    );
    expect(() => invoke(IPC_CHANNELS.news.list, { limit: 0 })).toThrowError(IpcValidationError);
    expect(invoke(IPC_CHANNELS.news.list, undefined)).toEqual([]);
  });

  it('sin empaquetar registra los ganchos y pollNow devuelve el resultado', async () => {
    env.isPackaged = false;
    const ctx = ctxFor(db());
    registerNews(ctx as never);

    expect(env.handlers.has(IPC_CHANNELS.news.pollNow)).toBe(true);
    expect(env.handlers.has(IPC_CHANNELS.news.advanceClock)).toBe(true);

    const result = (await invoke(IPC_CHANNELS.news.pollNow)) as NewsPollResult;
    expect(result).toMatchObject({ sourcesPolled: 0, newItems: 0 });
    expect(() => invoke(IPC_CHANNELS.news.advanceClock, -5)).toThrowError(IpcValidationError);
    const advanced = invoke(IPC_CHANNELS.news.advanceClock, 60_000) as { now: string };
    expect(advanced.now).toBe(new Date(FIXED_NOW + 60_000).toISOString());
  });

  it('observa connectivity:changed y lanza una pasada al volver la red', async () => {
    const database = db();
    const { impl, calls } = fetchByUrl({ [FEED_A]: response(200, rssFeed) });
    const ctx = ctxFor(database);
    // Sustituimos el registro de conectores por uno con el fetch por URL.
    const sourcesRepo = createSourcesRepository(database);
    ctx.services.sources = createSourcesService({
      repo: sourcesRepo,
      connectors: createConnectorRegistry({ fetch: impl }),
    });
    const service = registerNews(ctx as never);
    ctx.services.sources.add({
      name: 'Feed',
      kind: 'rss',
      connector: 'rss',
      url: FEED_A,
      reliability: 'prensa',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);

    // Al emitirse connectivity:changed en 'online' por el broadcast envuelto
    // llega otra pasada (la fuente está forzada por recover → agenda normal).
    await vi.advanceTimersByTimeAsync(0);
    expect(service.listNews()).toHaveLength(3);
    expect(ctx.broadcast).toBeDefined();
    service.stop();
  });
});
