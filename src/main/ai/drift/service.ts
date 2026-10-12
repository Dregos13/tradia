/**
 * Servicio de detección de degradación — fase 6 (núcleo testeable).
 *
 * Revisa tres frentes en la rutina diaria (gancho `routine.onPostMarket`
 * del cableado, o manual con `evaluate()`):
 *
 * - Drift de datos (`datos`, diario, sobre el modelo): PSI por variable
 *   de las últimas `sampleSessions` sesiones de cada activo del
 *   seguimiento frente a la distribución de referencia de la ficha.
 *   Alerta cuando ≥ DRIFT_PSI_MIN_FEATURES variables superan
 *   DRIFT_PSI_THRESHOLD; degrada el modelo solo si la alerta se sostiene
 *   DRIFT_SUSTAIN_SESSIONS revisiones seguidas.
 * - Drift de resultados (`resultados`, diario, sobre el modelo): Brier
 *   móvil de las últimas DRIFT_BRIER_WINDOW predicciones resueltas
 *   frente al Brier fuera de muestra de la ficha. Alerta con ventana
 *   completa y `delta > DRIFT_BRIER_DELTA`; misma persistencia.
 * - Rendimiento de estrategias (`rendimiento`, mensual): operaciones
 *   paper cerradas frente a la expectativa del backtest. Alerta con ≥
 *   DEGRADE_MIN_TRADES operaciones y |desviación| > DEGRADE_DEVIATION_PCT;
 *   degrada la ficha solo tras DEGRADE_MIN_CONSECUTIVE_REVIEWS revisiones
 *   mensuales seguidas en alerta. Una racha perdedora aislada —aunque
 *   supere el máximo del backtest— queda en observación y nunca degrada.
 *   Una revisión solo cuenta como mensual si ha pasado un mes real
 *   (≥ DEGRADE_MIN_REVIEW_GAP_DAYS días) o si ve operaciones nuevas: dos
 *   revisiones a un día de distancia a caballo de fin de mes con las
 *   mismas operaciones no son dos meses de evidencia (`sinMesReal`).
 *
 * Una degradación es irreversible hasta el reentrenamiento: deja el
 * motivo en la ficha (`model_cards.motivo_no_apto` para el modelo;
 * `strategy_changelog` para la estrategia vía `setStatus`), una entrada
 * 'limite' en el Diario, una notificación crítica y como mucho una
 * propuesta por trimestre natural (UNIQUE `trimestre`). La app nunca
 * reentrena: la propuesta la aprueba o pospone el usuario y el pipeline
 * corre fuera, en `ml/`.
 */
import {
  DEGRADE_DEVIATION_PCT,
  DEGRADE_MIN_CONSECUTIVE_REVIEWS,
  DEGRADE_MIN_REVIEW_GAP_DAYS,
  DEGRADE_MIN_TRADES,
  DRIFT_BRIER_DELTA,
  DRIFT_BRIER_WINDOW,
  DRIFT_PSI_MIN_FEATURES,
  DRIFT_PSI_THRESHOLD,
  DRIFT_SUSTAIN_SESSIONS,
  dataDriftSince,
  driftPsiKey,
  featurePsiOverThresholdSince,
  resultsDriftSince,
  type DataDriftSummary,
  type DriftCheck,
  type DriftCheckKind,
  type ModelCard,
  type ModelHealthOverview,
  type ModelHealthRow,
  type ModelHealthState,
  type ResultsDriftSummary,
  type RetrainProposal,
  type RetrainResolveRequest,
  type RetrainResolveResult,
  type SimulateDriftRequest,
  type StrategyDriftSummary,
} from '../../../shared/ai';
import type { NotificationPayload } from '../../../shared/ipc';
import { IPC_CHANNELS } from '../../../shared/ipc';
import type { JournalRecordInput } from '../../../shared/journal';
import type { SetStrategyStatusRequest, StrategySummary } from '../../../shared/strategy';
import { nySessionDate } from '../../market/calendar';
import type { ClosedTrade, StrategyExpectation } from '../../broker/deviation';
import {
  FEATURE_NAMES,
  featureRowAt,
  precomputeFeatures,
  type PredictionCandle,
} from '../prediction/features';
import { computePsi } from './psi';
import { quarterOf, type DriftRepository } from './repository';

/** Prefijo del motivo con el que la ficha del modelo queda marcada como degradada. */
export const MODEL_DEGRADED_MARK = 'Degradada por drift sostenido';

/** Sesiones recientes por activo que alimentan la muestra del PSI. */
const DEFAULT_SAMPLE_SESSIONS = DRIFT_SUSTAIN_SESSIONS;

const DAY_MS = 86_400_000;

/** Estados de ficha que la revisión mensual evalúa (las que operan). */
const EVALUABLE_STRATEGY_STATUSES = ['activa', 'paper'] as const;

/** Datos que usaría el pipeline al aprobarse una propuesta. */
const PROPOSAL_DATA_SCOPE =
  'Velas limpias exportadas de la app (ml/export_candles.py → ml/data/velas.csv); ' +
  'origen real y corte temporal 60/20/20 del pipeline.';

/** Pasos del pipeline externo que se entregan al aprobar una propuesta. */
export const RETRAIN_INSTRUCTIONS = [
  'Reentrenamiento fuera de la app (pipeline ml/):',
  '1. Exporta las velas limpias de la app:',
  '     .venv-ml/bin/python ml/export_candles.py --out ml/data/velas.csv',
  '2. Entrena con origen real y una versión nueva:',
  '     .venv-ml/bin/python ml/train.py --data ml/data/velas.csv --origin real --version <nueva>',
  '3. Revisa resources/models/<nueva>/model-card.json: la ficha solo queda',
  '   apta con origen real y Brier OOS mejor que el de referencia.',
  '4. Actívala actualizando resources/models/current.json a <nueva> y',
  '   reiniciando la app.',
  'La nueva versión no se activa sola ni sustituye la validación fuera de muestra.',
].join('\n');

export class DriftServiceError extends Error {
  readonly code: 'not-found' | 'invalid-input';

  constructor(code: 'not-found' | 'invalid-input', message: string) {
    super(message);
    this.name = 'DriftServiceError';
    this.code = code;
  }
}

export interface DriftServiceDeps {
  repo: DriftRepository;
  /** Tickers del seguimiento (muestra del PSI). */
  listWatchlistTickers(): string[];
  /** Serie ajustada completa del ticker (misma fuente que predicción). */
  barsFor(ticker: string): PredictionCandle[];
  /** Fichas de la biblioteca (estado, métricas resumen). */
  listStrategies(): StrategySummary[];
  /** Cambio de estado de una ficha (escribe el registro de cambios). */
  setStrategyStatus(request: SetStrategyStatusRequest): unknown;
  /** Operaciones paper cerradas (patitas emparejadas de broker_orders). */
  closedTrades(): ClosedTrade[];
  /** Expectativa del último backtest por estrategia (ver broker/deviation). */
  expectationFor(strategyId: number): StrategyExpectation;
  /** Entrada del Diario automático (`services.journal.record`). */
  recordJournal?(input: JournalRecordInput): void;
  /** Notificación nativa (`services.notifications.notify`). */
  notify?(payload: NotificationPayload): void;
  /** `ctx.broadcast` perezoso para `ai:changed` ('salud'). */
  broadcast?(channel: string, payload: unknown): void;
  /** false pausa la revisión (sin conexión no cambia estados). */
  isOnline?(): boolean;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
  /** Sesiones por activo en la muestra del PSI; def. DRIFT_SUSTAIN_SESSIONS. */
  sampleSessions?: number;
  logger?: Partial<{ warn(m: string): void; error(m: string): void }>;
}

export interface DriftService {
  /**
   * Revisión de la rutina diaria: a lo sumo una 'datos' y una
   * 'resultados' por día civil de Nueva York y una 'rendimiento' por
   * mes y estrategia. Devuelve las revisiones persistidas ([] en pausa
   * por falta de conexión o sin novedad).
   */
  evaluate(): DriftCheck[];
  /** Salud de modelos (`ai:health`): revisa lo pendiente y devuelve la vista. */
  health(): ModelHealthOverview;
  /** Solo la vista persistida, sin evaluar (uso interno y pruebas). */
  overview(): ModelHealthOverview;
  /** Historial de propuestas (`ai:retrain-proposals`). */
  proposals(): RetrainProposal[];
  /** Resuelve una propuesta pendiente (`ai:resolve-retrain`). */
  resolve(request: RetrainResolveRequest): RetrainResolveResult;
  /**
   * Gancho E2E `ai:simulate-drift`: inyecta revisiones sintéticas con la
   * persistencia pedida y aplica la misma transición que la evaluación.
   */
  simulateDrift(request: SimulateDriftRequest): ModelHealthOverview;
}

const detailNumber = (detail: DriftCheck['detail'], key: string): number | null => {
  const value = detail[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

const fmtPct = (value: number): string =>
  `${value < 0 ? '−' : '+'}${Math.abs(value).toFixed(1).replace('.', ',')} %`;

const modelName = (card: ModelCard): string => `Modelo de dirección y volatilidad v${card.version}`;

const isCardMarked = (card: ModelCard): boolean =>
  card.ineligibleReason !== null && card.ineligibleReason.startsWith(MODEL_DEGRADED_MARK);

export function createDriftService(deps: DriftServiceDeps): DriftService {
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger ?? console;
  const sampleSessions = deps.sampleSessions ?? DEFAULT_SAMPLE_SESSIONS;

  const isoNow = (): string => new Date(now()).toISOString();

  const recordJournal = (input: JournalRecordInput): void => {
    try {
      deps.recordJournal?.(input);
    } catch (error: unknown) {
      logger.warn?.(`[ai/drift] no se pudo escribir en el diario: ${String(error)}`);
    }
  };

  const notify = (payload: NotificationPayload): void => {
    try {
      deps.notify?.(payload);
    } catch (error: unknown) {
      logger.warn?.(`[ai/drift] no se pudo notificar: ${String(error)}`);
    }
  };

  const emitChanged = (): void => {
    try {
      deps.broadcast?.(IPC_CHANNELS.ai.changed, { kind: 'salud', at: isoNow() });
    } catch (error: unknown) {
      logger.warn?.(`[ai/drift] no se pudo difundir ai:changed: ${String(error)}`);
    }
  };

  // -- Propuestas de reentrenamiento ------------------------------------------

  const proposeRetrain = (
    input: { modelCardId: number | null; strategyId: number | null; reason: string },
    evaluatedAt: string,
  ): RetrainProposal | null => {
    const { proposal, inserted } = deps.repo.createProposal({
      modelCardId: input.modelCardId,
      strategyId: input.strategyId,
      quarter: quarterOf(nySessionDate(Date.parse(evaluatedAt))),
      reason: input.reason,
      dataScope: PROPOSAL_DATA_SCOPE,
      createdAt: evaluatedAt,
    });
    return inserted ? proposal : null;
  };

  // -- Transición a degradada ------------------------------------------------

  /**
   * Marca el modelo como degradado (una sola vez por ficha): ficha +
   * Diario + notificación crítica + propuesta del trimestre. La marca es
   * la única fuente para no repetir los efectos en revisiones siguientes.
   */
  const degradeModel = (card: ModelCard, check: DriftCheck, reason: string): void => {
    if (isCardMarked(card)) return;
    deps.repo.markModelCardDegraded(card.id, `${MODEL_DEGRADED_MARK}: ${reason}`);
    recordJournal({
      type: 'limite',
      result: 'alcanzado',
      reason: `${modelName(card)} queda degradado. ${reason}`,
      dataUsed: {
        componente: 'ai/drift',
        tipo: check.kind,
        revisionId: check.id,
        persistencia: check.streak,
        detalle: check.detail,
      },
      ruleChecks: [
        {
          code: 'DRIFT_SUSTAIN',
          label: 'Drift sostenido del modelo',
          cumplida: false,
          observed: `${check.streak} revisiones consecutivas en alerta`,
          limit:
            check.kind === 'datos'
              ? `PSI > ${DRIFT_PSI_THRESHOLD} en ≥ ${DRIFT_PSI_MIN_FEATURES} variables durante ${DRIFT_SUSTAIN_SESSIONS} sesiones`
              : `Brier móvil +${DRIFT_BRIER_DELTA} sobre la ficha durante ${DRIFT_SUSTAIN_SESSIONS} sesiones`,
        },
      ],
    });
    notify({
      level: 'critica',
      title: 'Modelo degradado por drift sostenido',
      body: `${reason} Revisa «Salud de modelos».`,
      navigateTo: 'salud-modelos',
    });
    proposeRetrain({ modelCardId: card.id, strategyId: null, reason }, check.evaluatedAt);
    emitChanged();
  };

  const degradeStrategy = (
    ficha: StrategySummary,
    check: DriftCheck,
    deviationPct: number,
    trades: number,
  ): void => {
    const reason =
      `Desviación ${fmtPct(deviationPct)} fuera del ±${DEGRADE_DEVIATION_PCT} % del backtest ` +
      `en ${check.streak} revisiones mensuales con ${trades} operaciones.`;
    deps.setStrategyStatus({
      id: ficha.id,
      status: 'degradada',
      note: `Degradada por drift sostenido: ${reason}`,
    });
    recordJournal({
      type: 'limite',
      result: 'alcanzado',
      strategies: [{ strategyId: ficha.id, name: ficha.name, version: ficha.version }],
      reason: `«${ficha.name}» pasa a «degradada»: ${reason}`,
      dataUsed: {
        componente: 'ai/drift',
        revisionId: check.id,
        operaciones: trades,
        desviacionPct: deviationPct,
        persistencia: check.streak,
      },
      ruleChecks: [
        {
          code: 'STRATEGY_DEVIATION_PERSISTENT',
          label: 'Desviación frente al backtest sostenida',
          cumplida: false,
          observed: `${fmtPct(deviationPct)} en ${check.streak} revisiones mensuales`,
          limit: `±${DEGRADE_DEVIATION_PCT} % durante ${DEGRADE_MIN_CONSECUTIVE_REVIEWS} revisiones con ≥ ${DEGRADE_MIN_TRADES} operaciones`,
        },
      ],
    });
    notify({
      level: 'critica',
      title: `Estrategia degradada · ${ficha.name}`,
      body: `${reason} Sale de la evaluación de señales; revisa «Salud de modelos».`,
      navigateTo: 'salud-modelos',
    });
    const card = deps.repo.latestModelCard();
    proposeRetrain(
      { modelCardId: card?.id ?? null, strategyId: ficha.id, reason },
      check.evaluatedAt,
    );
    emitChanged();
  };

  // -- Revisiones del modelo ---------------------------------------------------

  /**
   * Muestra del PSI: las últimas `sampleSessions` filas de variables
   * válidas por cada activo del seguimiento, en columnas por nombre.
   * `newestDataDate` es la vela más reciente vista: la persistencia solo
   * avanza cuando llegan sesiones nuevas, no con cada revisión diaria.
   */
  const featureSample = (
    card: ModelCard,
  ): { values: Map<string, number[]>; rows: number; newestDataDate: string | null } => {
    const indexByName = new Map<string, number>();
    for (const ref of card.referenceDistribution) {
      const index = FEATURE_NAMES.indexOf(ref.name as (typeof FEATURE_NAMES)[number]);
      if (index >= 0) indexByName.set(ref.name, index);
    }
    const values = new Map<string, number[]>([...indexByName.keys()].map((name) => [name, []]));
    let rows = 0;
    let newestDataDate: string | null = null;
    for (const ticker of deps.listWatchlistTickers()) {
      const candles = deps.barsFor(ticker);
      if (candles.length === 0) continue;
      const lastDate = candles[candles.length - 1]!.date;
      if (newestDataDate === null || lastDate > newestDataDate) newestDataDate = lastDate;
      const series = precomputeFeatures(candles);
      const start = Math.max(0, candles.length - sampleSessions);
      for (let t = start; t < candles.length; t++) {
        const row = featureRowAt(series, candles, t);
        if (row === null) continue;
        rows += 1;
        for (const [name, index] of indexByName) {
          const value = row[index]!;
          if (Number.isFinite(value)) values.get(name)!.push(value);
        }
      }
    }
    return { values, rows, newestDataDate };
  };

  const evaluateDataDrift = (card: ModelCard, evaluatedAt: string): DriftCheck | null => {
    if (card.referenceDistribution.length === 0) return null;
    const { values, rows, newestDataDate } = featureSample(card);
    if (rows === 0) return null;

    const detail: Record<string, number | string> = { muestras: rows };
    let overCount = 0;
    const overNames: string[] = [];
    for (const ref of card.referenceDistribution) {
      const sample = values.get(ref.name);
      if (sample === undefined) continue;
      const psi = round4(computePsi(ref.bins, sample));
      detail[driftPsiKey(ref.name)] = psi;
      if (psi > DRIFT_PSI_THRESHOLD) {
        overCount += 1;
        overNames.push(ref.name);
      }
    }
    detail.variablesSobreUmbral = overCount;
    if (newestDataDate !== null) detail.ultimaVela = newestDataDate;

    const drifted = overCount >= DRIFT_PSI_MIN_FEATURES;
    const previous = deps.repo.latestCheck('modelo', card.id, 'datos');
    // La persistencia cuenta sesiones de mercado, no revisiones: con los
    // mismos datos se congela la racha y queda «sin datos nuevos».
    const sameData = previous !== null && previous.detail['ultimaVela'] === newestDataDate;
    if (sameData) detail.sinDatosNuevos = 'si';
    const streak = drifted
      ? sameData
        ? previous!.streak
        : previous?.drifted === true
          ? previous.streak + 1
          : 1
      : 0;
    const check = deps.repo.insertCheck({
      subject: 'modelo',
      subjectId: card.id,
      subjectName: modelName(card),
      kind: 'datos',
      streak,
      detail,
      drifted,
      evaluatedAt,
    });
    if (drifted && streak >= DRIFT_SUSTAIN_SESSIONS) {
      degradeModel(
        card,
        check,
        `Drift de datos sostenido: PSI > ${DRIFT_PSI_THRESHOLD} en ${overNames.join(' y ')} ` +
          `durante ${streak} sesiones.`,
      );
    }
    return check;
  };

  const evaluateResultsDrift = (card: ModelCard, evaluatedAt: string): DriftCheck | null => {
    const briers = deps.repo.resolvedBriers(card.version, DRIFT_BRIER_WINDOW);
    const resolvedCount = deps.repo.resolvedCount(card.version);
    const windowFull = briers.length >= DRIFT_BRIER_WINDOW;
    const rollingBrier =
      briers.length === 0
        ? null
        : round4(briers.reduce((acc, brier) => acc + brier, 0) / briers.length);
    // Sin ventana completa no hay delta comparable con la ficha.
    const delta =
      windowFull && rollingBrier !== null ? round4(rollingBrier - card.metrics.brierOos) : null;

    const detail: Record<string, number | string> = {
      resolvedCount,
      cardBrier: card.metrics.brierOos,
    };
    if (rollingBrier !== null) detail.rollingBrier = rollingBrier;
    if (delta !== null) detail.delta = delta;

    const drifted = delta !== null && delta > DRIFT_BRIER_DELTA;
    const previous = deps.repo.latestCheck('modelo', card.id, 'resultados');
    // Sin predicciones nuevas resueltas la ventana móvil no cambia: la
    // racha se congela en lugar de sumar una sesión fantasma.
    const sameData = previous !== null && previous.detail['resolvedCount'] === resolvedCount;
    if (sameData) detail.sinDatosNuevos = 'si';
    const streak = drifted
      ? sameData
        ? previous!.streak
        : previous?.drifted === true
          ? previous.streak + 1
          : 1
      : 0;
    const check = deps.repo.insertCheck({
      subject: 'modelo',
      subjectId: card.id,
      subjectName: modelName(card),
      kind: 'resultados',
      streak,
      detail,
      drifted,
      evaluatedAt,
    });
    if (drifted && streak >= DRIFT_SUSTAIN_SESSIONS) {
      degradeModel(
        card,
        check,
        `Drift de resultados sostenido: Brier móvil ${rollingBrier} frente a ` +
          `${card.metrics.brierOos} de la ficha (+${delta}) durante ${streak} sesiones.`,
      );
    }
    return check;
  };

  // -- Revisión mensual de estrategias ------------------------------------------

  /**
   * Métricas de rendimiento de una ficha sobre sus operaciones paper
   * cerradas: desviación frente a la expectativa del backtest, racha
   * perdedora actual y fecha NY del último cierre (la huella que dice
   * si una revisión posterior ve operaciones nuevas). La usa la
   * revisión mensual y la vista de Salud, que la devuelve en vivo.
   */
  const strategyMetrics = (ficha: StrategySummary, all?: readonly ClosedTrade[]) => {
    const trades = (all ?? deps.closedTrades()).filter((trade) => trade.strategyId === ficha.id);
    const expectation = deps.expectationFor(ficha.id);
    const realPct = round4(trades.reduce((acc, trade) => acc + trade.returnPct, 0));
    const expectedPct =
      expectation.perTradeReturnPct === null
        ? null
        : round4(expectation.perTradeReturnPct * trades.length);
    const deviationPct = expectedPct === null ? null : round4(realPct - expectedPct);
    let losingStreak = 0;
    for (let i = trades.length - 1; i >= 0 && trades[i]!.returnPct < 0; i -= 1) {
      losingStreak += 1;
    }
    let lastClosedAt: string | null = null;
    for (const trade of trades) {
      if (lastClosedAt === null || trade.closedAtNy > lastClosedAt) {
        lastClosedAt = trade.closedAtNy;
      }
    }
    return { trades, expectation, realPct, expectedPct, deviationPct, losingStreak, lastClosedAt };
  };

  const evaluateStrategy = (
    ficha: StrategySummary,
    evaluatedAt: string,
    month: string,
  ): DriftCheck | null => {
    const previous = deps.repo.latestCheck('estrategia', ficha.id, 'rendimiento');
    if (
      previous !== null &&
      nySessionDate(Date.parse(previous.evaluatedAt)).slice(0, 7) === month
    ) {
      return null; // una revisión mensual por estrategia
    }
    const { trades, realPct, expectedPct, deviationPct, losingStreak, lastClosedAt } =
      strategyMetrics(ficha);

    const detail: Record<string, number | string> = {
      trades: trades.length,
      realPct,
      losingStreak,
      mes: month,
    };
    if (expectedPct !== null) detail.expectedPct = expectedPct;
    if (deviationPct !== null) detail.deviationPct = deviationPct;
    if (lastClosedAt !== null) detail.ultimaOperacionCierre = lastClosedAt;

    const drifted =
      trades.length >= DEGRADE_MIN_TRADES &&
      deviationPct !== null &&
      Math.abs(deviationPct) > DEGRADE_DEVIATION_PCT;
    // Una revisión solo cuenta como «mensual» si ha pasado un mes real
    // (≥ DEGRADE_MIN_REVIEW_GAP_DAYS) o si la segunda ve operaciones
    // nuevas: dos revisiones a un día de distancia a caballo de fin de
    // mes con las mismas operaciones no son dos meses de evidencia y la
    // racha se congela —nunca aumenta— con `sinMesReal`.
    const previousLastClose =
      typeof previous?.detail['ultimaOperacionCierre'] === 'string'
        ? (previous.detail['ultimaOperacionCierre'] as string)
        : null;
    const newTrades =
      previous !== null &&
      (trades.length > (detailNumber(previous.detail, 'trades') ?? 0) ||
        (lastClosedAt !== null &&
          (previousLastClose === null || lastClosedAt > previousLastClose)));
    const reviewCounts =
      previous === null ||
      now() - Date.parse(previous.evaluatedAt) >= DEGRADE_MIN_REVIEW_GAP_DAYS * DAY_MS ||
      newTrades;
    if (!reviewCounts) detail.sinMesReal = 'si';
    const streak = drifted
      ? reviewCounts
        ? previous?.drifted === true
          ? previous.streak + 1
          : 1
        : previous!.streak
      : 0;
    const check = deps.repo.insertCheck({
      subject: 'estrategia',
      subjectId: ficha.id,
      subjectName: `${ficha.name} · v${ficha.version}`,
      kind: 'rendimiento',
      streak,
      detail,
      drifted,
      evaluatedAt,
    });
    if (drifted && streak >= DEGRADE_MIN_CONSECUTIVE_REVIEWS && ficha.status !== 'degradada') {
      degradeStrategy(ficha, check, deviationPct, trades.length);
    }
    return check;
  };

  // -- Evaluación diaria --------------------------------------------------------

  const evaluate = (): DriftCheck[] => {
    if (deps.isOnline?.() === false) return [];
    const evaluatedAt = isoNow();
    const todayNy = nySessionDate(now());
    const created: DriftCheck[] = [];

    const card = deps.repo.latestModelCard();
    if (card !== null) {
      for (const kind of ['datos', 'resultados'] as const) {
        const last = deps.repo.latestCheck('modelo', card.id, kind);
        if (last !== null && nySessionDate(Date.parse(last.evaluatedAt)) === todayNy) continue;
        const check =
          kind === 'datos'
            ? evaluateDataDrift(card, evaluatedAt)
            : evaluateResultsDrift(card, evaluatedAt);
        if (check !== null) created.push(check);
      }
    }

    const month = todayNy.slice(0, 7);
    for (const ficha of deps.listStrategies()) {
      if (!(EVALUABLE_STRATEGY_STATUSES as readonly string[]).includes(ficha.status)) continue;
      const check = evaluateStrategy(ficha, evaluatedAt, month);
      if (check !== null) created.push(check);
    }
    return created;
  };

  // -- Vista «Salud de modelos» --------------------------------------------------

  const modelRow = (card: ModelCard | null): ModelHealthRow => {
    if (card === null) {
      return {
        subject: 'modelo',
        subjectId: 0,
        name: 'Modelo predictivo',
        state: 'insuficiente',
        dataDrift: null,
        resultsDrift: null,
        strategyEval: null,
        reason: 'Sin ficha de modelo registrada.',
        lastReviewedAt: null,
      };
    }
    const checks = deps.repo.listChecks('modelo', card.id);
    const dataChecks = checks.filter((check) => check.kind === 'datos');
    const resultChecks = checks.filter((check) => check.kind === 'resultados');
    const lastDatos = dataChecks[dataChecks.length - 1] ?? null;
    const lastResult = resultChecks[resultChecks.length - 1] ?? null;

    const dataDrift: DataDriftSummary | null =
      card.referenceDistribution.length === 0
        ? null
        : {
            drifted: lastDatos?.drifted ?? false,
            sessions: lastDatos?.streak ?? 0,
            features: card.referenceDistribution.map((ref) => {
              const psi = detailNumber(lastDatos?.detail ?? {}, driftPsiKey(ref.name)) ?? 0;
              const overThreshold = psi > DRIFT_PSI_THRESHOLD;
              return {
                name: ref.name,
                psi,
                overThreshold,
                overThresholdSince: overThreshold
                  ? featurePsiOverThresholdSince(checks, ref.name)
                  : null,
              };
            }),
            driftedFeatures: lastDatos
              ? card.referenceDistribution.filter(
                  (ref) =>
                    (detailNumber(lastDatos.detail, driftPsiKey(ref.name)) ?? 0) >
                    DRIFT_PSI_THRESHOLD,
                ).length
              : 0,
            driftSince: dataDriftSince(checks),
          };

    // El Brier móvil y la desviación se calculan en vivo (como
    // resolvedCount): la revisión diaria guardada solo gobierna la
    // alerta y la persistencia, no la métrica que se muestra. Con la
    // referencia disponible los números siempre llegan; el null queda
    // para cuando de verdad falta, y entonces `missingReason` dice por
    // qué.
    const briers = deps.repo.resolvedBriers(card.version, DRIFT_BRIER_WINDOW);
    const resolvedCount = deps.repo.resolvedCount(card.version);
    const rollingBrier =
      briers.length === 0
        ? null
        : round4(briers.reduce((acc, brier) => acc + brier, 0) / briers.length);
    const delta =
      rollingBrier !== null && briers.length >= DRIFT_BRIER_WINDOW
        ? round4(rollingBrier - card.metrics.brierOos)
        : null;
    const resultsDrift: ResultsDriftSummary = {
      drifted: lastResult?.drifted ?? false,
      resolvedCount: Math.min(resolvedCount, DRIFT_BRIER_WINDOW),
      rollingBrier,
      cardBrier: card.metrics.brierOos,
      delta,
      driftSince: resultsDriftSince(checks),
      missingReason:
        rollingBrier === null
          ? 'Todavía no hay predicciones resueltas del modelo.'
          : delta === null
            ? `Ventana incompleta: ${briers.length} de ${DRIFT_BRIER_WINDOW} ` +
              'predicciones resueltas; la diferencia con la ficha llega con la ventana llena.'
            : null,
    };

    let state: ModelHealthState;
    let reason: string | null = null;
    if (isCardMarked(card)) {
      state = 'degradada';
      const mark = (card.ineligibleReason ?? '').replace(/[\s.:]+$/u, '');
      reason = `${mark}. No se debe a una sola racha perdedora.`;
    } else if (lastDatos?.drifted === true || lastResult?.drifted === true) {
      state = 'observacion';
      reason =
        lastDatos?.drifted === true
          ? `Drift de datos en vigilancia: ${lastDatos.streak} de ${DRIFT_SUSTAIN_SESSIONS} sesiones.`
          : `Drift de resultados en vigilancia: ${lastResult!.streak} de ${DRIFT_SUSTAIN_SESSIONS} sesiones.`;
    } else if (resolvedCount === 0 || (dataChecks.length === 0 && resultChecks.length === 0)) {
      // Sin una sola predicción resuelta (o sin revisiones) no hay
      // evidencia para llamar al modelo saludable: «Sin datos
      // suficientes», igual que las estrategias sin muestra.
      state = 'insuficiente';
      reason =
        resolvedCount < DRIFT_BRIER_WINDOW
          ? `Aún no hay ${DRIFT_BRIER_WINDOW} predicciones resueltas.`
          : 'Sin revisiones todavía.';
    } else {
      state = 'saludable';
    }

    const reviewed = [lastDatos?.evaluatedAt, lastResult?.evaluatedAt]
      .filter((at): at is string => typeof at === 'string')
      .sort();
    return {
      subject: 'modelo',
      subjectId: card.id,
      name: modelName(card),
      state,
      dataDrift,
      resultsDrift,
      strategyEval: null,
      reason,
      lastReviewedAt: reviewed[reviewed.length - 1] ?? null,
    };
  };

  const strategyRow = (
    ficha: StrategySummary,
    allTrades: readonly ClosedTrade[],
  ): ModelHealthRow => {
    const last = deps.repo.latestCheck('estrategia', ficha.id, 'rendimiento');
    // Operaciones, desviación y racha van en vivo (la revisión mensual
    // solo gobierna la persistencia): la desviación es número siempre
    // que haya backtest de referencia, y cuando falta `missingReason`
    // lo dice.
    const live = strategyMetrics(ficha, allTrades);
    // En una ficha degradada la fila cuenta la evidencia que la degradó
    // —los números de la última revisión, los mismos de la propuesta—:
    // la muestra en vivo puede haber cambiado (o no tener backtest de
    // referencia) y contradeciría el motivo de la degradación.
    const degraded = ficha.status === 'degradada';
    const storedTrades = degraded ? detailNumber(last?.detail ?? {}, 'trades') : null;
    const storedDeviation = degraded ? detailNumber(last?.detail ?? {}, 'deviationPct') : null;
    const deviationPct = degraded && storedDeviation !== null ? storedDeviation : live.deviationPct;
    const backtestMax = ficha.metricsSummary?.maxLosingStreak ?? null;
    const strategyEval: StrategyDriftSummary = {
      trades: degraded && storedTrades !== null ? storedTrades : live.trades.length,
      deviationPct,
      consecutiveReviews: last?.streak ?? 0,
      losingStreak: live.losingStreak,
      maxLosingStreakBacktest: backtestMax,
      missingReason:
        deviationPct === null
          ? 'Sin backtest de referencia: no hay expectativa con la que comparar la desviación.'
          : null,
    };

    let state: ModelHealthState;
    let reason: string | null = null;
    if (ficha.status === 'degradada') {
      state = 'degradada';
      reason = 'Drift sostenido. No se debe a una sola racha perdedora.';
    } else if (last === null || strategyEval.trades < DEGRADE_MIN_TRADES) {
      state = 'insuficiente';
      reason =
        last === null
          ? 'Sin revisiones todavía.'
          : `Sin muestra suficiente: ${strategyEval.trades} de ${DEGRADE_MIN_TRADES} operaciones.`;
    } else if (last.drifted) {
      state = 'observacion';
      reason =
        `Desviación ${strategyEval.deviationPct !== null ? fmtPct(strategyEval.deviationPct) : ''} ` +
        `fuera del ±${DEGRADE_DEVIATION_PCT} % en la última revisión mensual ` +
        `(${last.streak} de ${DEGRADE_MIN_CONSECUTIVE_REVIEWS}).`;
    } else if ((strategyEval.losingStreak ?? 0) >= 3) {
      state = 'observacion';
      const streak = strategyEval.losingStreak!;
      reason =
        backtestMax !== null
          ? `En observación · racha de ${streak} pérdidas ${
              streak <= backtestMax
                ? `dentro del máximo de backtest (${backtestMax})`
                : `que supera el máximo de backtest (${backtestMax})`
            }. No degrada la estrategia.`
          : `En observación · racha de ${streak} pérdidas sin referencia de backtest. No degrada la estrategia.`;
    } else {
      state = 'saludable';
    }

    return {
      subject: 'estrategia',
      subjectId: ficha.id,
      name: `${ficha.name} · v${ficha.version}`,
      state,
      dataDrift: null,
      resultsDrift: null,
      strategyEval,
      reason,
      lastReviewedAt: last?.evaluatedAt ?? null,
    };
  };

  const overview = (): ModelHealthOverview => {
    const allTrades = deps.closedTrades();
    const subjects: ModelHealthRow[] = [
      modelRow(deps.repo.latestModelCard()),
      ...deps.listStrategies().map((ficha) => strategyRow(ficha, allTrades)),
    ];
    const counts: Record<ModelHealthState, number> = {
      saludable: 0,
      observacion: 0,
      degradada: 0,
      insuficiente: 0,
    };
    for (const row of subjects) counts[row.state] += 1;
    return {
      subjects,
      counts,
      proposals: deps.repo.listProposals(),
      evaluatedAt: deps.repo.latestEvaluatedAt(),
    };
  };

  // -- Simulador de drift (E2E y pruebas) --------------------------------------

  const isoDaysAgo = (days: number): string => new Date(now() - days * DAY_MS).toISOString();

  const simulatedDataChecks = (card: ModelCard, streak: number): DriftCheck => {
    // Siempre al menos DRIFT_PSI_MIN_FEATURES variables sobre el umbral:
    // si la ficha tiene menos variables de referencia se añaden claves
    // sintéticas (psi:sim_N) para que la revisión cuente como alerta.
    const overNames = card.referenceDistribution
      .slice(0, DRIFT_PSI_MIN_FEATURES)
      .map((ref) => ref.name);
    while (overNames.length < DRIFT_PSI_MIN_FEATURES) {
      overNames.push(`sim_${overNames.length}`);
    }
    let last: DriftCheck | null = null;
    for (let i = streak; i >= 1; i -= 1) {
      const detail: Record<string, number | string> = { muestras: 20, simulado: 1 };
      for (const ref of card.referenceDistribution) {
        detail[driftPsiKey(ref.name)] = overNames.includes(ref.name)
          ? DRIFT_PSI_THRESHOLD + 0.05
          : 0.05;
      }
      for (const name of overNames) {
        if (!(driftPsiKey(name) in detail)) detail[driftPsiKey(name)] = DRIFT_PSI_THRESHOLD + 0.05;
      }
      detail.variablesSobreUmbral = overNames.length;
      last = deps.repo.insertCheck({
        subject: 'modelo',
        subjectId: card.id,
        subjectName: modelName(card),
        kind: 'datos',
        streak: streak - i + 1,
        detail,
        drifted: true,
        evaluatedAt: isoDaysAgo(i - 1),
      });
    }
    return last!;
  };

  const simulatedResultsChecks = (card: ModelCard, streak: number): DriftCheck => {
    const delta = DRIFT_BRIER_DELTA + 0.03;
    let last: DriftCheck | null = null;
    for (let i = streak; i >= 1; i -= 1) {
      last = deps.repo.insertCheck({
        subject: 'modelo',
        subjectId: card.id,
        subjectName: modelName(card),
        kind: 'resultados',
        streak: streak - i + 1,
        detail: {
          rollingBrier: round4(card.metrics.brierOos + delta),
          cardBrier: card.metrics.brierOos,
          delta,
          resolvedCount: DRIFT_BRIER_WINDOW,
          simulado: 1,
        },
        drifted: true,
        evaluatedAt: isoDaysAgo(i - 1),
      });
    }
    return last!;
  };

  const simulatedStrategyChecks = (ficha: StrategySummary, streak: number): DriftCheck => {
    let last: DriftCheck | null = null;
    for (let i = streak; i >= 1; i -= 1) {
      const at = isoDaysAgo((i - 1) * 31);
      last = deps.repo.insertCheck({
        subject: 'estrategia',
        subjectId: ficha.id,
        subjectName: `${ficha.name} · v${ficha.version}`,
        kind: 'rendimiento',
        streak: streak - i + 1,
        detail: {
          trades: DEGRADE_MIN_TRADES + 4,
          expectedPct: 8,
          realPct: -28,
          deviationPct: -36,
          losingStreak: 2,
          mes: nySessionDate(Date.parse(at)).slice(0, 7),
          simulado: 1,
        },
        drifted: true,
        evaluatedAt: at,
      });
    }
    return last!;
  };

  const simulateDrift = (request: SimulateDriftRequest): ModelHealthOverview => {
    const kind: DriftCheckKind = request.kind;
    if (kind === 'rendimiento') {
      const fichas = deps.listStrategies();
      const ficha =
        fichas.find((f) => f.id === request.subjectId) ??
        fichas.find((f) => (EVALUABLE_STRATEGY_STATUSES as readonly string[]).includes(f.status)) ??
        fichas[0];
      if (ficha === undefined) {
        throw new DriftServiceError('not-found', 'no hay estrategias para simular');
      }
      const streak = request.streak ?? DEGRADE_MIN_CONSECUTIVE_REVIEWS;
      const last = simulatedStrategyChecks(ficha, streak);
      if (streak >= DEGRADE_MIN_CONSECUTIVE_REVIEWS && ficha.status !== 'degradada') {
        degradeStrategy(ficha, last, -36, DEGRADE_MIN_TRADES + 4);
      }
      emitChanged();
      return overview();
    }

    const card = deps.repo.latestModelCard();
    if (card === null) {
      throw new DriftServiceError('not-found', 'no hay ficha de modelo para simular');
    }
    const streak = request.streak ?? DRIFT_SUSTAIN_SESSIONS;
    const last =
      kind === 'datos' ? simulatedDataChecks(card, streak) : simulatedResultsChecks(card, streak);
    if (streak >= DRIFT_SUSTAIN_SESSIONS && !isCardMarked(card)) {
      degradeModel(
        card,
        last,
        kind === 'datos'
          ? `Drift de datos simulado sostenido durante ${streak} sesiones.`
          : `Drift de resultados simulado sostenido durante ${streak} sesiones.`,
      );
    }
    emitChanged();
    return overview();
  };

  return {
    evaluate,
    health: () => {
      evaluate();
      return overview();
    },
    overview,
    proposals: () => deps.repo.listProposals(),
    resolve: (request) => {
      const proposal = deps.repo.getProposal(request.id);
      if (proposal === null || proposal.status !== 'pendiente') {
        throw new DriftServiceError(
          'not-found',
          `no hay una propuesta pendiente con id ${request.id}`,
        );
      }
      if (request.action === 'posponer') {
        const until = request.postponeUntil;
        if (until === undefined || until <= nySessionDate(now())) {
          throw new DriftServiceError(
            'invalid-input',
            'posponer exige una fecha futura (postponeUntil)',
          );
        }
      }
      const resolved = deps.repo.resolveProposal(request.id, {
        status: request.action === 'aprobar' ? 'aprobada' : 'pospuesta',
        note: request.note?.trim() ? request.note.trim() : null,
        postponedUntil: request.action === 'posponer' ? request.postponeUntil! : null,
        resolvedAt: isoNow(),
      });
      if (resolved === null) {
        throw new DriftServiceError(
          'not-found',
          `no hay una propuesta pendiente con id ${request.id}`,
        );
      }
      if (request.action === 'aprobar') {
        recordJournal({
          type: 'resumen',
          result: 'completado',
          reason:
            `Propuesta de reentrenamiento ${resolved.quarter} aprobada: ` +
            'el pipeline ml/ corre fuera de la app.',
          dataUsed: {
            componente: 'ai/drift',
            propuestaId: resolved.id,
            trimestre: resolved.quarter,
          },
        });
      } else {
        const note = resolved.note?.replace(/[\s.]+$/, '');
        recordJournal({
          type: 'resumen',
          result: 'completado',
          reason:
            `Propuesta de reentrenamiento ${resolved.quarter} pospuesta hasta ` +
            `${resolved.postponedUntil}` +
            (note ? `. Motivo: ${note}` : '') +
            '.',
          dataUsed: {
            componente: 'ai/drift',
            propuestaId: resolved.id,
            trimestre: resolved.quarter,
            pospuestaHasta: resolved.postponedUntil,
          },
        });
      }
      emitChanged();
      return {
        proposal: resolved,
        instructions: request.action === 'aprobar' ? RETRAIN_INSTRUCTIONS : null,
      };
    },
    simulateDrift,
  };
}
