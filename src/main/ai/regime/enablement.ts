/**
 * Habilitación de estrategias por régimen — Fase 6 (núcleo puro).
 *
 * Regla de la ficha (`worksIn`/`failsIn`, ver src/shared/ai.ts):
 *
 * - 'degradada' tiene prioridad sobre cualquier etiqueta: el drift
 *   sostenido manda y se resuelve en Salud de modelos.
 * - 'desactivada' si alguna etiqueta vigente está en `failsIn`, o si
 *   `worksIn` no está vacío y no contiene ninguna etiqueta vigente.
 * - Sin régimen calculado (`current === null`) la regla cierra en
 *   falso: 'desactivada' cuando la ficha declara `failsIn` (motivo
 *   «Régimen desconocido»); el resto queda habilitada.
 * - 'habilitada' en el resto de los casos.
 *
 * El motivo es legible y sigue los textos de docs/diseno-fase-6-7.md.
 */
import {
  type RegimeDirectionLabel,
  type RegimeLabel,
  type RegimeVolatilityLabel,
  type StrategyRegimeState,
} from '../../../shared/ai';
import type { StrategyStatus } from '../../../shared/strategy';

/** Texto visible de cada etiqueta (página «IA» y motivos). */
export const REGIME_LABEL_TEXT: Record<RegimeLabel, string> = {
  tendencia: 'Tendencia',
  lateral: 'Lateral',
  'volatilidad-alta': 'Volatilidad alta',
  'volatilidad-baja': 'Volatilidad baja',
};

/** Régimen vigente contra el que se resuelve una estrategia. */
export interface ActiveRegime {
  direction: RegimeDirectionLabel;
  volatility: RegimeVolatilityLabel;
}

/** Campos de la ficha que gobiernan la habilitación por régimen. */
export interface RegimeRuleFields {
  worksIn: readonly RegimeLabel[];
  failsIn: readonly RegimeLabel[];
}

/** Resultado de la resolución: estado por régimen y motivo legible. */
export interface StrategyRegimeResolution {
  regimeState: StrategyRegimeState;
  reason: string;
}

const joinLabels = (labels: readonly RegimeLabel[]): string =>
  labels.map((label) => REGIME_LABEL_TEXT[label]).join(' · ');

/**
 * Resolución cuando el régimen guardado está desactualizado: hay una
 * etiqueta pero su sesión es anterior a la última esperada, así que no
 * habilita ni desactiva hasta que los datos se pongan al día.
 */
export function staleRegimeResolution(
  sessionDate: string,
  expected: string,
): StrategyRegimeResolution {
  return {
    regimeState: 'desactualizada',
    reason:
      `El régimen del mercado está desactualizado (último cierre ${sessionDate}; ` +
      `se esperaba la sesión del ${expected}): no habilita ni desactiva.`,
  };
}

/**
 * Resuelve una estrategia frente al régimen vigente (`current`: el del
 * mercado en la vista general; una capa posterior puede pasar el del
 * activo, cambiando `reference` para el motivo). `current === null`
 * significa que aún no hay régimen calculado: sin certeza sobre el
 * régimen, una estrategia que declara `failsIn` queda desactivada
 * (regla de cierre, motivo «Régimen desconocido»); las que no declaran
 * régimen de fallo quedan habilitadas con el motivo del porqué.
 */
export function resolveStrategyRegime(
  fields: RegimeRuleFields,
  status: StrategyStatus,
  current: ActiveRegime | null,
  reference = 'mercado',
): StrategyRegimeResolution {
  if (status === 'degradada') {
    return {
      regimeState: 'degradada',
      reason: 'El drift sostenido tiene prioridad. Revisa Salud de modelos.',
    };
  }
  if (current === null) {
    if (fields.failsIn.length > 0) {
      return {
        regimeState: 'desactivada',
        reason:
          `Régimen desconocido: todavía no hay régimen calculado del ${reference} ` +
          `y la estrategia declara que falla en ${joinLabels(fields.failsIn)}.`,
      };
    }
    return {
      regimeState: 'habilitada',
      reason: `Todavía no hay régimen calculado del ${reference}: faltan cierres.`,
    };
  }
  const active: RegimeLabel[] = [current.direction, current.volatility];
  const failures = fields.failsIn.filter((label) => active.includes(label));
  if (failures.length > 0) {
    return {
      regimeState: 'desactivada',
      reason:
        `El ${reference} está en ${joinLabels(active)} y la estrategia declara ` +
        `que falla en ${joinLabels(failures)}.`,
    };
  }
  if (fields.worksIn.length > 0 && !fields.worksIn.some((label) => active.includes(label))) {
    return {
      regimeState: 'desactivada',
      reason:
        `Solo funciona en ${joinLabels(fields.worksIn)}; ` +
        `el régimen actual es ${joinLabels(active)}.`,
    };
  }
  return {
    regimeState: 'habilitada',
    reason: `Coincide: ${joinLabels(active)}. No coincide con ningún régimen de fallo.`,
  };
}
