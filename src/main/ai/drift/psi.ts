/**
 * Índice de estabilidad poblacional (PSI) — deriva de datos del modelo.
 *
 * Compara la proporción de la muestra reciente en cada bin de la
 * distribución de referencia de una variable (`model_cards` la guarda por
 * variable, calculada sobre el entrenamiento) con la proporción esperada:
 *
 *   PSI = Σ (actualᵢ − esperadoᵢ) · ln(actualᵢ / esperadoᵢ)
 *
 * Reglas:
 * - Los bins vienen de la ficha: `from`/`to` a null significan −∞/+∞ en
 *   los extremos; el último bin es cerrado por la derecha.
 * - Una proporción cero (en cualquiera de los dos lados) se recorta a
 *   `PSI_EPSILON` para que el logaritmo sea finito; es la corrección
 *   habitual del PSI.
 * - PSI > DRIFT_PSI_THRESHOLD (0,25) marca la variable; la degradación
 *   exige persistencia (ver service.ts).
 */
import type { FeatureReferenceBin } from '../../../shared/ai';

/** Proporción mínima usada en ambos lados para evitar log(0) e ÷0. */
export const PSI_EPSILON = 1e-4;

/** Proporción de `values` que cae en el bin `[from, to)` (to null/∞ incluido en el último). */
function binProportion(
  values: readonly number[],
  from: number | null,
  to: number | null,
): number {
  if (values.length === 0) return 0;
  let count = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (from !== null && value < from) continue;
    if (to !== null && value >= to) continue;
    count += 1;
  }
  return count / values.length;
}

/**
 * PSI de una muestra frente a la distribución de referencia de una
 * variable. Una muestra vacía o bins vacíos devuelven 0 (sin evidencia,
 * nunca alerta). Valores no finitos no llegan a ningún bin.
 */
export function computePsi(
  bins: readonly FeatureReferenceBin[],
  values: readonly number[],
): number {
  if (bins.length === 0 || values.length === 0) return 0;
  let psi = 0;
  for (const bin of bins) {
    const expected = Math.max(PSI_EPSILON, bin.proportion > 0 ? bin.proportion : PSI_EPSILON);
    const actual = Math.max(PSI_EPSILON, binProportion(values, bin.from, bin.to));
    psi += (actual - expected) * Math.log(actual / expected);
  }
  return Number.isFinite(psi) && psi > 0 ? psi : 0;
}
