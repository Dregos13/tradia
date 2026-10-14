/**
 * Catálogo local de activos buscables (`market:search`).
 *
 * Tabla estática y deliberadamente corta: el universo inicial completo,
 * los pares de divisas admitidos (`shared/fx.FX_PAIRS`), los ETF de
 * divisa que los replican (`shared/suggestions`) y una selección de
 * acciones y ETF de EE. UU. de gran capitalización que el proveedor
 * (Tiingo) cubre. No pretende listar todo el mercado: si la consulta es
 * un símbolo válido fuera del catálogo, `searchAssets` lo devuelve como
 * `directTicker` para que el alta siga siendo posible.
 *
 * Solo datos, sin lógica.
 */
import { formatFxPair, FX_PAIRS } from '../../shared/fx';
import type { AssetSearchClass } from '../../shared/ipc';

export interface CatalogAsset {
  /** Símbolo en su forma guardada ('AAPL', 'EURUSD'). */
  ticker: string;
  /** Nombre descriptivo para el usuario. */
  name: string;
  /** Clase de activo en la búsqueda. */
  assetClass: AssetSearchClass;
}

/** Pares de divisas admitidos, con su nombre para la búsqueda. */
const FX_NAMES: Readonly<Record<string, string>> = {
  EURUSD: 'Euro / Dólar estadounidense',
  GBPUSD: 'Libra esterlina / Dólar estadounidense',
  USDJPY: 'Dólar estadounidense / Yen japonés',
  USDCHF: 'Dólar estadounidense / Franco suizo',
};

/** Acciones del universo inicial y otras de gran capitalización. */
const STOCKS: ReadonlyArray<readonly [string, string]> = [
  ['AAPL', 'Apple Inc.'],
  ['MSFT', 'Microsoft Corporation'],
  ['NVDA', 'NVIDIA Corporation'],
  ['AMZN', 'Amazon.com Inc.'],
  ['GOOGL', 'Alphabet Inc. (Clase A)'],
  ['META', 'Meta Platforms Inc.'],
  ['JPM', 'JPMorgan Chase & Co.'],
  ['XOM', 'Exxon Mobil Corporation'],
  ['JNJ', 'Johnson & Johnson'],
  ['PG', 'Procter & Gamble Co.'],
  ['V', 'Visa Inc.'],
  ['HD', 'The Home Depot Inc.'],
  ['KO', 'The Coca-Cola Company'],
  ['AVGO', 'Broadcom Inc.'],
  ['AMD', 'Advanced Micro Devices Inc.'],
  ['TSLA', 'Tesla Inc.'],
  ['NFLX', 'Netflix Inc.'],
  ['INTC', 'Intel Corporation'],
  ['CSCO', 'Cisco Systems Inc.'],
  ['PFE', 'Pfizer Inc.'],
  ['DIS', 'The Walt Disney Company'],
  ['BA', 'The Boeing Company'],
  ['WMT', 'Walmart Inc.'],
  ['COST', 'Costco Wholesale Corporation'],
  ['MCD', "McDonald's Corporation"],
  ['NKE', 'Nike Inc.'],
  ['ABBV', 'AbbVie Inc.'],
  ['CRM', 'Salesforce Inc.'],
  ['ORCL', 'Oracle Corporation'],
  ['ADBE', 'Adobe Inc.'],
  ['PYPL', 'PayPal Holdings Inc.'],
  ['UBER', 'Uber Technologies Inc.'],
  ['COIN', 'Coinbase Global Inc.'],
  ['PLTR', 'Palantir Technologies Inc.'],
  ['LLY', 'Eli Lilly and Company'],
  ['UNH', 'UnitedHealth Group Inc.'],
  ['BRK.B', 'Berkshire Hathaway Inc. (Clase B)'],
  ['MA', 'Mastercard Inc.'],
  ['BAC', 'Bank of America Corporation'],
  ['WFC', 'Wells Fargo & Company'],
  ['GS', 'The Goldman Sachs Group Inc.'],
  ['MS', 'Morgan Stanley'],
  ['CAT', 'Caterpillar Inc.'],
  ['GE', 'GE Aerospace'],
  ['F', 'Ford Motor Company'],
  ['GM', 'General Motors Company'],
  ['RTX', 'RTX Corporation'],
  ['LMT', 'Lockheed Martin Corporation'],
  ['DE', 'Deere & Company'],
  ['ABT', 'Abbott Laboratories'],
  ['PEP', 'PepsiCo Inc.'],
  ['QCOM', 'Qualcomm Inc.'],
  ['TXN', 'Texas Instruments Inc.'],
  ['IBM', 'International Business Machines Corporation'],
  ['INTU', 'Intuit Inc.'],
  ['AMGN', 'Amgen Inc.'],
  ['NOW', 'ServiceNow Inc.'],
  ['T', 'AT&T Inc.'],
  ['VZ', 'Verizon Communications Inc.'],
  ['CMCSA', 'Comcast Corporation'],
  ['SBUX', 'Starbucks Corporation'],
  ['TGT', 'Target Corporation'],
  ['LOW', "Lowe's Companies Inc."],
  ['AXP', 'American Express Company'],
  ['SCHW', 'The Charles Schwab Corporation'],
  ['BLK', 'BlackRock Inc.'],
  ['CVX', 'Chevron Corporation'],
  ['COP', 'ConocoPhillips'],
  ['MRK', 'Merck & Co. Inc.'],
  ['BMY', 'Bristol-Myers Squibb Company'],
  ['GILD', 'Gilead Sciences Inc.'],
];

/** ETF del universo inicial, de divisas y otros líquidos. */
const ETFS: ReadonlyArray<readonly [string, string]> = [
  ['SPY', 'SPDR S&P 500 ETF Trust'],
  ['QQQ', 'Invesco QQQ Trust'],
  ['DIA', 'SPDR Dow Jones Industrial Average ETF Trust'],
  ['IWM', 'iShares Russell 2000 ETF'],
  ['VTI', 'Vanguard Total Stock Market ETF'],
  ['XLF', 'Financial Select Sector SPDR Fund'],
  ['XLK', 'Technology Select Sector SPDR Fund'],
  ['XLE', 'Energy Select Sector SPDR Fund'],
  ['XLV', 'Health Care Select Sector SPDR Fund'],
  ['TLT', 'iShares 20+ Year Treasury Bond ETF'],
  ['XLU', 'Utilities Select Sector SPDR Fund'],
  ['XLP', 'Consumer Staples Select Sector SPDR Fund'],
  ['XLI', 'Industrial Select Sector SPDR Fund'],
  ['XLB', 'Materials Select Sector SPDR Fund'],
  ['XLRE', 'Real Estate Select Sector SPDR Fund'],
  ['XLC', 'Communication Services Select Sector SPDR Fund'],
  ['VOO', 'Vanguard S&P 500 ETF'],
  ['GLD', 'SPDR Gold Shares'],
  ['SLV', 'iShares Silver Trust'],
  ['EEM', 'iShares MSCI Emerging Markets ETF'],
  ['HYG', 'iShares iBoxx $ High Yield Corporate Bond ETF'],
  ['LQD', 'iShares iBoxx $ Investment Grade Corporate Bond ETF'],
  ['ARKK', 'ARK Innovation ETF'],
  // ETF que replican divisas (sustitutos clásicos del par).
  ['FXE', 'Invesco CurrencyShares Euro Trust'],
  ['FXB', 'Invesco CurrencyShares British Pound Sterling Trust'],
  ['FXY', 'Invesco CurrencyShares Japanese Yen Trust'],
  ['FXF', 'Invesco CurrencyShares Swiss Franc Trust'],
  ['VGK', 'Vanguard FTSE Europe ETF'],
  ['EZU', 'iShares MSCI Eurozone ETF'],
];

/**
 * Catálogo completo: divisas primero (son las que el usuario pidió
 * explícitamente), después acciones y ETF. El orden dentro de cada grupo
 * es el de prioridad al desempatar coincidencias.
 */
export const ASSET_CATALOG: readonly CatalogAsset[] = [
  ...FX_PAIRS.map((ticker): CatalogAsset => ({
    ticker,
    name: FX_NAMES[ticker] ?? `Par de divisas ${formatFxPair(ticker)}`,
    assetClass: 'divisa',
  })),
  ...STOCKS.map(([ticker, name]): CatalogAsset => ({ ticker, name, assetClass: 'accion' })),
  ...ETFS.map(([ticker, name]): CatalogAsset => ({ ticker, name, assetClass: 'etf' })),
];
