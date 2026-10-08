/**
 * Versión de un lote de velas: hash estable del contenido normalizado.
 *
 * El lote se serializa en forma canónica —velas ordenadas por fecha, campos
 * en orden fijo y números redondeados a 9 decimales— y se le aplica
 * SHA-256 (el mismo mecanismo que usa `db/migrator.ts` para los checksums
 * de las migraciones). Misma entrada ⇒ mismo hash, en cualquier orden de
 * llegada y en cualquier proceso.
 *
 * `nextBatchVersion` compara con el lote guardado: hash igual ⇒ conserva la
 * versión (reprocesar no crea versiones nuevas); hash distinto ⇒ versión + 1.
 */
import { createHash } from 'node:crypto';

import type { AdjustedBar, BatchVersion } from './types';

/** Decimales conservados al normalizar números para el hash. */
const HASH_DECIMALS = 9;

function canonicalNumber(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Number(value.toFixed(HASH_DECIMALS));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Contenido normalizado del lote: una fila por vela con los campos en orden
 * fijo [date, OHLCV crudos, adjOHLCV, splitFactor, dividend]. El orden de
 * las velas no influye: se ordenan por fecha antes de serializar.
 */
export function normalizeBatch(bars: readonly AdjustedBar[]): unknown[][] {
  return [...bars]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((bar) => [
      bar.date,
      canonicalNumber(bar.open),
      canonicalNumber(bar.high),
      canonicalNumber(bar.low),
      canonicalNumber(bar.close),
      canonicalNumber(bar.volume),
      canonicalNumber(bar.adjOpen),
      canonicalNumber(bar.adjHigh),
      canonicalNumber(bar.adjLow),
      canonicalNumber(bar.adjClose),
      canonicalNumber(bar.adjVolume),
      canonicalNumber(bar.splitFactor),
      canonicalNumber(bar.dividend),
    ]);
}

/** SHA-256 en hex del contenido normalizado del lote. */
export function batchHash(bars: readonly AdjustedBar[]): string {
  return createHash('sha256')
    .update(JSON.stringify(normalizeBatch(bars)), 'utf8')
    .digest('hex');
}

/**
 * Versión del lote comparada con la guardada (`previous`): mismo hash ⇒
 * misma versión; hash distinto ⇒ `previous.version + 1`; sin previo ⇒ 1.
 */
export function nextBatchVersion(
  bars: readonly AdjustedBar[],
  previous?: BatchVersion | null,
): BatchVersion {
  const hash = batchHash(bars);
  if (previous && previous.hash === hash) {
    return { version: previous.version, hash };
  }
  return { version: (previous?.version ?? 0) + 1, hash };
}
