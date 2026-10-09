/**
 * Diario automático (fase 4) — servicio y registro IPC.
 *
 * Registra todo lo que hace el sistema en `journal_entries` (migración
 * 008): cada señal, veto, contradicción, operación simulada, resumen de la
 * rutina, límite alcanzado y error, con su motivo, los datos usados, el
 * resultado, los errores y el cumplimiento de reglas.
 *
 * Los demás servicios escriben por `record()`; los vetos del motor de
 * riesgo llegan solos: `registerJournal` envuelve `ctx.broadcast` y
 * escucha `risk:vetoed` (mismo patrón que killSwitch con
 * `data-status:changed`), así cada regla incumplida queda en el diario aun
 * sin señal persistida. Cada alta emite `journal:updated` al renderer.
 *
 * IPC: `journal:list` (página con filtros y total), `journal:get`
 * (detalle) y `journal:export-csv` (RFC 4180 con BOM UTF-8; diálogo de
 * guardar en la app, `request.path` solo en modo E2E y acotado a las
 * carpetas del entorno de pruebas).
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

import { app, BrowserWindow, dialog, ipcMain } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isE2eEnabled,
  isJournalEntryId,
  isJournalEntryType,
  isJournalExportRequest,
  isJournalListQuery,
  isJournalResult,
  isNonEmptyString,
  type JournalEntry,
  type JournalExportRequest,
  type JournalExportResult,
  type JournalListQuery,
  type JournalPage,
  type JournalRecordInput,
  type JournalRuleCheck,
  type JournalStrategyRef,
  type JournalUpdatedEvent,
  type RiskVeto,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import { journalEntriesToCsv } from './csv';
import { createJournalRepository, type JournalRepository } from './repository';

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export const JOURNAL_SERVICE_ERROR_CODES = [
  'entrada-invalida',
  'ruta-no-permitida',
  'exportacion-fallida',
] as const;
export type JournalServiceErrorCode = (typeof JOURNAL_SERVICE_ERROR_CODES)[number];

export class JournalServiceError extends Error {
  readonly code: JournalServiceErrorCode;

  constructor(code: JournalServiceErrorCode, message: string) {
    super(message);
    this.name = 'JournalServiceError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Validación de record() (entrada interna de otros servicios)
// ---------------------------------------------------------------------------

const isStrategyRef = (value: unknown): value is JournalStrategyRef => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Number.isInteger(v.strategyId) &&
    (v.strategyId as number) > 0 &&
    typeof v.name === 'string' &&
    v.name.trim().length > 0 &&
    typeof v.version === 'number' &&
    Number.isFinite(v.version)
  );
};

const isRuleCheck = (value: unknown): value is JournalRuleCheck => {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const nullableString = (x: unknown) => x === null || typeof x === 'string';
  return (
    isNonEmptyString(v.code) &&
    typeof v.label === 'string' &&
    typeof v.cumplida === 'boolean' &&
    nullableString(v.observed) &&
    nullableString(v.limit)
  );
};

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Valida lo que llega a `record()`: el diario es la pista de auditoría,
 * así que una entrada mal formada se rechaza con error legible en vez de
 * persistir basura. Las fechas las pone el servicio.
 */
export function assertJournalRecordInput(
  input: unknown,
): asserts input is JournalRecordInput {
  if (!isRecord(input)) {
    throw new JournalServiceError('entrada-invalida', 'la entrada del diario no es un objeto');
  }
  if (!isJournalEntryType(input.type)) {
    throw new JournalServiceError('entrada-invalida', `tipo de entrada inválido: ${input.type}`);
  }
  if (!isNonEmptyString(input.reason)) {
    throw new JournalServiceError('entrada-invalida', 'el motivo es obligatorio');
  }
  const v = input as Record<string, unknown>;
  if (v.ticker !== undefined && v.ticker !== null && !isNonEmptyString(v.ticker)) {
    throw new JournalServiceError('entrada-invalida', 'el activo debe ser texto no vacío');
  }
  if (
    v.result !== undefined &&
    v.result !== null &&
    !isJournalResult(v.result)
  ) {
    throw new JournalServiceError('entrada-invalida', `resultado inválido: ${v.result}`);
  }
  if (v.strategies !== undefined && (!Array.isArray(v.strategies) || !v.strategies.every(isStrategyRef))) {
    throw new JournalServiceError(
      'entrada-invalida',
      'estrategias debe ser una lista de {strategyId, name, version}',
    );
  }
  if (v.errors !== undefined && !isStringList(v.errors)) {
    throw new JournalServiceError('entrada-invalida', 'errores debe ser una lista de texto');
  }
  if (v.ruleChecks !== undefined && (!Array.isArray(v.ruleChecks) || !v.ruleChecks.every(isRuleCheck))) {
    throw new JournalServiceError(
      'entrada-invalida',
      'reglas debe ser una lista de {code, label, cumplida, observed, limit}',
    );
  }
  if (v.dataUsed !== undefined && v.dataUsed !== null && !isRecord(v.dataUsed)) {
    throw new JournalServiceError('entrada-invalida', 'datos debe ser un objeto');
  }
  if (
    v.signalId !== undefined &&
    v.signalId !== null &&
    !(Number.isInteger(v.signalId) && (v.signalId as number) > 0)
  ) {
    throw new JournalServiceError('entrada-invalida', 'senal_id debe ser un entero positivo');
  }
}

// ---------------------------------------------------------------------------
// Veto del motor de riesgo → entrada 'veto'
// ---------------------------------------------------------------------------

/** Guarda estructural del payload `risk:vetoed` (RiskVeto). */
export function isRiskVetoLike(payload: unknown): payload is RiskVeto {
  if (!isRecord(payload)) return false;
  return (
    Number.isInteger(payload.id) &&
    isNonEmptyString(payload.ticker) &&
    (payload.decision === 'vetada' || payload.decision === 'reducida') &&
    isNonEmptyString(payload.code) &&
    typeof payload.message === 'string' &&
    isRecord(payload.signal) &&
    typeof payload.size === 'number' &&
    isRecord(payload.details) &&
    typeof payload.createdAt === 'string'
  );
}

/** Claves de `details` que representan el valor observado de la regla. */
const OBSERVED_DETAIL_KEYS = [
  'real',
  'ratio',
  'perdida',
  'drawdown',
  'exposicion',
  'correlacion',
  'posiciones',
  'confianza',
  'apalancamiento',
] as const;

/** Claves de `details` que representan el límite de la regla. */
const LIMIT_DETAIL_KEYS = ['limite', 'maximo', 'minimo'] as const;

/** Primer valor presente de las claves dadas, formateado; null si ninguna aplica. */
const pickDetail = (
  details: Record<string, number | string>,
  keys: readonly string[],
): string | null => {
  for (const key of keys) {
    const value = details[key];
    if (value !== undefined) return String(value);
  }
  return null;
};

/**
 * Una entrada 'veto' por evento `risk:vetoed` (el motor emite una por cada
 * regla incumplida). `senal` queda sin enlazar: el veto ocurre antes de
 * que la señal se persista; la entrada 'senal' que registra el motor
 * lleva el `signalId`.
 */
function vetoToRecordInput(veto: RiskVeto): JournalRecordInput {
  return {
    type: 'veto',
    ticker: veto.ticker,
    reason: veto.message,
    result: veto.decision,
    dataUsed: {
      vetoId: veto.id,
      senal: veto.signal,
      tamano: veto.size,
      detalles: veto.details,
      vetoEn: veto.createdAt,
    },
    ruleChecks: [
      {
        code: veto.code,
        label: veto.message,
        cumplida: false,
        observed: pickDetail(veto.details, OBSERVED_DETAIL_KEYS),
        limit: pickDetail(veto.details, LIMIT_DETAIL_KEYS),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Núcleo del servicio (sin Electron)
// ---------------------------------------------------------------------------

export interface JournalSaveDialogOptions {
  title: string;
  defaultPath: string;
  filters: { name: string; extensions: string[] }[];
}

export interface JournalServiceDeps {
  repo: JournalRepository;
  broadcast(channel: string, payload: unknown): void;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
  /** Diálogo de guardar (Electron en la app; falso en pruebas). */
  showSaveDialog?(
    options: JournalSaveDialogOptions,
  ): Promise<{ canceled: boolean; filePath?: string }>;
  /** Escritura del CSV (fs.writeFileSync en la app). */
  writeFile?(path: string, contents: string): void;
  /** true en modo E2E: `request.path` se respeta, acotada a allowedExportDirs. */
  e2e?: boolean;
  /** Carpetas permitidas para la ruta de exportación forzada en E2E. */
  allowedExportDirs?(): string[];
}

export interface JournalService {
  /**
   * Registra una entrada (validada) y emite `journal:updated`. Es la vía
   * de escritura para los demás servicios: señales, contradicciones,
   * operaciones simuladas, límites, resúmenes y errores.
   */
  record(input: JournalRecordInput): JournalEntry;
  /**
   * Registra un veto del motor de riesgo (evento `risk:vetoed`): una
   * entrada por regla incumplida, con su código, motivo y valores.
   */
  recordRiskVeto(veto: RiskVeto): JournalEntry;
  /** Página del diario con los filtros del contrato. */
  list(query?: JournalListQuery): JournalPage;
  /** Entrada completa; null si no existe. */
  get(id: number): JournalEntry | null;
  /**
   * Exporta el conjunto filtrado a CSV (hasta JOURNAL_LIST_MAX_LIMIT
   * filas). En modo E2E escribe en `request.path` (acotada); en la app
   * abre el diálogo de guardar.
   */
  exportCsv(request?: JournalExportRequest): Promise<JournalExportResult>;
  stop(): void;
}

const isInsideDir = (dir: string, target: string): boolean => {
  const base = resolve(dir);
  return target === base || target.startsWith(`${base}${sep}`);
};

export function createJournalService(deps: JournalServiceDeps): JournalService {
  const now = deps.now ?? (() => Date.now());

  const record = (input: JournalRecordInput): JournalEntry => {
    assertJournalRecordInput(input);
    const entry = deps.repo.insert(
      {
        type: input.type,
        ticker: input.ticker ?? null,
        strategies: input.strategies ?? [],
        reason: input.reason.trim(),
        dataUsed: input.dataUsed ?? null,
        result: input.result ?? null,
        errors: input.errors ?? [],
        ruleChecks: input.ruleChecks ?? [],
        signalId: input.signalId ?? null,
      },
      new Date(now()).toISOString(),
    );
    deps.broadcast(IPC_CHANNELS.journal.updated, { entry } satisfies JournalUpdatedEvent);
    return entry;
  };

  const writeCsv = (path: string, csv: string): void => {
    if (!deps.writeFile) {
      throw new JournalServiceError('exportacion-fallida', 'escritura de archivos no disponible');
    }
    try {
      deps.writeFile(path, csv);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new JournalServiceError(
        'exportacion-fallida',
        `no se pudo escribir el CSV en ${path}: ${detail}`,
      );
    }
  };

  return {
    record,

    recordRiskVeto: (veto) => record(vetoToRecordInput(veto)),

    list: (query) => deps.repo.list(query),

    get: (id) => deps.repo.getById(id),

    exportCsv: async (request = {}) => {
      // La exportación cubre todo el conjunto filtrado (tope del contrato:
      // JOURNAL_LIST_MAX_LIMIT), no solo la página visible.
      const { entries } = deps.repo.list(request.query);
      const csv = journalEntriesToCsv(entries);
      const fileName = `tradia-diario-${new Date(now()).toISOString().slice(0, 10)}.csv`;

      // Solo en E2E (sin empaquetar): ruta forzada, acotada a las carpetas
      // del entorno de pruebas; sin diálogo, que Playwright no puede usar.
      if (deps.e2e === true && request.path !== undefined) {
        const target = resolve(request.path);
        const allowed = deps.allowedExportDirs?.() ?? [];
        if (!allowed.some((dir) => isInsideDir(dir, target))) {
          throw new JournalServiceError(
            'ruta-no-permitida',
            'la ruta de exportación E2E debe estar dentro del entorno de pruebas',
          );
        }
        writeCsv(target, csv);
        return { canceled: false, path: target, entries: entries.length };
      }

      if (!deps.showSaveDialog) {
        throw new JournalServiceError('exportacion-fallida', 'diálogo de guardar no disponible');
      }
      const result = await deps.showSaveDialog({
        title: 'Exportar diario a CSV',
        defaultPath: fileName,
        filters: [{ name: 'CSV (separado por comas)', extensions: ['csv'] }],
      });
      if (result.canceled || !result.filePath) {
        return { canceled: true, path: null, entries: 0 };
      }
      writeCsv(result.filePath, csv);
      return { canceled: false, path: result.filePath, entries: entries.length };
    },

    stop: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Registro en la app
// ---------------------------------------------------------------------------

export function registerJournal(ctx: ServiceContext): JournalService {
  // Mismo patrón de degradación que el resto de servicios: sin base de
  // datos el diario vive en memoria y la app sigue arrancando.
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[journal] almacén no disponible: el diario solo vivirá en memoria');
    db = openDatabase(':memory:');
  }

  const e2e = isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E);
  const service = createJournalService({
    repo: createJournalRepository(db),
    // Indirección: usa el ctx.broadcast vigente en cada emisión.
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
    e2e,
    // La ruta E2E solo puede caer en el temporal del sistema, en el
    // userData aislado de la prueba o en test-results/ del proyecto.
    allowedExportDirs: () => [
      tmpdir(),
      app.getPath('userData'),
      resolve('test-results'),
    ],
    showSaveDialog: (options) => {
      const win = BrowserWindow.getAllWindows()[0];
      return win && !win.isDestroyed()
        ? dialog.showSaveDialog(win, options)
        : dialog.showSaveDialog(options);
    },
    writeFile: (path, contents) => writeFileSync(path, contents, 'utf8'),
  });

  // Los vetos entran al diario escuchando `risk:vetoed` (envoltura de
  // ctx.broadcast, como killSwitch con data-status:changed). Los demás
  // tipos de entrada llegan por record() desde cada servicio.
  let acceptingVetoes = true;
  const innerBroadcast = ctx.broadcast;
  ctx.broadcast = (channel, payload) => {
    innerBroadcast(channel, payload);
    if (acceptingVetoes && channel === IPC_CHANNELS.risk.vetoed && isRiskVetoLike(payload)) {
      service.recordRiskVeto(payload);
    }
  };

  ipcMain.handle(IPC_CHANNELS.journal.list, (_event, query: unknown) => {
    if (!isJournalListQuery(query)) {
      throw new IpcValidationError(
        IPC_CHANNELS.journal.list,
        'se esperaba {desde?, hasta?, type?, ticker?, strategyId?, result?, limit?, offset?}',
      );
    }
    return service.list(query);
  });
  ipcMain.handle(IPC_CHANNELS.journal.get, (_event, id: unknown) => {
    if (!isJournalEntryId(id)) {
      throw new IpcValidationError(IPC_CHANNELS.journal.get, 'se esperaba un id entero positivo');
    }
    return service.get(id);
  });
  ipcMain.handle(IPC_CHANNELS.journal.exportCsv, (_event, request: unknown) => {
    if (!isJournalExportRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.journal.exportCsv, 'se esperaba {query?, path?}');
    }
    return service.exportCsv(request);
  });

  return {
    ...service,
    stop: () => {
      acceptingVetoes = false;
      service.stop();
    },
  };
}
