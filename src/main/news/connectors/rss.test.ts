import { describe, expect, it } from 'vitest';

import atomFeed from './__fixtures__/atom.xml?raw';
import error404Body from './__fixtures__/error-404.html?raw';
import malformedFeed from './__fixtures__/malformed.xml?raw';
import notAFeed from './__fixtures__/not-a-feed.xml?raw';
import rssFeed from './__fixtures__/rss20.xml?raw';
import { createRssConnector, RSS_CONNECTOR_ID } from './rss';
import {
  connectorFetch,
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

/** fetch simulado que graba llamadas y sirve el cuerpo/estado indicados. */
function fetchReturning(
  body: string | (() => string),
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
      text: () => Promise.resolve(typeof body === 'function' ? body() : body),
    };
  };
  return { fetch, calls };
}

const source = (url: string | null = 'https://example.com/feed.xml'): ConnectorSourceConfig => ({
  id: null,
  name: 'Fuente de prueba',
  kind: 'rss',
  url,
  params: {},
});

const make = (fetch: ConnectorFetch, extra: Parameters<typeof createRssConnector>[0] = {}) =>
  createRssConnector({ fetch, now: () => FIXED_NOW, ...extra });

describe('conector RSS/Atom', () => {
  it('mapea un feed RSS 2.0 grabado: fechas UTC, guid, resumen en texto plano', async () => {
    const { fetch, calls } = fetchReturning(rssFeed);
    const items = await make(fetch).fetchItems(source());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.headers?.['User-Agent']).toContain('Tradia');
    // 4 <item> en el documento, uno duplicado por guid: se sirve una vez.
    expect(items).toHaveLength(3);

    const [fomc, minutes, speech] = items;
    expect(fomc).toMatchObject({
      title: 'Federal Reserve issues FOMC statement',
      url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261007a.htm',
      publishedAt: '2026-10-07T18:00:00.000Z',
      externalId: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261007a.htm',
      assets: [],
    });
    expect(fomc!.summary).toBe('El comunicado de prueba del FOMC con HTML dentro.');

    // dc:date con zona horaria se normaliza a UTC; guid no-permalink es id, no URL.
    expect(minutes).toMatchObject({
      publishedAt: '2026-10-08T07:30:00.000Z',
      externalId: 'fed-minutes-2026-09',
      url: 'https://www.federalreserve.gov/newsevents/pressreleases/minutes20261008.htm',
    });

    // Sin fecha usable: se sella con el reloj inyectado (ISO 8601 UTC).
    expect(speech!.publishedAt).toBe('2026-10-08T12:00:00.000Z');
  });

  it('mapea un feed Atom: enlace alternate, published preferido a updated', async () => {
    const { fetch } = fetchReturning(atomFeed);
    const items = await make(fetch).fetchItems(source('https://www.sec.gov/feed.atom'));

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: '8-K - ACME CORP (0000000001)',
      url: 'https://www.sec.gov/Archives/edgar/data/1/0000000001-26-000001-index.htm',
      publishedAt: '2026-10-06T14:00:00.000Z',
      externalId: 'urn:tag:sec.gov,2026:0000000001-26-000001',
      summary: 'Current report filing & details.',
    });
    // Sin <published>: cae a <updated>; el resumen sale del CDATA de <content>.
    expect(items[1]).toMatchObject({
      publishedAt: '2026-10-07T16:45:00.000Z',
      summary: 'Form 4 statement of changes in beneficial ownership.',
    });
  });

  it('rechaza XML malformado con un error invalid-feed claro', async () => {
    const { fetch } = fetchReturning(malformedFeed);
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'invalid-feed') && /XML inválido/.test(e.message),
    );
  });

  it('rechaza XML bien formado que no es un feed', async () => {
    const { fetch } = fetchReturning(notAFeed);
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'invalid-feed') && /no es un feed/.test(e.message),
    );
  });

  it('traduce los errores HTTP: 404 not-found, 401 auth, 500 network', async () => {
    for (const [status, kind] of [
      [404, 'not-found'],
      [401, 'auth'],
      [403, 'auth'],
      [500, 'network'],
      [503, 'network'],
    ] as const) {
      const { fetch } = fetchReturning(error404Body, status);
      await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
        (e) => isNewsConnectorError(e, kind) && e.status === status,
      );
    }
  });

  it('un 429 es rate-limit y respeta Retry-After', async () => {
    const { fetch } = fetchReturning('', 429, { 'retry-after': '30' });
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'rate-limit') && e.retryAfterMs === 30_000,
    );
  });

  it('un fallo de transporte es network; una fuente sin URL es bad-data', async () => {
    const fetch: ConnectorFetch = () => Promise.reject(new TypeError('fetch failed'));
    await expect(make(fetch).fetchItems(source())).rejects.toSatisfy((e) =>
      isNewsConnectorError(e, 'network'),
    );
    await expect(make(fetch).fetchItems(source(null))).rejects.toSatisfy((e) =>
      isNewsConnectorError(e, 'bad-data'),
    );
  });

  it('lee feeds file:// con el transporte por defecto y mapea ENOENT a not-found', async () => {
    const fixtureUrl = new URL('./__fixtures__/rss20.xml', import.meta.url).href;
    const connector = createRssConnector({ now: () => FIXED_NOW });
    const items = await connector.fetchItems(source(fixtureUrl));
    expect(items).toHaveLength(3);

    const missing = new URL('./__fixtures__/no-existe.xml', import.meta.url).href;
    await expect(connector.fetchItems(source(missing))).rejects.toSatisfy((e) =>
      isNewsConnectorError(e, 'not-found'),
    );
  });

  it('test() nunca lanza: informa de titulares o del motivo del fallo', async () => {
    const okFetch = fetchReturning(rssFeed).fetch;
    const okResult = await make(okFetch).test(source());
    expect(okResult).toMatchObject({ ok: true, itemsFound: 3, latencyMs: 0, error: null });

    const badFetch = fetchReturning(error404Body, 404).fetch;
    const badResult = await make(badFetch).test(source());
    expect(badResult.ok).toBe(false);
    expect(badResult.itemsFound).toBe(0);
    expect(badResult.error).toContain('404');
  });

  it('el conector no pide clave (secretsKey null) y declara su cuota', () => {
    const connector = make(fetchReturning(rssFeed).fetch);
    expect(connector.id).toBe(RSS_CONNECTOR_ID);
    expect(connector.secretsKey).toBeNull();
    expect(connector.requiresUrl).toBe(true);
    expect(connector.rateLimits.perHour).toBeGreaterThan(0);
  });

  it('connectorFetch rechaza protocolos distintos de http(s) y file', async () => {
    await expect(connectorFetch('javascript:alert(1)')).rejects.toSatisfy((e) =>
      isNewsConnectorError(e, 'bad-data'),
    );
  });
});
