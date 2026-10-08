/**
 * Versión de un lote de observaciones macro: hash estable del contenido
 * normalizado, el mismo mecanismo que `market/cleaning/version.ts` usa
 * para las velas.
 *
 * El lote se serializa en forma canónica —observaciones ordenadas por
 * fecha y valores redondeados a 9 decimales— y se le aplica SHA-256. Misma
 * entrada ⇒ mismo hash, en cualquier orden de llegada y en cualquier
 * proceso; así `refreshSeries` conserva la versión cuando el proveedor
 * devuelve lo mismo y sube +1 cuando cambia el contenido.
 */
import { createHash } from 'node:crypto';

import type { MacroObservation } from './types';

/** Decimales conservados al normalizar números para el hash. */
const HASH_DECIMALS = 9;

function canonicalNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Number(value.toFixed(HASH_DECIMALS));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Contenido normalizado del lote: una fila [date, value] por observación.
 * El orden de llegada no influye: se ordenan por fecha antes de serializar.
 */
export function normalizeMacroObservations(observations: readonly MacroObservation[]): unknown[][] {
  return [...observations]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((obs) => [obs.date, canonicalNumber(obs.value)]);
}

/** SHA-256 en hex del contenido normalizado del lote. */
export function macroBatchHash(observations: readonly MacroObservation[]): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeMacroObservations(observations)), 'utf8')
    .digest('hex');
}
