import { formatAssetSymbol, inferAssetClass } from '../../../shared/fx';
import { isUsdQuotedFxPair } from '../../../shared/fxTrading';

export const assetSymbol = (ticker: string) => formatAssetSymbol(ticker, inferAssetClass(ticker));
export const fxLabel = (ticker: string) =>
  `Divisa · 24/5 · ${isUsdQuotedFxPair(ticker) ? 'cartera simulada' : 'solo análisis'}`;
export const FX_CALENDAR_HELP =
  'Divisas: calendario 24/5, de lunes a viernes. No se esperan datos en fin de semana; sí en los festivos de EE. UU. Las velas diarias se publican tras el cierre del día UTC.';
export const fxPrice = (value: number) =>
  new Intl.NumberFormat('es-ES', { minimumFractionDigits: 5, maximumFractionDigits: 5 }).format(
    value,
  );
