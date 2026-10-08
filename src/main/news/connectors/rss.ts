/**
 * Conector RSS 2.0 / Atom (y RSS 1.0 RDF) — Fase 1b.
 *
 * Lee cualquier fuente que se sirva como feed: las de tipo 'rss' y 'redes'
 * del usuario y los canales RSS de los organismos oficiales (Fed, BCE,
 * BLS, BEA, CNMV…), que se dan de alta con `kind: 'oficial'`.
 *
 * - `fetch` es inyectable (`ConnectorDeps.fetch`): las pruebas sirven los
 *   feeds grabados de `__fixtures__` sin tocar la red y el modo E2E lee
 *   `file://` gracias al transporte por defecto (`connectorFetch`).
 * - Las fechas (`pubDate` RFC 822, `dc:date`, `published`/`updated` ISO) se
 *   normalizan a ISO 8601 UTC. Un ítem sin fecha usable conserva el
 *   instante de lectura (reloj inyectable), porque la deduplicación se hace
 *   por título + URL, no por fecha.
 * - Si el documento no es XML válido o no es un feed reconocible, el error
 *   es `NewsConnectorError` de tipo 'invalid-feed' con el motivo del parser.
 * - Ítems sin título se descartan (no son titulares); el resto del feed sigue
 *   sirviéndose. Se deduplica dentro del propio documento por guid/URL/título.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';

import {
  connectorFetch,
  isNewsConnectorError,
  NewsConnectorError,
  probeConnector,
  truncateText,
  type ConnectorDeps,
  type ConnectorFetch,
  type ConnectorFetchResponse,
  type ConnectorRateLimits,
  type ConnectorSourceConfig,
  type ConnectorTestResult,
  type NewsConnector,
  type RawNewsItem,
} from './types';

export const RSS_CONNECTOR_ID = 'rss';
/**
 * Un feed no tiene cuota formal; el programador la respeta junto al
 * `intervalSeconds` de la fuente (mínimo 60 s → 60 lecturas/hora).
 */
export const RSS_RATE_LIMITS: ConnectorRateLimits = { perHour: 60, perDay: 1440 };
export const RSS_TIMEOUT_MS = 15_000;
/** Tope de ítems leídos por pasada, por encima se recortan los más viejos. */
export const MAX_FEED_ITEMS = 200;
export const MAX_ITEM_TITLE_LENGTH = 300;
export const MAX_ITEM_SUMMARY_LENGTH = 500;
/** User-Agent propio: varios organismos (SEC, Fed) rechazan clientes sin él. */
export const RSS_USER_AGENT = 'Tradia/0.1 (lector de noticias RSS/Atom)';

const ACCEPT_HEADER =
  'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.8';

type XmlNode = Record<string, unknown>;

const asArray = (value: unknown): XmlNode[] => {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]) as XmlNode[];
};

/**
 * Texto de un nodo: cadena directa, número, u objeto con '#text' (nodos con
 * atributos, p. ej. `<guid isPermaLink="false">…</guid>`).
 */
const textOf = (value: unknown): string | null => {
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const text = (value as XmlNode)['#text'];
    if (typeof text === 'string' && text.trim()) return text.trim();
    if (typeof text === 'number') return String(text);
  }
  return null;
};

const attrOf = (node: XmlNode, name: string): string | null => {
  const value = node[`@_${name}`];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
};

/** Quita etiquetas y entidades básicas; el parser ya decodificó el XML. */
export function stripHtml(html: string): string {
  const noTags = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  const decoded = noTags
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(x?[0-9a-f]+);/gi, (_m, code: string) => {
      const n = code.startsWith('x') ? Number.parseInt(code.slice(1), 16) : Number(code);
      return Number.isFinite(n) ? String.fromCodePoint(n) : ' ';
    });
  return decoded.replace(/\s+/g, ' ').trim();
}

/** URL canónica del titular: solo http(s); cualquier otra cosa es null. */
function normalizeItemUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** 'Mon, 05 Oct 2026 14:00:00 GMT' o ISO 8601 → ISO 8601 UTC, o null. */
function toUtcIso(value: string | null): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// Mapeo de ítems
// ---------------------------------------------------------------------------

interface MapContext {
  now: () => number;
  logger?: { warn(message: string): void };
  /** Claves ya vistas en este documento (guid > URL > título). */
  seen: Set<string>;
}

function pushItem(items: RawNewsItem[], item: RawNewsItem | null, ctx: MapContext): void {
  if (item === null) {
    ctx.logger?.warn('[rss] ítem descartado por no tener título');
    return;
  }
  const key = item.externalId ?? item.url ?? item.title;
  if (ctx.seen.has(key)) return;
  ctx.seen.add(key);
  items.push(item);
}

function mapRssItem(raw: XmlNode, ctx: MapContext): RawNewsItem | null {
  const title = textOf(raw.title);
  if (!title) return null;

  // guid con isPermaLink="false" es un id opaco, no una URL.
  const guidIsPermalink = asArray(raw.guid)[0]
    ? attrOf(asArray(raw.guid)[0]!, 'isPermaLink') !== 'false'
    : true;
  const externalId = textOf(raw.guid);
  const url =
    normalizeItemUrl(textOf(raw.link)) ?? (guidIsPermalink ? normalizeItemUrl(externalId) : null);

  const publishedAt =
    toUtcIso(textOf(raw.pubDate)) ??
    toUtcIso(textOf(raw['dc:date'])) ??
    toUtcIso(textOf(raw.date)) ??
    new Date(ctx.now()).toISOString();

  const summary = textOf(raw['content:encoded']) ?? textOf(raw.description);

  return {
    title: truncateText(title, MAX_ITEM_TITLE_LENGTH),
    url,
    publishedAt,
    summary: summary ? truncateText(stripHtml(summary), MAX_ITEM_SUMMARY_LENGTH) : null,
    externalId,
    assets: [],
  };
}

function mapAtomEntry(raw: XmlNode, ctx: MapContext): RawNewsItem | null {
  const title = textOf(raw.title);
  if (!title) return null;

  // El enlace canónico es el rel="alternate" (o el primero sin rel).
  let url: string | null = null;
  let first: string | null = null;
  for (const link of asArray(raw.link)) {
    const href = normalizeItemUrl(attrOf(link, 'href') ?? textOf(link));
    if (href === null) continue;
    first ??= href;
    const rel = attrOf(link, 'rel');
    if (rel === null || rel === 'alternate') {
      url = href;
      break;
    }
  }
  url ??= first;

  const publishedAt =
    toUtcIso(textOf(raw.published)) ??
    toUtcIso(textOf(raw.updated)) ??
    new Date(ctx.now()).toISOString();

  const summary = textOf(raw.summary) ?? textOf(raw.content);

  return {
    title: truncateText(title, MAX_ITEM_TITLE_LENGTH),
    url,
    publishedAt,
    summary: summary ? truncateText(stripHtml(summary), MAX_ITEM_SUMMARY_LENGTH) : null,
    externalId: textOf(raw.id),
    assets: [],
  };
}

// ---------------------------------------------------------------------------
// Parseo del documento
// ---------------------------------------------------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Todo llega como cadenas: la normalización es nuestra, no del parser.
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

function fail(
  kind: ConstructorParameters<typeof NewsConnectorError>[0],
  message: string,
  status?: number,
  retryAfterMs?: number,
  cause?: unknown,
): NewsConnectorError {
  return new NewsConnectorError(kind, `[rss] ${message}`, {
    connector: RSS_CONNECTOR_ID,
    status,
    retryAfterMs,
    cause,
  });
}

/** Traduce una respuesta HTTP con error al `NewsConnectorError` que toca. */
function errorFromResponse(response: ConnectorFetchResponse, body: string): NewsConnectorError {
  const status = response.status;
  const detail = truncateText(stripHtml(body), 200);
  if (status === 401 || status === 403) {
    return fail('auth', `acceso rechazado por el servidor (HTTP ${status})`, status);
  }
  if (status === 404) {
    return fail('not-found', `el feed no existe (HTTP 404)${detail ? `: ${detail}` : ''}`, status);
  }
  if (status === 429) {
    const retryAfter = Number(response.headers.get('retry-after'));
    const retryAfterMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
    return fail('rate-limit', `el servidor pide esperar (HTTP 429)`, status, retryAfterMs);
  }
  if (status >= 500) {
    return fail(
      'network',
      `error del servidor (HTTP ${status})${detail ? `: ${detail}` : ''}`,
      status,
    );
  }
  return fail('bad-data', `respuesta inesperada (HTTP ${status})`, status);
}

/** Parsea el XML del feed y devuelve los ítems, o lanza 'invalid-feed'. */
function parseFeed(xml: string, ctx: MapContext): RawNewsItem[] {
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const where = 'line' in validation.err ? ` (línea ${validation.err.line})` : '';
    throw fail('invalid-feed', `XML inválido: ${validation.err.msg}${where}`);
  }

  let doc: XmlNode;
  try {
    doc = parser.parse(xml) as XmlNode;
  } catch (error) {
    throw fail('invalid-feed', `no se pudo interpretar el XML`, undefined, undefined, error);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw fail('invalid-feed', 'el documento no es un feed RSS 2.0 ni Atom');
  }

  // La raíz puede llevar prefijo de namespace (atom:feed, rdf:RDF…): se
  // compara por nombre local. '?xml' es la declaración, no un elemento.
  const rootKey = Object.keys(doc).find((key) => !key.startsWith('@_') && !key.startsWith('?'));
  const root = rootKey ? (doc[rootKey] as XmlNode) : undefined;
  const localName = rootKey?.split(':').pop();

  const items: RawNewsItem[] = [];
  if (localName === 'rss' && typeof root?.channel === 'object' && root.channel !== null) {
    for (const raw of asArray((root.channel as XmlNode).item)) {
      pushItem(items, mapRssItem(raw, ctx), ctx);
    }
  } else if (localName === 'RDF' && root !== undefined) {
    // RSS 1.0: los ítems cuelgan de la raíz junto a <channel>.
    for (const raw of asArray(root.item)) {
      pushItem(items, mapRssItem(raw, ctx), ctx);
    }
  } else if (localName === 'feed' && root !== undefined) {
    for (const raw of asArray(root.entry)) {
      pushItem(items, mapAtomEntry(raw, ctx), ctx);
    }
  } else {
    throw fail('invalid-feed', 'el documento no es un feed RSS 2.0 ni Atom');
  }
  return items.slice(0, MAX_FEED_ITEMS);
}

// ---------------------------------------------------------------------------
// Conector
// ---------------------------------------------------------------------------

export function createRssConnector(deps: ConnectorDeps = {}): NewsConnector {
  const fetchImpl: ConnectorFetch = deps.fetch ?? connectorFetch;
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = RSS_TIMEOUT_MS;

  const fetchItems = async (source: ConnectorSourceConfig): Promise<RawNewsItem[]> => {
    if (!source.url) {
      throw fail('bad-data', `la fuente '${source.name}' no tiene URL de feed`);
    }

    let response: ConnectorFetchResponse;
    try {
      response = await fetchImpl(source.url, {
        method: 'GET',
        headers: { Accept: ACCEPT_HEADER, 'User-Agent': RSS_USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isNewsConnectorError(error)) throw error;
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw fail('not-found', `el archivo del feed no existe`, undefined, undefined, error);
      }
      throw fail(
        'network',
        `fallo de transporte: ${truncateText(String(error))}`,
        undefined,
        undefined,
        error,
      );
    }

    const body = await response.text();
    if (!response.ok) throw errorFromResponse(response, body);

    const ctx: MapContext = { now, logger: deps.logger, seen: new Set() };
    return parseFeed(body, ctx);
  };

  const test = (source: ConnectorSourceConfig): Promise<ConnectorTestResult> =>
    probeConnector(() => fetchItems(source), now);

  return {
    id: RSS_CONNECTOR_ID,
    secretsKey: null,
    requiresUrl: true,
    rateLimits: RSS_RATE_LIMITS,
    fetchItems,
    test,
  };
}
