/**
 * Operativa de divisas: dónde se opera cada par y con qué reglas.
 *
 * Solo funciones puras y constantes, compartidas por main y renderer.
 *
 * Reglas (ver docs/senales.md, «Divisas»):
 * - Las divisas se operan solo en la cartera simulada interna de la app.
 *   Ninguna orden de divisas llega al bróker, ni en paper ni con dinero
 *   real: el bróker conectado (Alpaca) no opera divisas.
 * - Solo se operan los pares cotizados en USD (EURUSD, GBPUSD): el
 *   tamaño va en unidades de la moneda base y el precio en dólares, así
 *   que exposición y P&L salen directamente en la divisa de la cuenta
 *   (USD) con la misma aritmética que una acción.
 * - Los pares cotizados en otra moneda (USDJPY, USDCHF) tienen régimen,
 *   predicción y señales, pero no abren posición: su P&L estaría en JPY
 *   o CHF y la cartera no convierte divisas todavía.
 * - Para los límites de exposición, un par expone la cartera a su moneda
 *   base (EUR en EURUSD) y cuenta en el sector `FX_SECTOR`.
 */
import { fxPairCurrencies, isFxPair } from './fx';

/** Divisa de la cuenta de la cartera simulada (y del P&L). */
export const PAPER_ACCOUNT_CURRENCY = 'USD';

/** Sector con el que cuentan los pares para el límite de exposición sectorial. */
export const FX_SECTOR = 'divisas';

/** Motivo por el que un par no cotizado en USD no abre posición. */
export const FX_ANALYSIS_ONLY_REASON = 'par no cotizado en USD: solo análisis por ahora';

/** Código del rechazo de una orden de divisas hacia el bróker (viaja en el mensaje). */
export const FX_BROKER_REJECTION_CODE = 'divisa-sin-broker';

/** Motivo legible del rechazo de una orden de divisas hacia el bróker. */
export const FX_BROKER_REJECTION_REASON =
  'el bróker conectado no opera divisas: se opera solo en la cartera simulada';

/**
 * Mensaje del rechazo tal como sale en errores y motivos: el código va
 * dentro del texto porque las propiedades de un error se pierden al
 * cruzar el IPC de Electron.
 */
export const FX_BROKER_REJECTION_MESSAGE = `[${FX_BROKER_REJECTION_CODE}] ${FX_BROKER_REJECTION_REASON}`;

/**
 * Coste de ejecución de los pares en el backtest: deslizamiento fijo de
 * 2 pb por ejecución, siempre en contra, sin comisión ni spread aparte.
 * Los 2 pb cubren el diferencial típico de EUR/USD y GBP/USD en un
 * proveedor minorista (0,1–1,5 pips ≈ 0,1–1,4 pb) más el deslizamiento
 * de una orden de mercado; en la cartera simulada no hay comisión.
 */
export const FX_BACKTEST_COSTS = Object.freeze({
  commissionPct: 0,
  commissionMin: 0,
  slippageBps: 2,
  spreadBps: 0,
});

/** Destino de una señal: dónde puede operarse. */
export const SIGNAL_DESTINATIONS = ['cartera-simulada', 'solo-analisis'] as const;
export type SignalDestination = (typeof SIGNAL_DESTINATIONS)[number];

const normalize = (symbol: string): string => symbol.trim().toUpperCase();

/** true si el símbolo (en cualquier capitalización) es un par admitido. */
export function isFxSymbol(symbol: string): boolean {
  return isFxPair(normalize(symbol));
}

/** true si es un par admitido cotizado en USD (EURUSD, GBPUSD). */
export function isUsdQuotedFxPair(symbol: string): boolean {
  const pair = normalize(symbol);
  return isFxPair(pair) && fxPairCurrencies(pair).quote === PAPER_ACCOUNT_CURRENCY;
}

/**
 * Moneda a la que expone una posición del símbolo: la base de un par
 * ('EUR' en EURUSD) o la divisa de la cuenta para todo lo demás.
 */
export function exposureCurrencyOf(symbol: string): string {
  const pair = normalize(symbol);
  return isFxPair(pair) ? fxPairCurrencies(pair).base : PAPER_ACCOUNT_CURRENCY;
}

/**
 * Destino de la señal de un activo y, si no se opera, el motivo:
 * acciones y pares cotizados en USD → 'cartera-simulada'; pares
 * cotizados en otra moneda → 'solo-analisis'.
 */
export function signalDestinationOf(symbol: string): {
  destination: SignalDestination;
  reason: string | null;
} {
  if (isFxSymbol(symbol) && !isUsdQuotedFxPair(symbol)) {
    return { destination: 'solo-analisis', reason: FX_ANALYSIS_ONLY_REASON };
  }
  return { destination: 'cartera-simulada', reason: null };
}
