import { describe, expect, it } from 'vitest';

import {
  CURRENCY_TO_FX_PAIR,
  formatAssetSymbol,
  formatFxPair,
  FX_PAIRS,
  fxPairCurrencies,
  fxPairForCurrency,
  inferAssetClass,
  isFxPair,
  normalizeFxPair,
} from './fx';
import { ASSET_CLASSES, DEFAULT_ASSET_CLASS, isAssetClass, isTicker } from './ipc';

describe('tipo de activo', () => {
  it('admite solo equity y fx, con equity por defecto', () => {
    expect(ASSET_CLASSES).toEqual(['equity', 'fx']);
    expect(DEFAULT_ASSET_CLASS).toBe('equity');
    expect(isAssetClass('equity')).toBe(true);
    expect(isAssetClass('fx')).toBe(true);
    expect(isAssetClass('FX')).toBe(false);
    expect(isAssetClass('crypto')).toBe(false);
    expect(isAssetClass(null)).toBe(false);
  });

  it('infiere fx solo para los pares admitidos', () => {
    expect(inferAssetClass('EURUSD')).toBe('fx');
    expect(inferAssetClass(' eurusd ')).toBe('fx');
    expect(inferAssetClass('USDJPY')).toBe('fx');
    expect(inferAssetClass('EUR')).toBe('equity');
    expect(inferAssetClass('FXE')).toBe('equity');
    expect(inferAssetClass('AAPL')).toBe('equity');
    // Seis letras que no son un par admitido siguen siendo un ticker.
    expect(inferAssetClass('GOOGLE')).toBe('equity');
    expect(inferAssetClass('EURJPY')).toBe('equity');
  });
});

describe('pares de divisas', () => {
  it('admite al menos EURUSD, GBPUSD, USDJPY y USDCHF', () => {
    expect(FX_PAIRS).toEqual(expect.arrayContaining(['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF']));
    // La forma guardada también es un ticker válido para el contrato IPC.
    for (const pair of FX_PAIRS) expect(isTicker(pair)).toBe(true);
  });

  it('isFxPair solo acepta la forma guardada de un par admitido', () => {
    expect(isFxPair('EURUSD')).toBe(true);
    expect(isFxPair('USDCHF')).toBe(true);
    expect(isFxPair('EUR/USD')).toBe(false);
    expect(isFxPair('eurusd')).toBe(false);
    expect(isFxPair('USDEUR')).toBe(false);
    expect(isFxPair('EUR')).toBe(false);
    expect(isFxPair(42)).toBe(false);
  });

  it('normaliza lo que escribe el usuario a la forma guardada', () => {
    expect(normalizeFxPair('EUR/USD')).toBe('EURUSD');
    expect(normalizeFxPair(' eur/usd ')).toBe('EURUSD');
    expect(normalizeFxPair('EURUSD')).toBe('EURUSD');
    expect(normalizeFxPair('gbp-usd')).toBe('GBPUSD');
    expect(normalizeFxPair('USD JPY')).toBe('USDJPY');
    expect(normalizeFxPair('USD / CHF')).toBe('USDCHF');
    // Pares no admitidos o invertidos, monedas sueltas y basura: null.
    expect(normalizeFxPair('USD/EUR')).toBeNull();
    expect(normalizeFxPair('AUD/USD')).toBeNull();
    expect(normalizeFxPair('EUR')).toBeNull();
    expect(normalizeFxPair('EUR//USD')).toBeNull();
    expect(normalizeFxPair('')).toBeNull();
    expect(normalizeFxPair(undefined)).toBeNull();
  });

  it('se muestra con barra y se descompone en base y cotizada', () => {
    expect(formatFxPair('EURUSD')).toBe('EUR/USD');
    expect(formatFxPair('USDJPY')).toBe('USD/JPY');
    // Lo que no es un par guardado se devuelve tal cual.
    expect(formatFxPair('AAPL')).toBe('AAPL');
    expect(formatFxPair('BRK.B')).toBe('BRK.B');
    expect(fxPairCurrencies('EURUSD')).toEqual({ base: 'EUR', quote: 'USD' });
    expect(fxPairCurrencies('USDCHF')).toEqual({ base: 'USD', quote: 'CHF' });
  });

  it('formatAssetSymbol solo cambia los símbolos de divisas', () => {
    expect(formatAssetSymbol('EURUSD', 'fx')).toBe('EUR/USD');
    expect(formatAssetSymbol('AAPL', 'equity')).toBe('AAPL');
  });
});

describe('moneda → par', () => {
  it('lleva cada moneda a su par frente al dólar en la convención de mercado', () => {
    expect(CURRENCY_TO_FX_PAIR).toEqual({
      EUR: 'EURUSD',
      GBP: 'GBPUSD',
      JPY: 'USDJPY',
      CHF: 'USDCHF',
    });
    for (const pair of Object.values(CURRENCY_TO_FX_PAIR)) expect(isFxPair(pair)).toBe(true);
    expect(Object.isFrozen(CURRENCY_TO_FX_PAIR)).toBe(true);
  });

  it('fxPairForCurrency normaliza la moneda y no confunde claves heredadas', () => {
    expect(fxPairForCurrency('EUR')).toBe('EURUSD');
    expect(fxPairForCurrency(' eur ')).toBe('EURUSD');
    expect(fxPairForCurrency('jpy')).toBe('USDJPY');
    expect(fxPairForCurrency('USD')).toBeNull();
    expect(fxPairForCurrency('AAPL')).toBeNull();
    expect(fxPairForCurrency('constructor')).toBeNull();
    expect(fxPairForCurrency('toString')).toBeNull();
    expect(fxPairForCurrency(null)).toBeNull();
  });
});
