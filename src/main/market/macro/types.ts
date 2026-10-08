/**
 * Contrato de proveedores de series macroeconómicas — Fase 1.
 *
 * Un proveedor macro entrega observaciones puntuales (fecha, valor) de las
 * series del catálogo: `getObservations(seriesId, desde, hasta)`. Cada
 * proveedor declara sus `rateLimits` como los de `market/providers`, y los
 * errores reutilizan `MarketDataError` (auth, rate-limit, not-found,
 * network, bad-data).
 *
 * `MACRO_SERIES_CATALOG` es la lista fija de la fase: DFF (tipo de fondos
 * federales), CPIAUCSL (IPC), DGS2 y DGS10 (curva 2 y 10 años), T10Y2Y
 * (diferencial) y VIXCLS (VIX desde FRED, sin segundo proveedor). Los
 * metadatos (nombre en español, unidad, frecuencia) son los que ve el
 * panel macro y coinciden con el adaptador simulado del renderer.
 */
import type { RateLimits, SessionDate } from '../providers/types';

export interface MacroSeriesMeta {
  /** Identificador de la serie en el proveedor ('DFF', 'VIXCLS'…). */
  id: string;
  /** Nombre legible para el panel. */
  name: string;
  unit?: string;
  frequency?: string;
}

/** Un dato puntual de una serie macro; los valores ausentes no llegan aquí. */
export interface MacroObservation {
  /** Fecha de la observación ('YYYY-MM-DD', calendario del propio dato). */
  date: SessionDate;
  value: number;
}

export interface MacroDataProvider {
  /** Identificador estable del proveedor: 'fred', 'macro-simulated'… */
  readonly id: string;
  readonly rateLimits: RateLimits;
  /** Series que el proveedor sabe servir (subconjunto o igual al catálogo). */
  listSeries(): readonly MacroSeriesMeta[];
  /**
   * Observaciones entre `desde` y `hasta` (ambas inclusive, 'YYYY-MM-DD'),
   * ordenadas ascendentemente por fecha. Lanza 'not-found' si la serie no
   * existe en el proveedor.
   */
  getObservations(
    seriesId: string,
    desde?: SessionDate,
    hasta?: SessionDate,
  ): Promise<MacroObservation[]>;
}

/**
 * Las 6 series macro del panel. `CPIAUCSL` guarda el nivel del índice (la
 * variación interanual se deriva en la interfaz); el resto son tasas en % o
 * el nivel del índice VIX.
 */
export const MACRO_SERIES_CATALOG: readonly MacroSeriesMeta[] = [
  { id: 'DFF', name: 'Tipo de fondos federales', unit: '%', frequency: 'daily' },
  { id: 'CPIAUCSL', name: 'IPC interanual (EE. UU.)', unit: '%', frequency: 'monthly' },
  { id: 'DGS2', name: 'Tesoro EE. UU. 2 años', unit: '%', frequency: 'daily' },
  { id: 'DGS10', name: 'Tesoro EE. UU. 10 años', unit: '%', frequency: 'daily' },
  { id: 'T10Y2Y', name: 'Diferencial 10 años − 2 años', unit: '%', frequency: 'daily' },
  { id: 'VIXCLS', name: 'VIX (volatilidad CBOE)', unit: 'índice', frequency: 'daily' },
] as const;
