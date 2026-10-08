import { describe, expect, it } from 'vitest';

import { createRateLimiter } from '../../market/providers/rateLimiter';
import alphaError from './__fixtures__/alphavantage-error.json?raw';
import alphaNews from './__fixtures__/alphavantage-news.json?raw';
import alphaRateLimit from './__fixtures__/alphavantage-rate-limit.json?raw';
import { ALPHAVANTAGE_SECRETS_KEY, createAlphaVantageConnector } from './alphavantage';
import {
  isNewsConnectorError,
  type ConnectorFetch,
  type ConnectorFetchInit,
  type ConnectorSourceConfig,
} from './types';

const FIXED_NOW = Date.parse('2026-10-08T12:00:00.000Z');
const TEST_KEY = 'ALPHA_KEY_987';

interface RecordedCall {
  url: string;
  init?: ConnectorFetchInit;
}

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
): ConnectorSourceConfig => ({ id: null, name: 'Alpha Vantage', kind: 'api', url, params });

const make = (
  fetch: ConnectorFetch,
  extra: Parameters<typeof createAlphaVantageConnector>[0] = {},
) =>
  createAlphaVantageConnector({
    fetch,
    now: () => FIXED_NOW,
    getApiKey: async () => TEST_KEY,
    ...extra,
  });

describe('conector Alpha Vantage', () => {
  it('mapea la respuesta grabada: time_published, fuente original y tickers', async () => {
    const { fetch, calls } = fetchReturning(alphaNews);
    const items = await make(fetch).fetchItems(source());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('function=NEWS_SENTIMENT');
    expect(calls[0]!.url).toContain(`apikey=${TEST_KEY}`);
    expect(calls[0]!.url).toContain('limit=50');

    expect(items).toHaveLength(2);
    const [fed, apple] = items;
    expect(fed).toMatchObject({
      title: 'Fed keeps rates unchanged, flags sticky inflation',
      url: 'https://www.reuters.com/markets/fed-decision-2026-10-07/',
      publishedAt: '2026-10-07T18:00:00.000Z',
      externalId: 'https://www.reuters.com/markets/fed-decision-2026-10-07/',
      sourceName: 'Reuters',
      reliability: 'agencia',
      assets: ['SPY', 'TLT'],
    });
    // ticker 'aapl' llega en minúsculas → se normaliza a 'AAPL'.
    expect(apple).toMatchObject({
      sourceName: 'MarketWatch',
      reliability: 'prensa',
      assets: ['AAPL'],
      publishedAt: '2026-10-08T09:30:00.000Z',
    });
  });

  it('construye la query con tickers, topics y limit', async () => {
    const { fetch, calls } = fetchReturning(alphaNews);
    await make(fetch).fetchItems(
      source(null, { tickers: ['aapl', 'MSFT'], topics: ['earnings'], limit: 10 }),
    );
    const url = calls[0]!.url;
    expect(url).toContain('tickers=AAPL%2CMSFT');
    expect(url).toContain('topics=earnings');
    expect(url).toContain('limit=10');
  });

  it('un Information de cuota en un 200 es rate-limit legible', async () => {
    const { fetch } = fetchReturning(alphaRateLimit);
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
      (e) =>
        isNewsConnectorError(e, 'rate-limit') && /cuota|rate limit|25 requests/i.test(e.message),
    );
  });

  it('un Error Message de clave en un 200 es auth', async () => {
    const { fetch } = fetchReturning(alphaError);
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'auth') && /apikey|clave/i.test(e.message),
    );
  });

  it('429 por HTTP es rate-limit y conserva Retry-After', async () => {
    const { fetch } = fetchReturning('', 429, { 'retry-after': '120' });
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'rate-limit') && e.retryAfterMs === 120_000,
    );
  });

  it('la clave nunca aparece en los mensajes de error', async () => {
    const body = `{"detail":"request denied for apikey=${TEST_KEY}"}`;
    const { fetch } = fetchReturning(body, 500);
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
      (e) => isNewsConnectorError(e) && !e.message.includes(TEST_KEY) && e.message.includes('***'),
    );
  });

  it('sin clave guardada el error es auth', async () => {
    const { fetch } = fetchReturning(alphaNews);
    const connector = make(fetch, { getApiKey: async () => null });
    await expect(connector.fetchItems(source())).rejects.toSatisfy((e) =>
      isNewsConnectorError(e, 'auth'),
    );
    expect(connector.secretsKey).toBe(ALPHAVANTAGE_SECRETS_KEY);
  });

  it('la cuota local agotada es rate-limit sin tocar la red', async () => {
    const { fetch, calls } = fetchReturning(alphaNews);
    const connector = make(fetch, {
      rateLimiter: createRateLimiter({ limits: { perHour: 0, perDay: 0 } }),
    });
    await expect(connector.fetchItems(source())).rejects.toSatisfy((e) =>
      isNewsConnectorError(e, 'rate-limit'),
    );
    expect(calls).toHaveLength(0);
  });

  it('test() nunca lanza: informa de titulares o del motivo', async () => {
    const ok = await make(fetchReturning(alphaNews).fetch).test(source());
    expect(ok).toMatchObject({ ok: true, itemsFound: 2, latencyMs: 0, error: null });

    const bad = await make(fetchReturning(alphaRateLimit).fetch).test(source());
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
  });
});
