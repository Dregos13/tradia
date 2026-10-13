/**
 * La tabla vive en `shared/suggestions.ts` (la usa también el adaptador
 * del renderer); este archivo solo la reexporta para no mover los
 * importadores del dominio de mercado.
 */
export { TICKER_SUGGESTIONS, tickerSuggestions } from '../../../shared/suggestions';
