/**
 * Las fichas semilla de las cuatro estrategias clásicas: pasan la validación
 * real del repositorio (alta en una base en memoria) y sus parámetros y
 * rangos son coherentes para el mapa de sensibilidad.
 */
import { describe, expect, it } from 'vitest';

import type Database from 'better-sqlite3';

import { DEFAULT_STRATEGY_COSTS } from '../../../shared/strategy';
import { openDatabase } from '../../db/database';
import { createStrategiesRepository } from '../../strategies/repository';
import { CLASSIC_STRATEGIES } from './index';

const EXPECTED_NAMES = [
  'Cruce de medias',
  'Reversión RSI/Bollinger',
  'Ruptura de rangos',
  'Momentum entre activos',
];

function closeToStep(value: number, min: number, step: number): boolean {
  return Math.abs((value - min) / step - Math.round((value - min) / step)) < 1e-9;
}

describe('fichas semilla de las estrategias clásicas', () => {
  it('hay cuatro, con los nombres del diseño y claves estables únicas', () => {
    expect(CLASSIC_STRATEGIES.map((d) => d.seed.name)).toEqual(EXPECTED_NAMES);
    expect(new Set(CLASSIC_STRATEGIES.map((d) => d.key)).size).toBe(4);
  });

  it('cada semilla se puede dar de alta en estado «investigacion»', () => {
    const db: Database.Database = openDatabase(':memory:');
    try {
      const repo = createStrategiesRepository(db);
      for (const { seed } of CLASSIC_STRATEGIES) {
        const created = repo.create(seed);
        expect(created.status).toBe('investigacion');
        expect(created.version).toBe(1);
        expect(created.metricsSummary).toBeNull();
      }
      expect(repo.list()).toHaveLength(4);
    } finally {
      db.close();
    }
  });

  it('todo parámetro tiene su rango de sensibilidad y el default está en la rejilla', () => {
    for (const { key, seed } of CLASSIC_STRATEGIES) {
      const params = seed.parameters;
      const ranges = seed.parameterRanges ?? {};
      expect(Object.keys(ranges).sort(), key).toEqual(Object.keys(params).sort());
      for (const [param, range] of Object.entries(ranges)) {
        const value = params[param]!;
        expect(value, `${key}.${param} bajo el mínimo`).toBeGreaterThanOrEqual(range.min);
        expect(value, `${key}.${param} sobre el máximo`).toBeLessThanOrEqual(range.max);
        expect(closeToStep(value, range.min, range.step), `${key}.${param} fuera de la rejilla`).toBe(
          true,
        );
      }
    }
  });

  it('los costes asumidos son los del plan y los periodos van en orden', () => {
    for (const { seed } of CLASSIC_STRATEGIES) {
      expect(seed.assumedCosts).toEqual(DEFAULT_STRATEGY_COSTS);
      expect(seed.trainingPeriod!.desde <= seed.trainingPeriod!.hasta).toBe(true);
      expect(seed.outOfSamplePeriod!.desde <= seed.outOfSamplePeriod!.hasta).toBe(true);
      // Fuera de muestra empieza después del entrenamiento.
      expect(seed.outOfSamplePeriod!.desde > seed.trainingPeriod!.hasta).toBe(true);
      // Hipótesis y reglas redactadas (validación del repositorio aparte).
      expect(seed.hypothesis.length).toBeGreaterThan(50);
      for (const rule of Object.values(seed.rules)) {
        expect(rule.length).toBeGreaterThan(20);
      }
      expect(seed.regime.length).toBeGreaterThan(10);
    }
  });

  it('cada factoría produce una estrategia ejecutable que acepta sus parámetros', () => {
    for (const { key, create, seed } of CLASSIC_STRATEGIES) {
      const strategy = create();
      expect(() => strategy.init(seed.parameters), key).not.toThrow();
      // init se puede llamar de nuevo (nuevo run sobre la misma instancia).
      expect(() => strategy.init({}), key).not.toThrow();
    }
  });
});
