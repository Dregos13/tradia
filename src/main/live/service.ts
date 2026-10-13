/**
 * Servicio del modo real mínimo (fase 7) — lista de comprobación,
 * límites escritos y bloqueo de `live:activate` en el proceso principal.
 *
 * `createLiveService` es el núcleo, con todo lo externo inyectado
 * (almacén, evidencia sembrada, fuentes del resto de dominios, parada,
 * diario, notificaciones, broadcast y reloj): las pruebas lo montan sin
 * Electron. `registerLive` (index.ts) lo cablea en la app.
 *
 * Reglas de negocio:
 * - La lista se reevalúa en cada consulta y en cada mutación: ningún
 *   requisito automático se marca desde la interfaz ni se cachea.
 * - `activate` exige los siete requisitos cumplidos, límites guardados
 *   (≤ `LIVE_FIXED_CAPS`) y la frase exacta generada con esos valores;
 *   nunca lanza por requisitos pendientes: devuelve la lista de motivos.
 * - El modo real solo sale de 'activo' por acción explícita del usuario
 *   (`deactivate` o una nueva activación tras 'suspendido') o por
 *   suspensión: parada de emergencia, conexión perdida o requisito que
 *   deja de cumplirse. Nunca se reactiva solo.
 * - Toda transición y cada intento rechazado quedan en el Diario.
 */
import type Database from 'better-sqlite3';

import {
  IPC_CHANNELS,
  type ConnectivityState,
  type JournalRecordInput,
  type KillSwitchResumeRequest,
  type KillSwitchState,
  type NotificationPayload,
  type RiskOverview,
} from '../../shared/ipc';
import {
  LIVE_ALL_DECLARATION_REQUIREMENTS,
  LIVE_AUTOMATIC_REQUIREMENTS,
  LIVE_DECLARATION_TEXTS,
  LIVE_FIXED_CAPS,
  LIVE_REQUIREMENT_TITLES,
  LIVE_REQUIREMENTS,
  LIVE_SHORT_AUTOMATIC_REQUIREMENTS,
  LIVE_SHORT_ERROR_CODE,
  LIVE_SHORT_REQUIREMENTS,
  liveConfirmationPhrase,
  livePhraseMatches,
  type LiveActivateRequest,
  type LiveActivateResult,
  type LiveChecklist,
  type LiveChecklistItem,
  type LiveDeclareRequest,
  type LiveFixedCaps,
  type LiveKillSwitchTestResult,
  type LiveLimits,
  type LiveLimitsInput,
  type LiveLimitsState,
  type LiveModeState,
  type LiveRequirement,
  type LiveRequirementState,
  type LiveSeedProgressRequest,
  type LiveShortChecklist,
  type LiveSmokeTestResult,
  type LiveState,
  type LiveSuspensionReason,
} from '../../shared/live';
import {
  declarationPendingReason,
  evaluateAlertChannel,
  evaluateFinalTest,
  evaluateKillSwitchTest,
  evaluatePaperProgress,
  evaluatePaperShorts,
  formatLiveDate,
  pendingRequirementsOf,
  paperShortStatsFromOrders,
  paperStatsFromOrders,
  type AlertTestEvidence,
  type FinalTestCoverage,
  type PaperProgressStats,
  type PaperShortStats,
  type RequirementVerdict,
} from './checklist';
import type { BrokerOrder } from '../../shared/ipc';
import type { StrategyExpectation } from '../broker/deviation';

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export const LIVE_SERVICE_ERROR_CODES = [
  'limites-fuera-techo',
  'declaracion-invalida',
  'corto-requisitos',
] as const;
export type LiveServiceErrorCode = (typeof LIVE_SERVICE_ERROR_CODES)[number];

export class LiveServiceError extends Error {
  readonly code: LiveServiceErrorCode;

  constructor(code: LiveServiceErrorCode, message: string) {
    super(message);
    this.name = 'LiveServiceError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Almacén (migración 011: live_checklist, live_limits, live_mode)
// ---------------------------------------------------------------------------

interface LiveChecklistRow {
  estado: LiveRequirementState;
  evidencia: string | null;
  declaracion: string | null;
  detalle_declaracion: string | null;
  marcado_en: string | null;
}

interface LiveLimitsRow {
  capital_usd: number;
  orden_usd: number;
  perdida_diaria_usd: number;
  posiciones_max: number;
  /** Límites del corto (migración 016): a 0 en las filas migradas. */
  corto_orden_usd: number;
  corto_exposicion_usd: number;
  corto_posiciones_max: number;
  confirmados: number;
  guardados_en: string;
  confirmados_en: string | null;
}

interface LiveModeRow {
  estado: LiveModeState;
  motivo_suspension: LiveSuspensionReason | null;
  detalle_suspension: string | null;
  broker: string | null;
  cuenta: string | null;
  prueba_humo: string | null;
  activado_en: string | null;
  suspendido_en: string | null;
  actualizado_en: string;
}

export interface LiveStore {
  getChecklistRow(requirement: LiveRequirement): LiveChecklistRow | null;
  /** Escribe el veredicto de un requisito automático. */
  setAutomatic(
    requirement: LiveRequirement,
    verdict: { estado: LiveRequirementState; evidencia: string | null; marcadoEn: string },
  ): void;
  /** Suscribe (confirmed) o retira una declaración. */
  setDeclaration(
    requirement: LiveRequirement,
    patch: {
      confirmed: boolean;
      declaracion: string | null;
      detalle: string | null;
      marcadoEn: string | null;
      actualizadoEn: string;
    },
  ): void;
  getLimits(): LiveLimitsRow | null;
  /** Guarda los límites; reinicia la confirmación escrita. */
  saveLimits(limits: LiveLimits, savedAt: string): void;
  /** Marca los límites vigentes como confirmados por escrito. */
  confirmLimits(at: string): void;
  getMode(): LiveModeRow;
  setMode(patch: {
    estado: LiveModeState;
    motivo: LiveSuspensionReason | null;
    detalle: string | null;
    activadoEn: string | null;
    suspendidoEn: string | null;
    actualizadoEn: string;
  }): void;
  /**
   * Anota el broker y la cuenta enmascarada de la conexión live para la
   * franja (`live_mode.broker`/`cuenta`); null al desconectar.
   */
  setConnection(patch: {
    broker: string | null;
    cuenta: string | null;
    actualizadoEn: string;
  }): void;
  /** Persiste la última prueba de humo (`live_mode.prueba_humo`, JSON). */
  setSmokeTest(patch: { pruebaHumo: string | null; actualizadoEn: string }): void;
  /** Estrategias candidatas (paper/activa) con su versión vigente. */
  listCandidates(): { strategyId: number; version: number; name: string }[];
  /** true si la versión tiene un run 'prueba-final' guardado. */
  hasFinalTest(strategyId: number, version: number): boolean;
  /** Última reanudación de la parada (prueba de que activa y suelta). */
  latestKillSwitchResumeAt(): string | null;
  /**
   * Descuadres aún abiertos de la conciliación de la cuenta paper
   * (`reconcile_discrepancies` unidas a `reconcile_runs` con
   * `cuenta = 'paper'`). Es la evidencia de 'paper-cortos': la
   * conciliación debe cuadrar —ninguna abierta— para habilitar el corto
   * con dinero real.
   */
  listOpenPaperDiscrepancies(): {
    id: number;
    type: string;
    ticker: string | null;
    detail: string;
    createdAt: string;
  }[];
}

export function createLiveStore(db: Database.Database): LiveStore {
  const checklistRow = db.prepare(
    `SELECT estado, evidencia, declaracion, detalle_declaracion, marcado_en
     FROM live_checklist WHERE requisito = ?`,
  );
  const setAutomaticStmt = db.prepare(
    `UPDATE live_checklist SET estado = ?, evidencia = ?, marcado_en = ?,
       actualizado_en = ? WHERE requisito = ?`,
  );
  const setDeclarationStmt = db.prepare(
    `UPDATE live_checklist SET estado = ?, declaracion = ?, detalle_declaracion = ?,
       marcado_en = ?, actualizado_en = ? WHERE requisito = ?`,
  );
  const limitsRow = db.prepare(
    `SELECT capital_usd, orden_usd, perdida_diaria_usd, posiciones_max,
       corto_orden_usd, corto_exposicion_usd, corto_posiciones_max,
       confirmados, guardados_en, confirmados_en FROM live_limits WHERE id = 1`,
  );
  const saveLimitsStmt = db.prepare(
    `INSERT INTO live_limits (id, capital_usd, orden_usd, perdida_diaria_usd,
       posiciones_max, corto_orden_usd, corto_exposicion_usd, corto_posiciones_max,
       confirmados, guardados_en, confirmados_en)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)
     ON CONFLICT (id) DO UPDATE SET
       capital_usd = excluded.capital_usd,
       orden_usd = excluded.orden_usd,
       perdida_diaria_usd = excluded.perdida_diaria_usd,
       posiciones_max = excluded.posiciones_max,
       corto_orden_usd = excluded.corto_orden_usd,
       corto_exposicion_usd = excluded.corto_exposicion_usd,
       corto_posiciones_max = excluded.corto_posiciones_max,
       confirmados = 0,
       guardados_en = excluded.guardados_en,
       confirmados_en = NULL`,
  );
  const confirmLimitsStmt = db.prepare(
    `UPDATE live_limits SET confirmados = 1, confirmados_en = ? WHERE id = 1`,
  );
  const modeRow = db.prepare(
    `SELECT estado, motivo_suspension, detalle_suspension, broker, cuenta,
       prueba_humo, activado_en, suspendido_en, actualizado_en
     FROM live_mode WHERE id = 1`,
  );
  const setModeStmt = db.prepare(
    `UPDATE live_mode SET estado = ?, motivo_suspension = ?, detalle_suspension = ?,
       activado_en = ?, suspendido_en = ?, actualizado_en = ? WHERE id = 1`,
  );
  const setConnectionStmt = db.prepare(
    `UPDATE live_mode SET broker = ?, cuenta = ?, actualizado_en = ? WHERE id = 1`,
  );
  const setSmokeTestStmt = db.prepare(
    `UPDATE live_mode SET prueba_humo = ?, actualizado_en = ? WHERE id = 1`,
  );
  const candidatesStmt = db.prepare(
    `SELECT s.id AS strategy_id, v.version AS version, v.nombre AS name
     FROM strategies s
     JOIN strategy_versions v
       ON v.strategy_id = s.id
      AND v.version = (SELECT MAX(version) FROM strategy_versions WHERE strategy_id = s.id)
     WHERE s.estado IN ('paper', 'activa')
     ORDER BY s.id`,
  );
  const finalTestStmt = db.prepare(
    `SELECT 1 AS found FROM backtest_runs
     WHERE strategy_id = ? AND version = ? AND kind = 'prueba-final' LIMIT 1`,
  );
  const resumeStmt = db.prepare(
    `SELECT creado_en FROM kill_switch_events
     WHERE accion = 'reanudada' ORDER BY id DESC LIMIT 1`,
  );
  const openPaperDiscrepanciesStmt = db.prepare(
    `SELECT d.id, d.tipo AS type, d.ticker, d.detalle AS detail,
       d.creada_en AS createdAt
     FROM reconcile_discrepancies d
     JOIN reconcile_runs r ON r.id = d.run_id
     WHERE d.estado = 'abierta' AND r.cuenta = 'paper'
     ORDER BY d.id`,
  );

  return {
    getChecklistRow: (requirement) =>
      (checklistRow.get(requirement) as LiveChecklistRow | undefined) ?? null,

    setAutomatic: (requirement, verdict) => {
      setAutomaticStmt.run(
        verdict.estado,
        verdict.evidencia,
        verdict.marcadoEn,
        verdict.marcadoEn,
        requirement,
      );
    },

    setDeclaration: (requirement, patch) => {
      setDeclarationStmt.run(
        patch.confirmed ? 'cumplido' : 'pendiente',
        patch.declaracion,
        patch.detalle,
        patch.marcadoEn,
        patch.actualizadoEn,
        requirement,
      );
    },

    getLimits: () => (limitsRow.get() as LiveLimitsRow | undefined) ?? null,

    saveLimits: (limits, savedAt) => {
      saveLimitsStmt.run(
        limits.capitalUsd,
        limits.orderUsd,
        limits.dailyLossUsd,
        limits.openPositions,
        limits.shortOrderUsd,
        limits.shortExposureUsd,
        limits.shortPositions,
        savedAt,
      );
    },

    confirmLimits: (at) => {
      confirmLimitsStmt.run(at);
    },

    getMode: () => modeRow.get() as LiveModeRow,

    setMode: (patch) => {
      setModeStmt.run(
        patch.estado,
        patch.motivo,
        patch.detalle,
        patch.activadoEn,
        patch.suspendidoEn,
        patch.actualizadoEn,
      );
    },

    setConnection: (patch) => {
      setConnectionStmt.run(patch.broker, patch.cuenta, patch.actualizadoEn);
    },

    setSmokeTest: (patch) => {
      setSmokeTestStmt.run(patch.pruebaHumo, patch.actualizadoEn);
    },

    listCandidates: () =>
      (candidatesStmt.all() as { strategy_id: number; version: number; name: string }[]).map(
        (row) => ({ strategyId: row.strategy_id, version: row.version, name: row.name }),
      ),

    hasFinalTest: (strategyId, version) =>
      (finalTestStmt.get(strategyId, version) as { found: number } | undefined) !== undefined,

    latestKillSwitchResumeAt: () => {
      const row = resumeStmt.get() as { creado_en: string } | undefined;
      return row?.creado_en ?? null;
    },

    listOpenPaperDiscrepancies: () =>
      openPaperDiscrepanciesStmt.all() as {
        id: number;
        type: string;
        ticker: string | null;
        detail: string;
        createdAt: string;
      }[],
  };
}

// ---------------------------------------------------------------------------
// Evidencia sembrada/observada (settings key 'live.evidence')
// ---------------------------------------------------------------------------

/**
 * Evidencia que no se deriva de la base: la semilla del gancho E2E
 * (`live:seed-progress`) y los sellos que el propio servicio anota (la
 * prueba de parada). La prueba de canal externo la escribe delivery en
 * `DELIVERY_TEST_EVIDENCE_KEY` y el servicio la lee por `alertTest()`.
 */
export interface LiveEvidenceRecord {
  /** Semilla: días de paper continuo a simular. */
  paperDays?: number;
  /** Semilla: operaciones paper cerradas a simular. */
  paperTrades?: number;
  /** Semilla: desviación frente al backtest en %. */
  deviationPct?: number;
  /** Semilla: cortos cerrados en paper a simular ('paper-cortos'). */
  paperShortTrades?: number;
  /** Semilla: semanas entre el primer y el último corto en paper. */
  paperShortWeeks?: number;
  /** Semilla: la prueba final consta ejecutada (ISO 8601). */
  finalTestDoneAt?: string;
  /** Sello: última prueba de parada correcta (acción o semilla). */
  killSwitchTestedAt?: string;
  /** Semilla: envío de prueba externo correcto (ISO 8601) y su canal. */
  alertTestedAt?: string;
  alertChannel?: string;
}

export interface LiveEvidenceStore {
  get(): LiveEvidenceRecord;
  /** Fusiona campos; un valor null/undefined borra la clave. */
  update(patch: { [K in keyof LiveEvidenceRecord]?: LiveEvidenceRecord[K] | null }): void;
}

export const LIVE_EVIDENCE_KEY = 'live.evidence';

const isEvidenceRecord = (value: unknown): value is LiveEvidenceRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Almacén de evidencia sobre el par getValue/setValue de settings (clave
 * `live.evidence`, JSON). En memoria si falta el almacén.
 */
export function createLiveEvidenceStore(
  getValue: ((key: string) => string | null) | undefined,
  setValue: ((key: string, value: string) => void) | undefined,
): LiveEvidenceStore {
  let memory: LiveEvidenceRecord = {};
  const read = (): LiveEvidenceRecord => {
    if (!getValue) return { ...memory };
    const raw = getValue(LIVE_EVIDENCE_KEY);
    if (raw === null) return {};
    try {
      const parsed: unknown = JSON.parse(raw);
      return isEvidenceRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };
  return {
    get: read,
    update: (patch) => {
      const next = { ...read() };
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null) {
          delete next[key as keyof LiveEvidenceRecord];
        } else {
          (next as Record<string, unknown>)[key] = value;
        }
      }
      if (setValue) {
        setValue(LIVE_EVIDENCE_KEY, JSON.stringify(next));
      } else {
        memory = next;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Dependencias y superficie
// ---------------------------------------------------------------------------

/** Canal externo de alertas tal como lo ve la lista (delivery.config). */
export interface LiveAlertChannel {
  channel: string;
  /** Activo en la configuración de entrega. */
  enabled: boolean;
  /** Con su destino configurado (chat id / servidor+destinatario). */
  configured: boolean;
}

/** Trozo del servicio de parada que la lista usa (services.killSwitch). */
export interface LiveKillSwitchLike {
  getState(): KillSwitchState;
  activate(cause: 'manual', actor: 'usuario', detail?: string | null): KillSwitchState;
  resume(request: KillSwitchResumeRequest): KillSwitchState;
}

export interface LiveServiceDeps {
  store: LiveStore;
  evidence: LiveEvidenceStore;
  /**
   * true solo cuando los ganchos E2E existen (TRADIA_E2E y app sin
   * empaquetar): la evidencia de `settings['live.evidence']` es un
   * simulacro de esos ganchos y solo cuenta entonces. En la app real se
   * ignora siempre — una copia restaurada o una edición a mano de la
   * base no pueden cumplir los requisitos automáticos (H1). Por
   * defecto no cuenta.
   */
  allowSeededEvidence?(): boolean;
  /** Órdenes paper ejecutadas (broker.listOrders paginado). */
  listExecutedOrders?(): BrokerOrder[];
  /** Expectativa del último backtest de la estrategia (broker/deviation). */
  expectationFor?(strategyId: number): Pick<StrategyExpectation, 'perTradeReturnPct'>;
  /** Canales externos configurados (telegram/correo de delivery.config). */
  alertChannels?(): LiveAlertChannel[];
  /** Último envío de prueba externo correcto (delivery.lastTestSuccess). */
  alertTest?(): AlertTestEvidence | null;
  /** Parada de emergencia real (la acción «Probar parada» la ejerce). */
  killSwitch?: LiveKillSwitchLike;
  /** Claves live guardadas en su ranura (secrets.hasKey). */
  hasLiveCredentials?(): boolean | Promise<boolean>;
  /** Cuenta live enmascarada para la franja (la anota be-broker-real). */
  recordJournal?(input: JournalRecordInput): unknown;
  notify?(payload: NotificationPayload): void;
  broadcast(channel: string, payload: unknown): void;
  now?(): number;
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export interface LiveService {
  /** Lista evaluada ahora (escribe los veredictos en live_checklist). */
  getChecklist(): LiveChecklist;
  /** Estado completo del modo real (franja incluida). */
  getState(): Promise<LiveState>;
  declare(request: LiveDeclareRequest): LiveChecklist;
  setLimits(input: LiveLimitsInput): LiveLimitsState;
  /** Con la lista incompleta devuelve los motivos; nunca lanza por ello. */
  activate(request: LiveActivateRequest): Promise<LiveActivateResult>;
  /** Vuelta a paper inmediata; conserva límites, lista e historial. */
  deactivate(): Promise<LiveState>;
  /** «Probar parada»: la activa y la reanuda, con sello y Diario. */
  testKillSwitch(): LiveKillSwitchTestResult;
  /**
   * Reevalúa la lista y aplica las transiciones (la rutina diaria la
   * llama para detectar requisitos vencidos con la app en marcha).
   */
  reevaluate(): LiveChecklist;
  /**
   * Suspende el modo real si está 'activo' (no-op en otro estado): la
   * usan los observadores de parada/conexión y quienes cableen la fase.
   */
  suspend(reason: LiveSuspensionReason, detail: string): void;
  /** Entrada de `risk:changed`: parada activa → 'parada-emergencia'. */
  handleRiskChanged(payload: unknown): void;
  /** Entrada de `connectivity:changed`: 'offline' → 'sin-conexion'. */
  handleConnectivityChange(payload: unknown): void;
  /** Gancho E2E (`live:seed-progress`): siembra evidencia automática. */
  seedProgress(request?: LiveSeedProgressRequest): LiveChecklist;
}

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

const SUSPENSION_LABELS: Record<LiveSuspensionReason, string> = {
  'sin-conexion': 'Sin conexión a internet',
  'parada-emergencia': 'Parada de emergencia activa',
  'requisito-vencido': 'Un requisito de la lista dejó de cumplirse',
};

const AUTOMATIC_SET = new Set<string>([
  ...LIVE_AUTOMATIC_REQUIREMENTS,
  ...LIVE_SHORT_AUTOMATIC_REQUIREMENTS,
]);
const DECLARATION_SET = new Set<string>(LIVE_ALL_DECLARATION_REQUIREMENTS);

const fmtUsd = (value: number): string =>
  `${Number.isInteger(value) ? String(value) : value.toFixed(2)} USD`;

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export function createLiveService(deps: LiveServiceDeps): LiveService {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());
  const isoNow = (): string => new Date(now()).toISOString();

  /** Cache de claves live para los `live:changed` síncronos. */
  let credentialsCache = false;

  const modeRow = () => deps.store.getMode();
  const limitsRow = () => deps.store.getLimits();

  const limitsOf = (row: LiveLimitsRow | null): LiveLimits | null =>
    row === null
      ? null
      : {
          capitalUsd: row.capital_usd,
          orderUsd: row.orden_usd,
          dailyLossUsd: row.perdida_diaria_usd,
          openPositions: row.posiciones_max,
          shortOrderUsd: row.corto_orden_usd,
          shortExposureUsd: row.corto_exposicion_usd,
          shortPositions: row.corto_posiciones_max,
        };

  // -- Evaluación de la lista -------------------------------------------------

  interface Evaluation {
    checklist: LiveChecklist;
    states: Map<LiveRequirement, LiveRequirementState>;
    pending: LiveRequirement[];
    reasons: string[];
    /** Requisitos del corto aún pendientes (vacío si el corto está listo). */
    shortPending: LiveRequirement[];
    /** Motivos legibles de lo que falta para el corto. */
    shortReasons: string[];
  }

  const evaluateAutomatic = (): Map<LiveRequirement, RequirementVerdict> => {
    // La evidencia sembrada solo existe en E2E: fuera de él los
    // requisitos automáticos se miden con datos reales y nada más.
    const evidence: LiveEvidenceRecord =
      deps.allowSeededEvidence?.() === true ? deps.evidence.get() : {};
    const verdicts = new Map<LiveRequirement, RequirementVerdict>();

    // 1. Validación fuera de muestra: prueba final de cada candidata.
    const candidates = deps.store.listCandidates();
    const coverage: FinalTestCoverage = { total: candidates.length, done: 0, missing: [] };
    for (const candidate of candidates) {
      if (deps.store.hasFinalTest(candidate.strategyId, candidate.version)) {
        coverage.done += 1;
      } else {
        coverage.missing.push(candidate.name);
      }
    }
    verdicts.set(
      'validacion-fuera-muestra',
      evaluateFinalTest(coverage, evidence.finalTestDoneAt !== undefined),
    );

    // 2. Paper continuo: órdenes reales + expectativa del backtest.
    const executedOrders = deps.listExecutedOrders?.() ?? [];
    const computed: PaperProgressStats = paperStatsFromOrders(
      executedOrders,
      deps.expectationFor ?? (() => ({ perTradeReturnPct: null })),
    );
    const stats: PaperProgressStats = {
      daysActive: evidence.paperDays ?? computed.daysActive,
      closedTrades: evidence.paperTrades ?? computed.closedTrades,
      deviationPct: evidence.deviationPct ?? computed.deviationPct,
    };
    verdicts.set('paper-continuo', evaluatePaperProgress(stats));

    // 2b. Cortos en paper ('paper-cortos'): sobre las mismas órdenes
    // paper ejecutadas — un corto es la operación cerrada cuya entrada
    // es una venta — más la conciliación de paper, que debe cuadrar sin
    // ningún descuadre abierto. La semilla solo vale en E2E, igual que
    // el resto de la evidencia sembrada; los descuadres se leen siempre
    // de la base (una semilla no puede «cuadrar» la conciliación).
    const computedShorts = paperShortStatsFromOrders(executedOrders);
    const shortStats: PaperShortStats = {
      closedShorts: evidence.paperShortTrades ?? computedShorts.closedShorts,
      spanDays:
        evidence.paperShortWeeks !== undefined
          ? evidence.paperShortWeeks * 7
          : computedShorts.spanDays,
      openDiscrepancies: deps.store.listOpenPaperDiscrepancies().length,
    };
    verdicts.set('paper-cortos', evaluatePaperShorts(shortStats));

    // 3. Parada probada: sello propio o cualquier reanudación real.
    const resumeAt = deps.store.latestKillSwitchResumeAt();
    const stamped = evidence.killSwitchTestedAt ?? null;
    const lastTest =
      stamped !== null && (resumeAt === null || Date.parse(stamped) > Date.parse(resumeAt))
        ? stamped
        : resumeAt;
    verdicts.set('parada-probada', evaluateKillSwitchTest(lastTest, now()));

    // 4. Alertas: último envío de prueba externo correcto + canal activo.
    const realTest = deps.alertTest?.() ?? null;
    const seededTest: AlertTestEvidence | null =
      evidence.alertTestedAt !== undefined
        ? { channel: evidence.alertChannel ?? 'simulado', at: evidence.alertTestedAt }
        : null;
    const test =
      realTest !== null &&
      (seededTest === null || Date.parse(realTest.at) >= Date.parse(seededTest.at))
        ? realTest
        : seededTest;
    const channels = deps.alertChannels?.() ?? [];
    const isChannelActive = (channel: string): boolean =>
      channel === 'simulado' ||
      channels.some((c) => c.channel === channel && c.enabled && c.configured);
    verdicts.set('alertas-activas', evaluateAlertChannel(test, isChannelActive));

    return verdicts;
  };

  const evaluate = (): Evaluation => {
    const evaluatedAt = isoNow();
    const verdicts = evaluateAutomatic();

    // Los veredictos automáticos se escriben; las declaraciones conservan
    // lo que suscribió el usuario (estado y fecha propios).
    for (const [requirement, verdict] of verdicts) {
      deps.store.setAutomatic(requirement, {
        estado: verdict.state,
        evidencia: verdict.evidence,
        marcadoEn: evaluatedAt,
      });
    }

    const buildItem = (requirement: LiveRequirement): LiveChecklistItem => {
      const row = deps.store.getChecklistRow(requirement);
      const isDeclaration = DECLARATION_SET.has(requirement);
      const declared = isDeclaration && row?.declaracion !== null && row?.declaracion !== undefined;
      // Una declaración solo cuenta si guarda su texto y su fecha.
      const state: LiveRequirementState = isDeclaration
        ? declared
          ? (row?.estado ?? 'pendiente')
          : 'pendiente'
        : (row?.estado ?? 'pendiente');
      // La evidencia de una declaración cumplida es su propio texto con
      // la fecha local de la suscripción (la pantalla la muestra tal cual).
      const evidence =
        declared === true
          ? `«${row!.declaracion}» — suscrita el ` +
            `${formatLiveDate(row!.marcado_en ?? evaluatedAt)}.`
          : (row?.evidencia ?? null);
      return {
        requirement,
        kind: AUTOMATIC_SET.has(requirement) ? 'automatica' : 'declaracion',
        title: LIVE_REQUIREMENT_TITLES[requirement],
        state,
        evidence,
        declaration: row?.declaracion ?? null,
        declarationDetail: row?.detalle_declaracion ?? null,
        markedAt: row?.marcado_en ?? null,
      };
    };

    const items: LiveChecklistItem[] = LIVE_REQUIREMENTS.map(buildItem);
    const shortItems: LiveChecklistItem[] = LIVE_SHORT_REQUIREMENTS.map(buildItem);

    const states = new Map<LiveRequirement, LiveRequirementState>(
      [...items, ...shortItems].map((item) => [item.requirement, item.state]),
    );
    const pending = pendingRequirementsOf(LIVE_REQUIREMENTS, states);
    const reasonsOf = (list: readonly LiveRequirement[]): string[] => {
      const result: string[] = [];
      for (const requirement of list) {
        const verdict = verdicts.get(requirement);
        if (verdict !== undefined && verdict.reasons.length > 0) {
          result.push(...verdict.reasons);
        } else {
          result.push(declarationPendingReason(LIVE_REQUIREMENT_TITLES[requirement]));
        }
      }
      return result;
    };
    const reasons = reasonsOf(pending);
    // Los requisitos del corto se evalúan con los mismos veredictos pero
    // nunca cuentan para la puerta del largo (allComplete sigue siendo
    // la de los siete).
    const shortPending = pendingRequirementsOf(LIVE_SHORT_REQUIREMENTS, states);
    const shortReasons = reasonsOf(shortPending);
    const short: LiveShortChecklist = {
      items: shortItems,
      completedCount: shortItems.filter((item) => item.state === 'cumplido').length,
      total: shortItems.length,
      allComplete: shortPending.length === 0,
      blockReason: shortPending.length === 0 ? null : shortReasons.join(' '),
    };

    // Los límites guardados viajan con la lista aunque no estén
    // confirmados: la pantalla recupera el borrador al volver a ella.
    const savedLimits = limitsRow();
    const limits: LiveLimitsState =
      savedLimits === null
        ? { limits: null, confirmationPhrase: null, confirmed: false, savedAt: null }
        : {
            limits: limitsOf(savedLimits),
            confirmationPhrase: liveConfirmationPhrase(limitsOf(savedLimits)!),
            confirmed: savedLimits.confirmados === 1,
            savedAt: savedLimits.guardados_en,
          };

    const checklist: LiveChecklist = {
      items,
      completedCount: items.filter((item) => item.state === 'cumplido').length,
      total: items.length,
      allComplete: pending.length === 0,
      short,
      limits,
      evaluatedAt,
    };

    // Transiciones de estado que solo toca la evaluación:
    // - 'activo' con la lista rota → 'suspendido' ('requisito-vencido').
    // - 'bloqueado'/'listo' se derivan de lista + límites guardados.
    const mode = modeRow();
    if (mode.estado === 'activo' && !checklist.allComplete) {
      const first = pending[0];
      service.suspend(
        'requisito-vencido',
        first === undefined
          ? 'la lista dejó de estar completa'
          : `${LIVE_REQUIREMENT_TITLES[first]} pendiente`,
      );
    } else if (mode.estado === 'bloqueado' || mode.estado === 'listo') {
      const derived: LiveModeState =
        checklist.allComplete && limitsRow() !== null ? 'listo' : 'bloqueado';
      if (derived !== mode.estado) {
        deps.store.setMode({
          estado: derived,
          motivo: mode.motivo_suspension,
          detalle: mode.detalle_suspension,
          activadoEn: mode.activado_en,
          suspendidoEn: mode.suspendido_en,
          actualizadoEn: evaluatedAt,
        });
      }
    }

    return { checklist, states, pending, reasons, shortPending, shortReasons };
  };

  // -- Estado del modo real ----------------------------------------------------

  const parseSmokeTest = (raw: string | null): LiveSmokeTestResult | null => {
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as LiveSmokeTestResult) : null;
    } catch {
      return null;
    }
  };

  /**
   * Estado de los requisitos del corto leído de `live_checklist` (la
   * última evaluación ya escribió el veredicto de 'paper-cortos'): no
   * reevalúa, así `buildState` sigue siendo barato y sin efectos.
   */
  const shortStatusFromRows = (): LiveState['short'] => {
    const missing = LIVE_SHORT_REQUIREMENTS.filter((requirement) => {
      const row = deps.store.getChecklistRow(requirement);
      if (DECLARATION_SET.has(requirement)) {
        return row?.estado !== 'cumplido' || row.declaracion === null;
      }
      return row?.estado !== 'cumplido';
    });
    if (missing.length === 0) return { allComplete: true, blockReason: null };
    return {
      allComplete: false,
      blockReason:
        'los requisitos propios del corto siguen pendientes: ' +
        missing.map((requirement) => LIVE_REQUIREMENT_TITLES[requirement]).join(' · '),
    };
  };

  const buildState = (hasCredentials: boolean): LiveState => {
    const mode = modeRow();
    const limits = limitsRow();
    return {
      mode: mode.estado,
      suspension:
        mode.estado === 'suspendido' && mode.motivo_suspension !== null
          ? { reason: mode.motivo_suspension, detail: mode.detalle_suspension ?? '' }
          : null,
      hasCredentials,
      accountMasked: mode.cuenta,
      limits: limits !== null && limits.confirmados === 1 ? limitsOf(limits) : null,
      caps: { ...LIVE_FIXED_CAPS } as LiveFixedCaps,
      short: shortStatusFromRows(),
      smokeTest: parseSmokeTest(mode.prueba_humo),
      activatedAt: mode.activado_en,
      suspendedAt: mode.suspendido_en,
      updatedAt: mode.actualizado_en,
    };
  };

  const emitChanged = (): void => {
    deps.broadcast(IPC_CHANNELS.live.changed, buildState(credentialsCache));
  };

  const journal = (input: JournalRecordInput): void => {
    try {
      // La lista, los límites y el modo son del dominio del dinero real.
      deps.recordJournal?.({ ...input, mode: 'live' });
    } catch (error: unknown) {
      logger.warn(`[live] no se pudo escribir el Diario: ${String(error)}`);
    }
  };

  // -- Servicio ----------------------------------------------------------------

  const service: LiveService = {
    getChecklist: () => evaluate().checklist,

    reevaluate: () => evaluate().checklist,

    getState: async () => {
      evaluate();
      const credentials = await (deps.hasLiveCredentials?.() ?? false);
      credentialsCache = credentials === true;
      return buildState(credentialsCache);
    },

    declare: (request) => {
      // Defensa en profundidad: la guarda del canal ya lo limita a las
      // declaraciones, pero el servicio vuelve a comprobarlo.
      if (!DECLARATION_SET.has(request.requirement)) {
        throw new LiveServiceError(
          'declaracion-invalida',
          `«${request.requirement}» no es una declaración del usuario`,
        );
      }
      const detail =
        request.detail !== undefined && request.detail.trim() !== '' ? request.detail.trim() : null;
      deps.store.setDeclaration(request.requirement, {
        confirmed: request.confirmed,
        declaracion: request.confirmed ? LIVE_DECLARATION_TEXTS[request.requirement] : null,
        detalle: detail,
        marcadoEn: request.confirmed ? isoNow() : null,
        actualizadoEn: isoNow(),
      });
      journal({
        type: 'resumen',
        result: 'completado',
        reason: request.confirmed
          ? `Declaración «${LIVE_REQUIREMENT_TITLES[request.requirement]}» suscrita por escrito.`
          : `Declaración «${LIVE_REQUIREMENT_TITLES[request.requirement]}» retirada.`,
        dataUsed: {
          requisito: request.requirement,
          declarada: request.confirmed,
          detalle: detail,
        },
      });
      const evaluation = evaluate();
      emitChanged();
      return evaluation.checklist;
    },

    setLimits: (input) => {
      // Los límites del corto son opcionales en la entrada: ausentes se
      // resuelven a 0 —corto desactivado—, así una interfaz que aún no
      // expone esos campos nunca habilita el corto sin querer.
      const limits: LiveLimits = {
        capitalUsd: input.capitalUsd,
        orderUsd: input.orderUsd,
        dailyLossUsd: input.dailyLossUsd,
        openPositions: input.openPositions,
        shortOrderUsd: input.shortOrderUsd ?? 0,
        shortExposureUsd: input.shortExposureUsd ?? 0,
        shortPositions: input.shortPositions ?? 0,
      };
      // Doble comprobación de los techos fijos: el CHECK de la tabla y la
      // guarda del canal ya los exigen, pero un límite fuera de techo no
      // debe llegar nunca a `live_limits`.
      const usdOk = (value: number, cap: number) =>
        Number.isFinite(value) && value > 0 && value <= cap;
      // Los límites del corto admiten 0: así se deja el corto desactivado.
      const shortUsdOk = (value: number, cap: number) =>
        Number.isFinite(value) && value >= 0 && value <= cap;
      const valid =
        usdOk(limits.capitalUsd, LIVE_FIXED_CAPS.capitalUsd) &&
        usdOk(limits.orderUsd, LIVE_FIXED_CAPS.orderUsd) &&
        usdOk(limits.dailyLossUsd, LIVE_FIXED_CAPS.dailyLossUsd) &&
        Number.isInteger(limits.openPositions) &&
        limits.openPositions >= 1 &&
        limits.openPositions <= LIVE_FIXED_CAPS.openPositions &&
        shortUsdOk(limits.shortOrderUsd, LIVE_FIXED_CAPS.shortOrderUsd) &&
        shortUsdOk(limits.shortExposureUsd, LIVE_FIXED_CAPS.shortExposureUsd) &&
        Number.isInteger(limits.shortPositions) &&
        limits.shortPositions >= 0 &&
        limits.shortPositions <= LIVE_FIXED_CAPS.shortPositions;
      if (!valid) {
        throw new LiveServiceError(
          'limites-fuera-techo',
          'los límites escritos superan los techos fijos de la fase o no son positivos',
        );
      }
      // El corto lleva además sus requisitos propios: sin ellos ningún
      // límite del corto mayor que 0 se guarda — la interfaz y cualquier
      // cliente IPC tropican con la misma puerta. El código va en el
      // propio mensaje («[corto-requisitos] motivo») porque las
      // propiedades tipadas no cruzan el IPC de Electron.
      const shortRequested =
        limits.shortOrderUsd > 0 || limits.shortExposureUsd > 0 || limits.shortPositions > 0;
      if (shortRequested) {
        const shortCheck = evaluate().checklist.short;
        if (!shortCheck.allComplete) {
          const message =
            `[${LIVE_SHORT_ERROR_CODE}] ` +
            (shortCheck.blockReason ?? 'los requisitos propios del corto no están cumplidos');
          journal({
            type: 'limite',
            result: 'alcanzado',
            reason: 'Límites del corto rechazados: faltan sus requisitos propios.',
            errors: [message],
          });
          logger.warn(`[live] límites del corto rechazados: ${shortCheck.blockReason}`);
          throw new LiveServiceError('corto-requisitos', message);
        }
      }
      const savedAt = isoNow();
      deps.store.saveLimits(limits, savedAt);
      journal({
        type: 'resumen',
        result: 'completado',
        reason:
          `Límites escritos del modo real guardados: capital ${fmtUsd(limits.capitalUsd)}, ` +
          `${fmtUsd(limits.orderUsd)} por orden, ${fmtUsd(limits.dailyLossUsd)} de pérdida ` +
          `diaria y ${limits.openPositions} posición(es). Corto: ` +
          `${fmtUsd(limits.shortOrderUsd)} por orden, ${fmtUsd(limits.shortExposureUsd)} de ` +
          `exposición y ${limits.shortPositions} posición(es) en corto` +
          `${limits.shortOrderUsd > 0 && limits.shortExposureUsd > 0 && limits.shortPositions > 0 ? '' : ' (desactivado)'}.`,
        dataUsed: { ...limits, techos: { ...LIVE_FIXED_CAPS } },
        ruleChecks: [
          {
            code: 'LIVE_CAP_CAPITAL',
            label: 'Capital real ≤ techo fijo',
            cumplida: limits.capitalUsd <= LIVE_FIXED_CAPS.capitalUsd,
            observed: fmtUsd(limits.capitalUsd),
            limit: fmtUsd(LIVE_FIXED_CAPS.capitalUsd),
          },
          {
            code: 'LIVE_CAP_ORDER',
            label: 'Nocional por orden ≤ techo fijo',
            cumplida: limits.orderUsd <= LIVE_FIXED_CAPS.orderUsd,
            observed: fmtUsd(limits.orderUsd),
            limit: fmtUsd(LIVE_FIXED_CAPS.orderUsd),
          },
          {
            code: 'LIVE_CAP_DAILY_LOSS',
            label: 'Pérdida diaria ≤ techo fijo',
            cumplida: limits.dailyLossUsd <= LIVE_FIXED_CAPS.dailyLossUsd,
            observed: fmtUsd(limits.dailyLossUsd),
            limit: fmtUsd(LIVE_FIXED_CAPS.dailyLossUsd),
          },
          {
            code: 'LIVE_CAP_POSITIONS',
            label: 'Posiciones abiertas ≤ techo fijo',
            cumplida: limits.openPositions <= LIVE_FIXED_CAPS.openPositions,
            observed: String(limits.openPositions),
            limit: String(LIVE_FIXED_CAPS.openPositions),
          },
          {
            code: 'LIVE_CAP_SHORT_ORDER',
            label: 'Nocional por orden en corto ≤ techo fijo',
            cumplida: limits.shortOrderUsd <= LIVE_FIXED_CAPS.shortOrderUsd,
            observed: fmtUsd(limits.shortOrderUsd),
            limit: fmtUsd(LIVE_FIXED_CAPS.shortOrderUsd),
          },
          {
            code: 'LIVE_CAP_SHORT_EXPOSURE',
            label: 'Exposición corta ≤ techo fijo',
            cumplida: limits.shortExposureUsd <= LIVE_FIXED_CAPS.shortExposureUsd,
            observed: fmtUsd(limits.shortExposureUsd),
            limit: fmtUsd(LIVE_FIXED_CAPS.shortExposureUsd),
          },
          {
            code: 'LIVE_CAP_SHORT_POSITIONS',
            label: 'Posiciones cortas ≤ techo fijo',
            cumplida: limits.shortPositions <= LIVE_FIXED_CAPS.shortPositions,
            observed: String(limits.shortPositions),
            limit: String(LIVE_FIXED_CAPS.shortPositions),
          },
        ],
      });
      // Cambiar los límites con el modo real activo exige volver a
      // confirmarlos por escrito: se suspende hasta la nueva activación.
      if (modeRow().estado === 'activo') {
        service.suspend(
          'requisito-vencido',
          'los límites escritos cambiaron; hay que confirmarlos de nuevo',
        );
      }
      evaluate();
      emitChanged();
      return {
        limits: { ...limits },
        confirmationPhrase: liveConfirmationPhrase(limits),
        confirmed: false,
        savedAt,
      };
    },

    activate: async (request) => {
      const evaluation = evaluate();
      const finish = async (
        activated: boolean,
        reasons: string[],
        pending = evaluation.pending,
      ): Promise<LiveActivateResult> => ({
        activated,
        pendingRequirements: activated ? [] : pending,
        reasons,
        state: await service.getState(),
      });

      if (modeRow().estado === 'activo') return finish(true, []);

      if (evaluation.pending.length > 0) {
        journal({
          type: 'limite',
          result: 'alcanzado',
          reason:
            `Activación de dinero real rechazada: ${evaluation.pending.length} ` +
            'requisito(s) pendiente(s).',
          errors: evaluation.reasons,
          dataUsed: { pendientes: evaluation.pending },
        });
        logger.warn(
          `[live] activación rechazada: ${evaluation.pending.length} requisito(s) pendiente(s)`,
        );
        return finish(false, evaluation.reasons);
      }

      const limits = limitsRow();
      if (limits === null) {
        const reasons = ['Guarda primero los límites escritos del modo real.'];
        journal({
          type: 'limite',
          result: 'alcanzado',
          reason: 'Activación de dinero real rechazada: sin límites escritos.',
          errors: reasons,
        });
        return finish(false, reasons);
      }
      const written = limitsOf(limits)!;
      // Confirmar los límites también exige los requisitos del corto
      // cuando algún límite del corto es mayor que 0: una declaración
      // retirada o un descuadre nuevo de la conciliación de paper entre
      // guardar y confirmar deja la confirmación fuera — los valores
      // escritos se conservan, pero el corto queda bloqueado.
      const shortWritten =
        written.shortOrderUsd > 0 || written.shortExposureUsd > 0 || written.shortPositions > 0;
      if (shortWritten && !evaluation.checklist.short.allComplete) {
        const reasons = [
          `[${LIVE_SHORT_ERROR_CODE}] ` +
            (evaluation.checklist.short.blockReason ??
              'los requisitos propios del corto no están cumplidos'),
        ];
        journal({
          type: 'limite',
          result: 'alcanzado',
          reason:
            'Activación de dinero real rechazada: los límites del corto no se ' +
            'pueden confirmar sin sus requisitos propios.',
          errors: reasons,
        });
        logger.warn('[live] activación rechazada: requisitos del corto sin cumplir');
        return finish(
          false,
          reasons,
          [...evaluation.pending, ...evaluation.shortPending],
        );
      }
      if (!livePhraseMatches(request.phrase, written)) {
        const reasons = ['La frase de confirmación no coincide con la generada para tus límites.'];
        journal({
          type: 'limite',
          result: 'alcanzado',
          reason: 'Activación de dinero real rechazada: frase de confirmación incorrecta.',
          errors: reasons,
        });
        logger.warn('[live] activación rechazada: frase de confirmación incorrecta');
        return finish(false, reasons);
      }

      const at = isoNow();
      deps.store.confirmLimits(at);
      deps.store.setMode({
        estado: 'activo',
        motivo: null,
        detalle: null,
        activadoEn: at,
        suspendidoEn: null,
        actualizadoEn: at,
      });
      journal({
        type: 'limite',
        result: 'completado',
        reason:
          `Modo real ACTIVADO con capital ${fmtUsd(written.capitalUsd)}, ` +
          `${fmtUsd(written.orderUsd)} por orden, ${fmtUsd(written.dailyLossUsd)} de ` +
          `pérdida diaria y ${written.openPositions} posición(es). Corto: ` +
          `${fmtUsd(written.shortOrderUsd)} por orden, ${fmtUsd(written.shortExposureUsd)} ` +
          `de exposición y ${written.shortPositions} posición(es) en corto` +
          `${
            written.shortOrderUsd > 0 && written.shortExposureUsd > 0 && written.shortPositions > 0
              ? ''
              : ' (desactivado)'
          }.`,
        dataUsed: { limites: written, fraseConfirmada: true },
      });
      logger.warn('[live] modo real ACTIVADO con límites mínimos');
      emitChanged();
      return finish(true, []);
    },

    deactivate: async () => {
      const mode = modeRow();
      if (mode.estado === 'activo' || mode.estado === 'suspendido') {
        const at = isoNow();
        const derived = evaluate();
        deps.store.setMode({
          estado: derived.checklist.allComplete && limitsRow() !== null ? 'listo' : 'bloqueado',
          motivo: null,
          detalle: null,
          activadoEn: mode.activado_en,
          suspendidoEn: null,
          actualizadoEn: at,
        });
        journal({
          type: 'resumen',
          result: 'completado',
          reason: 'Modo real desactivado por el usuario; la app vuelve a paper.',
        });
        logger.info('[live] modo real desactivado; vuelta a paper');
        emitChanged();
      }
      return service.getState();
    },

    testKillSwitch: () => {
      const killSwitch = deps.killSwitch;
      if (killSwitch === undefined) {
        return {
          ok: false,
          error: 'El servicio de parada de emergencia no está disponible.',
          testedAt: null,
        };
      }
      if (killSwitch.getState().active) {
        return {
          ok: false,
          error: 'La parada ya está activa; reanúdala desde «Riesgo» antes de probar.',
          testedAt: null,
        };
      }
      if (modeRow().estado === 'activo') {
        return {
          ok: false,
          error: 'No se prueba la parada con el modo real activo.',
          testedAt: null,
        };
      }
      try {
        killSwitch.activate('manual', 'usuario', 'Prueba desde «Dinero real»');
        killSwitch.resume({ confirm: true, note: 'Prueba desde «Dinero real»' });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        journal({
          type: 'limite',
          result: 'error',
          reason: 'La prueba de la parada de emergencia falló.',
          errors: [message],
        });
        return { ok: false, error: message, testedAt: null };
      }
      const testedAt = isoNow();
      deps.evidence.update({ killSwitchTestedAt: testedAt });
      journal({
        type: 'limite',
        result: 'completado',
        reason: 'Parada de emergencia probada: se activó y se reanudó correctamente.',
        ruleChecks: [
          {
            code: 'KILL_SWITCH_TEST',
            label: 'La parada activa y reanuda',
            cumplida: true,
            observed: testedAt,
            limit: null,
          },
        ],
      });
      evaluate();
      emitChanged();
      return { ok: true, error: null, testedAt };
    },

    suspend: (reason, detail) => {
      const mode = modeRow();
      if (mode.estado !== 'activo') return;
      const at = isoNow();
      deps.store.setMode({
        estado: 'suspendido',
        motivo: reason,
        detalle: detail,
        activadoEn: mode.activado_en,
        suspendidoEn: at,
        actualizadoEn: at,
      });
      journal({
        type: 'limite',
        result: 'alcanzado',
        reason: `Modo real suspendido: ${SUSPENSION_LABELS[reason]}. ${detail}`,
        dataUsed: { motivo: reason, detalle: detail },
      });
      deps.notify?.({
        level: 'critica',
        title: 'Tradia ha suspendido el dinero real',
        body: `${SUSPENSION_LABELS[reason]}. No se enviarán órdenes reales nuevas. Abre «Dinero real» para revisarlo.`,
        navigateTo: 'dinero-real',
      });
      logger.warn(`[live] modo real suspendido (${reason}: ${detail})`);
      emitChanged();
    },

    handleRiskChanged: (payload) => {
      const overview = payload as RiskOverview | null | undefined;
      if (
        overview !== null &&
        typeof overview === 'object' &&
        overview.killSwitch?.active === true
      ) {
        service.suspend(
          'parada-emergencia',
          `causa: ${overview.killSwitch.cause ?? 'desconocida'}`,
        );
      }
    },

    handleConnectivityChange: (payload) => {
      const state = payload as ConnectivityState | null | undefined;
      if (state !== null && typeof state === 'object' && state.status === 'offline') {
        service.suspend('sin-conexion', 'conectividad perdida');
      }
    },

    seedProgress: (request = {}) => {
      const patch: Record<string, unknown> = {};
      if (request.paperMonths !== undefined) {
        patch.paperDays = Math.round(request.paperMonths * 30.4375);
      }
      if (request.paperTrades !== undefined) patch.paperTrades = request.paperTrades;
      if (request.deviationPct !== undefined) patch.deviationPct = request.deviationPct;
      if (request.paperShortTrades !== undefined) {
        patch.paperShortTrades = request.paperShortTrades;
      }
      if (request.paperShortWeeks !== undefined) {
        patch.paperShortWeeks = request.paperShortWeeks;
      }
      if (request.finalTestDone !== undefined) {
        patch.finalTestDoneAt = request.finalTestDone ? isoNow() : null;
      }
      if (request.killSwitchTested !== undefined) {
        patch.killSwitchTestedAt = request.killSwitchTested ? isoNow() : null;
      }
      if (request.alertsTested !== undefined) {
        patch.alertTestedAt = request.alertsTested ? isoNow() : null;
        patch.alertChannel = request.alertsTested ? 'simulado' : null;
      }
      deps.evidence.update(patch);
      return evaluate().checklist;
    },
  };

  return service;
}
