/**
 * Limpieza de lotes OHLCV: deduplicado, validación, huecos, valores
 * anómalos, ajuste hacia atrás por splits y dividendos y versión del lote
 * (`cleanBars` + `nextBatchVersion`/`batchHash` para el almacenamiento).
 */
export * from './types';
export * from './clean';
export * from './version';
