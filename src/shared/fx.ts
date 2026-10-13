/**
 * Pares de divisas: formato, pares admitidos y moneda → par.
 *
 * Solo funciones puras, compartidas por main y renderer.
 *
 * Formato: un par se guarda (watchlist, velas, data_status) como seis
 * letras mayúsculas sin separador, moneda base y moneda cotizada
 * ('EURUSD': euros cotizados en dólares), el mismo símbolo que usa el
 * endpoint FX de Tiingo. En pantalla se muestra con barra: 'EUR/USD'.
 *
 * Solo se admiten los pares de `FX_PAIRS`; el resto de combinaciones de
 * seis letras no son pares para la app.
 */
import type { AssetClass } from './ipc';

/** Pares de divisas admitidos, en su forma guardada. */
export const FX_PAIRS = ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF'] as const;
export type FxPair = (typeof FX_PAIRS)[number];

/**
 * Par que sigue cada moneda frente al dólar, en la convención de mercado
 * (EUR y GBP cotizan en dólares; el dólar cotiza en JPY y CHF). Sirve
 * para sugerir el par cuando el usuario escribe solo la moneda ('EUR').
 */
export const CURRENCY_TO_FX_PAIR: Readonly<Record<string, FxPair>> = Object.freeze({
  EUR: 'EURUSD',
  GBP: 'GBPUSD',
  JPY: 'USDJPY',
  CHF: 'USDCHF',
});

/** Seis letras con un separador opcional entre las dos monedas: 'EURUSD', 'EUR/USD', 'eur-usd'. */
const FX_PAIR_INPUT = /^([A-Za-z]{3})\s*[/\-_ ]?\s*([A-Za-z]{3})$/;
const STORED_PAIR = /^[A-Z]{6}$/;

/** true si `value` es un par admitido en su forma guardada ('EURUSD', no 'EUR/USD' ni 'eurusd'). */
export function isFxPair(value: unknown): value is FxPair {
  return typeof value === 'string' && (FX_PAIRS as readonly string[]).includes(value);
}

/**
 * Forma guardada de lo que escribe el usuario ('EUR/USD', 'eurusd',
 * ' EUR-USD ') o null si no es un par admitido.
 */
export function normalizeFxPair(input: unknown): FxPair | null {
  if (typeof input !== 'string') return null;
  const match = FX_PAIR_INPUT.exec(input.trim());
  if (!match) return null;
  const pair = `${match[1]}${match[2]}`.toUpperCase();
  return isFxPair(pair) ? pair : null;
}

/** 'EURUSD' → 'EUR/USD'. Lo que no sean seis letras mayúsculas se devuelve tal cual. */
export function formatFxPair(pair: string): string {
  return STORED_PAIR.test(pair) ? `${pair.slice(0, 3)}/${pair.slice(3)}` : pair;
}

/** Monedas base y cotizada de un par: 'EURUSD' → { base: 'EUR', quote: 'USD' }. */
export function fxPairCurrencies(pair: FxPair): { base: string; quote: string } {
  return { base: pair.slice(0, 3), quote: pair.slice(3) };
}

/** Par que sigue una moneda frente al dólar ('eur' → 'EURUSD'), o null si no hay. */
export function fxPairForCurrency(code: unknown): FxPair | null {
  if (typeof code !== 'string') return null;
  const key = code.trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(CURRENCY_TO_FX_PAIR, key)
    ? (CURRENCY_TO_FX_PAIR[key] ?? null)
    : null;
}

/**
 * Tipo de activo de un símbolo guardado cuando no viene indicado: 'fx'
 * para los pares admitidos, 'equity' para todo lo demás.
 */
export function inferAssetClass(symbol: string): AssetClass {
  return isFxPair(symbol.trim().toUpperCase()) ? 'fx' : 'equity';
}

/** Símbolo para mostrar: 'EUR/USD' para un par, el ticker tal cual para una acción. */
export function formatAssetSymbol(symbol: string, assetClass: AssetClass): string {
  return assetClass === 'fx' ? formatFxPair(symbol) : symbol;
}
