/**
 * Conector oficial de SEC EDGAR — Fase 1b.
 *
 * Feeds Atom de `browse-edgar` con los formularios 8-K (hechos
 * relevantes de emisores US) y 4 (operaciones de insiders) de las
 * empresas seguidas:
 *
 * - `params.ciks` (lista de CIKs, p. ej. la siembra con el universo
 *   inicial de `cik-map.ts`): un feed por CIK y formulario
 *   (`action=getcompany`); cada ítem se etiqueta con los tickers de ese
 *   CIK para que el lector los ligue a los activos seguidos.
 * - Sin `ciks` (o lista vacía): el feed global `action=getcurrent` por
 *   formulario; el ticker se deduce del `(##########)` del título cuando
 *   el CIK está en el mapa.
 * - `params.forms` permite cambiar los formularios; por defecto 8-K y 4.
 *
 * Acceso honesto a la SEC: User-Agent declarado con contacto
 * (`OFFICIAL_USER_AGENT`; la SEC rechaza herramientas sin declarar) y un
 * máximo de 10 peticiones por segundo (`minIntervalMs` = 100 ms entre
 * llamadas, ventana persistente entre pasadas del lector).
 */
import { normalizeCik, tickersForCik } from './cik-map';
import {
  createOfficialFeedConnector,
  OFFICIAL_USER_AGENT,
  type OfficialConnectorDeps,
} from './feed';
import {
  NewsConnectorError,
  type ConnectorRateLimits,
  type ConnectorSourceConfig,
  type NewsConnector,
  type RawNewsItem,
} from '../types';

export const SEC_EDGAR_CONNECTOR_ID = 'sec-edgar';

/** Política de acceso razonable de la SEC: máximo 10 peticiones/segundo. */
export const SEC_EDGAR_MAX_REQUESTS_PER_SECOND = 10;
export const SEC_EDGAR_MIN_INTERVAL_MS = 1_000 / SEC_EDGAR_MAX_REQUESTS_PER_SECOND;
export const SEC_EDGAR_RATE_LIMITS: ConnectorRateLimits = { perHour: 36_000, perDay: 864_000 };

/** Formularios servidos por defecto: 8-K (hechos relevantes) y Form 4. */
export const SEC_EDGAR_DEFAULT_FORMS = ['8-K', '4'] as const;
export const SEC_EDGAR_COUNT_PER_FEED = 40;

const EDGAR_BROWSE_URL = 'https://www.sec.gov/cgi-bin/browse-edgar';
const FORM_PATTERN = /^[A-Za-z0-9-/]{1,12}$/;

const fail = (message: string): NewsConnectorError =>
  new NewsConnectorError('bad-data', `[sec-edgar] ${message}`, {
    connector: SEC_EDGAR_CONNECTOR_ID,
  });

/** Lista de CIKs de `params.ciks` (o `params.cik`), normalizados a 10 dígitos. */
function ciksFromParams(source: ConnectorSourceConfig): string[] {
  const raw = source.params['ciks'] ?? source.params['cik'];
  if (raw === undefined || raw === null) return [];
  const entries = Array.isArray(raw) ? raw : [raw];
  const ciks: string[] = [];
  for (const entry of entries) {
    const cik = normalizeCik(entry);
    if (cik === null) {
      throw fail(`CIK inválido en params: ${String(entry)}`);
    }
    ciks.push(cik);
  }
  return [...new Set(ciks)];
}

/** Formularios de `params.forms`; por defecto `SEC_EDGAR_DEFAULT_FORMS`. */
function formsFromParams(source: ConnectorSourceConfig): string[] {
  const raw = source.params['forms'];
  if (raw === undefined || raw === null) return [...SEC_EDGAR_DEFAULT_FORMS];
  const entries = Array.isArray(raw) ? raw : [raw];
  const forms = entries.map((entry) => String(entry).trim());
  if (forms.length === 0 || forms.some((form) => !FORM_PATTERN.test(form))) {
    throw fail(`formularios inválidos en params.forms: ${JSON.stringify(raw)}`);
  }
  return [...new Set(forms)];
}

const countFromParams = (source: ConnectorSourceConfig): number => {
  const raw = source.params['count'];
  if (raw === undefined || raw === null) return SEC_EDGAR_COUNT_PER_FEED;
  const count = Number(raw);
  return Number.isInteger(count) && count >= 1 && count <= 100 ? count : SEC_EDGAR_COUNT_PER_FEED;
};

const companyFeedUrl = (cik: string, form: string, count: number): string =>
  `${EDGAR_BROWSE_URL}?action=getcompany&CIK=${cik}&type=${encodeURIComponent(form)}` +
  `&dateb=&owner=include&count=${count}&output=atom`;

const currentFeedUrl = (form: string, count: number): string =>
  `${EDGAR_BROWSE_URL}?action=getcurrent&type=${encodeURIComponent(form)}` +
  `&owner=include&count=${count}&output=atom`;

/** CIK que pidió el feed, si es una consulta por empresa. */
const feedCik = (feedUrl: string): string | null => {
  const match = /[?&]CIK=(\d+)/i.exec(feedUrl);
  return match?.[1] !== undefined ? normalizeCik(match[1]) : null;
};

/** CIK del emisor en el título del ítem: '8-K - Apple Inc. (0000320193)'. */
const titleCik = (item: RawNewsItem): string | null => {
  const match = /\((\d{10})\)/.exec(item.title);
  return match?.[1] !== undefined ? normalizeCik(match[1]) : null;
};

export function createSecEdgarConnector(deps: OfficialConnectorDeps = {}): NewsConnector {
  return createOfficialFeedConnector(
    {
      id: SEC_EDGAR_CONNECTOR_ID,
      userAgent: OFFICIAL_USER_AGENT,
      minIntervalMs: SEC_EDGAR_MIN_INTERVAL_MS,
      rateLimits: SEC_EDGAR_RATE_LIMITS,
      feeds: (source) => {
        const ciks = ciksFromParams(source);
        const forms = formsFromParams(source);
        const count = countFromParams(source);
        const urls: string[] = [];
        if (ciks.length > 0) {
          for (const cik of ciks) {
            for (const form of forms) urls.push(companyFeedUrl(cik, form, count));
          }
        } else {
          for (const form of forms) urls.push(currentFeedUrl(form, count));
        }
        return urls;
      },
      // Etiqueta el/los tickers del CIK (el del feed por empresa o, en el
      // feed global, el que aparece entre paréntesis en el título).
      mapItems: (items, feedUrl) => {
        const cik = feedCik(feedUrl);
        return items.map((item) => {
          const resolved = cik ?? titleCik(item);
          if (resolved === null) return item;
          const tickers = tickersForCik(resolved);
          if (tickers.length === 0) return item;
          return { ...item, assets: [...new Set([...item.assets, ...tickers])] };
        });
      },
    },
    deps,
  );
}
