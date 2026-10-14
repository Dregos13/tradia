/**
 * Alternativas operables para símbolos que Tiingo no cubre.
 *
 * El tramo de Tiingo que usa la app (precios diarios) solo cubre acciones
 * y ETF de EE. UU.: quien escribe un código de divisa suele querer un ETF
 * que la replique. La tabla es estática y deliberadamente corta: cada
 * alternativa debe existir de verdad en el proveedor.
 *
 * La usa la vigilancia (`health.ts`) para rellenar `suggestion` en la
 * lista `uncovered` del resumen de frescura, y la validación de altas
 * (watchlist) para proponer sustitutos al rechazar un ticker — allí la
 * alternativa primera es el par de divisas (`fxPairForCurrency`), seguida
 * de estos ETF.
 */

/** Símbolo no cubierto → alternativas operables, mejor opción primero. */
export const TICKER_SUGGESTIONS: Readonly<Record<string, readonly string[]>> = {
  // Divisas → ETF que las replica (CurrencyShares/Invesco).
  EUR: ['FXE'],
  GBP: ['FXB'],
  JPY: ['FXY'],
  CHF: ['FXF'],
  // «Bolsa europea» como símbolo genérico → ETF del mercado europeo.
  EUROPE: ['VGK', 'EZU'],
  EUROPA: ['VGK', 'EZU'],
} as const;

/**
 * Alternativas conocidas para un símbolo sin cobertura, en orden de
 * preferencia (la primera es la sugerencia principal). Vacío si no hay.
 */
export function tickerSuggestions(ticker: string): readonly string[] {
  return TICKER_SUGGESTIONS[ticker.trim().toUpperCase()] ?? [];
}
