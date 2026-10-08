import { describe, expect, it } from 'vitest';

import { createRateLimiter } from '../../market/providers/rateLimiter';
import newsapiErrorKey from './__fixtures__/newsapi-error-key.json?raw';
import newsapiErrorRate from './__fixtures__/newsapi-error-rate.json?raw';
import newsapiHeadlines from './__fixtures__/newsapi-headlines.json?raw';
import { createNewsApiConnector, NEWSAPI_SECRETS_KEY } from './newsapi';
import {
  isNewsConnectorError,
  type ConnectorFetch,
  type ConnectorFetchInit,
  type ConnectorSourceConfig,
} from './types';

const FIXED_NOW = Date.parse('2026-10-08T12:00:00.000Z');
const TEST_KEY = 'newsapi-key-1234';

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
): ConnectorSourceConfig => ({ id: null, name: 'NewsAPI', kind: 'api', url, params });

const make = (fetch: ConnectorFetch, extra: Parameters<typeof createNewsApiConnector>[0] = {}) =>
  createNewsApiConnector({
    fetch,
    now: () => FIXED_NOW,
    getApiKey: async () => TEST_KEY,
    ...extra,
  });

describe('conector NewsAPI', () => {
  it('mapea la respuesta grabada: ISO ya UTC, fuente original y [Removed] fuera', async () => {
    const { fetch, calls } = fetchReturning(newsapiHeadlines);
    const items = await make(fetch).fetchItems(source());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/top-headlines?');
    expect(calls[0]!.url).toContain('category=business');
    expect(calls[0]!.url).toContain('pageSize=50');
    expect(calls[0]!.init?.headers?.['X-Api-Key']).toBe(TEST_KEY);

    // 3 artículos: el '[Removed]' se descarta.
    expect(items).toHaveLength(2);
    const [fed, apple] = items;
    expect(fed).toMatchObject({
      title: 'Fed holds rates steady, Powell flags patience on cuts',
      url: 'https://www.reuters.com/markets/us/fed-holds-rates-2026-10-07/',
      publishedAt: '2026-10-07T18:00:00.000Z',
      externalId: 'https://www.reuters.com/markets/us/fed-holds-rates-2026-10-07/',
      sourceName: 'Reuters',
      reliability: 'agencia',
      assets: [],
    });
    expect(apple).toMatchObject({
      sourceName: 'CNBC',
      reliability: 'prensa',
      publishedAt: '2026-10-08T09:30:00.000Z',
    });
  });

  it('construye la query con country, language, q y pageSize', async () => {
    const { fetch, calls } = fetchReturning(newsapiHeadlines);
    await make(fetch).fetchItems(
      source(null, { country: 'US', language: 'en', q: 'inflation fed', pageSize: 10 }),
    );
    const url = calls[0]!.url;
    expect(url).toContain('country=us');
    expect(url).toContain('language=en');
    expect(url).toContain('q=inflation+fed');
    expect(url).toContain('pageSize=10');
  });

  it('apiKeyInvalid (401 o 200) es auth con mensaje legible', async () => {
    const { fetch } = fetchReturning(newsapiErrorKey, 401);
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'auth') && /apiKeyInvalid/.test(e.message),
    );

    // NewsAPI también puede devolver el error con HTTP 200.
    const { fetch: okBody } = fetchReturning(newsapiErrorKey, 200);
    await expect(make(okBody).fetchItems(source())).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'auth') && /apiKeyInvalid/.test(e.message),
    );
  });

  it('rateLimited es rate-limit y conserva Retry-After del header', async () => {
    const { fetch } = fetchReturning(newsapiErrorRate, 429, { 'retry-after': '45' });
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
      (e) =>
        isNewsConnectorError(e, 'rate-limit') &&
        e.retryAfterMs === 45_000 &&
        /rateLimited/.test(e.message),
    );
  });

  it('sin clave guardada el error es auth; params inválidos son bad-data', async () => {
    const { fetch } = fetchReturning(newsapiHeadlines);
    await expect(
      make(fetch, { getApiKey: async () => null }).fetchItems(source()),
    ).rejects.toSatisfy((e) => isNewsConnectorError(e, 'auth'));
    expect(make(fetch).secretsKey).toBe(NEWSAPI_SECRETS_KEY);

    await expect(make(fetch).fetchItems(source(null, { pageSize: 0 }))).rejects.toSatisfy((e) =>
      isNewsConnectorError(e, 'bad-data'),
    );
  });

  it('la cuota local agotada es rate-limit sin tocar la red', async () => {
    const { fetch, calls } = fetchReturning(newsapiHeadlines);
    const connector = make(fetch, {
      rateLimiter: createRateLimiter({ limits: { perHour: 0, perDay: 0 } }),
    });
    await expect(connector.fetchItems(source())).rejects.toSatisfy((e) =>
      isNewsConnectorError(e, 'rate-limit'),
    );
    expect(calls).toHaveLength(0);
  });

  it('test() nunca lanza: informa de titulares o del motivo', async () => {
    const ok = await make(fetchReturning(newsapiHeadlines).fetch).test(source());
    expect(ok).toMatchObject({ ok: true, itemsFound: 2, latencyMs: 0, error: null });

    const bad = await make(fetchReturning(newsapiErrorRate, 429).fetch).test(source());
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('rateLimited');
  });
});
