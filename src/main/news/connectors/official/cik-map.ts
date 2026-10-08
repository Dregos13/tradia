/**
 * Mapa ticker → CIK de la SEC para el universo inicial — Fase 1b.
 *
 * El CIK (Central Index Key) identifica al declarante en EDGAR; el
 * conector `sec-edgar` filtra los feeds de 8-K y Form 4 por estos CIKs.
 * Los valores salen de los ficheros oficiales `company_tickers.json` y
 * `company_tickers_mf.json` de la SEC (octubre 2026).
 *
 * Ojo con los ETF: declara el fondo fiduciario, no el valor — IWM y TLT
 * comparten el CIK de iShares Trust y los sectoriales el de Select Sector
 * SPDR Trust, así que sus feeds traen los filings de todo el fondo.
 * XOM apunta a ExxonMobil Holdings Corp, el declarante actual del ticker.
 */

/** CIK rellenado a 10 dígitos, como lo quiere EDGAR en la URL. */
export const TICKER_TO_CIK: Readonly<Record<string, string>> = {
  // ETF del universo inicial
  SPY: '0000884394', // SPDR S&P 500 ETF Trust
  QQQ: '0001067839', // Invesco QQQ Trust
  DIA: '0001041130', // SPDR Dow Jones Industrial Average ETF Trust
  IWM: '0001100663', // iShares Trust
  VTI: '0000036405', // Vanguard Index Funds
  XLF: '0001064641', // Select Sector SPDR Trust
  XLK: '0001064641',
  XLE: '0001064641',
  XLV: '0001064641',
  TLT: '0001100663', // iShares Trust
  // Acciones del universo inicial
  AAPL: '0000320193',
  MSFT: '0000789019',
  NVDA: '0001045810',
  AMZN: '0001018724',
  GOOGL: '0001652044', // Alphabet Inc.
  META: '0001326801',
  JPM: '0000019617',
  XOM: '0002115436', // ExxonMobil Holdings Corp (declarante actual de XOM)
  JNJ: '0000200406',
  PG: '0000080424',
  V: '0001403161',
  HD: '0000354950',
  KO: '0000021344',
  AVGO: '0001730168',
  AMD: '0000002488',
};

const CIK_TO_TICKERS: ReadonlyMap<string, string[]> = (() => {
  const byCik = new Map<string, string[]>();
  for (const [ticker, cik] of Object.entries(TICKER_TO_CIK)) {
    const list = byCik.get(cik) ?? [];
    list.push(ticker);
    byCik.set(cik, list);
  }
  return byCik;
})();

export const CIK_PATTERN = /^\d{1,10}$/;

/** Normaliza un CIK a 10 dígitos con ceros; null si no es un CIK válido. */
export function normalizeCik(value: unknown): string | null {
  const raw =
    typeof value === 'number' && Number.isInteger(value)
      ? String(value)
      : typeof value === 'string'
        ? value.trim()
        : '';
  return CIK_PATTERN.test(raw) ? raw.padStart(10, '0') : null;
}

/** CIK de 10 dígitos de un ticker del universo inicial; null si no consta. */
export function cikForTicker(ticker: string): string | null {
  return TICKER_TO_CIK[ticker.trim().toUpperCase()] ?? null;
}

/**
 * Tickers del universo inicial que declaran con ese CIK (varios ETF del
 * mismo fideicomiso comparten CIK). Vacío si el CIK no está en el mapa.
 */
export function tickersForCik(cik: string): string[] {
  const normalized = normalizeCik(cik);
  return normalized === null ? [] : [...(CIK_TO_TICKERS.get(normalized) ?? [])];
}
