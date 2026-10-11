/**
 * Servicio de predicción ONNX — fase 6 (núcleo testeable).
 *
 * Sirve el bundle de `resources/models/<version>/` con exactamente las
 * mismas variables y la misma calibración que el entrenamiento (paridad
 * 1e-6 con `parity-fixture.json`), y mide lo que predice:
 *
 * - Al guardarse velas de un activo (`handleBarStored`, mismo disparo
 *   que el régimen) calcula las variables sobre la historia completa —
 *   EMA/RSI/ATR arrastran semilla—, predice cada sesión pendiente desde
 *   la última ya guardada (incluida, por si la vela llegó corregida) y
 *   persiste cada predicción con versión y hash del modelo.
 * - Después resuelve las predicciones cuya vela `t + horizonte` ya
 *   existe: acierto (subida estricta del cierre, la misma regla que la
 *   etiqueta `y_up` de `ml/`) y Brier realizado. Las ya resueltas se
 *   re-verifican por si una vela posterior se corrigió.
 * - Si el modelo no carga (fichero ausente, JSON inválido, hash que no
 *   coincide, ficha inconsistente o runtime nativo indisponible) el
 *   servicio degrada: no predice pero sigue resolviendo lo pendiente y
 *   respondiendo al IPC, y lo notifica en el estado del sistema
 *   (`data_status` → `data-status:changed`) y en el Diario.
 * - La aptitud para señales la fija la regla de `isModelEligible`
 *   (origen real y Brier OOS mejor que la referencia), recalculada al
 *   registrar la ficha en `model_cards`.
 */
import { IPC_CHANNELS, type DataStatusState, type MarketUpdatedEvent } from '../../../shared/ipc';
import type { ModelCard, Prediction, PredictionsQuery } from '../../../shared/ai';
import type { JournalRecordInput } from '../../../shared/journal';
import {
  FEATURE_COUNT,
  precomputeFeatures,
  featureRowAt,
  FIRST_FEATURE_INDEX,
  type PredictionCandle,
} from './features';
import { ModelLoadError, type PredictionModel } from './model';
import { parseModelCard } from './modelCard';
import type { PredictionsRepository } from './repository';

export interface PredictionServiceLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Estado del servicio de predicción para diagnóstico y pruebas. */
export interface PredictionServiceStatus {
  /** 'cargando' durante el arranque; 'degradado' sin modelo servible. */
  state: 'cargando' | 'listo' | 'degradado';
  /** Motivo legible de la degradación; null cuando el modelo sirve. */
  reason: string | null;
  /** Versión del modelo cargado; null si ninguno. */
  version: string | null;
  /** La ficha del modelo vigente quedó registrada en `model_cards`. */
  cardRegistered: boolean;
}

export interface PredictionServiceDeps {
  repo: PredictionsRepository;
  /**
   * Serie ajustada completa del ticker (ordenada de antigua a reciente,
   * una sola fuente: la del lote disparador si existe, si no la más
   * reciente del activo — mismo criterio que régimen y señales).
   */
  barsFor(ticker: string, preferSource: string | null): PredictionCandle[];
  /** Tickers del seguimiento (pasada inicial y altas nuevas). */
  listWatchlistTickers(): string[];
  /** Carga el bundle ONNX + pipeline + calibración (rechaza si falla). */
  loadModel(): Promise<PredictionModel>;
  /** JSON crudo de `model-card.json`; lanza si no se puede leer. */
  loadCardJson(): unknown;
  /** Escribe el estado del modelo en el estado del sistema (opcional). */
  reportStatus?(patch: { state: DataStatusState; reason: string | null }): void;
  /** Entrada del Diario automático (`services.journal.record`). */
  recordJournal?(input: JournalRecordInput): void;
  /** `ctx.broadcast` perezoso para `ai:changed`. */
  broadcast(channel: string, payload: unknown): void;
  /**
   * Última sesión esperada según el calendario de mercado ('YYYY-MM-DD'),
   * al instante dado. Guarda de frescura (misma regla que régimen y
   * señales): una serie cuya última vela es anterior a la esperada no
   * genera predicciones nuevas — llega de una puesta al día atrasada y
   * una predicción sobre ella se presentaría como vigente—; sí se
   * resuelven las pendientes con las velas que sí llegaron. Sin la
   * dependencia no se aplica la guarda.
   */
  expectedSessionDate?(nowMs: number): string | null;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
  logger?: Partial<PredictionServiceLogger>;
}

export interface PredictionService {
  /**
   * Resuelve cuando la carga inicial y todo el trabajo encolado han
   * terminado (en pruebas; en la app no se espera a las predicciones).
   */
  ready(): Promise<void>;
  /** Evento «lote guardado»: encola predicción y resolución del ticker. */
  handleBarStored(event: MarketUpdatedEvent): void;
  /** Predice y resuelve todos los tickers del seguimiento. */
  recalculateAll(): Promise<void>;
  /** Predicciones guardadas, más recientes primero (`ai:predictions`). */
  predictions(query?: PredictionsQuery): Prediction[];
  /** Ficha del modelo vigente (`ai:model-card`); null si no hay ninguna. */
  modelCard(): ModelCard | null;
  /** Estado del servicio para diagnóstico. */
  status(): PredictionServiceStatus;
  /** Última predicción guardada del ticker (para señales). */
  latestPrediction(ticker: string): Prediction | null;
  /**
   * Identidad del modelo vigente para señales (`version`, `hash`,
   * `horizonDays`); null si no hay modelo servible o la ficha no es apta.
   */
  eligibleModel(): { version: string; hash: string; horizonDays: number } | null;
  /** Drena la cola y libera las sesiones ONNX. */
  stop(): Promise<void>;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createPredictionService(deps: PredictionServiceDeps): PredictionService {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());
  const isoNow = (): string => new Date(now()).toISOString();

  let model: PredictionModel | null = null;
  let card: ModelCard | null = null;
  let stopped = false;
  const status: PredictionServiceStatus = {
    state: 'cargando',
    reason: null,
    version: null,
    cardRegistered: false,
  };

  const reportStatus = (patch: { state: DataStatusState; reason: string | null }): void => {
    try {
      deps.reportStatus?.(patch);
    } catch (error: unknown) {
      logger.warn?.(
        `[ai/prediction] no se pudo escribir el estado del sistema: ${errorMessage(error)}`,
      );
    }
  };

  const recordJournal = (input: JournalRecordInput): void => {
    try {
      deps.recordJournal?.(input);
    } catch (error: unknown) {
      logger.warn?.(`[ai/prediction] no se pudo escribir en el diario: ${errorMessage(error)}`);
    }
  };

  const emitChanged = (): void => {
    try {
      deps.broadcast(IPC_CHANNELS.ai.changed, { kind: 'prediccion', at: isoNow() });
    } catch (error: unknown) {
      logger.warn?.(`[ai/prediction] no se pudo difundir ai:changed: ${errorMessage(error)}`);
    }
  };

  // -- Carga inicial ----------------------------------------------------------

  const registerCard = (): void => {
    let raw: unknown;
    try {
      raw = deps.loadCardJson();
      card = deps.repo.registerModelCard(parseModelCard(raw));
      status.cardRegistered = true;
    } catch (error: unknown) {
      card = null;
      status.cardRegistered = false;
      logger.error?.(
        `[ai/prediction] la ficha del modelo no se pudo registrar: ${errorMessage(error)}`,
      );
    }
  };

  const loadModel = async (): Promise<void> => {
    try {
      const loaded = await deps.loadModel();
      if (
        card !== null &&
        (card.hash !== loaded.modelHash || card.horizonDays !== loaded.horizonDays)
      ) {
        throw new ModelLoadError(
          'la ficha no coincide con el modelo servido (hash u horizonte distintos)',
        );
      }
      model = loaded;
      status.state = 'listo';
      status.version = loaded.version;
      // El estado del sistema refleja la ficha tal cual: sin ficha o con
      // una no apta («Datos sintéticos · no apto») el modelo sirve pero
      // no puede venderse como fiable ni apoyar señales.
      const cardNote =
        card === null
          ? 'sin ficha registrada; solo se informa'
          : card.eligible
            ? null
            : (card.ineligibleReason ?? 'la ficha no es apta; el modelo no apoya señales');
      status.reason = cardNote;
      reportStatus({
        state: cardNote === null ? 'fiable' : 'desactualizado',
        reason: cardNote,
      });
    } catch (error: unknown) {
      model = null;
      status.state = 'degradado';
      status.reason = errorMessage(error);
      reportStatus({ state: 'no-fiable', reason: `el modelo no se pudo cargar: ${status.reason}` });
      recordJournal({
        type: 'error',
        reason: `El modelo de predicción no se pudo cargar: ${status.reason}`,
        dataUsed: { componente: 'ai/prediction' },
        result: 'error',
      });
    }
  };

  // -- Predicción y resolución --------------------------------------------------

  /**
   * Predice las sesiones pendientes del ticker y las persiste con la
   * versión del modelo. Devuelve true si escribió algo.
   */
  const predictSessions = async (
    serving: PredictionModel,
    ticker: string,
    candles: readonly PredictionCandle[],
  ): Promise<boolean> => {
    const series = precomputeFeatures(candles);
    let start = FIRST_FEATURE_INDEX;
    const last = deps.repo.latestSession(ticker, serving.version);
    if (last !== null) {
      const idx = candles.findIndex((candle) => candle.date === last);
      // Recalcula también la última sesión guardada: la vela pudo llegar
      // corregida (mismo criterio que el régimen). Si ya no está en la
      // serie se repredice desde el inicio definido.
      if (idx >= FIRST_FEATURE_INDEX) start = idx;
    }

    const pending: { session: string; vector: number[] }[] = [];
    for (let t = Math.max(start, 0); t < candles.length; t++) {
      const vector = featureRowAt(series, candles, t);
      if (vector !== null && vector.length === FEATURE_COUNT) {
        pending.push({ session: candles[t]!.date, vector });
      }
    }
    if (pending.length === 0) return false;

    const predictions = await serving.predictBatch(pending.map((item) => item.vector));
    let changed = false;
    pending.forEach((item, index) => {
      const served = predictions[index]!;
      const result = deps.repo.upsertPrediction({
        ticker,
        session: item.session,
        horizonDays: serving.horizonDays,
        probUp: served.probUp,
        expectedVolatility: served.expectedVolatility,
        modelVersion: serving.version,
        modelHash: serving.modelHash,
        modelCardId: card?.id ?? null,
      });
      changed = changed || result.changed;
    });
    return changed;
  };

  /**
   * Resuelve las predicciones del ticker cuya vela `t + horizonte` ya
   * existe, y re-verifica las ya resueltas (una vela corregida dentro
   * del horizonte cambia el acierto). Devuelve true si escribió algo.
   */
  const resolveSessions = (ticker: string, candles: readonly PredictionCandle[]): boolean => {
    const indexByDate = new Map(candles.map((candle, index) => [candle.date, index]));
    const outcomeFor = (
      prediction: Prediction,
    ): { session: string; outcomeUp: boolean; realizedBrier: number } | null => {
      const i = indexByDate.get(prediction.sessionDate);
      if (i === undefined) return null;
      const j = i + prediction.horizonDays;
      const target = candles[j];
      const base = candles[i];
      if (target === undefined || base === undefined) return null;
      const outcomeUp = target.close > base.close;
      const realizedBrier = (prediction.probUp - (outcomeUp ? 1 : 0)) ** 2;
      return { session: target.date, outcomeUp, realizedBrier };
    };

    let changed = false;
    for (const prediction of deps.repo.pendingResolutions(ticker)) {
      const outcome = outcomeFor(prediction);
      if (outcome === null) continue;
      deps.repo.resolvePrediction(prediction.id, outcome);
      changed = true;
    }
    // Re-verificación de las resueltas: una vela corregida en el tramo
    // t..t+N cambia el resultado guardado.
    for (const prediction of deps.repo.resolvedForTicker(ticker)) {
      const outcome = outcomeFor(prediction);
      if (outcome === null) continue;
      if (
        outcome.session !== prediction.resolvedSession ||
        outcome.outcomeUp !== prediction.outcomeUp ||
        outcome.realizedBrier !== prediction.realizedBrier
      ) {
        deps.repo.resolvePrediction(prediction.id, outcome);
        changed = true;
      }
    }
    return changed;
  };

  const recalculateTicker = async (
    rawTicker: string,
    preferSource: string | null,
  ): Promise<void> => {
    const ticker = rawTicker.trim().toUpperCase();
    const candles = deps.barsFor(ticker, preferSource);
    if (candles.length === 0) return;
    let changed = false;
    if (model !== null) {
      // Guarda de frescura: con la serie por detrás de la última sesión
      // esperada no se crean predicciones nuevas (llegarían de una puesta
      // al día atrasada y se presentarían como vigentes). Al ponerse al
      // día, la pasada cubre todas las sesiones pendientes. Las
      // predicciones ya emitidas sí se resuelven con las velas llegadas.
      const expected = deps.expectedSessionDate?.(now()) ?? null;
      const lastCandle = candles[candles.length - 1]!.date;
      if (expected !== null && lastCandle < expected) {
        logger.info?.(
          `[ai/prediction] ${ticker}: última vela ${lastCandle} anterior a la sesión ` +
            `esperada ${expected}; no se predicen sesiones`,
        );
      } else {
        changed = await predictSessions(model, ticker, candles);
      }
    }
    changed = resolveSessions(ticker, candles) || changed;
    if (changed) emitChanged();
  };

  // -- Cola serializada -----------------------------------------------------------

  const init: Promise<void> = (async () => {
    registerCard();
    await loadModel();
  })();
  // La carga inicial no debería rechazar (cada paso degrada por dentro);
  // si lo hace, queda registrado en lugar de un rechazo sin manejar.
  init.catch((error: unknown) => {
    logger.error?.(`[ai/prediction] falló la carga inicial: ${errorMessage(error)}`);
  });

  let tail: Promise<void> = Promise.resolve();
  /** Encola trabajo tras la carga inicial; los errores se registran, nunca se propagan al emisor. */
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    tail = tail.then(async () => {
      if (stopped) return;
      await init;
      if (stopped) return;
      await work();
    });
    tail = tail.catch((error: unknown) => {
      logger.error?.(`[ai/prediction] falló el trabajo encolado: ${errorMessage(error)}`);
    });
    return tail;
  };

  const recalculateAll = (): Promise<void> =>
    enqueue(async () => {
      const tickers = [...new Set(deps.listWatchlistTickers())];
      for (const ticker of tickers) {
        try {
          await recalculateTicker(ticker, null);
        } catch (error: unknown) {
          logger.error?.(`[ai/prediction] falló el recálculo de ${ticker}: ${errorMessage(error)}`);
        }
      }
    });

  // La pasada inicial se encola al crear el servicio: los datos
  // anteriores al servicio no emiten `market:updated`.
  void recalculateAll();

  const service: PredictionService = {
    ready: () => init.then(() => tail).then(() => undefined),

    handleBarStored: (event) => {
      void enqueue(() => recalculateTicker(event.ticker, event.source ?? null));
    },

    recalculateAll,

    predictions: (query) => deps.repo.listPredictions(query ?? {}),

    // La ficha se relee de la base (no la copia en memoria): así la marca
    // de «degradada por drift» que escribe ai/drift se ve al instante en
    // `ai:model-card` y en la aptitud para señales.
    modelCard: () => {
      const fresh = card === null ? null : (deps.repo.modelCard(card.version, card.hash) ?? card);
      return fresh ?? deps.repo.latestModelCard();
    },

    status: () => ({ ...status }),

    latestPrediction: (ticker) => deps.repo.latestPrediction(ticker),

    eligibleModel: () => {
      const fresh = card === null ? null : (deps.repo.modelCard(card.version, card.hash) ?? card);
      return model !== null && fresh !== null && fresh.eligible
        ? { version: model.version, hash: model.modelHash, horizonDays: model.horizonDays }
        : null;
    },

    stop: async () => {
      stopped = true;
      await tail.catch(() => undefined);
      if (model !== null) {
        await model.release().catch(() => undefined);
        model = null;
      }
    },
  };

  return service;
}
