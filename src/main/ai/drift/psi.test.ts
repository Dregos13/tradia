import { describe, expect, it } from 'vitest';

import { computePsi, PSI_EPSILON } from './psi';

describe('computePsi', () => {
  const reference = [
    { from: null, to: 0, proportion: 0.5 },
    { from: 0, to: 0.5, proportion: 0.3 },
    { from: 0.5, to: null, proportion: 0.2 },
  ];

  it('es ~0 cuando la muestra sigue la referencia', () => {
    const values = [...Array(50).fill(-1), ...Array(30).fill(0.25), ...Array(20).fill(1)];
    expect(computePsi(reference, values)).toBeLessThan(0.01);
  });

  it('crece al desplazar la muestra fuera de los bins de referencia', () => {
    const aligned = [...Array(50).fill(-1), ...Array(30).fill(0.25), ...Array(20).fill(1)];
    const shifted = [...Array(10).fill(-1), ...Array(20).fill(0.25), ...Array(70).fill(1)];
    const psi = computePsi(reference, shifted);
    expect(psi).toBeGreaterThan(0.25);
    expect(psi).toBeGreaterThan(computePsi(reference, aligned));
  });

  it('un bin vacío en la muestra se recorta con el épsilon y no da infinito', () => {
    const values = Array(100).fill(1); // todo en el último bin
    const psi = computePsi(reference, values);
    expect(Number.isFinite(psi)).toBe(true);
    expect(psi).toBeGreaterThan(0.25);
  });

  it('una proporción cero en la referencia usa el épsilon', () => {
    const bins = [
      { from: null, to: 0, proportion: 0 },
      { from: 0, to: null, proportion: 1 },
    ];
    const psi = computePsi(bins, [-1, -2, -3, 1, 2]);
    expect(Number.isFinite(psi)).toBe(true);
    expect(psi).toBeGreaterThan(0);
    expect(PSI_EPSILON).toBeLessThan(1e-3);
  });

  it('muestra vacía o sin bins devuelve 0 (sin evidencia)', () => {
    expect(computePsi(reference, [])).toBe(0);
    expect(computePsi([], [1, 2, 3])).toBe(0);
  });

  it('ignora valores no finitos en la muestra', () => {
    const values = [Number.NaN, -1, 0.25, 1];
    const psi = computePsi(reference, values);
    expect(Number.isFinite(psi)).toBe(true);
  });
});
