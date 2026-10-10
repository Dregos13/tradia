/**
 * Ficha del modelo (`model-card.json`) — validación y aptitud.
 *
 * El pipeline de `ml/` escribe la ficha con `id: 0` y
 * `registeredAt = trainedAt` como marcadores: el servicio los sustituye
 * al registrarla en `model_cards`. La aptitud (`eligible` /
 * `ineligibleReason`) la decide siempre la app con la misma regla del
 * contrato (`isModelEligible` de `src/shared/ai.ts`), no la que traiga
 * el archivo.
 */
import {
  isModelEligible,
  MODEL_DATA_ORIGINS,
  type CalibrationBin,
  type FeatureReference,
  type ModelCard,
  type ModelDataOrigin,
  type ModelPeriod,
} from '../../../shared/ai';

export class ModelCardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelCardError';
  }
}

/** Ficha lista para persistir (sin `id` ni `registeredAt`, que fija la base). */
export type NewModelCard = Omit<ModelCard, 'id' | 'registeredAt'>;

/** Motivos legibles de no aptitud; idénticos a los que escribe `ml/train.py`. */
export const INELIGIBLE_REASONS = {
  synthetic: 'Datos sintéticos · no apto',
  baseline: 'No supera la referencia · no apto para apoyar señales',
} as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' &&
  ISO_DATE.test(value) &&
  !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isNullableNumber = (value: unknown): value is number | null =>
  value === null || isFiniteNumber(value);

/**
 * El pipeline escribe los periodos como `{startDate, endDate}` (claves
 * del JSON de la ficha) y el dominio los usa como `{desde, hasta}`
 * (`ModelPeriod`); se aceptan ambas escrituras y se normaliza.
 */
const isPeriodJson = (value: unknown): boolean =>
  isRecord(value) &&
  ((isIsoDate(value.startDate) && isIsoDate(value.endDate)) ||
    (isIsoDate(value.desde) && isIsoDate(value.hasta)));

const toPeriod = (value: unknown): ModelPeriod => {
  const record = value as Record<string, unknown>;
  return record.desde !== undefined
    ? { desde: record.desde as string, hasta: record.hasta as string }
    : { desde: record.startDate as string, hasta: record.endDate as string };
};

const isCalibrationBin = (value: unknown): value is CalibrationBin =>
  isRecord(value) &&
  isFiniteNumber(value.from) &&
  isFiniteNumber(value.to) &&
  isFiniteNumber(value.meanPredicted) &&
  isFiniteNumber(value.observed) &&
  Number.isInteger(value.count) &&
  (value.count as number) >= 0;

const isFeatureReference = (value: unknown): value is FeatureReference =>
  isRecord(value) &&
  typeof value.name === 'string' &&
  value.name !== '' &&
  isNullableNumber(value.mean) &&
  isNullableNumber(value.std) &&
  Array.isArray(value.bins) &&
  (value.bins as unknown[]).every(
    (bin) =>
      isRecord(bin) &&
      isNullableNumber(bin.from) &&
      isNullableNumber(bin.to) &&
      isFiniteNumber(bin.proportion),
  );

/**
 * Valida el JSON de `model-card.json` y devuelve la ficha lista para
 * `model_cards`, con la aptitud recalculada por la app:
 * `eligible = origen 'real' y brierOos < brierBaseline`; el motivo es el
 * mismo literal que escribe el pipeline ('Datos sintéticos · no apto' o
 * 'No supera la referencia · no apto para apoyar señales').
 *
 * Lanza `ModelCardError` si el documento no tiene la forma esperada:
 * una ficha incompleta nunca se registra a medias.
 */
export function parseModelCard(raw: unknown): NewModelCard {
  // `function` (no const flecha): TS solo estrecha el flujo tras llamadas
  // que devuelven `never` cuando el llamado es una declaración.
  function fail(detail: string): never {
    throw new ModelCardError(`model-card.json inválido: ${detail}`);
  }
  if (!isRecord(raw)) fail('no es un objeto');

  if (typeof raw.version !== 'string' || raw.version.trim() === '') fail('version ausente');
  if (typeof raw.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(raw.hash)) {
    fail('hash debe ser un SHA-256 en hexadecimal');
  }
  if (!Number.isInteger(raw.horizonDays) || (raw.horizonDays as number) < 1) {
    fail('horizonDays debe ser un entero >= 1');
  }
  if (!isPeriodJson(raw.trainingPeriod)) fail('trainingPeriod incompleto');
  if (!isPeriodJson(raw.calibrationPeriod)) fail('calibrationPeriod incompleto');
  if (!isPeriodJson(raw.testPeriod)) fail('testPeriod incompleto');
  if (!(MODEL_DATA_ORIGINS as readonly string[]).includes(raw.dataOrigin as string)) {
    fail('dataOrigin desconocido');
  }
  const metrics = raw.metrics;
  if (
    !isRecord(metrics) ||
    !isFiniteNumber(metrics.brierOos) ||
    !isNullableNumber(metrics.logLossOos) ||
    !isFiniteNumber(metrics.brierBaseline)
  ) {
    fail('metrics incompletas');
  }
  if (!Array.isArray(raw.calibration) || !raw.calibration.every(isCalibrationBin)) {
    fail('calibration debe ser una lista de bins');
  }
  if (
    !Array.isArray(raw.referenceDistribution) ||
    !raw.referenceDistribution.every(isFeatureReference)
  ) {
    fail('referenceDistribution debe ser una lista de variables');
  }
  if (typeof raw.trainedAt !== 'string' || Number.isNaN(Date.parse(raw.trainedAt))) {
    fail('trainedAt ausente o no es ISO 8601');
  }

  const dataOrigin = raw.dataOrigin as ModelDataOrigin;
  const cardMetrics = {
    brierOos: metrics.brierOos as number,
    logLossOos: metrics.logLossOos as number | null,
    brierBaseline: metrics.brierBaseline as number,
  };
  const eligible = isModelEligible({ dataOrigin, metrics: cardMetrics });
  const ineligibleReason = eligible
    ? null
    : dataOrigin !== 'real'
      ? INELIGIBLE_REASONS.synthetic
      : INELIGIBLE_REASONS.baseline;

  return {
    version: (raw.version as string).trim(),
    hash: (raw.hash as string).toLowerCase(),
    horizonDays: raw.horizonDays as number,
    trainingPeriod: toPeriod(raw.trainingPeriod),
    calibrationPeriod: toPeriod(raw.calibrationPeriod),
    testPeriod: toPeriod(raw.testPeriod),
    dataOrigin,
    metrics: cardMetrics,
    calibration: raw.calibration as CalibrationBin[],
    referenceDistribution: raw.referenceDistribution as FeatureReference[],
    eligible,
    ineligibleReason,
    trainedAt: new Date(raw.trainedAt as string).toISOString(),
  };
}
