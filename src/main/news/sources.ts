/**
 * Gestor de fuentes de noticias — Fase 1b.
 *
 * Repositorio sobre `news_sources` (migración 004) + servicio con las
 * operaciones del panel Fuentes: alta, edición, baja, activar/desactivar y
 * «probar conexión», que devuelve el número de titulares encontrados o el
 * motivo del error (`TestSourceResult`, nunca lanza por un fallo de red).
 *
 * Reglas:
 * - `connector` debe existir en el registro (`connectors/index.ts`); los
 *   conectores con `requiresUrl` (RSS/Atom) además exigen `url` en el alta.
 * - Las claves de API nunca viajan en `params` ni se devuelven al renderer:
 *   los conectores las piden al servicio secrets por su `secretsKey`. Como
 *   defensa extra, el servicio rechaza `params` con nombres de secreto.
 * - Quitar una fuente borra sus enlaces en `news_item_sources` (cascada) y
 *   conserva los titulares ya guardados: «deja de traer titulares nuevos».
 * - El programador (tarea siguiente) usa `listActive`, `connectorFor`,
 *   `toConnectorConfig` y `recordFetch` para leer cada fuente activa.
 */
import type Database from 'better-sqlite3';
import { ipcMain } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isAddSourceRequest,
  isSourceId,
  isTestSourceRequest,
  isUpdateSourceRequest,
  isSourceUrl,
  type AddSourceRequest,
  type NewsSource,
  type Reliability,
  type SourceKind,
  type SourceState,
  type TestSourceRequest,
  type TestSourceResult,
  type UpdateSourceRequest,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import {
  createDefaultConnectorRegistry,
  seedOfficialSources,
  type ConnectorRegistry,
  type ConnectorSourceConfig,
  type NewsConnector,
} from './connectors';

export const SOURCE_DEFAULT_INTERVAL_SECONDS = 300;
const MAX_SOURCE_ERROR_LENGTH = 300;

// ---------------------------------------------------------------------------
// Errores del servicio
// ---------------------------------------------------------------------------

export const SOURCES_ERROR_CODES = ['unknown-connector', 'not-found', 'invalid-input'] as const;
export type SourcesErrorCode = (typeof SOURCES_ERROR_CODES)[number];

export class SourcesError extends Error {
  readonly code: SourcesErrorCode;

  constructor(code: SourcesErrorCode, message: string) {
    super(message);
    this.name = 'SourcesError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Repositorio (tabla news_sources)
// ---------------------------------------------------------------------------

interface SourceRow {
  id: number;
  nombre: string;
  tipo: SourceKind;
  conector: string;
  url: string | null;
  params: string;
  fiabilidad: Reliability;
  intervalo_segundos: number;
  activa: number;
  ultimo_estado: SourceState;
  ultimo_error: string | null;
  ultima_lectura: string | null;
  creado_en: string;
}

const SOURCE_COLUMNS =
  'id, nombre, tipo, conector, url, params, fiabilidad, intervalo_segundos, ' +
  'activa, ultimo_estado, ultimo_error, ultima_lectura, creado_en';

function parseParams(raw: string, sourceId: number): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // cae al return de abajo
  }
  console.warn(`[sources] params ilegibles en la fuente ${sourceId}; se devuelve {}`);
  return {};
}

function toNewsSource(row: SourceRow): NewsSource {
  return {
    id: row.id,
    name: row.nombre,
    kind: row.tipo,
    connector: row.conector,
    url: row.url,
    params: parseParams(row.params, row.id),
    reliability: row.fiabilidad,
    intervalSeconds: row.intervalo_segundos,
    active: row.activa === 1,
    lastStatus: row.ultimo_estado,
    lastError: row.ultimo_error,
    lastFetchedAt: row.ultima_lectura,
    createdAt: row.creado_en,
  };
}

export interface NewSourceRecord {
  name: string;
  kind: SourceKind;
  connector: string;
  url: string | null;
  params: Record<string, unknown>;
  reliability: Reliability;
  intervalSeconds: number;
}

export interface SourceStatusReport {
  state: SourceState;
  /** Motivo legible del estado; null en una lectura correcta. */
  error: string | null;
  /** Instante de la lectura correcta (ISO 8601); solo con state 'ok'. */
  fetchedAt?: string;
}

export interface SourcesRepository {
  list(): NewsSource[];
  /** Solo las activas: las que lee el programador en cada pasada. */
  listActive(): NewsSource[];
  get(id: number): NewsSource | null;
  insert(record: NewSourceRecord): NewsSource;
  /** Aplica los campos presentes del parche; null si la fuente no existe. */
  update(id: number, patch: UpdateSourceRequest): NewsSource | null;
  /** Borra la fuente y, en cascada, sus enlaces con titulares. */
  delete(id: number): boolean;
  /** Resultado de una lectura o prueba de conexión. */
  recordStatus(id: number, report: SourceStatusReport): void;
}

export function createSourcesRepository(db: Database.Database): SourcesRepository {
  const selectAll = db.prepare(`SELECT ${SOURCE_COLUMNS} FROM news_sources ORDER BY id`);
  const selectActive = db.prepare(
    `SELECT ${SOURCE_COLUMNS} FROM news_sources WHERE activa = 1 ORDER BY id`,
  );
  const selectOne = db.prepare(`SELECT ${SOURCE_COLUMNS} FROM news_sources WHERE id = ?`);
  const insertStmt = db.prepare(`
    INSERT INTO news_sources (nombre, tipo, conector, url, params, fiabilidad, intervalo_segundos)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteStmt = db.prepare('DELETE FROM news_sources WHERE id = ?');
  const statusStmt = db.prepare(`
    UPDATE news_sources
    SET ultimo_estado = ?, ultimo_error = ?, ultima_lectura = COALESCE(?, ultima_lectura),
        actualizado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `);

  const get = (id: number): NewsSource | null => {
    const row = selectOne.get(id) as SourceRow | undefined;
    return row ? toNewsSource(row) : null;
  };

  return {
    list: () => (selectAll.all() as SourceRow[]).map(toNewsSource),
    listActive: () => (selectActive.all() as SourceRow[]).map(toNewsSource),
    get,

    insert: (record) => {
      const result = insertStmt.run(
        record.name,
        record.kind,
        record.connector,
        record.url,
        JSON.stringify(record.params),
        record.reliability,
        record.intervalSeconds,
      );
      const inserted = get(Number(result.lastInsertRowid));
      if (!inserted) {
        throw new SourcesError('invalid-input', 'no se pudo releer la fuente recién creada');
      }
      return inserted;
    },

    update: (id, patch) => {
      const sets: string[] = [];
      const values: unknown[] = [];
      const field = (column: string, value: unknown): void => {
        sets.push(`${column} = ?`);
        values.push(value);
      };
      if (patch.name !== undefined) field('nombre', patch.name.trim());
      if (patch.url !== undefined) field('url', patch.url);
      if (patch.params !== undefined) field('params', JSON.stringify(patch.params));
      if (patch.reliability !== undefined) field('fiabilidad', patch.reliability);
      if (patch.intervalSeconds !== undefined) field('intervalo_segundos', patch.intervalSeconds);
      if (patch.active !== undefined) field('activa', patch.active ? 1 : 0);
      if (sets.length === 0) return get(id);
      sets.push(`actualizado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`);
      const result = db
        .prepare(`UPDATE news_sources SET ${sets.join(', ')} WHERE id = ?`)
        .run(...values, id);
      return result.changes > 0 ? get(id) : null;
    },

    delete: (id) => deleteStmt.run(id).changes > 0,

    recordStatus: (id, report) => {
      statusStmt.run(
        report.state,
        report.error === null ? null : report.error.slice(0, MAX_SOURCE_ERROR_LENGTH),
        report.state === 'ok' ? (report.fetchedAt ?? new Date().toISOString()) : null,
        id,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

/** Nombres de parámetro que jamás deben viajar en `params` (van a secrets). */
const SECRETISH_PARAM = /api[-_]?key|secret|token|password|passwd|credential|clave/i;

export interface SourcesServiceDeps {
  repo: SourcesRepository;
  connectors: ConnectorRegistry;
  /** Reloj inyectable (ms epoch) para sellar lecturas y latencias. */
  now?: () => number;
  logger?: { warn(message: string): void };
}

export interface SourcesService {
  list(): NewsSource[];
  /** Fuentes activas, en orden de alta; las lee el programador. */
  listActive(): NewsSource[];
  add(request: AddSourceRequest): NewsSource;
  update(request: UpdateSourceRequest): NewsSource;
  /** Quita la fuente y devuelve la lista resultante. */
  remove(id: number): NewsSource[];
  /**
   * «Probar conexión» de una fuente guardada (`{ id }`) o del borrador del
   * alta. Devuelve el nº de titulares o el motivo del error; solo lanza
   * `SourcesError` si la fuente pedida por id no existe.
   */
  test(request: TestSourceRequest): Promise<TestSourceResult>;
  /** Conector que lee una fuente; null si ya no está registrado. */
  connectorFor(source: NewsSource): NewsConnector | null;
  /** Vista de una fuente tal como la necesita el conector. */
  toConnectorConfig(source: NewsSource): ConnectorSourceConfig;
  /** El programador informa del resultado de cada lectura. */
  recordFetch(sourceId: number, outcome: { ok: boolean; error?: string | null }): void;
}

/** Rechaza params con nombres de secreto: las claves viven en `secrets`. */
function assertNoSecretsInParams(params: Record<string, unknown>): void {
  for (const key of Object.keys(params)) {
    if (SECRETISH_PARAM.test(key)) {
      throw new SourcesError(
        'invalid-input',
        `el parámetro '${key}' parece una credencial: las claves de API se guardan en el gestor de claves, no en la fuente`,
      );
    }
  }
}

export function createSourcesService(deps: SourcesServiceDeps): SourcesService {
  const { repo, connectors } = deps;
  const now = deps.now ?? (() => Date.now());
  const isoNow = (): string => new Date(now()).toISOString();

  const toConnectorConfig = (source: NewsSource): ConnectorSourceConfig => ({
    id: source.id,
    name: source.name,
    kind: source.kind,
    url: source.url,
    params: source.params,
  });

  const requireConnector = (connectorId: string): NewsConnector => {
    const connector = connectors.get(connectorId);
    if (!connector) {
      throw new SourcesError(
        'unknown-connector',
        `el conector '${connectorId}' no está registrado en la app`,
      );
    }
    return connector;
  };

  const service: SourcesService = {
    list: () => repo.list(),
    listActive: () => repo.listActive(),
    toConnectorConfig,
    connectorFor: (source) => connectors.get(source.connector) ?? null,

    add: (request) => {
      const connector = requireConnector(request.connector);
      const url = request.url ?? null;
      if (connector.requiresUrl && !isSourceUrl(url)) {
        throw new SourcesError(
          'invalid-input',
          `el conector '${connector.id}' necesita una URL de feed válida`,
        );
      }
      const params = request.params ?? {};
      assertNoSecretsInParams(params);
      return repo.insert({
        name: request.name.trim(),
        kind: request.kind,
        connector: connector.id,
        url,
        params,
        reliability: request.reliability,
        intervalSeconds: request.intervalSeconds ?? SOURCE_DEFAULT_INTERVAL_SECONDS,
      });
    },

    update: (request) => {
      const existing = repo.get(request.id);
      if (!existing) {
        throw new SourcesError('not-found', `no existe la fuente ${request.id}`);
      }
      if (request.params !== undefined) assertNoSecretsInParams(request.params);
      // Las fuentes oficiales predefinidas se pueden desactivar pero no
      // reclasificar: su fiabilidad queda fijada en 'oficial'.
      if (
        request.reliability !== undefined &&
        existing.kind === 'oficial' &&
        request.reliability !== existing.reliability
      ) {
        throw new SourcesError(
          'invalid-input',
          'las fuentes oficiales no pueden reclasificarse: solo activarse, desactivarse o ajustar su configuración',
        );
      }
      const connector = connectors.get(existing.connector);
      const url = request.url ?? existing.url;
      if (connector?.requiresUrl && !isSourceUrl(url)) {
        throw new SourcesError(
          'invalid-input',
          `el conector '${existing.connector}' necesita una URL de feed válida`,
        );
      }
      const updated = repo.update(request.id, request);
      if (!updated) {
        throw new SourcesError('not-found', `no existe la fuente ${request.id}`);
      }
      return updated;
    },

    remove: (id) => {
      // Los enlaces con titulares caen en cascada; las noticias se quedan.
      repo.delete(id);
      return repo.list();
    },

    test: async (request) => {
      let config: ConnectorSourceConfig;
      let saved: NewsSource | null = null;
      if ('id' in request) {
        saved = repo.get(request.id);
        if (!saved) {
          throw new SourcesError('not-found', `no existe la fuente ${request.id}`);
        }
        config = toConnectorConfig(saved);
      } else {
        config = {
          id: null,
          name: request.name,
          kind: request.kind,
          url: request.url ?? null,
          params: request.params ?? {},
        };
      }

      const connectorId = 'id' in request ? saved!.connector : request.connector;
      const resolved = connectors.get(connectorId);
      if (!resolved) {
        return {
          ok: false,
          itemsFound: 0,
          latencyMs: null,
          error: `el conector '${connectorId}' no está registrado en la app`,
        };
      }

      const result = await resolved.test(config);

      if (saved) {
        repo.recordStatus(saved.id, {
          state: result.ok ? 'ok' : 'error',
          error: result.ok ? null : (result.error ?? 'fallo desconocido'),
          fetchedAt: result.ok ? isoNow() : undefined,
        });
      }
      return result;
    },

    recordFetch: (sourceId, outcome) => {
      repo.recordStatus(sourceId, {
        state: outcome.ok ? 'ok' : 'error',
        error: outcome.ok ? null : (outcome.error ?? 'fallo desconocido'),
        fetchedAt: outcome.ok ? isoNow() : undefined,
      });
    },
  };

  return service;
}

// ---------------------------------------------------------------------------
// Registro IPC (canales sources:*)
// ---------------------------------------------------------------------------

export interface RegisterSourcesOptions {
  /**
   * true en la app real (`initServices`): siembra las fuentes oficiales
   * predefinidas (Fed, BCE, BLS, BEA, SEC EDGAR, CNMV) una sola vez por
   * conector. Las pruebas lo dejan en false para partir de una lista vacía.
   */
  seedOfficial?: boolean;
}

export function registerSources(
  ctx: ServiceContext,
  options: RegisterSourcesOptions = {},
): SourcesService {
  // Sin almacén el servicio no puede persistir: se degrada a memoria para que
  // el resto de la app siga arrancando (mismo patrón que market).
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[sources] almacén no disponible: las fuentes solo vivirán en memoria');
    db = openDatabase(':memory:');
  }
  if (options.seedOfficial) {
    seedOfficialSources(db);
  }
  const repo = createSourcesRepository(db);
  const secrets = ctx.services.secrets;
  const connectors = createDefaultConnectorRegistry({
    // Los conectores piden sus claves a secrets por su secretsKey; el
    // renderer no participa y las claves nunca salen del proceso principal.
    getApiKey: secrets ? (key) => secrets.getKey(key) : async () => null,
    logger: console,
  });
  const service = createSourcesService({ repo, connectors });

  ipcMain.handle(IPC_CHANNELS.sources.list, () => service.list());
  ipcMain.handle(IPC_CHANNELS.sources.add, (_event, request: unknown) => {
    if (!isAddSourceRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.sources.add, 'alta de fuente inválida');
    }
    return service.add(request);
  });
  ipcMain.handle(IPC_CHANNELS.sources.update, (_event, request: unknown) => {
    if (!isUpdateSourceRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.sources.update, 'cambio de fuente inválido');
    }
    return service.update(request);
  });
  ipcMain.handle(IPC_CHANNELS.sources.remove, (_event, id: unknown) => {
    if (!isSourceId(id)) {
      throw new IpcValidationError(IPC_CHANNELS.sources.remove, 'id de fuente inválido');
    }
    return service.remove(id);
  });
  ipcMain.handle(IPC_CHANNELS.sources.test, (_event, request: unknown) => {
    if (!isTestSourceRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.sources.test, 'prueba de conexión inválida');
    }
    return service.test(request);
  });

  return service;
}
