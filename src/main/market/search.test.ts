import { describe, expect, it } from 'vitest';

import { isFxPair } from '../../shared/fx';
import { IPC_CHANNELS } from '../../shared/ipc';
import { ASSET_CATALOG } from './catalog';
import { registerMarketSearch, SEARCH_MAX_RESULTS, searchAssets } from './search';

describe('catálogo de activos', () => {
  it('cubre las clases requeridas: acciones, ETF y divisas (EUR/USD)', () => {
    const classes = new Set(ASSET_CATALOG.map((asset) => asset.assetClass));
    expect(classes).toEqual(new Set(['accion', 'etf', 'divisa']));
    expect(ASSET_CATALOG.some((a) => a.ticker === 'EURUSD' && a.assetClass === 'divisa')).toBe(
      true,
    );
  });

  it('los símbolos son únicos y están en su forma guardada', () => {
    const tickers = ASSET_CATALOG.map((a) => a.ticker);
    expect(new Set(tickers).size).toBe(tickers.length);
    for (const asset of ASSET_CATALOG) {
      expect(asset.ticker).toMatch(/^[A-Z0-9.]+$/);
      expect(asset.name.length).toBeGreaterThan(0);
      if (asset.assetClass === 'divisa') expect(isFxPair(asset.ticker)).toBe(true);
    }
  });
});

describe('searchAssets', () => {
  it('busca por símbolo exacto y por prefijo', () => {
    const aapl = searchAssets('AAPL');
    expect(aapl.matches[0]).toMatchObject({
      ticker: 'AAPL',
      display: 'AAPL',
      assetClass: 'accion',
    });
    // El símbolo exacto ya está en matches: no se repite como directTicker.
    expect(aapl.directTicker).toBeNull();

    const aa = searchAssets('AA');
    expect(aa.matches.some((m) => m.ticker === 'AAPL')).toBe(true);
  });

  it('busca por nombre sin distinguir tildes ni mayúsculas', () => {
    const apple = searchAssets('apple');
    expect(apple.matches.some((m) => m.ticker === 'AAPL')).toBe(true);

    const dolar = searchAssets('dolar');
    expect(dolar.matches.some((m) => m.ticker === 'EURUSD')).toBe(true);
  });

  it('encuentra EUR/USD por moneda, por símbolo compacto y con barra', () => {
    for (const query of ['EUR', 'eur', 'EURUSD', 'eurusd', 'EUR/USD', 'eur-usd']) {
      const result = searchAssets(query);
      expect(
        result.matches.some((m) => m.ticker === 'EURUSD'),
        `la consulta ${query} debe encontrar EUR/USD`,
      ).toBe(true);
      const eurusd = result.matches.find((m) => m.ticker === 'EURUSD');
      expect(eurusd?.display).toBe('EUR/USD');
      expect(eurusd?.assetClass).toBe('divisa');
    }
    // Un código de moneda suelto no es un ticker directo añadible:
    // la intención de 'EUR' es el par.
    expect(searchAssets('EUR').directTicker).toBeNull();
  });

  it('devuelve directTicker cuando la consulta es un símbolo válido fuera del catálogo', () => {
    const result = searchAssets('ZZZZ');
    expect(result.matches).toEqual([]);
    expect(result.directTicker).toBe('ZZZZ');
  });

  it('una consulta que no es símbolo ni nombre devuelve resultado vacío', () => {
    for (const query of ['', '   ', '¿qué tal?', '!!!']) {
      expect(searchAssets(query)).toEqual({ query: query.trim(), matches: [], directTicker: null });
    }
  });

  it('acota las coincidencias a SEARCH_MAX_RESULTS', () => {
    // 'a' o 'e' concuerdan por nombre con media tabla o más.
    expect(searchAssets('a').matches.length).toBeLessThanOrEqual(SEARCH_MAX_RESULTS);
  });

  it('los filtros por clase funcionan vía nombre y símbolo', () => {
    // La clase se infiere del match: buscar 'etf' no es necesario, pero
    // cada clase llega etiquetada para que el frontend la filtre.
    const etfs = searchAssets('etf').matches;
    expect(etfs.every((m) => ['etf', 'accion'].includes(m.assetClass))).toBe(true);
  });
});

describe('registerMarketSearch', () => {
  it('registra el canal market:search y responde con el contrato', async () => {
    const handlers = new Map<string, (event: unknown, query: unknown) => unknown>();
    registerMarketSearch({
      handle: (channel, fn) => {
        handlers.set(channel, fn as (event: unknown, query: unknown) => unknown);
      },
    });
    const handler = handlers.get(IPC_CHANNELS.market.search);
    expect(handler).toBeTypeOf('function');
    const result = handler?.(null, 'EUR/USD') as ReturnType<typeof searchAssets>;
    expect(result.matches.some((m) => m.ticker === 'EURUSD')).toBe(true);
  });

  it('una consulta no válida devuelve vacío en vez de lanzar', () => {
    const handlers = new Map<string, (event: unknown, query: unknown) => unknown>();
    registerMarketSearch({
      handle: (channel, fn) => {
        handlers.set(channel, fn as (event: unknown, query: unknown) => unknown);
      },
    });
    const handler = handlers.get(IPC_CHANNELS.market.search)!;
    expect(handler(null, 42)).toEqual({ query: '', matches: [], directTicker: null });
    const big = handler(null, 'x'.repeat(500)) as ReturnType<typeof searchAssets>;
    expect(big.matches).toEqual([]);
  });
});
