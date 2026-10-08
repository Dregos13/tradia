import type Database from 'better-sqlite3';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../../../db/database';
import { createSourcesRepository, createSourcesService, SourcesError } from '../../sources';
import { createConnectorRegistry } from '../index';
import type { ConnectorFetch, ConnectorFetchInit, ConnectorSourceConfig } from '../types';
import { isNewsConnectorError } from '../types';

import beaNews from './__fixtures__/bea-news.xml?raw';
import blsCpi from './__fixtures__/bls-cpi.atom.xml?raw';
import blsEmpsit from './__fixtures__/bls-empsit.atom.xml?raw';
import cnmvHr from './__fixtures__/cnmv-hr.xml?raw';
import cnmvIp from './__fixtures__/cnmv-ip.xml?raw';
import cnmvOir from './__fixtures__/cnmv-oir.xml?raw';
import ecbPress from './__fixtures__/ecb-press.xml?raw';
import fedAll from './__fixtures__/fed-press-all.xml?raw';
import fedMonetary from './__fixtures__/fed-press-monetary.xml?raw';
import secEdgar8k from './__fixtures__/sec-edgar-8k.atom.xml?raw';
import secEdgarForm4 from './__fixtures__/sec-edgar-form4.atom.xml?raw';
import {
  cikForTicker,
  INITIAL_UNIVERSE_CIKS,
  normalizeCik,
  OFFICIAL_SOURCE_SEEDS,
  OFFICIAL_USER_AGENT,
  SEC_EDGAR_MAX_REQUESTS_PER_SECOND,
  seedOfficialSources,
  TICKER_TO_CIK,
  tickersForCik,
} from './index';
import { BEA_CONNECTOR_ID } from './bea';
import { BLS_CONNECTOR_ID } from './bls';
import { CNMV_CONNECTOR_ID } from './cnmv';
import { ECB_CONNECTOR_ID } from './ecb';
import { FED_CONNECTOR_ID } from './fed';
import { SEC_EDGAR_CONNECTOR_ID } from './sec-edgar';

const FIXED_NOW = Date.parse('2026-10-08T12:00:00.000Z');

interface RecordedCall {
  url: string;
  init?: ConnectorFetchInit;
}

/**
 * fetch simulado que sirve la respuesta grabada de cada organismo según la
 * URL pedida (los conectores resuelven sus endpoints por defecto).
 */
function fetchByFixture(routes: Record<string, { body: string; status?: number }>): {
  fetch: ConnectorFetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetch: ConnectorFetch = async (url, init) => {
    calls.push({ url, init });
    for (const [match, route] of Object.entries(routes)) {
      if (url.includes(match)) {
        const status = route.status ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: { get: () => null },
          text: () => Promise.resolve(route.body),
        };
      }
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      text: () => Promise.resolve('<html><body>404</body></html>'),
    };
  };
  return { fetch, calls };
}

/** Rutas con las respuestas reales grabadas de los seis organismos. */
const OFFICIAL_ROUTES: Record<string, { body: string; status?: number }> = {
  'federalreserve.gov/feeds/press_all.xml': { body: fedAll },
  'federalreserve.gov/feeds/press_monetary.xml': { body: fedMonetary },
  'ecb.europa.eu/rss/press.html': { body: ecbPress },
  'bls.gov/feed/empsit.rss': { body: blsEmpsit },
  'bls.gov/feed/cpi.rss': { body: blsCpi },
  'apps.bea.gov/rss/rss.xml': { body: beaNews },
  'informacion-privilegiada/RSS.asmx': { body: cnmvIp },
  'Otra-Informacion-Relevante/RSS.asmx': { body: cnmvOir },
  'hechosrelevantes.asmx': { body: cnmvHr },
};

const edgarRoutes: Record<string, { body: string; status?: number }> = {
  'type=8-K': { body: secEdgar8k },
  'type=4': { body: secEdgarForm4 },
};

const source = (overrides: Partial<ConnectorSourceConfig> = {}): ConnectorSourceConfig => ({
  id: null,
  name: 'Fuente oficial de prueba',
  kind: 'oficial',
  url: null,
  params: {},
  ...overrides,
});

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

const registryWith = (
  fetch: ConnectorFetch,
  extra: { sleep?: (ms: number) => Promise<void> } = {},
) => createConnectorRegistry({ fetch, now: () => FIXED_NOW, ...extra });

describe('conectores oficiales: Fed, BCE, BLS, BEA y CNMV', () => {
  it('Fed: fusiona comunicados y FOMC deduplicando por guid entre feeds', async () => {
    const { fetch, calls } = fetchByFixture(OFFICIAL_ROUTES);
    const connector = registryWith(fetch).get(FED_CONNECTOR_ID)!;

    const items = await connector.fetchItems(source({ name: 'Fed' }));

    // press_all (3) + press_monetary (2) con las minutas del FOMC repetidas.
    expect(calls.map((c) => c.url)).toEqual([
      'https://www.federalreserve.gov/feeds/press_all.xml',
      'https://www.federalreserve.gov/feeds/press_monetary.xml',
    ]);
    expect(items).toHaveLength(4);
    const titles = items.map((item) => item.title);
    expect(titles).toContain('Minutes of the Federal Open Market Committee, September 15-16, 2026');
    expect(titles).toContain('Federal Reserve issues FOMC statement');
    expect(
      titles.filter(
        (t) => t === 'Minutes of the Federal Open Market Committee, September 15-16, 2026',
      ),
    ).toHaveLength(1);

    const minutes = items.find((item) => item.title.startsWith('Minutes of'))!;
    expect(minutes.publishedAt).toBe('2026-10-07T18:00:00.000Z');
    expect(minutes.url).toBe(
      'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261007a.htm',
    );
    // User-Agent identificado (Fed/SEC/BLS rechazan clientes sin él).
    expect(calls[0]!.init?.headers?.['User-Agent']).toBe(OFFICIAL_USER_AGENT);
    expect(connector.requiresUrl).toBe(false);
    expect(connector.secretsKey).toBeNull();
    // Los ítems salen marcados como 'oficial'.
    expect(items.every((item) => item.reliability === 'oficial')).toBe(true);
  });

  it('BCE: notas de prensa con pubDate +0200 normalizada a UTC', async () => {
    const { fetch } = fetchByFixture(OFFICIAL_ROUTES);
    const items = await registryWith(fetch).get(ECB_CONNECTOR_ID)!.fetchItems(source());

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      title: 'Meeting of 9-10 September 2026',
      url: 'https://www.ecb.europa.eu//press/accounts/2026/html/ecb.mg261008~a10153d090.en.html',
      publishedAt: '2026-10-08T11:30:00.000Z',
    });
  });

  it('BLS: publicaciones Atom de nóminas (empsit) e IPC (cpi)', async () => {
    const { fetch, calls } = fetchByFixture(OFFICIAL_ROUTES);
    const items = await registryWith(fetch).get(BLS_CONNECTOR_ID)!.fetchItems(source());

    expect(calls.map((c) => c.url)).toEqual([
      'https://www.bls.gov/feed/empsit.rss',
      'https://www.bls.gov/feed/cpi.rss',
    ]);
    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({
      title:
        'Both payroll employment (+29,000) and unemployment rate (4.2%) change little in September',
      url: 'https://www.bls.gov/news.release/archives/empsit_10022026.htm',
      publishedAt: '2026-10-02T11:51:08.289Z',
      externalId: 'empsit-2026_10_02__07_51_08',
    });
    expect(items.at(-1)!.title).toContain('CPI for all items increases 0.1% in July');
  });

  it('BEA: comunicados con ítems <item name=…> y pubDate propio', async () => {
    const { fetch } = fetchByFixture(OFFICIAL_ROUTES);
    const items = await registryWith(fetch).get(BEA_CONNECTOR_ID)!.fetchItems(source());

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({
      title: 'U.S. International Trade in Goods and Services, August 2026',
      url: 'https://www.bea.gov/news/2026/us-international-trade-goods-and-services-august-2026',
      publishedAt: '2026-10-06T12:30:00.000Z',
    });
    expect(items[0]!.summary).toContain('trade deficit increased in August 2026');
  });

  it('CNMV: etiquetas en mayúsculas (<Channel>, <Title>) en sus tres canales', async () => {
    const { fetch, calls } = fetchByFixture(OFFICIAL_ROUTES);
    const items = await registryWith(fetch).get(CNMV_CONNECTOR_ID)!.fetchItems(source());

    expect(calls).toHaveLength(3);
    expect(items).toHaveLength(5);
    // Orden de feeds: información privilegiada, otra relevante, HR de IIC.
    expect(items[0]).toMatchObject({
      title: 'AENA, S.M.E., S.A.',
      url: 'https://www.cnmv.es/Portal/Informacion-Privilegiada/Resultado-IP.aspx?nreg=3361',
      publishedAt: '2026-10-07T16:03:00.000Z',
    });
    expect(items[1]!.title).toBe('CIRSA ENTERPRISES, S.A.');
    expect(items[1]!.summary).toContain('proyecto común de fusión entre CIRSA y Lottomatica');
    expect(items.at(-1)!.title).toBe('GOLDMAN SACHS FUNDS III');
  });

  it('una url propia sustituye a los endpoints del organismo (feeds E2E)', async () => {
    const { fetch, calls } = fetchByFixture(OFFICIAL_ROUTES);
    const connector = registryWith(fetch).get(FED_CONNECTOR_ID)!;
    // La URL no está en las rutas simuladas: responde 404 y se propaga,
    // pero lo importante es que solo se consultó esa URL, no los dos feeds.
    await expect(
      connector.fetchItems(source({ url: 'file:///tmp/feed-e2e.xml', name: 'Fed local' })),
    ).rejects.toSatisfy((e) => isNewsConnectorError(e, 'not-found'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('file:///tmp/feed-e2e.xml');
  });

  it('fallo tolerante: con un feed caído devuelve lo demás; si caen todos, lanza', async () => {
    const routes = {
      ...OFFICIAL_ROUTES,
      'federalreserve.gov/feeds/press_all.xml': { body: '<html>404</html>', status: 404 },
    };
    const { fetch } = fetchByFixture(routes);
    const connector = registryWith(fetch).get(FED_CONNECTOR_ID)!;

    const items = await connector.fetchItems(source());
    expect(items).toHaveLength(2); // solo press_monetary
    expect(items.every((i) => i.title.length > 0)).toBe(true);

    const dead = fetchByFixture({
      'federalreserve.gov': { body: '<html>404</html>', status: 404 },
    });
    await expect(
      registryWith(dead.fetch).get(FED_CONNECTOR_ID)!.fetchItems(source()),
    ).rejects.toSatisfy(
      (e) => isNewsConnectorError(e, 'not-found') && e.connector === FED_CONNECTOR_ID,
    );
  });

  it('test() informa del recuento de titulares sin lanzar', async () => {
    const { fetch } = fetchByFixture(OFFICIAL_ROUTES);
    const result = await registryWith(fetch).get(ECB_CONNECTOR_ID)!.test(source());
    expect(result).toMatchObject({ ok: true, itemsFound: 3, error: null });
  });
});

describe('conector SEC EDGAR (8-K y Form 4 por CIK)', () => {
  const edgarFetch = () => fetchByFixture(edgarRoutes);

  it('pide un feed por CIK y formulario y etiqueta el ticker en los ítems', async () => {
    const { fetch, calls } = edgarFetch();
    const sleeps: number[] = [];
    const connector = registryWith(fetch, {
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    }).get(SEC_EDGAR_CONNECTOR_ID)!;

    const items = await connector.fetchItems(
      source({ name: 'SEC EDGAR', params: { ciks: ['320193'] } }),
    );

    expect(calls.map((c) => c.url)).toEqual([
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=8-K&dateb=&owner=include&count=40&output=atom',
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=4&dateb=&owner=include&count=40&output=atom',
    ]);
    // Máximo 10 peticiones/segundo: 100 ms de espera entre llamadas.
    expect(sleeps).toEqual([100]);
    expect(SEC_EDGAR_MAX_REQUESTS_PER_SECOND).toBe(10);
    expect(calls[0]!.init?.headers?.['User-Agent']).toBe(OFFICIAL_USER_AGENT);

    expect(items).toHaveLength(5);
    expect(items.every((item) => item.assets.includes('AAPL'))).toBe(true);
    expect(items[0]).toMatchObject({
      title: '8-K/A [Amend]  - Current report',
      url: 'https://www.sec.gov/Archives/edgar/data/320193/000114036126035325/0001140361-26-035325-index.htm',
      publishedAt: '2026-09-01T20:30:35.000Z',
      externalId: 'urn:tag:sec.gov,2008:accession-number=0001140361-26-035325',
    });
  });

  it('sin CIKs usa el feed global getcurrent por formulario', async () => {
    const { fetch, calls } = edgarFetch();
    const items = await registryWith(fetch)
      .get(SEC_EDGAR_CONNECTOR_ID)!
      .fetchItems(source({ params: {} }));

    expect(calls.map((c) => c.url)).toEqual([
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&owner=include&count=40&output=atom',
      'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=4&owner=include&count=40&output=atom',
    ]);
    expect(items.length).toBeGreaterThan(0);
  });

  it('en el feed global deduce el ticker del (CIK) del título', async () => {
    const globalFeed = `<?xml version="1.0" encoding="ISO-8859-1"?>
<feed xmlns="http://www.w3.org/2005/Atom"><entry>
  <title>4  - Apple Inc.  (0000320193)  (Reporting)</title>
  <link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/320193/x.htm"/>
  <id>urn:tag:sec.gov,2008:accession-number=0000000000-26-000001</id>
  <updated>2026-10-01T10:00:00-04:00</updated>
</entry><entry>
  <title>8-K  - Desconocida SA (0999999999)  (Filer)</title>
  <link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/999999999/y.htm"/>
  <id>urn:tag:sec.gov,2008:accession-number=9999999999-26-000002</id>
  <updated>2026-10-01T11:00:00-04:00</updated>
</entry></feed>`;
    const { fetch } = fetchByFixture({ 'sec.gov': { body: globalFeed } });
    const items = await registryWith(fetch)
      .get(SEC_EDGAR_CONNECTOR_ID)!
      .fetchItems(source({ params: { forms: ['8-K'] } }));

    expect(items).toHaveLength(2);
    expect(items[0]!.assets).toEqual(['AAPL']);
    expect(items[1]!.assets).toEqual([]); // CIK fuera del mapa
  });

  it('rechaza un CIK inválido y un formulario malformado con bad-data', async () => {
    const { fetch } = edgarFetch();
    const connector = registryWith(fetch).get(SEC_EDGAR_CONNECTOR_ID)!;
    await expect(
      connector.fetchItems(source({ params: { ciks: ['no-es-cik'] } })),
    ).rejects.toSatisfy((e) => isNewsConnectorError(e, 'bad-data'));
    await expect(
      connector.fetchItems(source({ params: { forms: ['<script>'] } })),
    ).rejects.toSatisfy((e) => isNewsConnectorError(e, 'bad-data'));
  });
});

describe('mapa ticker → CIK del universo inicial', () => {
  it('cubre los 25 tickers del universo inicial con CIKs de 10 dígitos', () => {
    const universe = [
      'SPY',
      'QQQ',
      'DIA',
      'IWM',
      'VTI',
      'XLF',
      'XLK',
      'XLE',
      'XLV',
      'TLT',
      'AAPL',
      'MSFT',
      'NVDA',
      'AMZN',
      'GOOGL',
      'META',
      'JPM',
      'XOM',
      'JNJ',
      'PG',
      'V',
      'HD',
      'KO',
      'AVGO',
      'AMD',
    ];
    for (const ticker of universe) {
      expect(TICKER_TO_CIK[ticker], ticker).toMatch(/^\d{10}$/);
    }
    expect(cikForTicker('aapl')).toBe('0000320193');
    expect(cikForTicker('DESCONOCIDA')).toBeNull();
  });

  it('los ETF del mismo fideicomiso comparten CIK y el inverso los devuelve', () => {
    expect(tickersForCik('1100663').sort()).toEqual(['IWM', 'TLT']);
    expect(tickersForCik('1064641').sort()).toEqual(['XLE', 'XLF', 'XLK', 'XLV']);
    expect(tickersForCik('0000000000')).toEqual([]);
    expect(normalizeCik('320193')).toBe('0000320193');
    expect(normalizeCik('nope')).toBeNull();
  });
});

describe('fuentes oficiales predefinidas (siembra)', () => {
  it('siembra los seis organismos como oficial/oficial una sola vez', () => {
    const database = db();
    const repo = createSourcesRepository(database);

    const first = seedOfficialSources(database);
    expect(first).toHaveLength(6);

    const sources = repo.list();
    expect(sources).toHaveLength(6);
    for (const s of sources) {
      expect(s).toMatchObject({ kind: 'oficial', reliability: 'oficial', active: true });
    }
    expect(sources.map((s) => s.connector).sort()).toEqual(
      [...OFFICIAL_SOURCE_SEEDS.map((s) => s.connector)].sort(),
    );

    // EDGAR llega con los CIKs del universo inicial en params.
    const edgar = sources.find((s) => s.connector === SEC_EDGAR_CONNECTOR_ID)!;
    expect(edgar.params['ciks']).toEqual([...INITIAL_UNIVERSE_CIKS]);
    expect(INITIAL_UNIVERSE_CIKS.length).toBeGreaterThanOrEqual(15);

    // Idempotente: una segunda siembra no duplica.
    expect(seedOfficialSources(database)).toEqual([]);
    expect(repo.list()).toHaveLength(6);
  });

  it('si el usuario borra una fuente oficial no resucita (lápida en settings)', () => {
    const database = db();
    const repo = createSourcesRepository(database);
    seedOfficialSources(database);

    const fed = repo.list().find((s) => s.connector === FED_CONNECTOR_ID)!;
    repo.delete(fed.id);

    expect(seedOfficialSources(database)).toEqual([]);
    expect(repo.list().find((s) => s.connector === FED_CONNECTOR_ID)).toBeUndefined();
    // El resto sigue siembrado.
    expect(repo.list()).toHaveLength(5);
  });

  it('se pueden desactivar pero no reclasificar', async () => {
    const database = db();
    seedOfficialSources(database);
    const repo = createSourcesRepository(database);
    const { fetch } = fetchByFixture(OFFICIAL_ROUTES);
    const connectors = registryWith(fetch);
    const service = createSourcesService({ repo, connectors, now: () => FIXED_NOW });

    const fed = service.list().find((s) => s.connector === FED_CONNECTOR_ID)!;
    expect(() => service.update({ id: fed.id, reliability: 'prensa' })).toThrowError(SourcesError);
    expect(() => service.update({ id: fed.id, reliability: 'prensa' })).toThrowError(
      /no pueden reclasificarse/,
    );

    const deactivated = service.update({ id: fed.id, active: false });
    expect(deactivated.active).toBe(false);
    expect(service.listActive().map((s) => s.id)).not.toContain(fed.id);
  });

  it('el conector oficial resuelto por el servicio devuelve titulares oficiales', async () => {
    const database = db();
    seedOfficialSources(database);
    const repo = createSourcesRepository(database);
    const { fetch } = fetchByFixture(OFFICIAL_ROUTES);
    const service = createSourcesService({
      repo,
      connectors: registryWith(fetch),
      now: () => FIXED_NOW,
    });

    const bea = service.list().find((s) => s.connector === BEA_CONNECTOR_ID)!;
    expect(bea.reliability).toBe('oficial');

    const result = await service.test({ id: bea.id });
    expect(result).toMatchObject({ ok: true, itemsFound: 3 });
    expect(service.list().find((s) => s.id === bea.id)!.lastStatus).toBe('ok');
  });
});
