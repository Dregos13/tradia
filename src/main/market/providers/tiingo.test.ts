import { describe, expect, it, vi } from 'vitest';

import aaplLatest from './__fixtures__/aapl-latest.json';
import aaplPrices from './__fixtures__/aapl-prices.json';
import error401 from './__fixtures__/error-401.json';
import error404 from './__fixtures__/error-404.json';
import error429 from './__fixtures__/error-429.json';
import error500 from './__fixtures__/error-500.json';
import malformedPrices from './__fixtures__/malformed-prices.json';
import nvdaPrices from './__fixtures__/nvda-prices.json';
import { createRateLimiter, type RateLimiter } from './rateLimiter';
import { createTiingoProvider } from './tiingo';
import { isMarketDataError, type MarketDataErrorKind } from './types';

const API_KEY = 'tk-SECRETO-de-prueba-12345';

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

/** fetch simulado que graba las llamadas y devuelve la respuesta indicada. */
function fetchReturning(response: () => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return response();
  };
  return { fetch, calls };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const make = (
  fetch: typeof globalThis.fetch,
  extra: Partial<Parameters<typeof createTiingoProvider>[0]> = {},
) =>
  createTiingoProvider({
    fetch,
    getApiKey: async () => API_KEY,
    ...extra,
  });

describe('adaptador Tiingo', () => {
  it('mapea las filas grabadas a velas del contrato, ordenadas', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(aaplPrices));
    const provider = make(fetch);

    const bars = await provider.getBars('AAPL', '2020-08-01', '2020-09-05');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/tiingo/daily/AAPL/prices');
    expect(calls[0]!.url).toContain('startDate=2020-08-01');
    expect(calls[0]!.url).toContain('endDate=2020-09-05');
    expect(bars.map((b) => b.date)).toEqual([
      '2020-08-05',
      '2020-08-06',
      '2020-08-07',
      '2020-08-10',
      '2020-08-28',
      '2020-08-31',
      '2020-09-01',
    ]);
    const split = bars.find((b) => b.date === '2020-08-31')!;
    expect(split.splitFactor).toBe(4);
    const dividend = bars.find((b) => b.date === '2020-08-07')!;
    expect(dividend.dividend).toBe(0.82);
    // Todos los campos del contrato rellenos.
    for (const bar of bars) {
      expect(bar.adjClose).toBeGreaterThan(0);
      expect(Number.isFinite(bar.volume)).toBe(true);
    }
  });

  it('envía la clave en la cabecera Authorization, nunca en la URL', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(aaplPrices));
    const provider = make(fetch);
    await provider.getBars('AAPL', '2020-08-01', '2020-09-05');

    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Token ${API_KEY}`);
    expect(calls[0]!.url).not.toContain(API_KEY);
    expect(calls[0]!.url).not.toContain('token=');
  });

  it('getQuote devuelve la última vela de la ventana reciente', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(aaplLatest));
    const provider = make(fetch);
    const quote = await provider.getQuote('AAPL');
    expect(quote).toEqual({ ticker: 'AAPL', date: '2026-10-07', last: 232.18, volume: 39120500 });
  });

  it('getCorporateActions deriva split y dividendo de las filas', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(aaplPrices));
    const provider = make(fetch);
    const actions = await provider.getCorporateActions('AAPL', '2020-08-01', '2020-09-05');
    expect(actions).toEqual([
      { ticker: 'AAPL', date: '2020-08-07', kind: 'dividend', value: 0.82 },
      { ticker: 'AAPL', date: '2020-08-31', kind: 'split', value: 4 },
    ]);
  });

  it('lee el split 10:1 de NVDA de otra grabación', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(nvdaPrices));
    const provider = make(fetch);
    const actions = await provider.getCorporateActions('NVDA', '2024-06-01', '2024-06-30');
    expect(actions).toEqual([
      { ticker: 'NVDA', date: '2024-06-07', kind: 'dividend', value: 0.01 },
      { ticker: 'NVDA', date: '2024-06-10', kind: 'split', value: 10 },
    ]);
  });

  it('sin clave guardada falla con auth y no llama a la red', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(aaplPrices));
    const provider = make(fetch, { getApiKey: async () => null });
    await expect(provider.getBars('AAPL', '2020-08-01', '2020-09-05')).rejects.toMatchObject({
      name: 'MarketDataError',
      kind: 'auth',
      provider: 'tiingo',
    });
    expect(calls).toHaveLength(0);
  });

  it.each<[string, unknown, number, MarketDataErrorKind]>([
    ['401 → auth', error401, 401, 'auth'],
    ['404 → not-found', error404, 404, 'not-found'],
    ['429 → rate-limit', error429, 429, 'rate-limit'],
    ['500 → network', error500, 500, 'network'],
  ])('mapea el error HTTP %s', async (_label, body, status, kind) => {
    const { fetch } = fetchReturning(() => jsonResponse(body, status));
    const provider = make(fetch);
    const error = await provider
      .getBars('AAPL', '2020-08-01', '2020-09-05')
      .catch((e: unknown) => e);
    expect(isMarketDataError(error, kind)).toBe(true);
    expect((error as { status?: number }).status).toBe(status);
    expect((error as { retryable: boolean }).retryable).toBe(
      kind === 'rate-limit' || kind === 'network',
    );
  });

  it('429 trae la espera sugerida de la cabecera Retry-After', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(error429, 429, { 'Retry-After': '120' }));
    const provider = make(fetch);
    const error = await provider
      .getBars('AAPL', '2020-08-01', '2020-09-05')
      .catch((e: unknown) => e);
    expect(isMarketDataError(error, 'rate-limit')).toBe(true);
    expect((error as { retryAfterMs?: number }).retryAfterMs).toBe(120_000);
  });

  it('un fallo de transporte (fetch rechaza) es network', async () => {
    const { fetch } = fetchReturning(() => Promise.reject(new Error('socket hang up')));
    const provider = make(fetch);
    await expect(provider.getBars('AAPL', '2020-08-01', '2020-09-05')).rejects.toMatchObject({
      kind: 'network',
    });
  });

  it('una respuesta que no es JSON es bad-data', async () => {
    const { fetch } = fetchReturning(() => new Response('<html>error</html>', { status: 200 }));
    const provider = make(fetch);
    await expect(provider.getBars('AAPL', '2020-08-01', '2020-09-05')).rejects.toMatchObject({
      kind: 'bad-data',
    });
  });

  it('una respuesta 200 sin lista de precios es bad-data', async () => {
    const { fetch } = fetchReturning(() => jsonResponse({ detail: 'Error inesperado' }));
    const provider = make(fetch);
    await expect(provider.getBars('AAPL', '2020-08-01', '2020-09-05')).rejects.toMatchObject({
      kind: 'bad-data',
    });
  });

  it('una fila malformada (faltan campos) es bad-data', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(malformedPrices));
    const provider = make(fetch);
    await expect(provider.getBars('AAPL', '2020-08-01', '2020-09-05')).rejects.toMatchObject({
      kind: 'bad-data',
    });
  });

  it('una lista vacía devuelve [] sin error', async () => {
    const { fetch } = fetchReturning(() => jsonResponse([]));
    const provider = make(fetch);
    await expect(provider.getBars('AAPL', '2020-08-01', '2020-09-05')).resolves.toEqual([]);
  });

  it('consume el limitador de cuota antes de cada petición', async () => {
    const acquire = vi.fn(async () => {});
    const limiter: RateLimiter = {
      acquire,
      tryAcquire: () => true,
      remaining: () => ({ perHour: 50, perDay: 1000 }),
      waitTimeMs: () => 0,
    };
    const { fetch, calls } = fetchReturning(() => jsonResponse(aaplPrices));
    const provider = make(fetch, { rateLimiter: limiter });
    await provider.getBars('AAPL', '2020-08-01', '2020-09-05');
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(1);
  });

  it('si el limitador rechaza, no se lanza la petición', async () => {
    const limiter = createRateLimiter({
      limits: { perHour: 0, perDay: 0 },
      providerId: 'tiingo',
    });
    const { fetch, calls } = fetchReturning(() => jsonResponse(aaplPrices));
    const provider = make(fetch, { rateLimiter: limiter });
    await expect(provider.getBars('AAPL', '2020-08-01', '2020-09-05')).rejects.toMatchObject({
      kind: 'rate-limit',
    });
    expect(calls).toHaveLength(0);
  });

  it('la clave nunca aparece en errores ni en los avisos del logger', async () => {
    const logger = { warn: vi.fn() };
    const { fetch } = fetchReturning(() =>
      jsonResponse({ detail: `token ${API_KEY} rechazado` }, 401),
    );
    const provider = make(fetch, { getApiKey: async () => API_KEY, logger });
    const error = await provider
      .getBars('AAPL', '2020-08-01', '2020-09-05')
      .catch((e: unknown) => e);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
    for (const call of logger.warn.mock.calls) {
      expect(String(call[0])).not.toContain(API_KEY);
    }
  });
});
