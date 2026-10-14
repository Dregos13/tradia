/**
 * Búsqueda de activos para el buscador de Mercado (`market:search`).
 *
 * El catálogo (`catalog.ts`) es local y estático: la búsqueda no toca la
 * red ni el proveedor, así funciona igual sin conexión y sin clave de
 * API. Filtra por símbolo (con o sin separador: 'EURUSD' y 'EUR/USD'
 * encuentran el par) y por nombre (sin distinguir tildes: 'dolar'
 * encuentra 'Dólar'). Si la consulta es un símbolo válido que no está
 * en el catálogo, `directTicker` lo devuelve en su forma guardada para
 * que el alta siga siendo posible con un clic.
 *
 * La lógica es pura (sin Electron) para que el adaptador simulado del
 * renderer pueda responder igual; `registerMarketSearch` solo suelda el
 * canal IPC, con `ipcMain` inyectado para no acoplar el módulo.
 */
import type { IpcMain } from 'electron';

import { formatFxPair, fxPairForCurrency, isFxPair, normalizeFxPair } from '../../shared/fx';
import {
  IPC_CHANNELS,
  normalizeAssetSymbol,
  type AssetSearchMatch,
  type AssetSearchResult,
} from '../../shared/ipc';
import { ASSET_CATALOG, type CatalogAsset } from './catalog';

/** Máximo de coincidencias del desplegable (más allá hay que afinar). */
export const SEARCH_MAX_RESULTS = 12;
/** Tope de la consulta entrante (defensa ante pegados enormes). */
export const SEARCH_QUERY_MAX_LENGTH = 60;

/**
 * Comparación sin tildes ni mayúsculas: 'dolar' ≡ 'Dólar'. NFD separa
 * la letra del acento y se descarta la marca diacrítica.
 */
const fold = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toUpperCase();

/** Consulta como símbolo: sin espacios ni separadores ('eur/usd' → 'EURUSD'). */
const compactQuery = (query: string): string => fold(query).replace(/[\s/_-]+/g, '');

/**
 * Puntuación de una entrada: menor es mejor, -1 la descarta.
 * 0: símbolo exacto · 1: el símbolo empieza por la consulta ·
 * 2: el símbolo la contiene · 3: el nombre la contiene.
 */
const scoreMatch = (asset: CatalogAsset, queryFolded: string, queryCompact: string): number => {
  if (queryCompact === '') return -1;
  if (asset.ticker === queryCompact) return 0;
  if (asset.ticker.startsWith(queryCompact)) return 1;
  if (asset.ticker.includes(queryCompact)) return 2;
  return fold(asset.name).includes(queryFolded) ? 3 : -1;
};

/**
 * Coincidencias del catálogo para una consulta de texto libre, mejor
 * primero (exactas, prefijos del símbolo, símbolo que la contiene y por
 * último el nombre). Cuando la consulta es un símbolo válido fuera del
 * catálogo el resultado lo trae en `directTicker`, ya en su forma
 * guardada, para poder añadirlo igualmente con `watchlist:add`.
 */
export function searchAssets(query: string): AssetSearchResult {
  const trimmed = query.trim();
  const folded = fold(trimmed);
  const compact = compactQuery(trimmed);

  const scored = ASSET_CATALOG.map(
    (asset, index) => [scoreMatch(asset, folded, compact), index, asset] as const,
  )
    .filter(([score]) => score >= 0)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const matches: AssetSearchMatch[] = scored.slice(0, SEARCH_MAX_RESULTS).map(([, , asset]) => ({
    ticker: asset.ticker,
    display: isFxPair(asset.ticker) ? formatFxPair(asset.ticker) : asset.ticker,
    name: asset.name,
    assetClass: asset.assetClass,
  }));

  // Símbolo directo añadible: la consulta ya es un símbolo válido que el
  // catálogo no trajo (o un par en forma escrita: 'eur/usd' → 'EURUSD').
  // Un código de moneda suelto ('EUR') no vale como directTicker: la
  // intención es el par, que ya entra por `matches`.
  const direct = normalizeAssetSymbol(trimmed) ?? normalizeFxPair(compact);
  const inMatches = direct !== null && matches.some((m) => m.ticker === direct);
  const directTicker =
    direct !== null && !inMatches && fxPairForCurrency(trimmed) === null ? direct : null;

  return { query: trimmed, matches, directTicker };
}

/**
 * Registra el handler IPC de `market:search`. Una consulta no válida o
 * gigante no lanza: devuelve el resultado vacío, porque el buscador la
 * llama a cada pulsación.
 */
export function registerMarketSearch(ipcMain: Pick<IpcMain, 'handle'>): void {
  ipcMain.handle(IPC_CHANNELS.market.search, (_event, query: unknown) => {
    if (typeof query !== 'string' || query.length > SEARCH_QUERY_MAX_LENGTH) {
      return {
        query: typeof query === 'string' ? query.trim() : '',
        matches: [],
        directTicker: null,
      };
    }
    return searchAssets(query);
  });
}
