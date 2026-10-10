/**
 * Dominio de IA predictiva (fase 6) — contrato compartido.
 *
 * Régimen de mercado en dos ejes, predicción probabilística con ficha del
 * modelo, análisis de noticias por activo, detección de degradación y
 * propuestas de reentrenamiento. Reglas fijas del dominio (supuestos del
 * plan de fase y docs/diseno-fase-6-7.md):
 *
 * - La IA nunca crea una señal por sí sola: solo confirma o rebaja la
 *   confianza de las que ya generan las estrategias, y toda señal pasa por
 *   la pasarela del motor de riesgo (`risk:submit-signal`).
 * - Una noticia sin verificar nunca se analiza para señales ni dispara
 *   nada por sí sola.
 * - El modelo solo participa en señales si es apto: origen de datos real
 *   y Brier fuera de muestra mejor que el de referencia.
 * - La app nunca reentrena sola: como mucho una propuesta por trimestre
 *   natural y el reentrenamiento corre fuera, en `ml/`.
 *
 * Persistencia: migración 011 (`regimes`, `model_cards`, `predictions`,
 * `news_analysis`, `drift_checks`, `retrain_proposals`). Los literales de
 * aquí son los valores de los CHECK de la base.
 */

import type { StrategyPeriod, StrategyStatus } from './strategy';

// ---------------------------------------------------------------------------
// Régimen de mercado: dos ejes, cuatro etiquetas
// ---------------------------------------------------------------------------

/** Eje de dirección: tendencia si ADX(14) > 25 con pendiente de la SMA50. */
export const REGIME_DIRECTION_LABELS = ['tendencia', 'lateral'] as const;
export type RegimeDirectionLabel = (typeof REGIME_DIRECTION_LABELS)[number];

/** Eje de volatilidad: alta si la realizada de 20 sesiones supera su mediana de 252. */
export const REGIME_VOLATILITY_LABELS = ['volatilidad-alta', 'volatilidad-baja'] as const;
export type RegimeVolatilityLabel = (typeof REGIME_VOLATILITY_LABELS)[number];

/** Las cuatro etiquetas: una de cada eje por activo y por el mercado. */
export const REGIME_LABELS = [...REGIME_DIRECTION_LABELS, ...REGIME_VOLATILITY_LABELS] as const;
export type RegimeLabel = (typeof REGIME_LABELS)[number];

/** Ámbito de una lectura de régimen: un activo o el mercado (referencia SPY). */
export const REGIME_SCOPES = ['activo', 'mercado'] as const;
export type RegimeScope = (typeof REGIME_SCOPES)[number];

/** Ticker de referencia del régimen «de mercado». */
export const REGIME_MARKET_TICKER = 'SPY';

// Umbrales del clasificador (supuestos del plan): ADX(14) > 25 con
// pendiente de la SMA50 ≠ 0 da 'tendencia'; la volatilidad realizada de
// 20 sesiones por encima de su mediana de 252 da 'volatilidad-alta'.
export const REGIME_ADX_PERIOD = 14;
export const REGIME_ADX_TREND_THRESHOLD = 25;
export const REGIME_SMA_PERIOD = 50;
export const REGIME_VOL_WINDOW = 20;
export const REGIME_VOL_MEDIAN_WINDOW = 252;

/** Medidas con las que se calculó la etiqueta (solo datos hasta el cierre). */
export interface RegimeMetrics {
  /** ADX(14) del cierre evaluado; null si no había serie suficiente. */
  adx: number | null;
  /** Pendiente de la SMA50 (variación por sesión); null sin datos. */
  smaSlope: number | null;
  /** Volatilidad realizada de 20 sesiones; null sin datos. */
  realizedVolatility: number | null;
  /** Mediana de la volatilidad realizada en 252 sesiones; null sin datos. */
  volatilityMedian: number | null;
}

/**
 * Etiqueta de régimen de un activo o del mercado al cierre de una sesión
 * (fila de `regimes`). Siempre hay una etiqueta de cada eje: los dos ejes
 * se evalúan por separado y nunca pueden quedar vacíos.
 */
export interface RegimeSnapshot {
  scope: RegimeScope;
  /** Ticker del activo; en el mercado, el de referencia (REGIME_MARKET_TICKER). */
  ticker: string;
  /** Sesión del cierre evaluado ('YYYY-MM-DD'). */
  sessionDate: string;
  direction: RegimeDirectionLabel;
  volatility: RegimeVolatilityLabel;
  metrics: RegimeMetrics;
  /** Dirección anterior y sesión en que cambió; null en la primera lectura. */
  previousChange: { direction: RegimeDirectionLabel; sessionDate: string } | null;
  /** Cálculo (ISO 8601). */
  computedAt: string;
}

/** Estado de una estrategia frente al régimen vigente (página «IA»). */
export const STRATEGY_REGIME_STATES = ['habilitada', 'desactivada', 'degradada'] as const;
export type StrategyRegimeState = (typeof STRATEGY_REGIME_STATES)[number];

/**
 * Resolución de una estrategia según su ficha: desactivada si alguna
 * etiqueta vigente está en `failsIn`, o si `worksIn` no está vacío y no
 * contiene ninguna etiqueta vigente. 'degradada' tiene prioridad sobre
 * ambas (el drift sostenido manda, ver salud de modelos).
 */
export interface StrategyRegimeStatus {
  strategyId: number;
  name: string;
  /** Versión vigente evaluada. */
  version: number;
  /** Estado de ciclo de vida de la ficha. */
  status: StrategyStatus;
  regimeState: StrategyRegimeState;
  worksIn: RegimeLabel[];
  failsIn: RegimeLabel[];
  /** Motivo legible ('Solo funciona en Lateral; el régimen actual es Tendencia.'). */
  reason: string;
}

/** Vista del régimen para la página «IA»: mercado, activos y estrategias. */
export interface RegimeOverview {
  /** Régimen del mercado (referencia SPY); null hasta el primer cálculo. */
  market: RegimeSnapshot | null;
  /** Régimen por activo de la lista de seguimiento. */
  assets: RegimeSnapshot[];
  /** Estrategias habilitadas o desactivadas por el régimen vigente. */
  strategies: StrategyRegimeStatus[];
  /** Instante de la instantánea (ISO 8601). */
  computedAt: string | null;
}

// ---------------------------------------------------------------------------
// Predicción probabilística y ficha del modelo
// ---------------------------------------------------------------------------

/** Horizonte del modelo: probabilidad de subida a N sesiones. */
export const PREDICTION_HORIZON_DAYS = 5;
/** Umbral de confianza combinada: por debajo no se opera (diario: 'confianza baja'). */
export const SIGNAL_MIN_CONFIDENCE = 0.55;
/**
 * Ajuste máximo del sentimiento de noticias confirmadas sobre la confianza
 * combinada de una señal (± este tanto por uno): un sentimiento medio
 * totalmente alineado mueve la confianza un 15 %; neutro/mixto lo diluye.
 */
export const SIGNAL_NEWS_SENTIMENT_ADJUST = 0.15;

/** Origen de los datos de entrenamiento; 'sintetico' nunca es apto para señales. */
export const MODEL_DATA_ORIGINS = ['real', 'sintetico'] as const;
export type ModelDataOrigin = (typeof MODEL_DATA_ORIGINS)[number];

/** Un tramo temporal de la ficha ('YYYY-MM-DD', ambos inclusive). */
export type ModelPeriod = StrategyPeriod;

/**
 * Un bin del diagrama de calibración fuera de muestra: probabilidad media
 * estimada frente a frecuencia observada, con el número de casos.
 */
export interface CalibrationBin {
  /** Extremos del intervalo de probabilidad estimada (0–1). */
  from: number;
  to: number;
  meanPredicted: number;
  observed: number;
  count: number;
}

/** Un bin del histograma de referencia de una variable (para el PSI). */
export interface FeatureReferenceBin {
  /** Extremos del intervalo; null representa −∞/∞ en los extremos. */
  from: number | null;
  to: number | null;
  /** Proporción de la muestra de referencia en el bin (suma ≈ 1). */
  proportion: number;
}

/** Distribución de referencia de una variable del modelo (sobre el entrenamiento). */
export interface FeatureReference {
  /** Nombre de la variable, tal como la espera el modelo ('ret_5', 'rsi_14'…). */
  name: string;
  mean: number | null;
  std: number | null;
  bins: FeatureReferenceBin[];
}

/** Métricas fuera de muestra de la ficha, calculadas sobre la prueba final. */
export interface ModelCardMetrics {
  /** Brier fuera de muestra del modelo calibrado (0 = perfecto). */
  brierOos: number;
  /** Log loss fuera de muestra; null si el pipeline no la reportó. */
  logLossOos: number | null;
  /** Brier de referencia (climatología/base rate); el modelo debe mejorarlo. */
  brierBaseline: number;
}

/**
 * Ficha del modelo (model-card.json persistida en `model_cards`). Es lo
 * que ve la página «IA» y lo que valida el servicio antes de usar el
 * modelo en señales: apto = origen 'real' y Brier OOS mejor que la
 * referencia; si no, el modelo solo informa y queda marcado.
 */
export interface ModelCard {
  id: number;
  /** Versión semver del pipeline de ml/ (p. ej. '0.1.0'). */
  version: string;
  /** SHA-256 del archivo .onnx servido. */
  hash: string;
  /** Horizonte de la predicción en sesiones. */
  horizonDays: number;
  /** Periodos del corte temporal 60/20/20: entrenamiento, calibración y prueba. */
  trainingPeriod: ModelPeriod;
  calibrationPeriod: ModelPeriod;
  testPeriod: ModelPeriod;
  /** Origen de los datos de entrenamiento ('real' o 'sintetico'). */
  dataOrigin: ModelDataOrigin;
  metrics: ModelCardMetrics;
  /** Bins del diagrama de calibración fuera de muestra. */
  calibration: CalibrationBin[];
  /** Distribución de referencia de cada variable del modelo (para el PSI). */
  referenceDistribution: FeatureReference[];
  /** Aptitud para señales: la calcula el servicio al registrar la ficha. */
  eligible: boolean;
  /** Motivo legible cuando no es apto ('Datos sintéticos · no apto'). */
  ineligibleReason: string | null;
  /** Entrenamiento del modelo (ISO 8601). */
  trainedAt: string;
  /** Registro de la ficha en la app (ISO 8601). */
  registeredAt: string;
}

/** true si la ficha puede apoyar señales: datos reales y Brier OOS mejor que la referencia. */
export function isModelEligible(card: Pick<ModelCard, 'dataOrigin' | 'metrics'>): boolean {
  return card.dataOrigin === 'real' && card.metrics.brierOos < card.metrics.brierBaseline;
}

/**
 * Predicción guardada (`predictions`): probabilidad calibrada de subida a
 * `horizonDays` sesiones y volatilidad esperada, con versión y hash del
 * modelo para poder medirla al resolverla a t+N.
 */
export interface Prediction {
  id: number;
  ticker: string;
  /** Sesión del cierre evaluado ('YYYY-MM-DD'). */
  sessionDate: string;
  horizonDays: number;
  /** Probabilidad calibrada de subida (0–1). */
  probUp: number;
  /** Probabilidad de bajada: el complemento 1 − probUp. */
  probDown: number;
  /** Volatilidad esperada a N sesiones (tanto por uno); null si no aplica. */
  expectedVolatility: number | null;
  modelVersion: string;
  modelHash: string;
  /** Ficha del modelo usada; null si ya no consta. */
  modelCardId: number | null;
  createdAt: string;
  // Resolución a t+N (null hasta que llega la vela del horizonte).
  /** Sesión en que se resolvió ('YYYY-MM-DD'); null si sigue pendiente. */
  resolvedSession: string | null;
  /** Resultado real: subió el cierre a t+N (1) o no (0); null sin resolver. */
  outcomeUp: boolean | null;
  /** Brier de esta predicción una vez resuelta; null sin resolver. */
  realizedBrier: number | null;
}

/** Filtros de `ai:predictions`; todos opcionales y combinables. */
export interface PredictionsQuery {
  ticker?: string;
  /** Máximo de resultados; tope `PREDICTIONS_MAX_LIMIT`. */
  limit?: number;
}

export const PREDICTIONS_MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Análisis de noticias por activo
// ---------------------------------------------------------------------------

/** Sentimiento por activo de un titular confirmado. */
export const NEWS_SENTIMENTS = ['positivo', 'negativo', 'neutro', 'mixto'] as const;
export type NewsSentiment = (typeof NEWS_SENTIMENTS)[number];

/** Quién produjo el análisis: el LLM remoto o el clasificador léxico local. */
export const NEWS_ANALYZERS = ['llm', 'local'] as const;
export type NewsAnalyzer = (typeof NEWS_ANALYZERS)[number];

/**
 * Análisis de una noticia confirmada para un activo (`news_analysis`, una
 * fila por noticia × activo). Solo existe para titulares confirmados; un
 * análisis nunca crea una señal: como mucho ajusta la confianza de una
 * señal que ya generaron las estrategias.
 */
export interface NewsAnalysis {
  id: number;
  /** Titular analizado (`news_items.id`). */
  newsItemId: number;
  /** Activo al que se refiere el sentimiento. */
  ticker: string;
  /** Resumen de dos frases como máximo, atribuido al sistema. */
  summary: string;
  sentiment: NewsSentiment;
  analyzer: NewsAnalyzer;
  /** Modelo LLM que lo produjo; null en 'local'. */
  model: string | null;
  /** Instantáneo del análisis (ISO 8601). */
  analyzedAt: string;
}

/** Filtros de `ai:news-analysis`; todos opcionales y combinables. */
export interface NewsAnalysisQuery {
  newsItemId?: number;
  ticker?: string;
  limit?: number;
}

export const NEWS_ANALYSIS_MAX_LIMIT = 200;

// — Ajustes del LLM (Ajustes · «Análisis de noticias con LLM») -----------

/** Modelo fijo del análisis LLM (API Anthropic Messages). */
export const NEWS_LLM_MODEL = 'claude-haiku-4-5-20251001';
/** Proveedor del almacén `secrets` donde vive la clave de Anthropic. */
export const NEWS_LLM_SECRET_PROVIDER = 'news-llm-anthropic';
/** Tope diario de titulares analizados por defecto. */
export const NEWS_LLM_DAILY_CAP_DEFAULT = 200;
/** Márgenes del tope diario y del presupuesto mensual en euros. */
export const NEWS_LLM_DAILY_CAP_BOUNDS = { min: 1, max: 2_000 } as const;
export const NEWS_LLM_MONTHLY_BUDGET_BOUNDS = { min: 0, max: 30 } as const;

/**
 * Ajustes del análisis LLM (`ai:get-llm-settings`). Nunca incluye la
 * clave: `hasKey` solo dice si hay una guardada cifrada en `secrets`.
 */
export interface NewsLlmSettings {
  /** Interruptor «Usar LLM para titulares confirmados» (apagado por defecto). */
  enabled: boolean;
  /** Máximo de titulares analizados por día con el LLM. */
  dailyCap: number;
  /** Tope mensual de gasto en euros (0 = sin gasto autorizado). */
  monthlyBudgetEur: number;
  /** Hay una clave de Anthropic guardada cifrada. */
  hasKey: boolean;
  /** Titulares analizados hoy por el LLM. */
  usedToday: number;
  /** Gasto estimado del mes en euros. */
  spentThisMonthEur: number;
}

/** Entrada de `ai:set-llm-settings`; cada campo es opcional. */
export interface NewsLlmSettingsInput {
  enabled?: boolean;
  dailyCap?: number;
  monthlyBudgetEur?: number;
}

/** Resultado de `ai:test-llm` (prueba de conexión; nunca devuelve la clave). */
export interface NewsLlmTestResult {
  ok: boolean;
  error: string | null;
  latencyMs: number | null;
}

// ---------------------------------------------------------------------------
// Contexto de IA que guarda cada señal
// ---------------------------------------------------------------------------

/**
 * Datos de IA con los que se evaluó una señal (bloque `ai` opcional de
 * `SignalDataUsed`). La predicción y las noticias solo pueden confirmar o
 * rebajar la confianza: nunca crean la señal ni evitan el motor de riesgo.
 * Con la integración activa el bloque viaja siempre y lo que no participó
 * queda a null; solo falta en señales de fases anteriores.
 */
export interface SignalAiContext {
  /**
   * Etiquetas del régimen de referencia consultado (el del mercado, la
   * misma referencia que usa la habilitación por régimen de la página
   * «IA» y del backtest con filtro); null si aún no hay régimen calculado.
   */
  regime: { direction: RegimeDirectionLabel; volatility: RegimeVolatilityLabel } | null;
  /** Probabilidad calibrada de subida usada (0–1); null sin modelo apto. */
  probability: number | null;
  /** Horizonte de la probabilidad en sesiones; null sin modelo apto. */
  horizonDays: number | null;
  /** Versión y hash del modelo que ajustó la confianza; null sin modelo apto. */
  modelVersion: string | null;
  modelHash: string | null;
  /** Titulares (`news_items.id`) cuyo sentimiento influyó en la confianza. */
  newsItemIds: number[];
}

// ---------------------------------------------------------------------------
// Drift, salud de modelos y reentrenamiento controlado
// ---------------------------------------------------------------------------

// Umbrales de degradación (supuestos del plan): PSI > 0,25 en al menos 2
// variables durante 20 sesiones; Brier móvil de las últimas 60 predicciones
// resueltas que empeore la ficha en más de 0,02; y para una estrategia, al
// menos 30 operaciones con desviación superior al ±30 % del backtest que
// persista en dos revisiones mensuales seguidas. Una racha mala aislada no
// degrada nada por sí sola.
export const DRIFT_PSI_THRESHOLD = 0.25;
export const DRIFT_PSI_MIN_FEATURES = 2;
export const DRIFT_SUSTAIN_SESSIONS = 20;
export const DRIFT_BRIER_WINDOW = 60;
export const DRIFT_BRIER_DELTA = 0.02;
export const DEGRADE_MIN_TRADES = 30;
export const DEGRADE_DEVIATION_PCT = 30;
export const DEGRADE_MIN_CONSECUTIVE_REVIEWS = 2;

/** Qué se evalúa: el modelo (drift de datos/resultados) o una estrategia. */
export const DRIFT_SUBJECTS = ['modelo', 'estrategia'] as const;
export type DriftSubject = (typeof DRIFT_SUBJECTS)[number];

/** Clase de revisión guardada en `drift_checks`. */
export const DRIFT_CHECK_KINDS = ['datos', 'resultados', 'rendimiento'] as const;
export type DriftCheckKind = (typeof DRIFT_CHECK_KINDS)[number];

/**
 * Una revisión de drift persistida (`drift_checks`). 'datos' y
 * 'resultados' se aplican al modelo; 'rendimiento' a una estrategia
 * (operaciones y desviación frente al backtest).
 */
export interface DriftCheck {
  id: number;
  subject: DriftSubject;
  /** `model_cards.id` o `strategies.id`; null si el sujeto ya no existe. */
  subjectId: number | null;
  /** Versión del modelo o nombre de la estrategia en el momento de la revisión. */
  subjectName: string;
  kind: DriftCheckKind;
  /** Sesiones o revisiones consecutivas en alerta hasta esta evaluación. */
  streak: number;
  /**
   * Métricas de la revisión. Convención de claves: en 'datos', el PSI de
   * cada variable como 'psi:<nombre>' ('psi:ret_5'…, ver `driftPsiKey`);
   * en 'resultados', 'rollingBrier', 'cardBrier' y 'delta' (móvil −
   * ficha); en 'rendimiento', 'trades', 'deviationPct' y 'losingStreak'.
   * De aquí salen las fechas de inicio del drift (`driftStreakSince` y
   * cía.): una revisión sin el dato numérico no sostiene la racha.
   */
  detail: Record<string, number | string>;
  drifted: boolean;
  evaluatedAt: string;
}

/** PSI de una variable frente a su distribución de referencia. */
export interface FeaturePsi {
  name: string;
  psi: number;
  /** true si supera DRIFT_PSI_THRESHOLD. */
  overThreshold: boolean;
  /**
   * Inicio (ISO 8601) de la racha actual de esta variable sobre
   * DRIFT_PSI_THRESHOLD: el `evaluatedAt` de la primera revisión 'datos'
   * de la racha en `drift_checks`; null si la última revisión no la
   * supera. Lo rellena el proceso principal con
   * `featurePsiOverThresholdSince`; el renderer nunca lo deduce.
   */
  overThresholdSince: string | null;
}

/** Estados de la tabla «Salud de modelos». */
export const MODEL_HEALTH_STATES = [
  'saludable',
  'observacion',
  'degradada',
  'insuficiente',
] as const;
export type ModelHealthState = (typeof MODEL_HEALTH_STATES)[number];

/** Drift de datos de un sujeto (solo el modelo): PSI por variable. */
export interface DataDriftSummary {
  drifted: boolean;
  /** Sesiones consecutivas sobre el umbral. */
  sessions: number;
  /** Variables evaluadas en la última revisión. */
  features: FeaturePsi[];
  /** Variables por encima del umbral en la última revisión. */
  driftedFeatures: number;
  /**
   * Inicio (ISO 8601) de la racha actual con al menos
   * DRIFT_PSI_MIN_FEATURES variables sobre el umbral en la misma
   * revisión: el `evaluatedAt` de su primera revisión 'datos'; null si
   * la última no la cumple. Lo rellena el proceso principal con
   * `dataDriftSince`.
   */
  driftSince: string | null;
}

/** Drift de resultados (solo el modelo): Brier móvil frente a la ficha. */
export interface ResultsDriftSummary {
  drifted: boolean;
  /** Predicciones resueltas disponibles (hasta DRIFT_BRIER_WINDOW). */
  resolvedCount: number;
  rollingBrier: number | null;
  cardBrier: number | null;
  /** Diferencia móvil − ficha; null hasta tener la ventana completa. */
  delta: number | null;
  /**
   * Inicio (ISO 8601) de la racha actual con `delta` por encima de
   * DRIFT_BRIER_DELTA: el `evaluatedAt` de su primera revisión
   * 'resultados'; null si la última no lo supera. Lo rellena el proceso
   * principal con `resultsDriftSince`.
   */
  driftSince: string | null;
}

// — Fechas de inicio del drift (las calcula el proceso principal) -------

/**
 * Clave de `DriftCheck.detail` con el PSI de una variable en una
 * revisión 'datos' ('psi:ret_5', 'psi:vol_20'…).
 */
export const driftPsiKey = (feature: string): string => `psi:${feature}`;

const detailNumber = (value: number | string | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/**
 * `evaluatedAt` de la primera revisión de la racha actual que cumple
 * `isAlert`, con el historial recorrido en orden cronológico y solo del
 * `kind` indicado. Una revisión que no la cumple reinicia la racha: si
 * la última no está en alerta el resultado es null.
 */
function driftStreakSince(
  checks: readonly DriftCheck[],
  kind: DriftCheckKind,
  isAlert: (detail: DriftCheck['detail']) => boolean,
): string | null {
  let since: string | null = null;
  const ordered = checks
    .filter((check) => check.kind === kind)
    .sort((a, b) => a.evaluatedAt.localeCompare(b.evaluatedAt));
  for (const check of ordered) {
    since = isAlert(check.detail) ? (since ?? check.evaluatedAt) : null;
  }
  return since;
}

/**
 * Inicio de la racha actual de `feature` sobre DRIFT_PSI_THRESHOLD: el
 * `evaluatedAt` de la primera revisión 'datos' de la racha, o null si la
 * última no la supera. `checks` es el historial de `drift_checks` del
 * sujeto (cualquier orden; se ignoran los demás tipos). Una revisión sin
 * 'psi:<feature>' numérico no sostiene la racha. El proceso principal lo
 * usa para rellenar `FeaturePsi.overThresholdSince`.
 */
export function featurePsiOverThresholdSince(
  checks: readonly DriftCheck[],
  feature: string,
): string | null {
  const key = driftPsiKey(feature);
  return driftStreakSince(
    checks,
    'datos',
    (detail) => (detailNumber(detail[key]) ?? -Infinity) > DRIFT_PSI_THRESHOLD,
  );
}

/**
 * Inicio de la racha actual con al menos DRIFT_PSI_MIN_FEATURES
 * variables sobre el umbral en la misma revisión 'datos'. El proceso
 * principal lo usa para rellenar `DataDriftSummary.driftSince`.
 */
export function dataDriftSince(checks: readonly DriftCheck[]): string | null {
  return driftStreakSince(checks, 'datos', (detail) => {
    let over = 0;
    for (const [key, value] of Object.entries(detail)) {
      const psi = key.startsWith('psi:') ? detailNumber(value) : null;
      if (psi !== null && psi > DRIFT_PSI_THRESHOLD) over += 1;
    }
    return over >= DRIFT_PSI_MIN_FEATURES;
  });
}

/**
 * Inicio de la racha actual con 'delta' (Brier móvil − ficha) por encima
 * de DRIFT_BRIER_DELTA en revisiones 'resultados'. El proceso principal
 * lo usa para rellenar `ResultsDriftSummary.driftSince`.
 */
export function resultsDriftSince(checks: readonly DriftCheck[]): string | null {
  return driftStreakSince(
    checks,
    'resultados',
    (detail) => (detailNumber(detail['delta']) ?? -Infinity) > DRIFT_BRIER_DELTA,
  );
}

/** Evaluación de degradación de una estrategia (rendimiento paper/real). */
export interface StrategyDriftSummary {
  /** Operaciones contabilizadas en la evaluación. */
  trades: number;
  /** Desviación frente al backtest en puntos porcentuales; null sin base. */
  deviationPct: number | null;
  /** Revisiones mensuales seguidas fuera del ±30 %. */
  consecutiveReviews: number;
  /** Racha perdedora actual (contexto; nunca degrada por sí sola). */
  losingStreak: number | null;
  /** Racha perdedora máxima del backtest; null si no hay referencia. */
  maxLosingStreakBacktest: number | null;
}

/**
 * Una fila de la tabla «Salud de modelos»: el modelo o una estrategia,
 * con el resumen de cada evaluación. `state` es 'degradada' solo si la
 * degradación está marcada en la ficha; 'insuficiente' cuando aún no hay
 * muestra evaluable.
 */
export interface ModelHealthRow {
  subject: DriftSubject;
  subjectId: number;
  name: string;
  state: ModelHealthState;
  dataDrift: DataDriftSummary | null;
  resultsDrift: ResultsDriftSummary | null;
  strategyEval: StrategyDriftSummary | null;
  /** Motivo legible del estado ('Drift sostenido…'); null en 'saludable'. */
  reason: string | null;
  /** Última revisión evaluada (ISO 8601); null si nunca se revisó. */
  lastReviewedAt: string | null;
}

/** Propuestas de reentrenamiento controlado. */
export const RETRAIN_PROPOSAL_STATUSES = ['pendiente', 'aprobada', 'pospuesta'] as const;
export type RetrainProposalStatus = (typeof RETRAIN_PROPOSAL_STATUSES)[number];

/** Acciones de `ai:resolve-retrain` sobre una propuesta pendiente. */
export const RETRAIN_ACTIONS = ['aprobar', 'posponer'] as const;
export type RetrainAction = (typeof RETRAIN_ACTIONS)[number];

/**
 * Propuesta de reentrenamiento (`retrain_proposals`): como mucho una por
 * trimestre natural (`quarter` 'YYYY-Qn', UNIQUE en la base). La app nunca
 * reentrena sola: el usuario aprueba (y el trabajo corre en `ml/`, fuera
 * de la app) o pospone con fecha y motivo.
 */
export interface RetrainProposal {
  id: number;
  /** Ficha del modelo a reentrenar; null si ya no existe. */
  modelCardId: number | null;
  /** Estrategia cuya degradación motivó la propuesta; null si fue el drift del modelo. */
  strategyId: number | null;
  /** Trimestre natural de la propuesta ('YYYY-Qn'). */
  quarter: string;
  /** Motivo legible ('Drift de datos sostenido en ret_5 y vol_20…'). */
  reason: string;
  /** Datos que usaría el pipeline al aprobarse (descripción legible). */
  dataScope: string | null;
  /** Último reentrenamiento conocido (ISO 8601); null si nunca. */
  lastTrainedAt: string | null;
  /** Primera fecha en que podría proponerse otro ('YYYY-MM-DD'). */
  nextAllowedAt: string | null;
  status: RetrainProposalStatus;
  /** Nota del usuario al aprobar o posponer; null sin resolver. */
  note: string | null;
  /** Fecha hasta la que se pospuso ('YYYY-MM-DD'); null en otro estado. */
  postponedUntil: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** Petición de `ai:resolve-retrain` sobre una propuesta pendiente. */
export interface RetrainResolveRequest {
  id: number;
  action: RetrainAction;
  /** Hasta qué fecha se pospone ('YYYY-MM-DD'); obligatoria con 'posponer'. */
  postponeUntil?: string;
  /** Nota del usuario que queda registrada en la propuesta. */
  note?: string;
}

/** Respuesta de `ai:resolve-retrain`: la propuesta resuelta y, al aprobar, las instrucciones. */
export interface RetrainResolveResult {
  proposal: RetrainProposal;
  /**
   * Instrucciones del pipeline de `ml/` (reentrenar con datos reales,
   * verificar la ficha antes de activar). Solo al aprobar; null al posponer.
   */
  instructions: string | null;
}

/** Vista de la página «Salud de modelos» (`ai:health`). */
export interface ModelHealthOverview {
  subjects: ModelHealthRow[];
  /** Recuento por estado para el resumen («1 degradada · 2 en observación»). */
  counts: Record<ModelHealthState, number>;
  /** Propuestas (pendientes primero, después el historial reciente). */
  proposals: RetrainProposal[];
  /** Instante de la última revisión evaluada (ISO 8601); null si nunca. */
  evaluatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Comparación de backtest con y sin filtro de régimen
// ---------------------------------------------------------------------------

/** Métricas de un lado de la comparación (mismo periodo, universo y costes). */
export interface RegimeComparisonSide {
  /** Ejecución guardada (`backtest_runs.id`); null si ese lado aún no se corrió. */
  runId: number | null;
  totalReturnPct: number | null;
  maxDrawdownPct: number | null;
  sharpe: number | null;
  trades: number;
  winRatePct: number | null;
}

/**
 * Comparación emparejada con y sin filtro de régimen de una versión de la
 * ficha (`regime_comparisons`). Solo es `comparable` cuando ambos lados
 * corrieron sobre el mismo periodo, universo y costes.
 */
export interface RegimeComparison {
  strategyId: number;
  version: number;
  /** Periodo común de la comparación ('YYYY-MM-DD', ambos inclusive). */
  period: ModelPeriod;
  /** Universo evaluado en ambos lados. */
  markets: string[];
  withoutFilter: RegimeComparisonSide;
  withFilter: RegimeComparisonSide;
  /** false si los dos lados no usaron la misma base (no se muestran diferencias). */
  comparable: boolean;
  createdAt: string;
}

/** Petición de `backtest:regime-comparison` y `backtest:run-regime-comparison`. */
export interface RegimeComparisonRequest {
  strategyId: number;
  /** Versión concreta; por defecto la vigente. */
  version?: number;
}

// ---------------------------------------------------------------------------
// Eventos y ganchos E2E (solo TRADIA_E2E y sin empaquetar)
// ---------------------------------------------------------------------------

/** Qué cambió en el dominio de IA (payload de `ai:changed`). */
export const AI_CHANGED_KINDS = ['regimen', 'prediccion', 'noticias', 'salud'] as const;
export type AiChangedKind = (typeof AI_CHANGED_KINDS)[number];

export interface AiChangedEvent {
  kind: AiChangedKind;
  /** Instante del cambio (ISO 8601). */
  at: string;
}

/**
 * Gancho `ai:simulate-regime`: fija el régimen de un activo o del mercado
 * para la sesión dada (o la última), como si el clasificador lo hubiera
 * calculado, y emite `ai:changed`.
 */
export interface SimulateRegimeRequest {
  /** 'mercado' fija la referencia SPY; 'activo' exige `ticker`. */
  scope?: RegimeScope;
  ticker?: string;
  /** Etiqueta a fijar en cada eje; al menos una de las dos. */
  direction?: RegimeDirectionLabel;
  volatility?: RegimeVolatilityLabel;
  /** Sesión afectada ('YYYY-MM-DD'); por defecto la última calculada. */
  sessionDate?: string;
}

/**
 * Gancho `ai:simulate-drift`: inyecta una revisión de drift sostenida
 * (desplaza variables para 'datos', el Brier móvil para 'resultados' o la
 * desviación de una estrategia para 'rendimiento') con la persistencia
 * indicada, y devuelve la salud resultante.
 */
export interface SimulateDriftRequest {
  kind: DriftCheckKind;
  /** Sujeto al que aplicar el drift; por defecto el modelo vigente o, en
   * 'rendimiento', la primera estrategia activa. */
  subjectId?: number;
  /** Sesiones o revisiones consecutivas simuladas (persistencia del drift). */
  streak?: number;
}
