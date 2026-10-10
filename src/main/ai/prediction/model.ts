/**
 * Carga y sirve el modelo ONNX predictivo — fase 6.
 *
 * Lee el bundle de `resources/models/<version>/`: `pipeline.json` (orden
 * de variables, umbrales de la calibración isotónica y hashes) más los
 * dos grafos (`model.onnx` dirección, `vol.onnx` volatilidad). Antes de
 * crear las sesiones se verifica el SHA-256 de cada `.onnx` contra el
 * pipeline: un artefacto que no coincide con su manifiesto no se sirve.
 *
 * `onnxruntime-node` se importa de forma dinámica dentro del cargador:
 * si el módulo nativo no existe en la plataforma (o está corrupto en el
 * paquete) el cargador rechaza y el servicio degrada sin tumbar la app,
 * en lugar de fallar al evaluar el módulo.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createIsotonicCalibrator } from './calibrator';
import { FEATURE_COUNT, FEATURE_NAMES } from './features';

export class ModelLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelLoadError';
  }
}

/** Salida de una predicción servida (probabilidades ya calibradas). */
export interface ModelPrediction {
  /** Probabilidad cruda del ONNX (clase 1) antes de calibrar. */
  rawProbUp: number;
  /** Probabilidad calibrada de subida al horizonte (0–1). */
  probUp: number;
  /** Complemento 1 − probUp. */
  probDown: number;
  /** Volatilidad esperada a N sesiones (tanto por uno, ≥ 0). */
  expectedVolatility: number;
}

/** El bundle cargado y verificado, listo para servir predicciones. */
export interface PredictionModel {
  /** Versión del pipeline de ml/ (`pipelineVersion`, semver). */
  version: string;
  /** Horizonte de la predicción en sesiones. */
  horizonDays: number;
  /** SHA-256 del `model.onnx` servido (el de la ficha del modelo). */
  modelHash: string;
  /** SHA-256 del `vol.onnx` servido. */
  volHash: string;
  /**
   * Predice un lote de vectores de variables en el orden de
   * `FEATURE_NAMES` (una sola pasada por grafo; los vectores inválidos
   * —longitud o valores no finitos— hacen fallar el lote entero, porque
   * una variable corrupta nunca debe llegar al modelo).
   */
  predictBatch(vectors: readonly (readonly number[])[]): Promise<ModelPrediction[]>;
  /** Libera las sesiones nativas. */
  release(): Promise<void>;
}

/** Mínimo que el servicio necesita de una sesión ONNX (inyectable). */
export interface OrtSessionLike {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
  release(): Promise<void>;
}

/** Dependencias externas del cargador (inyectables en pruebas). */
export interface ModelLoaderDeps {
  readFile?(path: string): Promise<Uint8Array>;
  /** Crea una sesión de inferencia; por defecto `onnxruntime-node` (import dinámico). */
  createSession?(path: string): Promise<OrtSessionLike>;
  sha256?(data: Uint8Array): string;
}

const realSha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');

/** Crea sesiones con el runtime nativo real (solo CPU, sin EP extra). */
async function createOrtSession(path: string): Promise<OrtSessionLike> {
  const ort = await import('onnxruntime-node');
  const session = await ort.InferenceSession.create(path, {
    executionProviders: ['cpu'],
  });
  return session as unknown as OrtSessionLike;
}

// ---------------------------------------------------------------------------
// pipeline.json
// ---------------------------------------------------------------------------

interface PipelineJson {
  pipelineVersion: string;
  horizonDays: number;
  featureNames: string[];
  models: { direction: string; volatility: string };
  input: { name: string };
  outputs: { direction: string };
  calibrator: { xThresholds: number[]; yThresholds: number[] };
  hash: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '');

const isNumberList = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((item) => typeof item === 'number' && Number.isFinite(item));

const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);

function parsePipelineJson(raw: unknown, dir: string): PipelineJson {
  // `function` (no const flecha): TS solo estrecha el flujo tras llamadas
  // que devuelven `never` cuando el llamado es una declaración.
  function fail(detail: string): never {
    throw new ModelLoadError(`pipeline.json inválido en ${dir}: ${detail}`);
  }
  if (!isRecord(raw)) fail('no es un objeto');
  const p = raw;

  if (typeof p.pipelineVersion !== 'string' || p.pipelineVersion.trim() === '') {
    fail('pipelineVersion ausente');
  }
  if (!Number.isInteger(p.horizonDays) || (p.horizonDays as number) < 1) {
    fail('horizonDays debe ser un entero >= 1');
  }
  if (!isStringList(p.featureNames)) fail('featureNames debe ser una lista de nombres');
  const featureNames = p.featureNames as string[];
  if (
    featureNames.length !== FEATURE_NAMES.length ||
    featureNames.some((name, index) => name !== FEATURE_NAMES[index])
  ) {
    fail('featureNames no coincide con el orden esperado del modelo');
  }

  const models = p.models;
  if (
    !isRecord(models) ||
    typeof models.direction !== 'string' ||
    typeof models.volatility !== 'string'
  ) {
    fail('models.direction/models.volatility ausentes');
  }
  const input = p.input;
  if (!isRecord(input) || typeof input.name !== 'string' || input.name === '') {
    fail('input.name ausente');
  }
  const outputs = p.outputs;
  if (!isRecord(outputs) || typeof outputs.direction !== 'string' || outputs.direction === '') {
    fail('outputs.direction ausente');
  }
  const calibrator = p.calibrator;
  if (
    !isRecord(calibrator) ||
    !isNumberList(calibrator.xThresholds) ||
    !isNumberList(calibrator.yThresholds)
  ) {
    fail('calibrator sin umbrales numéricos');
  }
  if (!isRecord(p.hash)) fail('hash ausente');
  const hash = p.hash as Record<string, unknown>;
  const modelFile = (models as Record<string, string>).direction!;
  const volFile = (models as Record<string, string>).volatility!;
  if (!isSha256(hash[modelFile])) fail(`sin hash SHA-256 de ${modelFile}`);
  if (!isSha256(hash[volFile])) fail(`sin hash SHA-256 de ${volFile}`);
  // Los nombres de archivo se resuelven dentro de `dir`: sin rutas.
  for (const file of [modelFile, volFile]) {
    if (file.includes('/') || file.includes('\\') || file === '') {
      fail(`nombre de modelo no permitido: ${JSON.stringify(file)}`);
    }
  }

  return {
    pipelineVersion: p.pipelineVersion as string,
    horizonDays: p.horizonDays as number,
    featureNames,
    models: { direction: modelFile, volatility: volFile },
    input: { name: (input as Record<string, string>).name! },
    outputs: { direction: (outputs as Record<string, string>).direction! },
    calibrator: {
      xThresholds: (calibrator as Record<string, number[]>).xThresholds!,
      yThresholds: (calibrator as Record<string, number[]>).yThresholds!,
    },
    hash: hash as Record<string, string>,
  };
}

// ---------------------------------------------------------------------------
// Carga del bundle
// ---------------------------------------------------------------------------

/**
 * Carga y verifica el bundle de `dir` (`resources/models/<version>`).
 * Rechaza con `ModelLoadError` si falta algo, el JSON no valida o un
 * hash no coincide; otros errores (JSON mal formado, fallo del runtime
 * nativo) también se propagan como `ModelLoadError` para que el
 * servicio pueda informar de un solo motivo.
 */
export async function loadPredictionModel(
  dir: string,
  deps: ModelLoaderDeps = {},
): Promise<PredictionModel> {
  const read = deps.readFile ?? ((path: string) => readFile(path));
  const sha256 = deps.sha256 ?? realSha256;
  const createSession = deps.createSession ?? createOrtSession;

  const wrap =
    (detail: string) =>
    (error: unknown): never => {
      if (error instanceof ModelLoadError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ModelLoadError(`${detail}: ${message}`);
    };

  const pipelineRaw = await read(join(dir, 'pipeline.json')).catch(wrap('no se pudo leer'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(pipelineRaw).toString('utf8'));
  } catch (error: unknown) {
    wrap('pipeline.json no es JSON válido')(error);
  }
  const pipeline = parsePipelineJson(parsed, dir);

  const files = [pipeline.models.direction, pipeline.models.volatility] as const;
  const bytes: Record<string, Uint8Array> = {};
  for (const file of files) {
    bytes[file] = await read(join(dir, file)).catch(wrap(`no se pudo leer ${file}`));
    const actual = sha256(bytes[file]!);
    if (actual.toLowerCase() !== pipeline.hash[file]!.toLowerCase()) {
      throw new ModelLoadError(`${file}: el SHA-256 no coincide con pipeline.json`);
    }
  }

  const calibrate = createIsotonicCalibrator(
    pipeline.calibrator.xThresholds,
    pipeline.calibrator.yThresholds,
  );

  const directionPath = join(dir, pipeline.models.direction);
  const volPath = join(dir, pipeline.models.volatility);
  let direction: OrtSessionLike;
  let volatility: OrtSessionLike;
  try {
    direction = await createSession(directionPath);
    volatility = await createSession(volPath);
  } catch (error: unknown) {
    wrap('no se pudo crear la sesión ONNX')(error);
    throw new ModelLoadError('no se pudo crear la sesión ONNX');
  }

  const inputName = direction.inputNames[0] ?? pipeline.input.name;
  const probOutput = pipeline.outputs.direction;
  const volOutput = volatility.outputNames[0];

  const runModel = async (tensor: unknown, n: number): Promise<ModelPrediction[]> => {
    const dirResults = await direction.run({ [inputName]: tensor });
    const volResults = await volatility.run({ [inputName]: tensor });
    const probs = dirResults[probOutput];
    const vols = volOutput === undefined ? undefined : volResults[volOutput];
    if (probs === undefined) {
      throw new ModelLoadError(`la salida '${probOutput}' no existe en el modelo de dirección`);
    }
    const out: ModelPrediction[] = [];
    for (let i = 0; i < n; i++) {
      const rawProbUp = probs.data[i * 2 + 1] as number;
      const probUp = calibrate(rawProbUp);
      const expectedVolatility = vols === undefined ? 0 : Math.max(0, vols.data[i] as number);
      out.push({ rawProbUp, probUp, probDown: 1 - probUp, expectedVolatility });
    }
    return out;
  };

  return {
    version: pipeline.pipelineVersion,
    horizonDays: pipeline.horizonDays,
    modelHash: pipeline.hash[pipeline.models.direction]!.toLowerCase(),
    volHash: pipeline.hash[pipeline.models.volatility]!.toLowerCase(),

    predictBatch: async (vectors) => {
      if (vectors.length === 0) return [];
      for (const vector of vectors) {
        if (
          vector.length !== FEATURE_COUNT ||
          vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
        ) {
          throw new ModelLoadError(
            `vector de variables inválido: se esperaban ${FEATURE_COUNT} valores finitos`,
          );
        }
      }
      // El tensor se construye con el runtime real; en pruebas con
      // `createSession` inyectado se pasa el Float32Array crudo (la
      // sesión simulada solo lee `data`).
      const flat = new Float32Array(vectors.length * FEATURE_COUNT);
      vectors.forEach((vector, row) => flat.set(vector, row * FEATURE_COUNT));
      const tensor = await makeTensor(deps, flat, vectors.length);
      return runModel(tensor, vectors.length);
    },

    release: async () => {
      await Promise.allSettled([direction.release(), volatility.release()]);
    },
  };
}

/** Construye el tensor [N, 16] con el runtime real o pasa los datos crudos a la sesión inyectada. */
async function makeTensor(
  deps: ModelLoaderDeps,
  flat: Float32Array,
  rows: number,
): Promise<unknown> {
  if (deps.createSession !== undefined) {
    // Sesión simulada: acepta los datos directamente.
    return { data: flat, dims: [rows, FEATURE_COUNT] };
  }
  const ort = await import('onnxruntime-node');
  return new ort.Tensor('float32', flat, [rows, FEATURE_COUNT]);
}
