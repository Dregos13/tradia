import { describe, expect, it } from 'vitest';

import { CalibratorError, createIsotonicCalibrator } from './calibrator';

describe('createIsotonicCalibrator', () => {
  // Umbrales de una isotónica típica: tramos planos al inicio y al final.
  const xs = [0.05, 0.2, 0.4, 0.6, 0.9];
  const ys = [0.0, 0.1, 0.5, 0.9, 1.0];
  const calibrate = createIsotonicCalibrator(xs, ys);

  it('interpola linealmente entre umbrales', () => {
    expect(calibrate(0.3)).toBeCloseTo(0.3, 12); // mitad de 0.1..0.5
    expect(calibrate(0.2)).toBeCloseTo(0.1, 12); // punto exacto
    expect(calibrate(0.5)).toBeCloseTo(0.7, 12);
  });

  it('extrapola plano fuera del rango (out_of_bounds=clip)', () => {
    expect(calibrate(-0.5)).toBe(0);
    expect(calibrate(0.05)).toBe(0);
    expect(calibrate(0.95)).toBe(1);
    expect(calibrate(2)).toBe(1);
  });

  it('recorta el resultado a [0, 1] aunque los umbrales lo superen', () => {
    const weird = createIsotonicCalibrator([0.1, 0.9], [-0.4, 1.3]);
    expect(weird(0.1)).toBe(0);
    expect(weird(0.9)).toBe(1);
    expect(weird(0.5)).toBeCloseTo(0.45, 12);
  });

  it('con un solo umbral devuelve su valor constante', () => {
    const flat = createIsotonicCalibrator([0.4], [0.7]);
    expect(flat(0)).toBeCloseTo(0.7, 12);
    expect(flat(1)).toBeCloseTo(0.7, 12);
  });

  it('rechaza umbrales mal formados', () => {
    expect(() => createIsotonicCalibrator([], [])).toThrow(CalibratorError);
    expect(() => createIsotonicCalibrator([0.1], [0.1, 0.2])).toThrow(CalibratorError);
    expect(() => createIsotonicCalibrator([0.1, Number.NaN], [0.1, 0.2])).toThrow(CalibratorError);
  });
});
