import type Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AddSourceRequest } from '../../../shared/ipc';
import { openDatabase } from '../../db/database';
import finnhubFixture from '../connectors/__fixtures__/finnhub-news.json?raw';
import fedFixture from '../connectors/official/__fixtures__/fed-press-all.xml?raw';
import sec8kFixture from '../connectors/official/__fixtures__/sec-edgar-8k.atom.xml?raw';
import {
  createConnectorRegistry,
  type ConnectorFetch,
  type ConnectorFetchResponse,
} from '../connectors';
import { createNewsAlerts, createAlertsRepository } from '../alerts';
import {
  canonicalizeUrl,
  createNewsClock,
  createNewsPoller,
  createNewsRepository,
  type PollerPowerMonitorLike,
} from '../poller';
import { createSourcesRepository, createSourcesService } from '../sources';

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electronMock.handlers.set(channel, handler),
  },
  powerMonitor: { on: () => undefined, removeListener: () => undefined },
}));

const FIXED_NOW = Date.parse('2026-10-08T12:00:00.000Z');
const MINUTE = 60_000;
const RSS_URL = 'https://fixtures.example.test/rss.xml';
const FINNHUB_URL = 'https://fixtures.example.test/finnhub.json';
const FED_URL = 'https://fixtures.example.test/fed.xml';
const SEC_URL = 'https://fixtures.example.test/sec.atom';
const dbs: Database.Database[] = [];
const cleanups: Array<() => void> = [];

const database = (): Database.Database => {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
};

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const db of dbs.splice(0)) {
    if (db.open) db.close();
  }
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
  electronMock.handlers.clear();
});

const response = (body: string, status = 200): ConnectorFetchResponse => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  text: () => Promise.resolve(body),
});

const rssItem = (title: string, url: string, publishedAt: string, summary = '') =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Fixture</title>
   <item><title>${title}</title><link>${url}</link><pubDate>${publishedAt}</pubDate>
   <description>${summary}</description></item></channel></rss>`;

class FakePowerMonitor implements PollerPowerMonitorLike {
  private readonly listeners = new Set<() => void>();

  on(_event: 'resume', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeListener(_event: 'resume', listener: () => void): void {
    this.listeners.delete(listener);
  }

  resume(): void {
    for (const listener of this.listeners) listener();
  }
}

function harness(
  routes: Record<string, ConnectorFetchResponse>,
  options: { online?: { value: boolean }; watchlist?: readonly string[] } = {},
) {
  const db = database();
  const fetch: ConnectorFetch = async (url) => routes[url] ?? response('not found', 404);
  const connectors = createConnectorRegistry({
    fetch,
    now: () => Date.now(),
    getApiKey: async () => 'fixture-api-key',
  });
  const sources = createSourcesService({
    repo: createSourcesRepository(db),
    connectors,
    now: () => Date.now(),
  });
  const newsRepo = createNewsRepository(db);
  const power = new FakePowerMonitor();
  const online = options.online ?? { value: true };
  const watchlist = options.watchlist ?? [];
  const clock = createNewsClock(() => Date.now());
  const poller = createNewsPoller({
    repo: newsRepo,
    sources,
    broadcast: () => undefined,
    listWatchlist: () => watchlist,
    clock,
    isOnline: () => online.value,
    powerMonitor: power,
    random: () => 0.5,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const notify = vi.fn();
  const alerts = createNewsAlerts({
    repo: createAlertsRepository(db),
    notify,
    listWatchlist: () => watchlist,
    clock,
    powerMonitor: power,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const unsubscribe = poller.onItemsStored(alerts.handleItemsStored);
  cleanups.push(() => {
    unsubscribe();
    poller.stop();
    alerts.stop();
  });
  return { db, sources, newsRepo, poller, alerts, notify, power, online };
}

const addSource = (
  sources: ReturnType<typeof createSourcesService>,
  overrides: Partial<AddSourceRequest> = {},
) =>
  sources.add({
    name: 'Fuente RSS de prueba',
    kind: 'rss',
    connector: 'rss',
    url: RSS_URL,
    reliability: 'agencia',
    ...overrides,
  });

describe('integración de noticias, reglas y avisos', () => {
  it('añade un RSS, prueba conexión y guarda fecha, fuente, fiabilidad, prioridad y activos', async () => {
    const feed = rssItem(
      'AAPL beats earnings expectations and raises guidance',
      'https://news.example.test/aapl-results',
      'Wed, 07 Oct 2026 16:30:00 GMT',
      'Apple raises its annual outlook.',
    );
    const h = harness({ [RSS_URL]: response(feed) }, { watchlist: ['AAPL'] });
    const source = addSource(h.sources, { name: 'Agencia tecnológica' });

    await expect(h.sources.test({ id: source.id })).resolves.toMatchObject({
      ok: true,
      itemsFound: 1,
    });
    await expect(h.poller.pollNow()).resolves.toMatchObject({ sourcesPolled: 1, newItems: 1 });

    const [item] = h.poller.listNews();
    expect(item).toMatchObject({
      title: 'AAPL beats earnings expectations and raises guidance',
      publishedAt: '2026-10-07T16:30:00.000Z',
      priority: 'activo',
      confirmed: true,
      sources: [{ id: source.id, name: 'Agencia tecnológica', reliability: 'agencia' }],
      assets: ['AAPL'],
    });
  });

  it('fusiona una noticia recibida por RSS y Finnhub en un solo titular con ambas fuentes', async () => {
    const finnhubArticles = JSON.parse(finnhubFixture) as Array<{
      headline: string;
      url: string;
      datetime: number;
    }>;
    const article = finnhubArticles[0]!;
    const feed = rssItem(article.headline, article.url, 'Wed, 07 Oct 2026 18:00:00 GMT');
    const h = harness({
      [RSS_URL]: response(feed),
      [FINNHUB_URL]: response(finnhubFixture),
    });
    addSource(h.sources, { name: 'Reuters RSS', url: RSS_URL });
    addSource(h.sources, {
      name: 'Finnhub',
      kind: 'api',
      connector: 'finnhub',
      url: FINNHUB_URL,
      reliability: 'prensa',
    });

    await h.poller.pollNow();

    const matching = h.poller
      .listNews()
      .filter(
        (item) => item.url === canonicalizeUrl(article.url) && item.title === article.headline,
      );
    expect(matching).toHaveLength(1);
    expect(matching[0]!.sources.map((source) => source.name)).toEqual(['Reuters RSS', 'Finnhub']);
    expect(matching[0]!.publishedAt).toBe(new Date(article.datetime * 1000).toISOString());
  });

  it('ingiere comunicados Fed y SEC EDGAR con fiabilidad oficial y confirmación', async () => {
    const h = harness({
      [FED_URL]: response(fedFixture),
      [SEC_URL]: response(sec8kFixture),
    });
    addSource(h.sources, {
      name: 'Federal Reserve',
      kind: 'oficial',
      connector: 'fed',
      url: FED_URL,
      reliability: 'oficial',
    });
    addSource(h.sources, {
      name: 'SEC EDGAR',
      kind: 'oficial',
      connector: 'sec-edgar',
      url: SEC_URL,
      reliability: 'oficial',
    });

    await h.poller.pollNow();

    const feedItems = h.poller.listNews();
    const fedItem = feedItems.find((item) =>
      item.sources.some((source) => source.name === 'Federal Reserve'),
    );
    const secItem = feedItems.find((item) =>
      item.sources.some((source) => source.name === 'SEC EDGAR'),
    );
    expect(fedItem).toMatchObject({
      confirmed: true,
      sources: [expect.objectContaining({ reliability: 'oficial' })],
    });
    expect(secItem).toMatchObject({
      confirmed: true,
      sources: [expect.objectContaining({ reliability: 'oficial' })],
    });
    expect(secItem?.title).toContain('8-K');
  });

  it('una noticia solo de redes queda sin confirmar y nunca envía aviso crítico', async () => {
    const feed = rssItem(
      'Rumor: Fed may trigger a regional bank liquidity crisis',
      'https://social.example.test/rumour',
      'Wed, 07 Oct 2026 16:30:00 GMT',
    );
    const h = harness({ [RSS_URL]: response(feed) });
    addSource(h.sources, {
      name: 'Canal social',
      kind: 'redes',
      reliability: 'redes',
    });

    await h.poller.pollNow();

    const [item] = h.poller.listNews();
    expect(item).toMatchObject({ priority: 'maxima', confirmed: false });
    expect(
      h.notify.mock.calls.map(([payload]) => (payload as { level: string }).level),
    ).not.toContain('critica');
    const logs = h.db
      .prepare('SELECT nivel FROM notification_log WHERE ref_id = ?')
      .all(item!.id) as Array<{ nivel: string }>;
    expect(logs.every((entry) => entry.nivel !== 'critica')).toBe(true);
  });

  it('avisa una vez 30 minutos antes de un evento alto, aunque la evaluación ocurra al reanudar', async () => {
    const h = harness({});
    h.db
      .prepare(
        `INSERT INTO calendar_events (tipo, titulo, fecha_utc, impacto, pais, origen, clave)
         VALUES ('fomc', 'Decisión de tipos FOMC', ?, 'alto', 'US', 'oficial', 'fomc:integration')`,
      )
      .run(new Date(FIXED_NOW + 45 * MINUTE).toISOString());

    h.alerts.start();
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    expect(h.notify).toHaveBeenCalledTimes(1);
    vi.setSystemTime(FIXED_NOW + 20 * MINUTE);
    h.power.resume();
    h.alerts.evaluate();
    h.power.resume();

    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toMatchObject({
      level: 'alerta',
      title: 'Tradia · Evento de alto impacto en 30m',
      navigateTo: 'calendario',
    });
    expect(
      (
        h.db
          .prepare("SELECT COUNT(*) AS n FROM notification_log WHERE tipo = 'evento-previo'")
          .get() as { n: number }
      ).n,
    ).toBe(1);
  });

  it('pausa lecturas sin conexión y recupera titulares al volver la red', async () => {
    const feed = rssItem(
      'EIA crude inventories rise more than expected',
      'https://news.example.test/eia',
      'Wed, 07 Oct 2026 16:30:00 GMT',
    );
    const online = { value: false };
    const h = harness({ [RSS_URL]: response(feed) }, { online });
    addSource(h.sources);

    await h.poller.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.poller.listNews()).toHaveLength(0);

    online.value = true;
    await h.poller.recover();
    expect(h.poller.listNews()).toHaveLength(1);
    expect(h.poller.listNews()[0]!.priority).toBe('media');
  });
});
