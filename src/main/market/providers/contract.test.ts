/**
 * Pruebas del contrato MarketDataProvider, ejecutadas igual sobre todos los
 * adaptadores (simulado y Tiingo con respuestas grabadas): si un adaptador
 * nuevo se añade a la lista, hereda las mismas garantías.
 */
import { describe, expect, it } from 'vitest';

import aaplPrices from './__fixtures__/aapl-prices.json';
import { createSimulatedProvider } from './simulated';
import { createTiingoProvider } from './tiingo';
import {
  ISO_DATE_PATTERN,
  MARKET_DATA_ERROR_KINDS,
  MarketDataError,
  isMarketDataError,
  type Bar,
  type MarketDataProvider,
} from './types';

/** fetch que siempre responde la grabación de precios de AAPL. */
const fixtureFetch: typeof fetch = async () =>
  new Response(JSON.stringify(aaplPrices), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const SIMULATED_NOW = Date.parse('2024-06-14T12:00:00.000Z');

const adapters: Array<{ name: string; make: () => MarketDataProvider }> = [
  {
    name: 'simulated',
    make: () => createSimulatedProvider({ seed: 'contract', now: () => SIMULATED_NOW }),
  },
  {
    name: 'tiingo',
    make: () =>
      createTiingoProvider({
        fetch: fixtureFetch,
        getApiKey: async () => 'TEST-API-KEY',
        // La grabación es de 2020: el reloj inyectado fija la ventana de
        // getQuote en ese rango.
        now: () => Date.parse('2020-09-05T12:00:00.000Z'),
      }),
  },
];

const RANGE: [string, string] = ['2020-08-01', '2020-09-05'];

function assertBarShape(bar: Bar): void {
  expect(bar.date).toMatch(ISO_DATE_PATTERN);
  for (const field of ['open', 'high', 'low', 'close', 'adjClose'] as const) {
    expect(Number.isFinite(bar[field]), `${field} finito en ${bar.date}`).toBe(true);
  }
  expect(bar.high).toBeGreaterThanOrEqual(bar.low);
  expect(bar.volume).toBeGreaterThanOrEqual(0);
  expect(bar.splitFactor).toBeGreaterThan(0);
  expect(bar.dividend).toBeGreaterThanOrEqual(0);
}

describe.each(adapters)('contrato MarketDataProvider — $name', ({ make }) => {
  it('expone id y límites de uso por hora y por día', () => {
    const provider = make();
    expect(provider.id).toEqual(expect.any(String));
    expect(provider.id.length).toBeGreaterThan(0);
    expect(provider.rateLimits.perHour).toBeGreaterThan(0);
    expect(provider.rateLimits.perDay).toBeGreaterThan(0);
  });

  it('getBars devuelve velas válidas en orden ascendente', async () => {
    const provider = make();
    const bars = await provider.getBars('AAPL', RANGE[0], RANGE[1]);
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) assertBarShape(bar);
    const dates = bars.map((b) => b.date);
    expect([...dates].sort()).toEqual(dates);
    for (const date of dates) {
      expect(date >= RANGE[0] && date <= RANGE[1]).toBe(true);
    }
  });

  it('getQuote devuelve la última cotización del ticker', async () => {
    const provider = make();
    const quote = await provider.getQuote('AAPL');
    expect(quote.ticker).toBe('AAPL');
    expect(quote.date).toMatch(ISO_DATE_PATTERN);
    expect(quote.last).toBeGreaterThan(0);
  });

  it('getCorporateActions devuelve una lista de acciones válidas', async () => {
    const provider = make();
    const actions = await provider.getCorporateActions('AAPL', RANGE[0], RANGE[1]);
    expect(Array.isArray(actions)).toBe(true);
    for (const action of actions) {
      expect(action.ticker).toBe('AAPL');
      expect(action.date).toMatch(ISO_DATE_PATTERN);
      expect(['split', 'dividend']).toContain(action.kind);
      expect(action.value).toBeGreaterThan(0);
    }
  });

  it('rechaza entradas inválidas con error bad-data tipado', async () => {
    const provider = make();
    await expect(provider.getBars('!!!', RANGE[0], RANGE[1])).rejects.toMatchObject({
      name: 'MarketDataError',
      kind: 'bad-data',
    });
    await expect(provider.getBars('AAPL', '2020-09-05', '2020-08-01')).rejects.toMatchObject({
      kind: 'bad-data',
    });
    await expect(provider.getBars('AAPL', '01-08-2020', RANGE[1])).rejects.toMatchObject({
      kind: 'bad-data',
    });
    await expect(provider.getBars('AAPL', '2020-02-30', RANGE[1])).rejects.toMatchObject({
      kind: 'bad-data',
    });
  });

  it('los errores son MarketDataError con kind tipado y flag retryable', async () => {
    const provider = make();
    const error = await provider.getBars('!!!', RANGE[0], RANGE[1]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MarketDataError);
    expect(isMarketDataError(error)).toBe(true);
    expect(isMarketDataError(error, 'bad-data')).toBe(true);
    expect(isMarketDataError(error, 'auth')).toBe(false);
    expect(MARKET_DATA_ERROR_KINDS).toContain((error as MarketDataError).kind);
    // Solo rate-limit y network son reintentables.
    expect((error as MarketDataError).retryable).toBe(false);
    expect(new MarketDataError('network', 'x', { provider: 't' }).retryable).toBe(true);
    expect(new MarketDataError('rate-limit', 'x', { provider: 't' }).retryable).toBe(true);
    expect(new MarketDataError('auth', 'x', { provider: 't' }).retryable).toBe(false);
  });
});
