/**
 * Repositorio de estrategias — Fase 2.
 *
 * Único punto de escritura/lectura de `strategies`, `strategy_versions` y
 * `strategy_changelog` (migración 005). Las columnas de la base usan el
 * español de la migración; la superficie expone los tipos en inglés de
 * `shared/strategy.ts`.
 *
 * Reglas de negocio:
 * - El alta crea la versión 1 en estado 'investigacion' y anota el
 *   registro (`version`).
 * - Editar crea la versión N+1 con una nota obligatoria; las versiones
 *   anteriores quedan intactas y consultables.
 * - Cambiar el estado anota el registro (`estado`, con ambos extremos)
 *   sin crear versión nueva; no se puede repetir el estado actual.
 * - `metricas_resumen` la escribe el servicio de backtest
 *   (`setVersionMetrics`), nunca el alta ni la edición.
 */
import type Database from 'better-sqlite3';

import {
  DEFAULT_STRATEGY_COSTS,
  STRATEGY_STATUSES,
  type CreateStrategyRequest,
  type SetStrategyStatusRequest,
  type Strategy,
  type StrategyChangelogEntry,
  type StrategyChangelogKind,
  type StrategyCosts,
  type StrategyMetricsSummary,
  type StrategyParameterRange,
  type StrategyPeriod,
  type StrategyStatus,
  type StrategySummary,
  type UpdateStrategyRequest,
} from '../../shared/strategy';

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export const STRATEGIES_ERROR_CODES = ['not-found', 'invalid-input'] as const;
export type StrategiesErrorCode = (typeof STRATEGIES_ERROR_CODES)[number];

export class StrategiesError extends Error {
  readonly code: StrategiesErrorCode;

  constructor(code: StrategiesErrorCode, message: string) {
    super(message);
    this.name = 'StrategiesError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Filas crudas de SQLite
// ---------------------------------------------------------------------------

interface StrategyRow {
  id: number;
  estado: StrategyStatus;
  creado_en: string;
  actualizado_en: string;
}

interface VersionRow {
  strategy_id: number;
  version: number;
  nombre: string;
  hipotesis: string;
  regla_entrada: string;
  regla_salida: string;
  regla_stop: string;
  regla_objetivo: string;
  parametros: string;
  rangos_parametros: string;
  mercados: string;
  entrenamiento_desde: string | null;
  entrenamiento_hasta: string | null;
  fuera_muestra_desde: string | null;
  fuera_muestra_hasta: string | null;
  metricas_resumen: string | null;
  regimen: string;
  costes: string;
  nota: string;
  creado_en: string;
}

interface ChangelogRow {
  id: number;
  strategy_id: number;
  tipo: StrategyChangelogKind;
  version: number | null;
  estado_anterior: StrategyStatus | null;
  estado_nuevo: StrategyStatus | null;
  nota: string;
  creado_en: string;
}

const VERSION_COLUMNS =
  'strategy_id, version, nombre, hipotesis, regla_entrada, regla_salida, ' +
  'regla_stop, regla_objetivo, parametros, rangos_parametros, mercados, ' +
  'entrenamiento_desde, entrenamiento_hasta, fuera_muestra_desde, ' +
  'fuera_muestra_hasta, metricas_resumen, regimen, costes, nota, creado_en';

// ---------------------------------------------------------------------------
// Conversión y JSON defensivo
// ---------------------------------------------------------------------------

function parseJsonObject<T>(raw: string, fallback: T, what: string, versionId: string): T {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as T;
    }
  } catch {
    // cae al warn de abajo
  }
  console.warn(`[strategies] ${what} ilegible en ${versionId}; se devuelve el valor vacío`);
  return fallback;
}

function parseJsonArray(raw: string, versionId: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    // cae al warn de abajo
  }
  console.warn(`[strategies] mercados ilegibles en ${versionId}; se devuelve []`);
  return [];
}

function period(desde: string | null, hasta: string | null): StrategyPeriod | null {
  return desde !== null && hasta !== null ? { desde, hasta } : null;
}

function toStrategy(strategy: StrategyRow, row: VersionRow, executable: boolean): Strategy {
  const ref = `estrategia ${row.strategy_id} v${row.version}`;
  return {
    id: strategy.id,
    executable,
    version: row.version,
    name: row.nombre,
    hypothesis: row.hipotesis,
    rules: {
      entry: row.regla_entrada,
      exit: row.regla_salida,
      stop: row.regla_stop,
      target: row.regla_objetivo,
    },
    parameters: parseJsonObject<Record<string, number>>(row.parametros, {}, 'parametros', ref),
    parameterRanges: parseJsonObject<Record<string, StrategyParameterRange>>(
      row.rangos_parametros,
      {},
      'rangos_parametros',
      ref,
    ),
    markets: parseJsonArray(row.mercados, ref),
    trainingPeriod: period(row.entrenamiento_desde, row.entrenamiento_hasta),
    outOfSamplePeriod: period(row.fuera_muestra_desde, row.fuera_muestra_hasta),
    metricsSummary:
      row.metricas_resumen === null
        ? null
        : parseJsonObject<StrategyMetricsSummary | null>(
            row.metricas_resumen,
            null,
            'metricas_resumen',
            ref,
          ),
    regime: row.regimen,
    assumedCosts: parseJsonObject<StrategyCosts>(row.costes, DEFAULT_STRATEGY_COSTS, 'costes', ref),
    status: strategy.estado,
    changeNote: row.nota,
    createdAt: strategy.creado_en,
    updatedAt: strategy.actualizado_en,
    versionCreatedAt: row.creado_en,
  };
}

function toChangelogEntry(row: ChangelogRow): StrategyChangelogEntry {
  return {
    id: row.id,
    strategyId: row.strategy_id,
    kind: row.tipo,
    version: row.version,
    fromStatus: row.estado_anterior,
    toStatus: row.estado_nuevo,
    note: row.nota,
    createdAt: row.creado_en,
  };
}

// ---------------------------------------------------------------------------
// Validación de dominio (defensa en profundidad tras los guardas IPC)
// ---------------------------------------------------------------------------

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new StrategiesError('invalid-input', `${field} no puede estar vacío`);
  }
}

function assertFiniteNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StrategiesError('invalid-input', `${field} no es un número finito`);
  }
}

function assertPeriod(value: StrategyPeriod | null | undefined, field: string): void {
  if (value === null || value === undefined) return;
  assertNonEmpty(value.desde, `${field}.desde`);
  assertNonEmpty(value.hasta, `${field}.hasta`);
  if (value.desde > value.hasta) {
    throw new StrategiesError('invalid-input', `${field}: 'desde' no puede ir después de 'hasta'`);
  }
}

function assertStatus(value: unknown): asserts value is StrategyStatus {
  if (typeof value !== 'string' || !(STRATEGY_STATUSES as readonly string[]).includes(value)) {
    throw new StrategiesError(
      'invalid-input',
      `estado de estrategia inválido: ${JSON.stringify(value)}`,
    );
  }
}

/** Versión resuelta de la ficha: todos los campos rellenos. */
interface ResolvedDraft {
  name: string;
  hypothesis: string;
  rules: { entry: string; exit: string; stop: string; target: string };
  parameters: Record<string, number>;
  parameterRanges: Record<string, StrategyParameterRange>;
  markets: string[];
  trainingPeriod: StrategyPeriod | null;
  outOfSamplePeriod: StrategyPeriod | null;
  regime: string;
  assumedCosts: StrategyCosts;
}

function assertDraft(draft: ResolvedDraft): void {
  assertNonEmpty(draft.name, 'nombre');
  assertNonEmpty(draft.hypothesis, 'hipotesis');
  for (const [field, text] of Object.entries(draft.rules)) {
    assertNonEmpty(text, `reglas.${field}`);
  }
  for (const [key, value] of Object.entries(draft.parameters)) {
    assertNonEmpty(key, 'nombre de parámetro');
    assertFiniteNumber(value, `parametros.${key}`);
  }
  for (const [key, range] of Object.entries(draft.parameterRanges)) {
    if (!(key in draft.parameters)) {
      throw new StrategiesError(
        'invalid-input',
        `el rango de '${key}' no corresponde a ningún parámetro`,
      );
    }
    assertFiniteNumber(range.min, `rangos.${key}.min`);
    assertFiniteNumber(range.max, `rangos.${key}.max`);
    assertFiniteNumber(range.step, `rangos.${key}.step`);
    if (range.min > range.max || range.step <= 0) {
      throw new StrategiesError(
        'invalid-input',
        `el rango de '${key}' es inválido (min <= max y step > 0)`,
      );
    }
  }
  if (!Array.isArray(draft.markets) || draft.markets.length === 0) {
    throw new StrategiesError('invalid-input', 'la ficha necesita al menos un mercado');
  }
  for (const market of draft.markets) assertNonEmpty(market, 'mercado');
  assertPeriod(draft.trainingPeriod, 'periodo de entrenamiento');
  assertPeriod(draft.outOfSamplePeriod, 'periodo fuera de muestra');
  assertNonEmpty(draft.regime, 'regimen');
  for (const field of ['commissionPct', 'commissionMin', 'slippageBps', 'spreadBps'] as const) {
    assertFiniteNumber(draft.assumedCosts[field], `costes.${field}`);
    if (draft.assumedCosts[field] < 0) {
      throw new StrategiesError('invalid-input', `costes.${field} no puede ser negativo`);
    }
  }
}

function draftFromCreate(request: CreateStrategyRequest): ResolvedDraft {
  return {
    name: request.name,
    hypothesis: request.hypothesis,
    rules: request.rules,
    parameters: request.parameters ?? {},
    parameterRanges: request.parameterRanges ?? {},
    markets: request.markets,
    trainingPeriod: request.trainingPeriod ?? null,
    outOfSamplePeriod: request.outOfSamplePeriod ?? null,
    regime: request.regime,
    assumedCosts: request.assumedCosts ?? DEFAULT_STRATEGY_COSTS,
  };
}

function draftFromRow(row: VersionRow): ResolvedDraft {
  const ref = `estrategia ${row.strategy_id} v${row.version}`;
  return {
    name: row.nombre,
    hypothesis: row.hipotesis,
    rules: {
      entry: row.regla_entrada,
      exit: row.regla_salida,
      stop: row.regla_stop,
      target: row.regla_objetivo,
    },
    parameters: parseJsonObject(row.parametros, {}, 'parametros', ref),
    parameterRanges: parseJsonObject(row.rangos_parametros, {}, 'rangos_parametros', ref),
    markets: parseJsonArray(row.mercados, ref),
    trainingPeriod: period(row.entrenamiento_desde, row.entrenamiento_hasta),
    outOfSamplePeriod: period(row.fuera_muestra_desde, row.fuera_muestra_hasta),
    regime: row.regimen,
    assumedCosts: parseJsonObject(row.costes, DEFAULT_STRATEGY_COSTS, 'costes', ref),
  };
}

// ---------------------------------------------------------------------------
// Repositorio
// ---------------------------------------------------------------------------

export interface StrategiesRepository {
  /** Biblioteca: versión vigente de cada estrategia, en orden de alta. */
  list(): StrategySummary[];
  /** Ficha en la versión vigente o en `version`; null si no existe. */
  get(id: number, version?: number): Strategy | null;
  /** Números de versión existentes, de la 1 a la vigente. */
  listVersions(id: number): number[];
  /** Registro de cambios, más reciente primero. */
  history(id: number): StrategyChangelogEntry[];
  /** Alta: crea la versión 1 en estado 'investigacion' con su entrada. */
  create(request: CreateStrategyRequest): Strategy;
  /** Edición: crea la versión N+1 (nota obligatoria) y conserva las demás. */
  update(request: UpdateStrategyRequest): Strategy;
  /** Cambio de estado: entrada 'estado' en el registro, sin versión nueva. */
  setStatus(request: SetStrategyStatusRequest): Strategy;
  /**
   * Escribe las métricas resumen del backtest representativo de una versión
   * (la vigente por defecto). Lo usa el servicio de backtest.
   */
  setVersionMetrics(id: number, metrics: StrategyMetricsSummary, version?: number): Strategy;
}

const UPDATE_TOUCH = "actualizado_en = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export function createStrategiesRepository(
  db: Database.Database,
  isExecutable: (id: number) => boolean = () => false,
): StrategiesRepository {
  const selectStrategy = db.prepare(
    'SELECT id, estado, creado_en, actualizado_en FROM strategies WHERE id = ?',
  );
  const selectVersion = db.prepare(
    `SELECT ${VERSION_COLUMNS} FROM strategy_versions WHERE strategy_id = ? AND version = ?`,
  );
  const selectLatestVersion = db.prepare(
    `SELECT ${VERSION_COLUMNS} FROM strategy_versions
     WHERE strategy_id = ? ORDER BY version DESC LIMIT 1`,
  );
  const insertVersion = db.prepare(
    `INSERT INTO strategy_versions (
       strategy_id, version, nombre, hipotesis,
       regla_entrada, regla_salida, regla_stop, regla_objetivo,
       parametros, rangos_parametros, mercados,
       entrenamiento_desde, entrenamiento_hasta,
       fuera_muestra_desde, fuera_muestra_hasta,
       regimen, costes, nota
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertChangelog = db.prepare(
    `INSERT INTO strategy_changelog
       (strategy_id, tipo, version, estado_anterior, estado_nuevo, nota)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const getStrategyRow = (id: number): StrategyRow | null => {
    if (!Number.isInteger(id) || id <= 0) return null;
    return (selectStrategy.get(id) as StrategyRow | undefined) ?? null;
  };

  const getVersionRow = (id: number, version?: number): VersionRow | null => {
    const row =
      version === undefined ? selectLatestVersion.get(id) : selectVersion.get(id, version);
    return (row as VersionRow | undefined) ?? null;
  };

  const insertVersionRow = (
    strategyId: number,
    version: number,
    draft: ResolvedDraft,
    note: string,
  ): void => {
    insertVersion.run(
      strategyId,
      version,
      draft.name.trim(),
      draft.hypothesis.trim(),
      draft.rules.entry.trim(),
      draft.rules.exit.trim(),
      draft.rules.stop.trim(),
      draft.rules.target.trim(),
      JSON.stringify(draft.parameters),
      JSON.stringify(draft.parameterRanges),
      JSON.stringify(draft.markets.map((market) => market.trim())),
      draft.trainingPeriod?.desde ?? null,
      draft.trainingPeriod?.hasta ?? null,
      draft.outOfSamplePeriod?.desde ?? null,
      draft.outOfSamplePeriod?.hasta ?? null,
      draft.regime.trim(),
      JSON.stringify(draft.assumedCosts),
      note,
    );
  };

  const repo: StrategiesRepository = {
    list: () => {
      const rows = db
        .prepare(
          `SELECT s.id, s.estado, s.actualizado_en,
                  v.version, v.nombre, v.regimen, v.mercados, v.metricas_resumen
           FROM strategies s
           JOIN strategy_versions v
             ON v.strategy_id = s.id
            AND v.version = (SELECT MAX(version) FROM strategy_versions WHERE strategy_id = s.id)
           ORDER BY s.id`,
        )
        .all() as {
        id: number;
        estado: StrategyStatus;
        actualizado_en: string;
        version: number;
        nombre: string;
        regimen: string;
        mercados: string;
        metricas_resumen: string | null;
      }[];
      return rows.map((row) => ({
        id: row.id,
        name: row.nombre,
        version: row.version,
        status: row.estado,
        regime: row.regimen,
        markets: parseJsonArray(row.mercados, `estrategia ${row.id} v${row.version}`),
        metricsSummary:
          row.metricas_resumen === null
            ? null
            : parseJsonObject<StrategyMetricsSummary | null>(
                row.metricas_resumen,
                null,
                'metricas_resumen',
                `estrategia ${row.id} v${row.version}`,
              ),
        updatedAt: row.actualizado_en,
      }));
    },

    get: (id, version) => {
      const strategy = getStrategyRow(id);
      if (!strategy) return null;
      const row = getVersionRow(id, version);
      return row ? toStrategy(strategy, row, isExecutable(id)) : null;
    },

    listVersions: (id) =>
      (
        db
          .prepare('SELECT version FROM strategy_versions WHERE strategy_id = ? ORDER BY version')
          .all(id) as { version: number }[]
      ).map((row) => row.version),

    history: (id) =>
      (
        db
          .prepare(
            `SELECT id, strategy_id, tipo, version, estado_anterior, estado_nuevo, nota, creado_en
             FROM strategy_changelog WHERE strategy_id = ? ORDER BY id DESC`,
          )
          .all(id) as ChangelogRow[]
      ).map(toChangelogEntry),

    create: (request) => {
      const draft = draftFromCreate(request);
      assertDraft(draft);
      const note =
        typeof request.note === 'string' && request.note.trim() !== ''
          ? request.note.trim()
          : 'Alta de la estrategia';

      const id = db.transaction(() => {
        const result = db.prepare('INSERT INTO strategies DEFAULT VALUES').run();
        const strategyId = Number(result.lastInsertRowid);
        insertVersionRow(strategyId, 1, draft, note);
        insertChangelog.run(strategyId, 'version', 1, null, null, note);
        return strategyId;
      })();

      const created = repo.get(id);
      if (!created) {
        throw new StrategiesError('not-found', 'no se pudo releer la estrategia recién creada');
      }
      return created;
    },

    update: (request) => {
      const strategy = getStrategyRow(request.id);
      if (!strategy) {
        throw new StrategiesError('not-found', `no existe la estrategia ${request.id}`);
      }
      if (typeof request.note !== 'string' || request.note.trim() === '') {
        throw new StrategiesError(
          'invalid-input',
          'la edición exige una nota de cambio que explique qué cambió y por qué',
        );
      }
      const current = getVersionRow(request.id);
      if (!current) {
        throw new StrategiesError(
          'not-found',
          `la estrategia ${request.id} no tiene ninguna versión`,
        );
      }
      const merged = { ...draftFromRow(current) };
      const { id: _id, note, ...patch } = request;
      const changed = Object.entries(patch).filter(([, value]) => value !== undefined);
      if (changed.length === 0) {
        throw new StrategiesError(
          'invalid-input',
          'la edición necesita al menos un campo de la ficha además de la nota',
        );
      }
      for (const [key, value] of changed) {
        (merged as Record<string, unknown>)[key] = value;
      }
      if (request.parameterRanges === undefined) {
        // Si cambian los parámetros sin tocar los rangos, los rangos que ya
        // no apuntan a un parámetro se descartan en la nueva versión.
        for (const key of Object.keys(merged.parameterRanges)) {
          if (!(key in merged.parameters)) delete merged.parameterRanges[key];
        }
      }
      assertDraft(merged);

      const version = current.version + 1;
      const trimmedNote = note.trim();
      db.transaction(() => {
        insertVersionRow(request.id, version, merged, trimmedNote);
        insertChangelog.run(request.id, 'version', version, null, null, trimmedNote);
        db.prepare(`UPDATE strategies SET ${UPDATE_TOUCH} WHERE id = ?`).run(request.id);
      })();

      const updated = repo.get(request.id, version);
      if (!updated) {
        throw new StrategiesError('not-found', 'no se pudo releer la versión recién creada');
      }
      return updated;
    },

    setStatus: (request) => {
      const strategy = getStrategyRow(request.id);
      if (!strategy) {
        throw new StrategiesError('not-found', `no existe la estrategia ${request.id}`);
      }
      assertStatus(request.status);
      if (request.status === strategy.estado) {
        throw new StrategiesError(
          'invalid-input',
          `la estrategia ${request.id} ya está en estado '${request.status}'`,
        );
      }
      const note =
        typeof request.note === 'string' && request.note.trim() !== ''
          ? request.note.trim()
          : `Cambio de estado: ${strategy.estado} → ${request.status}`;

      db.transaction(() => {
        db.prepare(`UPDATE strategies SET estado = ?, ${UPDATE_TOUCH} WHERE id = ?`).run(
          request.status,
          request.id,
        );
        insertChangelog.run(request.id, 'estado', null, strategy.estado, request.status, note);
      })();

      const updated = repo.get(request.id);
      if (!updated) {
        throw new StrategiesError('not-found', 'no se pudo releer la estrategia actualizada');
      }
      return updated;
    },

    setVersionMetrics: (id, metrics, version) => {
      const strategy = getStrategyRow(id);
      if (!strategy) {
        throw new StrategiesError('not-found', `no existe la estrategia ${id}`);
      }
      const target = getVersionRow(id, version);
      if (!target) {
        throw new StrategiesError(
          'not-found',
          version === undefined
            ? `la estrategia ${id} no tiene ninguna versión`
            : `no existe la versión ${version} de la estrategia ${id}`,
        );
      }
      assertFiniteNumber(metrics.totalReturnPct, 'metricas.totalReturnPct');
      assertFiniteNumber(metrics.maxDrawdownPct, 'metricas.maxDrawdownPct');
      if (!Number.isInteger(metrics.trades) || metrics.trades < 0) {
        throw new StrategiesError('invalid-input', 'metricas.trades debe ser un entero >= 0');
      }
      if (!Number.isInteger(metrics.maxLosingStreak) || metrics.maxLosingStreak < 0) {
        throw new StrategiesError(
          'invalid-input',
          'metricas.maxLosingStreak debe ser un entero >= 0',
        );
      }
      db.transaction(() => {
        db.prepare(
          'UPDATE strategy_versions SET metricas_resumen = ? WHERE strategy_id = ? AND version = ?',
        ).run(JSON.stringify(metrics), id, target.version);
        db.prepare(`UPDATE strategies SET ${UPDATE_TOUCH} WHERE id = ?`).run(id);
      })();

      const updated = repo.get(id, target.version);
      if (!updated) {
        throw new StrategiesError('not-found', 'no se pudo releer la estrategia actualizada');
      }
      return updated;
    },
  };

  return repo;
}
