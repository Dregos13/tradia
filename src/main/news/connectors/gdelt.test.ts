import { describe, expect, it } from 'vitest';

import { createRateLimiter } from '../../market/providers/rateLimiter';
import gdeltArticles from './__fixtures__/gdelt-articles.json?raw';
import { createGdeltConnector, GDELT_DEFAULT_QUERY } from './gdelt';
import {
  isNewsConnectorError,
  type ConnectorFetch,
  type ConnectorFetchInit,
  type ConnectorSourceConfig,
} from './types';

const FIXED_NOW = Date.parse('2026-10-08T12:00:00.000Z');

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
): ConnectorSourceConfig => ({ id: null, name: 'GDELT', kind: 'api', url, params });

const make = (fetch: ConnectorFetch, extra: Parameters<typeof createGdeltConnector>[0] = {}) =>
  createGdeltConnector({ fetch, now: () => FIXED_NOW, ...extra });

describe('conector GDELT', () => {
  it('mapea la respuesta grabada: seendate UTC, dominio como fuente y fiabilidad', async () => {
    const { fetch, calls } = fetchReturning(gdeltArticles);
    const items = await make(fetch).fetchItems(source());

    expect(calls).toHaveLength(1);
    const url = calls[0]!.url;
    expect(url).toContain('api.gdeltproject.org');
    const params = new URL(url).searchParams;
    expect(params.get('mode')).toBe('ArtList');
    expect(params.get('format')).toBe('json');
    expect(params.get('query')).toBe(GDELT_DEFAULT_QUERY);
    expect(params.get('timespan')).toBe('1d');

    expect(items).toHaveLength(3);
    const [reuters, elpais, blog] = items;
    expect(reuters).toMatchObject({
      title: 'Fed holds rates steady; Powell signals patience on cuts',
      url: 'https://www.reuters.com/markets/us/fed-holds-rates-2026-10-07/',
      publishedAt: '2026-10-07T18:05:00.000Z',
      externalId: 'https://www.reuters.com/markets/us/fed-holds-rates-2026-10-07/',
      sourceName: 'reuters.com',
      reliability: 'agencia',
      assets: [],
      summary: null,
    });
    expect(elpais).toMatchObject({
      sourceName: 'elpais.com',
      reliability: 'prensa',
      publishedAt: '2026-10-08T11:30:00.000Z',
    });
    // seendate ilegible → instante del reloj inyectado.
    expect(blog!.publishedAt).toBe('2026-10-08T12:00:00.000Z');
  });

  it('no pide clave (secretsKey null) y funciona sin getApiKey', async () => {
    const { fetch } = fetchReturning(gdeltArticles);
    const connector = make(fetch);
    expect(connector.secretsKey).toBeNull();
    const items = await connector.fetchItems(source());
    expect(items).toHaveLength(3);
  });

  it('construye la query con query, timespan, sort y maxrecords', async () => {
    const { fetch, calls } = fetchReturning(gdeltArticles);
    await make(fetch).fetchItems(
      source(null, { query: 'opec', timespan: '7d', sort: 'DateDesc', maxrecords: 10 }),
    );
    const url = calls[0]!.url;
    expect(url).toContain('query=opec');
    expect(url).toContain('timespan=7d');
    expect(url).toContain('sort=datedesc');
    expect(url).toContain('maxrecords=10');
  });

  it('un cuerpo que no es JSON (avisos de texto de GDELT) es bad-data', async () => {
    const { fetch } = fetchReturning('The query timed out. Please narrow your search.');
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'bad-data') && /no es JSON/.test(e.message),
    );
  });

  it('429 es rate-limit; un sort desconocido es bad-data sin llamar a la API', async () => {
    const { fetch } = fetchReturning('', 429, { 'retry-after': '10' });
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'rate-limit') && e.retryAfterMs === 10_000,
    );

    const { fetch: fetch2, calls: calls2 } = fetchReturning(gdeltArticles);
    await expect(make(fetch2).fetchItems(source(null, { sort: 'aleatorio' }))).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'bad-data'),
    );
    expect(calls2).toHaveLength(0);
  });

  it('la cuota local agotada es rate-limit sin tocar la red', async () => {
    const { fetch, calls } = fetchReturning(gdeltArticles);
    const connector = make(fetch, {
      rateLimiter: createRateLimiter({ limits: { perHour: 0, perDay: 0 } }),
    });
    await expect(connector.fetchItems(source())).rejects.toSatisfy((e) =>
      isNewsConnectorError(e, 'rate-limit'),
    );
    expect(calls).toHaveLength(0);
  });

  it('test() nunca lanza: informa de titulares o del motivo', async () => {
    const ok = await make(fetchReturning(gdeltArticles).fetch).test(source());
    expect(ok).toMatchObject({ ok: true, itemsFound: 3, latencyMs: 0, error: null });

    const bad = await make(fetchReturning('error de gdelt', 503).fetch).test(source());
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeTruthy();
  });
});
