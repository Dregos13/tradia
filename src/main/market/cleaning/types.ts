/**
 * Limpieza y ajuste de lotes OHLCV — contratos.
 *
 * `cleanBars` (en `clean.ts`) recibe las velas crudas del proveedor, las
 * acciones corporativas del rango y el calendario de sesiones, y devuelve
 * las velas ajustadas (`AdjustedBar`), un `QualityReport` con lo encontrado
 * (duplicados, huecos, valores anómalos) y la `BatchVersion` del lote.
 */
import type { MarketSession } from '../calendar';
import type { Bar, CorporateAction, SessionDate } from '../providers/types';

/**
 * Vela limpia: conserva los precios crudos (`open`…`close`, `volume`) tal
 * como llegaron y añade la familia ajustada hacia atrás calculada por la
 * limpieza (`adjOpen`…`adjClose`, `adjVolume`). `adjClose` se recalcula
 * siempre —sustituye al que trajera el proveedor— para que toda la serie
 * ajustada sea coherente con las acciones corporativas declaradas.
 */
export interface AdjustedBar extends Bar {
  adjOpen: number;
  adjHigh: number;
  adjLow: number;
  /** Volumen ajustado: multiplicado por los splits posteriores a la vela. */
  adjVolume: number;
}

/** Tipos de valor anómalo detectables en una vela. */
export type AnomalyKind =
  /** La fecha no es 'YYYY-MM-DD' válida. */
  | 'bad-date'
  /** Algún campo numérico no es finito (NaN, Infinity). */
  | 'non-numeric'
  /** `high` menor que `low`. */
  | 'high-below-low'
  /** Algún precio (open, high, low o close) es 0 o negativo. */
  | 'non-positive-price'
  /** `volume` negativo. */
  | 'negative-volume'
  /** Salto de rentabilidad diaria superior al umbral σ sin acción corporativa. */
  | 'return-outlier'
  /** Vela en un día que el calendario no considera sesión. */
  | 'non-session';

export interface Anomaly {
  date: SessionDate;
  kind: AnomalyKind;
  /** Descripción legible del problema (sin datos sensibles). */
  detail: string;
  /**
   * 'dropped': la vela no forma parte del lote (dato estructuralmente
   * inválido, insalvable). 'flagged': la vela se conserva pero queda
   * marcada (sospechosa, puede ser real).
   */
  action: 'dropped' | 'flagged';
}

/** Informe de calidad del lote procesado. */
export interface QualityReport {
  ticker: string;
  /** Filas recibidas del proveedor. */
  received: number;
  /** Velas que quedan en el lote limpio. */
  kept: number;
  /** Fechas recibidas más de una vez; se conserva la última recibida. */
  duplicates: SessionDate[];
  /** Sesiones esperadas según el calendario sin vela en el lote. */
  gaps: SessionDate[];
  /** Valores anómalos detectados (dropped y flagged). */
  anomalies: Anomaly[];
  /** Incidencias no graves: acción ignorada, dividendo sin cierre previo… */
  warnings: string[];
  /** false si el lote tiene huecos, anomalías o avisos. */
  reliable: boolean;
}

/** Versión del lote: estable mientras el contenido normalizado no cambie. */
export interface BatchVersion {
  /** 1 para el primer lote; se incrementa cuando cambia el hash. */
  version: number;
  /** SHA-256 del contenido normalizado del lote (ver `version.ts`). */
  hash: string;
}

/**
 * Lo que la limpieza necesita del calendario: las sesiones esperadas entre
 * dos fechas. `market/calendar.ts` lo satisface directamente — su
 * `expectedSessionsBetween` devuelve `MarketSession[]`, que lleva `date`.
 */
export interface SessionCalendar {
  expectedSessionsBetween(desde: SessionDate, hasta: SessionDate): MarketSession[];
}

export interface CleanBarsInput {
  ticker: string;
  /** Velas crudas en orden de llegada (los duplicados los resuelve la limpieza). */
  bars: readonly Bar[];
  /**
   * Acciones corporativas del rango (splits y dividendos con fecha ex).
   * Si no se pasan, se derivan de `splitFactor`/`dividend` de cada vela —
   * los adaptadores (Tiingo, simulado) ya las traen en cada fila.
   */
  corporateActions?: readonly CorporateAction[];
  /** Calendario de sesiones para detectar huecos y velas en días no hábiles. */
  calendar?: SessionCalendar;
}

export interface CleanBarsOptions {
  /**
   * Versión del lote anteriormente guardado para este activo. Si el hash
   * del contenido normalizado coincide, se conserva la versión; si cambia,
   * se incrementa. Sin `previousBatch` el lote sale con versión 1.
   */
  previousBatch?: BatchVersion | null;
  /** Umbral en desviaciones típicas para el salto de rentabilidad (def. 8). */
  outlierSigma?: number;
  /** Mínimo de rentabilidades diarias para activar la detección (def. 10). */
  minOutlierReturns?: number;
}

export interface CleanBarsResult {
  /** Velas limpias y ajustadas, ordenadas ascendentemente por fecha. */
  bars: AdjustedBar[];
  report: QualityReport;
  batch: BatchVersion;
}
