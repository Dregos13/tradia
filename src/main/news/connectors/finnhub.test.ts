import { describe, expect, it } from 'vitest';

import { createRateLimiter } from '../../market/providers/rateLimiter';
import finnhubError from './__fixtures__/finnhub-error.json?raw';
import finnhubNews from './__fixtures__/finnhub-news.json?raw';
import { createFinnhubConnector, FINNHUB_CONNECTOR_ID, FINNHUB_SECRETS_KEY } from './finnhub';
import {
  isNewsConnectorError,
  type ConnectorFetch,
  type ConnectorFetchInit,
  type ConnectorSourceConfig,
} from './types';
import { createConnectorRegistry } from './index';

const FIXED_NOW = Date.parse('2026-10-08T12:00:00.000Z');
const TEST_KEY = 'finnhub-test-key-42';

interface RecordedCall {
  url: string;
  init?: ConnectorFetchInit;
}

/** fetch simulado que graba llamadas y sirve el cuerpo/estado indicados. */
function fetchReturning(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): { fetch: ConnectorFetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: ConnectorFetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      text: () => Promise.resolve(body),
    };
  };
  return { fetch, calls };
}

const source = (
  url: string | null = null,
  params: Record<string, unknown> = {},
): ConnectorSourceConfig => ({ id: null, name: 'Finnhub', kind: 'api', url, params });

const make = (fetch: ConnectorFetch, extra: Parameters<typeof createFinnhubConnector>[0] = {}) =>
  createFinnhubConnector({
    fetch,
    now: () => FIXED_NOW,
    getApiKey: async () => TEST_KEY,
    ...extra,
  });

describe('conector Finnhub', () => {
  it('mapea la respuesta grabada: fecha UTC, fuente original, tickers y fiabilidad', async () => {
    const { fetch, calls } = fetchReturning(finnhubNews);
    const items = await make(fetch).fetchItems(source());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://finnhub.io/api/v1/news?category=general');
    expect(calls[0]!.init?.headers?.['X-Finnhub-Token']).toBe(TEST_KEY);

    // 5 artículos: uno duplicado por id y uno sin titular → 3 titulares.
    expect(items).toHaveLength(3);

    const [fed, apple] = items;
    expect(fed).toMatchObject({
      title: 'Fed holds rates steady; Powell signals patience on cuts',
      url: 'https://www.reuters.com/markets/us/fed-holds-rates-2026-10-07/',
      publishedAt: '2026-10-07T18:00:00.000Z',
      externalId: '7284511',
      sourceName: 'Reuters',
      reliability: 'agencia',
      assets: ['SPY', 'QQQ', 'DIA'],
    });
    expect(apple).toMatchObject({
      sourceName: 'MarketWatch',
      reliability: 'prensa',
      assets: ['AAPL'],
    });
    // 'XLE,CL,' con vacío final queda en ['XLE','CL'].
    expect(items[2]!.assets).toEqual(['XLE', 'CL']);
    expect(items[2]!.reliability).toBe('agencia'); // Bloomberg
  });

  it('respeta params.category y una url alternativa no recibe la clave', async () => {
    const { fetch, calls } = fetchReturning('[]');
    await make(fetch).fetchItems(source(null, { category: 'crypto' }));
    expect(calls[0]!.url).toContain('category=crypto');

    const { fetch: fetch2, calls: calls2 } = fetchReturning('[]');
    await make(fetch2).fetchItems(source('https://mock.local/finnhub'));
    expect(calls2[0]!.url).toBe('https://mock.local/finnhub');
    expect(calls2[0]!.init?.headers?.['X-Finnhub-Token']).toBeUndefined();
  });

  it('sin clave guardada el error es auth y legible', async () => {
    const { fetch } = fetchReturning(finnhubNews);
    const connector = make(fetch, { getApiKey: async () => null });
    await expect(connector.fetchItems(source())).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'auth') && /secrets\['finnhub'\]/.test(e.message),
    );
    expect(connector.secretsKey).toBe(FINNHUB_SECRETS_KEY);
  });

  it('401 es auth con detalle saneado; {"error":…} en un 200 también es auth', async () => {
    const { fetch } = fetchReturning(finnhubError, 401);
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
      (e) =>
        isNewsConnectorError(e, 'auth') && e.status === 401 && /Invalid API key/.test(e.message),
    );

    const { fetch: okBody } = fetchReturning(finnhubError, 200);
    await expect(make(okBody).fetchItems(source())).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'auth') && /Invalid API key/.test(e.message),
    );
  });

  it('429 es rate-limit y conserva Retry-After', async () => {
    const { fetch } = fetchReturning('', 429, { 'retry-after': '60' });
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'rate-limit') && e.retryAfterMs === 60_000,
    );
  });

  it('la cuota local agotada es rate-limit sin tocar la red', async () => {
    const { fetch, calls } = fetchReturning(finnhubNews);
    const connector = make(fetch, {
      rateLimiter: createRateLimiter({ limits: { perHour: 0, perDay: 0 } }),
    });
    await expect(connector.fetchItems(source())).rejects.toSatisfy((e) =>
      isNewsConnectorError(e, 'rate-limit'),
    );
    expect(calls).toHaveLength(0);
  });

  it('un category desconocido es bad-data antes de llamar a la API', async () => {
    const { fetch, calls } = fetchReturning(finnhubNews);
    await expect(make(fetch).fetchItems(source(null, { category: 'deportes' }))).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'bad-data'),
    );
    expect(calls).toHaveLength(0);
  });

  it('test() nunca lanza: informa de titulares o del motivo', async () => {
    const ok = await make(fetchReturning(finnhubNews).fetch).test(source());
    expect(ok).toMatchObject({ ok: true, itemsFound: 3, latencyMs: 0, error: null });

    const bad = await make(fetchReturning(finnhubError, 401).fetch).test(source());
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('Invalid API key');
  });

  it('lee una respuesta grabada por file:// con el transporte por defecto', async () => {
    const fixtureUrl = new URL('./__fixtures__/finnhub-news.json', import.meta.url).href;
    const connector = createFinnhubConnector({
      now: () => FIXED_NOW,
      getApiKey: async () => TEST_KEY,
    });
    const items = await connector.fetchItems(source(fixtureUrl));
    expect(items).toHaveLength(3);
  });

  it('el registro incluye los conectores de API y el de RSS', () => {
    const ids = createConnectorRegistry()
      .list()
      .map((c) => c.id);
    // Los conectores oficiales se registran en otra tarea; aquí bastan los de API.
    expect(ids).toEqual(
      expect.arrayContaining(['rss', 'finnhub', 'alphavantage', 'newsapi', 'gdelt']),
    );
    const finnhub = createConnectorRegistry().get(FINNHUB_CONNECTOR_ID)!;
    expect(finnhub.requiresUrl).toBeFalsy();
    expect(finnhub.secretsKey).toBe('finnhub');
    expect(finnhub.rateLimits.perDay).toBeGreaterThan(0);
  });
});
