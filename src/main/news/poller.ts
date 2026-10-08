/**
 * Lector periódico de noticias en segundo plano — Fase 1b.
 *
 * `createNewsPoller` es el núcleo, con todo lo externo inyectado (reloj,
 * conexión, fuentes, powerMonitor, temporizadores reales): las pruebas lo
 * montan sin Electron y con reloj falso. `registerNews` lo cablea en la app:
 * vive en el proceso principal, así que sigue leyendo con la ventana
 * cerrada y la app residente en la bandeja.
 *
 * - Cada fuente activa se consulta según su `intervalSeconds` y el límite
 *   del conector (`rateLimits`, ventana deslizante de llamadas por hora y
 *   por día). Ante un fallo la fuente espera con retroceso exponencial
 *   (`backoffDelayMs`, 1 min base → 30 min tope) y honra `retryAfterMs`
 *   del 429; el fallo de una fuente nunca bloquea a las demás.
 * - Sin conexión (`connectivity` en 'offline') no se llama a ninguna
 *   fuente: se vuelve a mirar cada `POLLER_OFFLINE_RECHECK_MS` y, al volver
 *   la red, `recover()` lanza una pasada inmediata — `registerNews` la
 *   dispara observando `connectivity:changed` en `ctx.broadcast` (mismo
 *   patrón que market/health). Al volver de la suspensión (`powerMonitor`
 *   resume) se reevalúa al instante.
 * - Deduplicación entre fuentes: URL canónica (sin parámetros de
 *   seguimiento, sin fragmento, esquema/host en minúsculas y consulta
 *   ordenada) y título normalizado con similitud ≥ 0,9 (coeficiente de
 *   Dice sobre tokens) en una ventana de ±24 h sobre la fecha de
 *   publicación. Al coincidir, la fuente se añade al ítem existente y se
 *   reclasifica con el conjunto completo de fuentes (una noticia solo de
 *   'redes' nunca queda confirmada; ver `priority.ts`).
 * - Activos relacionados: los tickers que etiqueta la propia fuente, los
 *   tickers y $cashtags del texto, los activos de la lista de seguimiento
 *   encontrados por `findWatchedAssets` y los nombres de los activos
 *   seguidos (`DEFAULT_ASSET_ALIASES`: 'Apple' → AAPL; los nombres que son
 *   palabras comunes solo cuentan escritos con mayúscula).
 * - Cada ítem se guarda con la clasificación de `priority.ts` (prioridad y
 *   confirmada) y, si la pasada cambió el feed, se emite `news:updated`
 *   más el evento interno `onItemsStored` (lo consumirán los avisos de
 *   noticias críticas de la tarea siguiente).
 *
 * Canales IPC: `news:list` (siempre) y, solo sin empaquetar, los ganchos
 * de desarrollo `news:poll-now` y `news:advance-clock` — este último mueve
 * el `NewsClock` del servicio, que la tarea del calendario puede compartir
 * para adelantar también sus eventos.
 */
import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';
import { app, ipcMain, powerMonitor } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isNewsListQuery,
  NEWS_LIST_MAX_LIMIT,
  TICKER_PATTERN,
  type ConnectivityState,
  type NewsClockAdvanceResult,
  type NewsItem,
  type NewsItemSource,
  type NewsListQuery,
  type NewsPollResult,
  type NewsPriority,
  type NewsSource,
  type NewsUpdatedEvent,
  type Reliability,
  type SourceKind,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import { backoffDelayMs } from '../services/connectivity';
import type { ServiceContext } from '../services';
import {
  errorMessage,
  isNewsConnectorError,
  type ConnectorRateLimits,
  type NewsConnector,
  type RawNewsItem,
} from './connectors';
import {
  classifyNews,
  findWatchedAssets,
  isConfirmed,
  type PrioritySourceRef,
  type WatchlistEntry,
} from './priority';
import type { SourcesService } from './sources';

// ---------------------------------------------------------------------------
// Constantes y reloj
// ---------------------------------------------------------------------------

/** Ventana de la deduplicación por título: ±24 h sobre la fecha del ítem. */
export const DEDUP_WINDOW_MS = 24 * 3_600_000;
/** Similitud mínima de títulos normalizados para unirlos (Dice de tokens). */
export const DEDUP_SIMILARITY_THRESHOLD = 0.9;
/** Retroceso ante errores: 1 min, 2 min, 4 min… hasta 30 min. */
export const POLLER_BACKOFF_BASE_MS = 60_000;
export const POLLER_BACKOFF_MAX_MS = 30 * 60_000;
/** Sin conexión se vuelve a mirar cada 30 s por si vuelve la red. */
export const POLLER_OFFLINE_RECHECK_MS = 30_000;
/** Tope del temporizador: recoge fuentes nuevas aunque ninguna venza. */
export const POLLER_RESCAN_MS = 60_000;

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Reloj del servicio: ahora mismo y avance manual para desarrollo/pruebas. */
export interface NewsClock {
  now(): number;
  /** Adelanta el reloj `deltaMs` y devuelve el nuevo instante (ms epoch). */
  advance(deltaMs: number): number;
}

export function createNewsClock(base: () => number = () => Date.now()): NewsClock {
  let offset = 0;
  return {
    now: () => base() + offset,
    advance: (deltaMs) => {
      offset += deltaMs;
      return base() + offset;
    },
  };
}

/** Mínimo de `Electron.PowerMonitor` que usa el servicio (inyectable). */
export interface PollerPowerMonitorLike {
  on(event: 'resume', listener: () => void): unknown;
  removeListener(event: 'resume', listener: () => void): unknown;
}

/** Lo que el lector necesita del gestor de fuentes (`news/sources.ts`). */
export type NewsSourcesGateway = Pick<
  SourcesService,
  'listActive' | 'connectorFor' | 'toConnectorConfig' | 'recordFetch'
>;

// ---------------------------------------------------------------------------
// Deduplicación: URL canónica y título normalizado
// ---------------------------------------------------------------------------

/** Parámetros de seguimiento que no forman parte de la identidad de la URL. */
const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'wbraid',
  'gbraid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'si',
  'spm',
  'ref',
  'ref_src',
  'ref_url',
  'cmpid',
  'campaign_id',
  'hsctatracking',
  '_hsenc',
  '_hsmi',
  'otr',
  'ved',
  'usg',
]);

const isTrackingParam = (name: string): boolean =>
  name.startsWith('utm_') || TRACKING_PARAMS.has(name);

/**
 * URL canónica de un titular: solo http(s), esquema y host en minúsculas,
 * puerto por defecto y fragmento fuera, parámetros de seguimiento eliminados
 * y el resto ordenados alfabéticamente (misma noticia, mismo enlace aunque
 * cada fuente añada sus propios parámetros de campaña). Devuelve null si la
 * entrada no es una URL http(s) válida.
 */
export function canonicalizeUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80')
    ) {
      url.port = '';
    }
    const kept = [...url.searchParams.entries()]
      .filter(([name]) => !isTrackingParam(name.toLowerCase()))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    url.search = '';
    for (const [name, value] of kept) url.searchParams.append(name, value);
    if (url.pathname.length > 1 && url.pathname.endsWith('/')) {
      url.pathname = url.pathname.slice(0, -1);
    }
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Título comparable: minúsculas, sin marcas diacríticas y sin puntuación
 * (todo lo que no sea letra o número queda como separador de palabra).
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Coeficiente de Dice sobre los conjuntos de tokens normalizados:
 * `2·|A∩B| / (|A|+|B|)`. Con 0,9 de umbral une titulares casi idénticos
 * (una palabra de diferencia en ~10) sin fusionar noticias distintas.
 */
export function titleSimilarity(titleA: string, titleB: string): number {
  const tokensA = new Set(normalizeTitle(titleA).split(' ').filter(Boolean));
  const tokensB = new Set(normalizeTitle(titleB).split(' ').filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) shared += 1;
  }
  return (2 * shared) / (tokensA.size + tokensB.size);
}

/**
 * Hash de deduplicación exacta (`news_items.hash`, UNIQUE): título
 * normalizado + URL canónica. El mismo titular servido dos veces por la
 * misma fuente cae siempre en el mismo ítem.
 */
export function dedupHash(normalizedTitle: string, canonicalUrl: string | null): string {
  return createHash('sha256')
    .update(`${normalizedTitle}\n${canonicalUrl ?? ''}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Activos relacionados (ticker, $cashtag y nombre de los seguidos)
// ---------------------------------------------------------------------------

export interface AssetAlias {
  /** Nombre tal como aparece en prensa ('Apple', 'Coca-Cola'). */
  name: string;
  /**
   * true cuando el nombre es también una palabra común ('Apple', 'Meta',
   * 'Visa'): solo cuenta escrito con mayúscula inicial para no ligar el
   * sustantivo corriente al ticker.
   */
  caseSensitive?: boolean;
}

/**
 * Nombres de empresa de los valores del universo inicial de la lista de
 * seguimiento (acciones; los ETF no tienen nombre propio usable). Solo se
 * consultan para tickers presentes en la lista de seguimiento del usuario.
 */
export const DEFAULT_ASSET_ALIASES: Readonly<Record<string, readonly AssetAlias[]>> = {
  AAPL: [{ name: 'Apple', caseSensitive: true }],
  MSFT: [{ name: 'Microsoft' }],
  NVDA: [{ name: 'Nvidia' }],
  AMZN: [{ name: 'Amazon', caseSensitive: true }],
  GOOGL: [{ name: 'Alphabet', caseSensitive: true }, { name: 'Google' }],
  META: [{ name: 'Meta', caseSensitive: true }],
  JPM: [{ name: 'JPMorgan' }, { name: 'JP Morgan' }],
  XOM: [{ name: 'Exxon' }, { name: 'ExxonMobil' }],
  JNJ: [{ name: 'Johnson & Johnson' }],
  PG: [{ name: 'Procter & Gamble' }],
  V: [{ name: 'Visa', caseSensitive: true }],
  HD: [{ name: 'Home Depot' }],
  KO: [{ name: 'Coca-Cola' }, { name: 'Coca Cola' }],
  AVGO: [{ name: 'Broadcom' }],
};

const CASHTAG_PATTERN = /\$([A-Za-z0-9][A-Za-z0-9.-]{0,11})\b/g;
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Entrada mínima para ligar activos (vale RawNewsItem o NewsItem). */
export interface RelatedAssetsInput {
  title: string;
  summary?: string | null;
  assets?: readonly string[];
}

/**
 * Tickers relacionados con un titular:
 * - los que etiqueta la propia fuente (`item.assets`, típico de las APIs);
 * - los de la lista de seguimiento mencionados como ticker o $cashtag
 *   (`findWatchedAssets` de `priority.ts`);
 * - cualquier $cashtag del texto, aunque no se siga (es una mención
 *   explícita de ticker, no una palabra ambigua);
 * - los nombres de los activos seguidos (`aliases`): 'Apple' en el texto
 *   liga AAPL si está en la lista.
 * Devuelve los tickers en mayúsculas y ordenados.
 */
export function relatedAssets(
  item: RelatedAssetsInput,
  watchlist: readonly WatchlistEntry[],
  aliases: Readonly<Record<string, readonly AssetAlias[]>> = DEFAULT_ASSET_ALIASES,
): string[] {
  const found = new Set<string>(findWatchedAssets(item, watchlist));
  const text = `${item.title} ${item.summary ?? ''}`;
  const add = (raw: string): void => {
    const ticker = raw.trim().toUpperCase();
    if (TICKER_PATTERN.test(ticker)) found.add(ticker);
  };
  for (const asset of item.assets ?? []) add(asset);
  for (const match of text.matchAll(CASHTAG_PATTERN)) add(match[1]!);

  const watched = new Set(
    watchlist
      .map((entry) => (typeof entry === 'string' ? entry : entry.ticker).trim().toUpperCase())
      .filter(Boolean),
  );
  for (const ticker of watched) {
    for (const alias of aliases[ticker] ?? []) {
      const pattern = new RegExp(
        `\\b${escapeRegExp(alias.name)}\\b`,
        alias.caseSensitive ? '' : 'i',
      );
      if (pattern.test(text)) found.add(ticker);
    }
  }
  return [...found].sort();
}

/** Intervalo mínimo entre llamadas que impone la cuota declarada. */
export function minIntervalMsFromLimits(limits: ConnectorRateLimits): number {
  const perHour = limits.perHour > 0 ? HOUR_MS / limits.perHour : 0;
  const perDay = limits.perDay > 0 ? DAY_MS / limits.perDay : 0;
  return Math.ceil(Math.max(perHour, perDay));
}

// ---------------------------------------------------------------------------
// Repositorio (news_items + enlaces)
// ---------------------------------------------------------------------------

interface NewsItemRow {
  id: number;
  titulo: string;
  url: string | null;
  publicado: string;
  resumen: string | null;
  prioridad: NewsPriority;
  confirmada: number;
  hash: string;
}

interface SourceLinkRow {
  id: number;
  nombre: string;
  fiabilidad: Reliability;
  tipo: SourceKind;
}

interface NewNewsItemRecord {
  titulo: string;
  url: string | null;
  publicado: string;
  resumen: string | null;
  prioridad: NewsPriority;
  confirmada: 0 | 1;
  hash: string;
}

export interface NewsRepository {
  insertItem(record: NewNewsItemRecord): number;
  /** Ítem completo (fuentes y activos incluidos); null si no existe. */
  getItem(id: number): NewsItem | null;
  findByHash(hash: string): NewsItemRow | null;
  findByCanonicalUrl(url: string): NewsItemRow | null;
  /** Ítems publicados dentro de la ventana de deduplicación. */
  dedupCandidates(desdeIso: string, hastaIso: string): NewsItemRow[];
  /** Añade la fuente al ítem; true si era un enlace nuevo. */
  linkSource(itemId: number, sourceId: number, vistoEn: string): boolean;
  /** Añade los tickers al ítem; devuelve cuántos eran nuevos. */
  linkAssets(itemId: number, tickers: readonly string[]): number;
  /** Fuentes ligadas al ítem, para reclasificar y para NewsItem.sources. */
  sourceLinks(itemId: number): SourceLinkRow[];
  itemAssets(itemId: number): string[];
  /** Rellena url/resumen solo si el ítem los tenía a NULL. */
  fillMissing(itemId: number, fields: { url?: string | null; resumen?: string | null }): boolean;
  updateFlags(itemId: number, prioridad: NewsPriority, confirmada: boolean): void;
  /** Feed para `news:list`, con todos los filtros del contrato. */
  list(query?: NewsListQuery): NewsItem[];
}

export function createNewsRepository(db: Database.Database): NewsRepository {
  const insertStmt = db.prepare(`
    INSERT INTO news_items (titulo, url, publicado, resumen, prioridad, confirmada, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const byHashStmt = db.prepare('SELECT * FROM news_items WHERE hash = ?');
  const byUrlStmt = db.prepare('SELECT * FROM news_items WHERE url = ?');
  const byIdStmt = db.prepare('SELECT * FROM news_items WHERE id = ?');
  const candidatesStmt = db.prepare(
    'SELECT * FROM news_items WHERE publicado >= ? AND publicado <= ? ORDER BY id',
  );
  const linkSourceStmt = db.prepare(
    'INSERT OR IGNORE INTO news_item_sources (item_id, source_id, visto_en) VALUES (?, ?, ?)',
  );
  const linkAssetStmt = db.prepare(
    'INSERT OR IGNORE INTO news_item_assets (item_id, ticker) VALUES (?, ?)',
  );
  const sourcesStmt = db.prepare(`
    SELECT s.id, s.nombre, s.fiabilidad, s.tipo
    FROM news_item_sources ns JOIN news_sources s ON s.id = ns.source_id
    WHERE ns.item_id = ? ORDER BY s.id
  `);
  const assetsStmt = db.prepare(
    'SELECT ticker FROM news_item_assets WHERE item_id = ? ORDER BY ticker',
  );
  const fillUrlStmt = db.prepare(
    `UPDATE news_items SET url = ?, actualizado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND url IS NULL`,
  );
  const fillSummaryStmt = db.prepare(
    `UPDATE news_items SET resumen = ?, actualizado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? AND resumen IS NULL`,
  );
  const flagsStmt = db.prepare(
    `UPDATE news_items SET prioridad = ?, confirmada = ?,
       actualizado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  );

  const toNewsItem = (row: NewsItemRow): NewsItem => ({
    id: row.id,
    title: row.titulo,
    url: row.url,
    publishedAt: row.publicado,
    summary: row.resumen,
    priority: row.prioridad,
    confirmed: row.confirmada === 1,
    sources: (sourcesStmt.all(row.id) as SourceLinkRow[]).map((link): NewsItemSource => ({
      id: link.id,
      name: link.nombre,
      reliability: link.fiabilidad,
    })),
    assets: (assetsStmt.all(row.id) as { ticker: string }[]).map((a) => a.ticker),
  });

  const repo: NewsRepository = {
    insertItem: (record) =>
      Number(
        insertStmt.run(
          record.titulo,
          record.url,
          record.publicado,
          record.resumen,
          record.prioridad,
          record.confirmada,
          record.hash,
        ).lastInsertRowid,
      ),

    getItem: (id) => {
      const row = byIdStmt.get(id) as NewsItemRow | undefined;
      return row ? toNewsItem(row) : null;
    },

    findByHash: (hash) => (byHashStmt.get(hash) as NewsItemRow | undefined) ?? null,
    findByCanonicalUrl: (url) => (byUrlStmt.get(url) as NewsItemRow | undefined) ?? null,
    dedupCandidates: (desdeIso, hastaIso) =>
      candidatesStmt.all(desdeIso, hastaIso) as NewsItemRow[],

    linkSource: (itemId, sourceId, vistoEn) =>
      linkSourceStmt.run(itemId, sourceId, vistoEn).changes > 0,

    linkAssets: (itemId, tickers) => {
      let added = 0;
      for (const ticker of tickers) {
        added += linkAssetStmt.run(itemId, ticker).changes;
      }
      return added;
    },

    sourceLinks: (itemId) => sourcesStmt.all(itemId) as SourceLinkRow[],
    itemAssets: (itemId) => (assetsStmt.all(itemId) as { ticker: string }[]).map((a) => a.ticker),

    fillMissing: (itemId, fields) => {
      let changed = false;
      if (fields.url !== undefined && fields.url !== null) {
        changed = fillUrlStmt.run(fields.url, itemId).changes > 0 || changed;
      }
      if (fields.resumen !== undefined && fields.resumen !== null) {
        changed = fillSummaryStmt.run(fields.resumen, itemId).changes > 0 || changed;
      }
      return changed;
    },

    updateFlags: (itemId, prioridad, confirmada) => {
      flagsStmt.run(prioridad, confirmada ? 1 : 0, itemId);
    },

    list: (query = {}) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (query.desde !== undefined) {
        conditions.push('substr(ni.publicado, 1, 10) >= ?');
        params.push(query.desde);
      }
      if (query.hasta !== undefined) {
        conditions.push('substr(ni.publicado, 1, 10) <= ?');
        params.push(query.hasta);
      }
      if (query.priority !== undefined) {
        conditions.push('ni.prioridad = ?');
        params.push(query.priority);
      }
      if (query.confirmed !== undefined) {
        conditions.push('ni.confirmada = ?');
        params.push(query.confirmed ? 1 : 0);
      }
      if (query.ticker !== undefined) {
        conditions.push(
          'EXISTS (SELECT 1 FROM news_item_assets na WHERE na.item_id = ni.id AND na.ticker = ?)',
        );
        params.push(query.ticker.trim().toUpperCase());
      }
      if (query.sourceId !== undefined) {
        conditions.push(
          'EXISTS (SELECT 1 FROM news_item_sources ns WHERE ns.item_id = ni.id AND ns.source_id = ?)',
        );
        params.push(query.sourceId);
      }
      if (query.reliability !== undefined) {
        conditions.push(
          `EXISTS (
             SELECT 1 FROM news_item_sources ns JOIN news_sources s ON s.id = ns.source_id
             WHERE ns.item_id = ni.id AND s.fiabilidad = ?
           )`,
        );
        params.push(query.reliability);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = query.limit ?? NEWS_LIST_MAX_LIMIT;
      const rows = db
        .prepare(
          `SELECT ni.* FROM news_items ni ${where}
           ORDER BY ni.publicado DESC, ni.id DESC LIMIT ?`,
        )
        .all(...params, limit) as NewsItemRow[];
      return rows.map(toNewsItem);
    },
  };

  return repo;
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

/** Estado en memoria de cada fuente: agenda, fallos y ventana de cuota. */
interface SourceRuntime {
  /** Instante a partir del cual se puede volver a consultar (ms epoch). */
  nextDueMs: number;
  /** Fallos seguidos: el retroceso exponencial crece con ellos. */
  failures: number;
  /** Marcas de las llamadas recientes (ventana deslizante de cuota). */
  calls: number[];
}

export interface NewsItemsStoredEvent {
  /** Titulares nuevos guardados en la pasada. */
  added: NewsItem[];
  /** Titulares ya existentes a los que se añadió fuente o reclasificó. */
  updated: NewsItem[];
}

export interface NewsPollerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface NewsPollerDeps {
  repo: NewsRepository;
  /** Fuentes activas y resolución de su conector/estado. */
  sources: NewsSourcesGateway;
  /** Lista de seguimiento actual (para ligar activos y prioridad por activo). */
  listWatchlist?: () => readonly WatchlistEntry[];
  broadcast(channel: string, payload: unknown): void;
  /** Reloj con avance manual; habilita `advanceClock` (desarrollo). */
  clock?: NewsClock;
  /** Reloj simple (ms epoch); ignorado si hay `clock`. */
  now?: () => number;
  /** false cuando connectivity ve 'offline'; por defecto siempre en línea. */
  isOnline?: () => boolean;
  /** Recuperación al volver de la suspensión. */
  powerMonitor?: PollerPowerMonitorLike;
  /** Nombres de activos seguidos; por defecto `DEFAULT_ASSET_ALIASES`. */
  assetAliases?: Readonly<Record<string, readonly AssetAlias[]>>;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  offlineRecheckMs?: number;
  rescanMs?: number;
  /** Fuente del jitter de la espera (los tests la fijan). */
  random?: () => number;
  logger?: Partial<NewsPollerLogger>;
}

export interface NewsPollerService {
  listNews(query?: NewsListQuery): NewsItem[];
  /**
   * Pasada inmediata sobre todas las fuentes activas, ignorando la agenda
   * pero no la ventana de cuota. La usa el gancho de desarrollo
   * `news:poll-now`.
   */
  pollNow(): Promise<NewsPollResult>;
  /**
   * El vigilante de conexión lo llama al volver la red (a través de la
   * observación de `connectivity:changed` en `registerNews`): lanza una
   * pasada sin esperar a la agenda. Resuelve cuando termina.
   */
  recover(): Promise<void>;
  /**
   * Suscriptores internos del proceso principal con los titulares nuevos y
   * actualizados de cada pasada (avisos de noticias críticas, fase siguiente).
   */
  onItemsStored(listener: (event: NewsItemsStoredEvent) => void): () => void;
  /**
   * Gancho de desarrollo: avanza el reloj y reevalúa la agenda al instante.
   * Solo existe si se inyectó `clock`.
   */
  advanceClock?(deltaMs: number): NewsClockAdvanceResult;
  /** Arranca la agenda y hace la primera pasada (útil en pruebas). */
  start(): Promise<void>;
  stop(): void;
}

interface PollOutcome {
  /** true si se llegó a llamar al conector (cuenta en `sourcesPolled`). */
  polled: boolean;
  /** Ids de ítems nuevos guardados por esta lectura. */
  added: number[];
  /** Ids de ítems existentes que cambiaron (fuente añadida, reclasificación). */
  updated: number[];
}

export function createNewsPoller(deps: NewsPollerDeps): NewsPollerService {
  const repo = deps.repo;
  const now = deps.clock ? deps.clock.now : (deps.now ?? (() => Date.now()));
  const isOnline = deps.isOnline ?? (() => true);
  const listWatchlist = deps.listWatchlist ?? (() => []);
  const aliases = deps.assetAliases ?? DEFAULT_ASSET_ALIASES;
  const backoffBaseMs = deps.backoffBaseMs ?? POLLER_BACKOFF_BASE_MS;
  const backoffMaxMs = deps.backoffMaxMs ?? POLLER_BACKOFF_MAX_MS;
  const offlineRecheckMs = deps.offlineRecheckMs ?? POLLER_OFFLINE_RECHECK_MS;
  const rescanMs = deps.rescanMs ?? POLLER_RESCAN_MS;
  const random = deps.random ?? Math.random;
  const logger = deps.logger ?? console;

  let started = false;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<NewsPollResult> | null = null;
  const runtimes = new Map<number, SourceRuntime>();
  const listeners = new Set<(event: NewsItemsStoredEvent) => void>();

  const isoNow = (): string => new Date(now()).toISOString();

  // -- Deduplicación e ingesta ------------------------------------------------

  const runtimeFor = (source: NewsSource): SourceRuntime => {
    let runtime = runtimes.get(source.id);
    if (!runtime) {
      const lastFetched = source.lastFetchedAt ? Date.parse(source.lastFetchedAt) : Number.NaN;
      runtime = {
        // Primera lectura en cuanto toque; tras un reinicio se respeta lo
        // que falte del intervalo ya consumido antes del cierre.
        nextDueMs: Number.isNaN(lastFetched) ? 0 : lastFetched + source.intervalSeconds * 1000,
        failures: 0,
        calls: [],
      };
      runtimes.set(source.id, runtime);
    }
    return runtime;
  };

  const fuzzyMatch = (normalizedTitle: string, publishedAt: string): NewsItemRow | null => {
    if (normalizedTitle === '') return null;
    const publishedMs = Date.parse(publishedAt);
    const center = Number.isNaN(publishedMs) ? now() : publishedMs;
    const desde = new Date(center - DEDUP_WINDOW_MS).toISOString();
    const hasta = new Date(center + DEDUP_WINDOW_MS).toISOString();
    for (const candidate of repo.dedupCandidates(desde, hasta)) {
      if (titleSimilarity(normalizedTitle, candidate.titulo) >= DEDUP_SIMILARITY_THRESHOLD) {
        return candidate;
      }
    }
    return null;
  };

  /**
   * Guarda un titular crudo: si coincide con un ítem existente (URL
   * canónica, hash exacto o título casi igual en la ventana de 24 h) le
   * añade la fuente y lo reclasifica con todas sus fuentes; si no, lo crea
   * ya clasificado según las reglas de la sección 6.
   */
  const ingestItem = (raw: RawNewsItem, source: NewsSource): PollOutcome => {
    const canonicalUrl = canonicalizeUrl(raw.url);
    const normalizedTitle = normalizeTitle(raw.title);
    const hash = dedupHash(normalizedTitle, canonicalUrl);
    const watchlist = listWatchlist();
    const input = { title: raw.title, summary: raw.summary, assets: raw.assets };
    const publicado = Number.isNaN(Date.parse(raw.publishedAt)) ? isoNow() : raw.publishedAt;

    const existing =
      (canonicalUrl !== null ? repo.findByCanonicalUrl(canonicalUrl) : null) ??
      repo.findByHash(hash) ??
      fuzzyMatch(normalizedTitle, publicado);

    const outcome: PollOutcome = { polled: false, added: [], updated: [] };

    if (existing === null) {
      const assets = relatedAssets(input, watchlist, aliases);
      const ref: PrioritySourceRef = { reliability: source.reliability, kind: source.kind };
      const itemId = repo.insertItem({
        titulo: raw.title,
        url: canonicalUrl,
        publicado,
        resumen: raw.summary,
        prioridad: classifyNews({ ...input, assets }, [ref], watchlist),
        confirmada: isConfirmed([ref]) ? 1 : 0,
        hash,
      });
      repo.linkSource(itemId, source.id, isoNow());
      repo.linkAssets(itemId, assets);
      outcome.added.push(itemId);
      return outcome;
    }

    // La noticia ya estaba: se añade esta fuente y se reclasifica con el
    // conjunto completo (una agencia que llega después puede confirmarla).
    let changed = repo.linkSource(existing.id, source.id, isoNow());
    changed = repo.linkAssets(existing.id, relatedAssets(input, watchlist, aliases)) > 0 || changed;
    changed = repo.fillMissing(existing.id, { url: canonicalUrl, resumen: raw.summary }) || changed;

    const refs = repo
      .sourceLinks(existing.id)
      .map((link): PrioritySourceRef => ({ reliability: link.fiabilidad, kind: link.tipo }));
    const priority = classifyNews(
      {
        title: existing.titulo,
        summary: existing.resumen ?? raw.summary,
        assets: repo.itemAssets(existing.id),
      },
      refs,
      watchlist,
    );
    const confirmed = isConfirmed(refs);
    if (priority !== existing.prioridad || confirmed !== (existing.confirmada === 1)) {
      repo.updateFlags(existing.id, priority, confirmed);
      changed = true;
    }
    if (changed) outcome.updated.push(existing.id);
    return outcome;
  };

  // -- Agenda por fuente --------------------------------------------------------

  /**
   * Instante a partir del cual la ventana de cuota permite otra llamada:
   * las marcas más viejas que aún cuentan en cada ventana (hora y día).
   */
  const rateLimitedUntil = (runtime: SourceRuntime, limits: ConnectorRateLimits): number => {
    const current = now();
    runtime.calls = runtime.calls.filter((at) => current - at < DAY_MS);
    let until = 0;
    if (limits.perHour > 0) {
      const inHour = runtime.calls.filter((at) => current - at < HOUR_MS);
      if (inHour.length >= limits.perHour) until = Math.max(until, inHour[0]! + HOUR_MS);
    }
    if (limits.perDay > 0 && runtime.calls.length >= limits.perDay) {
      until = Math.max(until, runtime.calls[0]! + DAY_MS);
    }
    return until;
  };

  const pollSource = async (source: NewsSource, force: boolean): Promise<PollOutcome> => {
    const runtime = runtimeFor(source);
    const outcome: PollOutcome = { polled: false, added: [], updated: [] };
    if (!force && runtime.nextDueMs > now()) return outcome;

    const connector: NewsConnector | null = deps.sources.connectorFor(source);
    if (connector === null) {
      runtime.nextDueMs = now() + source.intervalSeconds * 1000;
      deps.sources.recordFetch(source.id, {
        ok: false,
        error: `el conector '${source.connector}' no está registrado en la app`,
      });
      return outcome;
    }

    const limitedUntil = rateLimitedUntil(runtime, connector.rateLimits);
    if (limitedUntil > now()) {
      // Cuota agotada: se pospone al instante en que expira la marca vieja.
      runtime.nextDueMs = Math.max(runtime.nextDueMs, limitedUntil);
      return outcome;
    }

    const effectiveIntervalMs = Math.max(
      source.intervalSeconds * 1000,
      minIntervalMsFromLimits(connector.rateLimits),
    );

    runtime.calls.push(now());
    outcome.polled = true;

    let items: RawNewsItem[];
    try {
      items = await connector.fetchItems(deps.sources.toConnectorConfig(source));
    } catch (error) {
      runtime.failures += 1;
      const waitMs = Math.max(
        backoffDelayMs(runtime.failures, backoffBaseMs, backoffMaxMs, random),
        isNewsConnectorError(error) ? (error.retryAfterMs ?? 0) : 0,
      );
      runtime.nextDueMs = now() + waitMs;
      deps.sources.recordFetch(source.id, { ok: false, error: errorMessage(error) });
      logger.warn?.(
        `[news] lectura de '${source.name}' falló; reintento en ${Math.round(waitMs / 1000)} s: ${errorMessage(error)}`,
      );
      return outcome;
    }

    runtime.failures = 0;
    runtime.nextDueMs = now() + effectiveIntervalMs;
    deps.sources.recordFetch(source.id, { ok: true });

    for (const raw of items) {
      const itemOutcome = ingestItem(raw, source);
      outcome.added.push(...itemOutcome.added);
      outcome.updated.push(...itemOutcome.updated);
    }
    return outcome;
  };

  /**
   * Una pasada sobre las fuentes activas, en serie para no solaparse ni
   * martillear la red: el fallo de una fuente nunca interrumpe a las demás.
   * `force` ignora la agenda (gancho `news:poll-now`); la ventana de cuota
   * se respeta siempre. Las pasadas concurrentes comparten la misma promesa.
   */
  const runPass = (force: boolean): Promise<NewsPollResult> => {
    if (running) return running;
    const task = (async () => {
      let sourcesPolled = 0;
      const addedIds = new Set<number>();
      const updatedIds = new Set<number>();

      if (isOnline()) {
        for (const source of deps.sources.listActive()) {
          const outcome = await pollSource(source, force);
          if (outcome.polled) sourcesPolled += 1;
          for (const id of outcome.added) addedIds.add(id);
          for (const id of outcome.updated) {
            if (!addedIds.has(id)) updatedIds.add(id);
          }
        }
      }

      const added = [...addedIds]
        .map((id) => repo.getItem(id))
        .filter((item): item is NewsItem => item !== null);
      const updated = [...updatedIds]
        .map((id) => repo.getItem(id))
        .filter((item): item is NewsItem => item !== null);

      if (added.length > 0 || updated.length > 0) {
        const event: NewsUpdatedEvent = { newItems: added.length, updatedAt: isoNow() };
        deps.broadcast(IPC_CHANNELS.news.updated, event);
        for (const listener of listeners) listener({ added, updated });
      }

      return { sourcesPolled, newItems: added.length, polledAt: isoNow() };
    })();
    running = task;
    task.finally(() => {
      if (running === task) running = null;
    });
    return task;
  };

  // -- Temporizador -------------------------------------------------------------

  const clearTimer = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  /** Arma el próximo despertar: la fuente que venza antes, con tope rescan. */
  const armNext = (): void => {
    if (!started) return;
    clearTimer();
    let delayMs = rescanMs;
    if (!isOnline()) {
      delayMs = Math.min(delayMs, offlineRecheckMs);
    } else {
      for (const source of deps.sources.listActive()) {
        delayMs = Math.min(delayMs, Math.max(0, runtimeFor(source).nextDueMs - now()));
      }
    }
    timer = setTimeout(() => {
      timer = null;
      void evaluateSafely();
    }, delayMs);
    // El temporizador no debe mantener vivo el proceso por sí solo.
    timer.unref?.();
  };

  const evaluate = async (): Promise<void> => {
    if (!started) return;
    await runPass(false);
    armNext();
  };

  /** evaluate() sin rechazos flotantes: un fallo inesperado queda en el log. */
  const evaluateSafely = (): Promise<void> =>
    evaluate().catch((error: unknown) => {
      logger.error?.(`[news] la pasada programada falló: ${String(error)}`);
      if (started) armNext();
    });

  const onResume = (): void => {
    logger.info?.('[news] el equipo despertó; se reevalúa la agenda del lector');
    void evaluateSafely();
  };

  // -- API pública --------------------------------------------------------------

  const service: NewsPollerService = {
    listNews: (query) => repo.list(query ?? {}),

    pollNow: () => runPass(true),

    recover: () => {
      if (!isOnline()) return Promise.resolve();
      logger.info?.('[news] conexión recuperada; pasada inmediata del lector');
      return evaluateSafely();
    },

    onItemsStored: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    ...(deps.clock
      ? {
          advanceClock: (deltaMs: number): NewsClockAdvanceResult => {
            const instant = deps.clock!.advance(deltaMs);
            logger.info?.(`[news] reloj adelantado ${deltaMs} ms (desarrollo)`);
            void evaluateSafely();
            return { now: new Date(instant).toISOString() };
          },
        }
      : {}),

    start: () => {
      if (started) return Promise.resolve();
      started = true;
      deps.powerMonitor?.on('resume', onResume);
      // La primera pasada cubre lo que quedó pendiente con la app cerrada.
      return evaluateSafely();
    },

    stop: () => {
      started = false;
      clearTimer();
      deps.powerMonitor?.removeListener('resume', onResume);
    },
  };

  return service;
}

// ---------------------------------------------------------------------------
// Registro en la app
// ---------------------------------------------------------------------------

export function registerNews(ctx: ServiceContext): NewsPollerService {
  // Sin base de datos el lector no puede persistir: se degrada a memoria
  // para que el resto de la app siga arrancando (mismo patrón que sources).
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[news] almacén no disponible: el feed solo vivirá en memoria');
    db = openDatabase(':memory:');
  }
  const repo = createNewsRepository(db);
  const clock = createNewsClock();

  const sources = ctx.services.sources ?? null;
  if (sources === null) {
    console.error('[news] gestor de fuentes no disponible: el lector no encontrará fuentes');
  }

  const service = createNewsPoller({
    repo,
    sources: sources ?? {
      listActive: () => [],
      connectorFor: () => null,
      toConnectorConfig: (source: NewsSource) => ({
        id: source.id,
        name: source.name,
        kind: source.kind,
        url: source.url,
        params: source.params,
      }),
      recordFetch: () => undefined,
    },
    listWatchlist: () => ctx.services.market?.listWatchlist() ?? [],
    broadcast: ctx.broadcast,
    clock,
    isOnline: () => ctx.services.connectivity?.getState().status !== 'offline',
    powerMonitor,
  });

  // Recuperación inmediata al volver la red: se observa el evento
  // connectivity:changed atravesando ctx.broadcast (mismo patrón que
  // market/health con data-status:changed). El lector sigue consultando su
  // propio isOnline en cada pasada por si el evento no llega.
  const innerBroadcast = ctx.broadcast;
  ctx.broadcast = (channel, payload) => {
    innerBroadcast(channel, payload);
    if (
      channel === IPC_CHANNELS.connectivity.changed &&
      (payload as Partial<ConnectivityState> | undefined)?.status === 'online'
    ) {
      void service.recover();
    }
  };

  ipcMain.handle(IPC_CHANNELS.news.list, (_event, query: unknown) => {
    if (!isNewsListQuery(query)) {
      throw new IpcValidationError(IPC_CHANNELS.news.list, 'consulta del feed inválida');
    }
    return service.listNews(query);
  });

  // Ganchos de desarrollo: la app empaquetada no registra los canales.
  if (!app.isPackaged) {
    ipcMain.handle(IPC_CHANNELS.news.pollNow, () => service.pollNow());
    ipcMain.handle(IPC_CHANNELS.news.advanceClock, (_event, deltaMs: unknown) => {
      if (typeof deltaMs !== 'number' || !Number.isFinite(deltaMs) || deltaMs <= 0) {
        throw new IpcValidationError(
          IPC_CHANNELS.news.advanceClock,
          'se esperaba un número de ms positivo',
        );
      }
      const result = service.advanceClock?.(deltaMs) ?? { now: new Date().toISOString() };
      // El contrato adelanta también el reloj del calendario (se registra
      // después del lector; por eso se busca aquí y no en el arranque).
      const calendar = (ctx.services as { calendar?: { advanceClock?: (ms: number) => unknown } })
        .calendar;
      calendar?.advanceClock?.(deltaMs);
      return result;
    });
  }

  void service.start();
  return service;
}
