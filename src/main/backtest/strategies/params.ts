/**
 * Lectura de parámetros de estrategia — Fase 2.
 *
 * `init` recibe el `parameters` de la ficha (un JSON de números ya validado
 * por el repositorio) pero los defaults hacen la estrategia robusta ante
 * fichas editadas o parciales: cualquier valor presente debe ser un número
 * finito, y las comprobaciones de rango específicas de cada estrategia se
 * hacen aparte con `requireIntegerParam` y amigos.
 */
import type { StrategyParams } from '../types';

/**
 * Fusiona `params` sobre `defaults`: solo se leen las claves conocidas y
 * cada una debe ser un número finito. Devuelve el mismo shape que
 * `defaults` para que la estrategia trabaje con tipos concretos.
 */
export function resolveParams<D extends Record<string, number>>(defaults: D, params: StrategyParams): D {
  const resolved = { ...defaults };
  for (const key of Object.keys(resolved) as (keyof D & string)[]) {
    const value = params[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(
        `estrategia: el parámetro '${key}' debe ser un número finito (${String(value)})`,
      );
    }
    resolved[key] = value as D[keyof D & string];
  }
  return resolved;
}

/** Exige un entero >= min (típico en periodos de indicador). */
export function requireIntegerParam(value: number, name: string, min = 1): void {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(
      `estrategia: el parámetro '${name}' debe ser un entero >= ${min} (${value})`,
    );
  }
}

/** Exige un número en (min, max) inclusive. */
export function requireParamRange(
  value: number,
  name: string,
  min: number,
  max: number,
): void {
  if (value < min || value > max) {
    throw new RangeError(
      `estrategia: el parámetro '${name}' debe estar entre ${min} y ${max} (${value})`,
    );
  }
}
