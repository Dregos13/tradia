/**
 * Contrato de conectores de noticias — Fase 1b.
 *
 * Un `NewsConnector` sabe leer un tipo de fuente (feed RSS/Atom, API de
 * noticias u organismo oficial) y devuelve sus titulares ya normalizados:
 * fechas en ISO 8601 UTC, URL canónica y resumen en texto plano. La
 * deduplicación, la prioridad y la confirmación no son cosa del conector:
 * las decide el servicio de noticias según las reglas de la sección 6.
 *
 * - `fetch` es inyectable (`ConnectorFetch`): las pruebas sirven fixtures
 *   sin tocar la red y el modo E2E puede leer `file://` (feeds locales).
 * - Las claves de API no viajan en `params` ni en la URL: el conector las
 *   pide al servicio secrets por su `secretsKey` mediante el `getApiKey`
 *   inyectado, igual que hace el proveedor Tiingo en fase 1.
 * - Errores: `fetchItems` rechaza con `NewsConnectorError`, cuyo `kind`
 *   decide la reacción (reintentar, pedir clave o dar el feed por inválido).
 *   `test` nunca lanza: devuelve el resultado con el motivo del fallo.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import type { SourceKind } from '../../../shared/ipc';

// ---------------------------------------------------------------------------
// Errores tipados
// ---------------------------------------------------------------------------

export const NEWS_CONNECTOR_ERROR_KINDS = [
  /** Credencial ausente, inválida o rechazada (401/403). */
  'auth',
  /** Cuota de la fuente agotada (429 o limitador local). */
  'rate-limit',
  /** Feed o recurso inexistente (404, fichero ausente). */
  'not-found',
  /** Fallo de transporte, tiempo de espera o 5xx del servidor. */
  'network',
  /** Entrada rechazada o respuesta con forma inesperada. */
  'bad-data',
  /** La respuesta no es un feed RSS/Atom válido. */
  'invalid-feed',
] as const;

export type NewsConnectorErrorKind = (typeof NEWS_CONNECTOR_ERROR_KINDS)[number];

export interface NewsConnectorErrorDetails {
  /** Identificador del conector que lanzó el error ('rss', 'finnhub'…). */
  connector: string;
  /** Código HTTP de la respuesta, si la hubo. */
  status?: number;
  /** Espera sugerida antes de reintentar (solo 'rate-limit'). */
  retryAfterMs?: number;
  cause?: unknown;
}

export class NewsConnectorError extends Error {
  readonly kind: NewsConnectorErrorKind;
  readonly connector: string;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(kind: NewsConnectorErrorKind, message: string, details: NewsConnectorErrorDetails) {
    super(message, { cause: details.cause });
    this.name = 'NewsConnectorError';
    this.kind = kind;
    this.connector = details.connector;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }

  /** 'rate-limit' y 'network' merecen reintento; el resto no se arregla solo. */
  get retryable(): boolean {
    return this.kind === 'rate-limit' || this.kind === 'network';
  }
}

export function isNewsConnectorError(error: unknown): error is NewsConnectorError;
export function isNewsConnectorError(
  error: unknown,
  kind: NewsConnectorErrorKind,
): error is NewsConnectorError;
export function isNewsConnectorError(error: unknown, kind?: NewsConnectorErrorKind): boolean {
  return error instanceof NewsConnectorError && (kind === undefined || error.kind === kind);
}

// ---------------------------------------------------------------------------
// Transporte inyectable
// ---------------------------------------------------------------------------

export interface ConnectorFetchInit {
  method?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Mínimo de `Response` que necesitan los conectores (fácil de simular). */
export interface ConnectorFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type ConnectorFetch = (
  url: string,
  init?: ConnectorFetchInit,
) => Promise<ConnectorFetchResponse>;

/**
 * Transporte por defecto del proceso principal: `fetch` para http(s) y
 * lectura de disco para `file://` (los feeds locales del modo E2E). Solo se
 * aceptan esos protocolos, igual que la guarda `isSourceUrl` del contrato.
 */
export const connectorFetch: ConnectorFetch = async (url, init = {}) => {
  const protocol = new URL(url).protocol;
  if (protocol === 'file:') {
    const body = await readFile(fileURLToPath(url), 'utf8');
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(body),
    };
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new NewsConnectorError('bad-data', `protocolo no admitido: ${protocol}`, {
      connector: 'transporte',
    });
  }
  return globalThis.fetch(url, init);
};

// ---------------------------------------------------------------------------
// Dominio del conector
// ---------------------------------------------------------------------------

/** Cuota de uso declarada por la fuente (peticiones por ventana deslizante). */
export interface ConnectorRateLimits {
  perHour: number;
  perDay: number;
}

/**
 * Una fuente ya resuelta para el conector: la fila guardada en
 * `news_sources` o el borrador que llega por `sources:test`. `params` nunca
 * contiene secretos (los rechaza el gestor de fuentes).
 */
export interface ConnectorSourceConfig {
  /** Id de `news_sources`; null en el borrador de «probar conexión». */
  id: number | null;
  name: string;
  kind: SourceKind;
  url: string | null;
  params: Record<string, unknown>;
}

/** Titular crudo tal como lo entrega la fuente, antes de deduplicar. */
export interface RawNewsItem {
  title: string;
  /** URL canónica de la noticia; null si la fuente no la da. */
  url: string | null;
  /** Publicación en ISO 8601 UTC (los conectores la normalizan). */
  publishedAt: string;
  /** Texto plano recortado; null si la fuente no trae resumen. */
  summary: string | null;
  /** Identificador estable en la fuente (guid RSS, id Atom…), si existe. */
  externalId: string | null;
  /** Tickers que la propia fuente asocia al titular (los de API); [] en RSS. */
  assets: string[];
}

/** Resultado de «probar conexión»: nunca lanza, informa del motivo. */
export interface ConnectorTestResult {
  ok: boolean;
  /** Titulares que devolvió la fuente en la prueba (0 si falló). */
  itemsFound: number;
  /** Latencia de la prueba en ms; null si no se pudo medir. */
  latencyMs: number | null;
  /** Motivo legible del fallo, o null. */
  error: string | null;
}

export interface NewsConnector {
  /** Identificador estable en minúsculas ('rss', 'finnhub', 'sec-edgar'…). */
  readonly id: string;
  /**
   * Clave del servicio secrets de la que el conector lee su credencial
   * ('finnhub', 'newsapi'…); null si la fuente no pide clave (RSS, GDELT).
   */
  readonly secretsKey: string | null;
  /**
   * true cuando la fuente necesita `url` para funcionar (feeds RSS/Atom);
   * los conectores de endpoint propio lo dejan en false/undefined y el
   * gestor de fuentes no exige URL en el alta.
   */
  readonly requiresUrl?: boolean;
  /** Cuota declarada de la fuente; el programador la respeta entre lecturas. */
  readonly rateLimits: ConnectorRateLimits;
  /**
   * Lee los titulares actuales de la fuente. Rechaza con `NewsConnectorError`;
   * sin reintentos internos: quien llama decide con el error tipado.
   */
  fetchItems(source: ConnectorSourceConfig): Promise<RawNewsItem[]>;
  /** «Probar conexión»: mismo recorrido que `fetchItems`, sin lanzar. */
  test(source: ConnectorSourceConfig): Promise<ConnectorTestResult>;
}

/** Dependencias compartidas de los conectores; todo inyectable en pruebas. */
export interface ConnectorDeps {
  fetch?: ConnectorFetch;
  /** Lee la clave del servicio secrets por su `secretsKey`. */
  getApiKey?: (secretsKey: string) => Promise<string | null>;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?: () => number;
  logger?: { warn(message: string): void };
}

// ---------------------------------------------------------------------------
// Utilidades compartidas
// ---------------------------------------------------------------------------

/** Recorta texto externo antes de meterlo en errores o en el feed. */
export const truncateText = (text: string, max = 300): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Motivo legible de cualquier error, sin exponer la traza completa. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return truncateText(error.message);
  return truncateText(String(error));
}

/**
 * Implementación común de `test()`: mide la latencia, cuenta los titulares
 * y traduce el fallo a un motivo legible sin propagar la excepción.
 */
export async function probeConnector(
  fetchItems: () => Promise<RawNewsItem[]>,
  now: () => number = () => Date.now(),
): Promise<ConnectorTestResult> {
  const startedAt = now();
  try {
    const items = await fetchItems();
    return {
      ok: true,
      itemsFound: items.length,
      latencyMs: Math.max(0, now() - startedAt),
      error: null,
    };
  } catch (error) {
    return { ok: false, itemsFound: 0, latencyMs: null, error: errorMessage(error) };
  }
}
