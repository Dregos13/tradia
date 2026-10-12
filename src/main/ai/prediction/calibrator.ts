/**
 * Calibración isotónica servida en la app — fase 6.
 *
 * El pipeline de `ml/` ajusta una `IsotonicRegression` solo sobre el
 * tramo de validación y exporta sus umbrales en `pipeline.json`
 * (`calibrator.xThresholds` / `yThresholds`). La probabilidad servida es
 *
 *   probUp = clip(interp_lineal(rawProbUp, xThresholds, yThresholds), 0, 1)
 *
 * con extrapolación plana fuera del rango (`out_of_bounds='clip'`), la
 * misma semántica que `IsotonicRegression.predict`/`np.interp`.
 */

export class CalibratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalibratorError';
  }
}

const clip01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * Construye la función de calibración a partir de los umbrales del
 * pipeline. Los umbrales llegan ordenados de menor a mayor (así los
 * exporta sklearn); se valida forma y finitud para no servir una
 * calibración corrupta en silencio.
 */
export function createIsotonicCalibrator(
  xThresholds: readonly number[],
  yThresholds: readonly number[],
): (rawProbUp: number) => number {
  if (
    !Array.isArray(xThresholds) ||
    !Array.isArray(yThresholds) ||
    xThresholds.length === 0 ||
    xThresholds.length !== yThresholds.length ||
    xThresholds.some((x) => typeof x !== 'number' || !Number.isFinite(x)) ||
    yThresholds.some((y) => typeof y !== 'number' || !Number.isFinite(y))
  ) {
    throw new CalibratorError('umbrales de calibración inválidos');
  }
  const n = xThresholds.length;
  if (n === 1) {
    const only = clip01(yThresholds[0]!);
    return () => only;
  }

  return (rawProbUp: number): number => {
    if (!Number.isFinite(rawProbUp)) return rawProbUp;
    // Extrapolación plana ('clip') fuera del rango de los umbrales.
    if (rawProbUp <= xThresholds[0]!) return clip01(yThresholds[0]!);
    if (rawProbUp >= xThresholds[n - 1]!) return clip01(yThresholds[n - 1]!);
    // Interpolación lineal entre los dos umbrales que rodean el valor.
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xThresholds[mid]! <= rawProbUp) lo = mid;
      else hi = mid;
    }
    const x0 = xThresholds[lo]!;
    const x1 = xThresholds[hi]!;
    const y0 = yThresholds[lo]!;
    const y1 = yThresholds[hi]!;
    const interpolated = x1 === x0 ? y0 : y0 + ((rawProbUp - x0) * (y1 - y0)) / (x1 - x0);
    return clip01(interpolated);
  };
}
