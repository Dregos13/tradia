/**
 * Paridad con el pipeline de entrenamiento (`ml/` → `resources/models/`).
 *
 * `parity-fixture.json` contiene las velas completas de dos activos y,
 * para sus últimas 8 sesiones con variables definidas, el vector
 * esperado y las salidas esperadas calculadas con el ONNX exportado
 * (`rawProbUp`, `probUp`, `probDown`, `expectedVolatility`). Aquí se
 * recomputan las variables en TypeScript sobre la historia completa y
 * se sirven con `onnxruntime-node` + la calibración de `pipeline.json`:
 * todo debe coincidir dentro de la tolerancia fijada por el fixture
 * (1e-6).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FEATURE_NAMES, featureRowAt, precomputeFeatures, type PredictionCandle } from './features';
import { loadPredictionModel, ModelLoadError } from './model';

interface FixtureSample {
  ticker: string;
  session: string;
  features: Record<string, number>;
  input: number[];
  rawProbUp: number;
  probUp: number;
  probDown: number;
  expectedVolatility: number;
}

interface ParityFixture {
  pipelineVersion: string;
  horizonDays: number;
  featureNames: string[];
  tolerance: number;
  candles: Record<string, PredictionCandle[]>;
  samples: FixtureSample[];
}

const MODELS_DIR = fileURLToPath(new URL('../../../../resources/models', import.meta.url));
const ACTIVE_VERSION = (
  JSON.parse(readFileSync(join(MODELS_DIR, 'current.json'), 'utf8')) as { version: string }
).version;
const MODEL_DIR = join(MODELS_DIR, ACTIVE_VERSION);
const FIXTURE = JSON.parse(
  readFileSync(join(MODEL_DIR, 'parity-fixture.json'), 'utf8'),
) as ParityFixture;

const expectClose = (actual: number, expected: number, what: string): void => {
  expect(
    Math.abs(actual - expected),
    `${what}: |${actual} - ${expected}| > ${FIXTURE.tolerance}`,
  ).toBeLessThanOrEqual(FIXTURE.tolerance);
};

describe('paridad de variables con el pipeline de ml/', () => {
  it('el fixture corresponde a la versión activa y declara las 16 variables en orden', () => {
    expect(FIXTURE.pipelineVersion).toBe(ACTIVE_VERSION);
    expect(FIXTURE.featureNames).toEqual([...FEATURE_NAMES]);
    expect(FIXTURE.samples.length).toBeGreaterThan(0);
  });

  it.each(FIXTURE.samples.map((sample) => [sample.ticker, sample.session, sample] as const))(
    'variables de %s en %s dentro de la tolerancia',
    (ticker, session, sample) => {
      const candles = FIXTURE.candles[ticker]!;
      const index = candles.findIndex((candle) => candle.date === session);
      expect(index, `${ticker} ${session} no está en las velas del fixture`).toBeGreaterThan(0);
      const row = featureRowAt(precomputeFeatures(candles), candles, index);
      expect(row, `la sesión ${session} debería tener variables definidas`).not.toBeNull();

      // Las 16 variables por nombre y el vector de entrada, ambos a 1e-6.
      for (const [name, expected] of Object.entries(sample.features)) {
        const idx = FEATURE_NAMES.indexOf(name as (typeof FEATURE_NAMES)[number]);
        expect(idx, `variable desconocida en el fixture: ${name}`).toBeGreaterThanOrEqual(0);
        expectClose(row![idx]!, expected, `${ticker} ${session} ${name}`);
      }
      sample.input.forEach((expected, idx) => {
        expectClose(row![idx]!, expected, `${ticker} ${session} input[${idx}]`);
      });
    },
  );

  it('las primeras sesiones sin historia suficiente no producen variables', () => {
    const candles = FIXTURE.candles[FIXTURE.samples[0]!.ticker]!;
    const series = precomputeFeatures(candles);
    expect(featureRowAt(series, candles, 0)).toBeNull();
    expect(featureRowAt(series, candles, 48)).toBeNull();
    expect(featureRowAt(series, candles, 49)).not.toBeNull();
  });
});

describe('paridad del servido ONNX en Node', () => {
  it('las salidas servidas coinciden con las del fixture a 1e-6', async () => {
    const model = await loadPredictionModel(MODEL_DIR);
    try {
      expect(model.version).toBe(FIXTURE.pipelineVersion);
      expect(model.horizonDays).toBe(FIXTURE.horizonDays);

      const vectors = FIXTURE.samples.map((sample) => {
        const candles = FIXTURE.candles[sample.ticker]!;
        const index = candles.findIndex((candle) => candle.date === sample.session);
        return featureRowAt(precomputeFeatures(candles), candles, index)!;
      });
      const served = await model.predictBatch(vectors);
      expect(served).toHaveLength(FIXTURE.samples.length);

      FIXTURE.samples.forEach((sample, i) => {
        const what = `${sample.ticker} ${sample.session}`;
        expectClose(served[i]!.rawProbUp, sample.rawProbUp, `${what} rawProbUp`);
        expectClose(served[i]!.probUp, sample.probUp, `${what} probUp`);
        expectClose(served[i]!.probDown, sample.probDown, `${what} probDown`);
        expectClose(
          served[i]!.expectedVolatility,
          sample.expectedVolatility,
          `${what} expectedVolatility`,
        );
      });
    } finally {
      await model.release();
    }
  });

  it('verifica el SHA-256 de los grafos antes de servirlos', async () => {
    const model = await loadPredictionModel(MODEL_DIR);
    await model.release();
    const pipeline = JSON.parse(readFileSync(join(MODEL_DIR, 'pipeline.json'), 'utf8')) as {
      hash: Record<string, string>;
    };
    expect(model.modelHash).toBe(pipeline.hash['model.onnx']);
    expect(model.volHash).toBe(pipeline.hash['vol.onnx']);
  });

  it('rechaza un bundle con hash manipulado o archivos ausentes', async () => {
    const { mkdtempSync, copyFileSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'tradia-model-'));
    try {
      // Sin artefactos: el cargador falla y el servicio degradaría.
      await expect(loadPredictionModel(dir)).rejects.toThrow(ModelLoadError);

      // pipeline.json con un hash que no coincide con el archivo real.
      copyFileSync(join(MODEL_DIR, 'model.onnx'), join(dir, 'model.onnx'));
      copyFileSync(join(MODEL_DIR, 'vol.onnx'), join(dir, 'vol.onnx'));
      const pipeline = JSON.parse(readFileSync(join(MODEL_DIR, 'pipeline.json'), 'utf8')) as {
        hash: Record<string, string>;
      };
      pipeline.hash['model.onnx'] = '0'.repeat(64);
      writeFileSync(join(dir, 'pipeline.json'), JSON.stringify(pipeline));
      await expect(loadPredictionModel(dir)).rejects.toThrow(/SHA-256/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
