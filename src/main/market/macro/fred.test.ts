import { describe, expect, it, vi } from 'vitest';

import cpiaucslObservations from './__fixtures__/cpiaucsl-observations.json';
import dgs10Observations from './__fixtures__/dgs10-observations.json';
import error400ApiKey from './__fixtures__/error-400-apikey.json';
import error400Series from './__fixtures__/error-400-series.json';
import error429 from './__fixtures__/error-429.json';
import error500 from './__fixtures__/error-500.json';
import malformedObservations from './__fixtures__/malformed-observations.json';
import vixclsObservations from './__fixtures__/vixcls-observations.json';
import { createFredProvider, FRED_RATE_LIMITS } from './fred';
import { isMarketDataError } from '../providers/types';
import { MACRO_SERIES_CATALOG } from './types';

const API_KEY = 'abcdef0123456789abcdef0123456789';

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
  extra: Partial<Parameters<typeof createFredProvider>[0]> = {},
) =>
  createFredProvider({
    fetch,
    getApiKey: async () => API_KEY,
    ...extra,
  });

describe('adaptador FRED', () => {
  it('sirve el catálogo de la fase y declara sus límites', () => {
    const provider = make(vi.fn());
    expect(provider.id).toBe('fred');
    expect(provider.rateLimits).toEqual(FRED_RATE_LIMITS);
    expect(provider.listSeries().map((s) => s.id)).toEqual(MACRO_SERIES_CATALOG.map((s) => s.id));
  });

  it('mapea las observaciones grabadas y trata "." como ausente', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(dgs10Observations));
    const provider = make(fetch);

    const observations = await provider.getObservations('DGS10', '2026-09-28', '2026-10-05');

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.stlouisfed.org/fred/series/observations');
    expect(url.searchParams.get('series_id')).toBe('DGS10');
    expect(url.searchParams.get('observation_start')).toBe('2026-09-28');
    expect(url.searchParams.get('observation_end')).toBe('2026-10-05');
    expect(url.searchParams.get('file_type')).toBe('json');
    expect(url.searchParams.get('api_key')).toBe(API_KEY);

    // Las dos fechas de fin de semana con '.' no se devuelven.
    expect(observations).toEqual([
      { date: '2026-09-28', value: 4.18 },
      { date: '2026-09-29', value: 4.15 },
      { date: '2026-09-30', value: 4.12 },
      { date: '2026-10-01', value: 4.1 },
      { date: '2026-10-02', value: 4.05 },
      { date: '2026-10-05', value: 4.02 },
    ]);
  });

  it('lee series mensuales (CPIAUCSL) y VIX (VIXCLS)', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(cpiaucslObservations));
    const provider = make(fetch);

    const cpi = await provider.getObservations('CPIAUCSL', '2026-06-01', '2026-09-01');
    expect(cpi.map((o) => o.date)).toEqual(['2026-06-01', '2026-07-01', '2026-08-01']);
    // El último mes aún sin publicar llega como '.' y queda ausente.

    const { fetch: fetchVix } = fetchReturning(() => jsonResponse(vixclsObservations));
    const vix = make(fetchVix);
    const vixObs = await vix.getObservations('VIXCLS');
    expect(vixObs).toHaveLength(4);
    expect(vixObs[3]).toEqual({ date: '2026-10-08', value: 16.88 });
  });

  it('recorta al rango pedido aunque la respuesta traiga más fechas', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(dgs10Observations));
    const provider = make(fetch);
    const observations = await provider.getObservations('DGS10', '2026-10-01', '2026-10-02');
    expect(observations.map((o) => o.date)).toEqual(['2026-10-01', '2026-10-02']);
  });

  it('sin clave guardada lanza auth sin llamar a la red', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(dgs10Observations));
    const provider = make(fetch, { getApiKey: async () => null });

    const error = await provider.getObservations('DGS10').catch((e: unknown) => e);
    expect(isMarketDataError(error, 'auth')).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rechaza series fuera del catálogo con not-found sin llamar a la red', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(dgs10Observations));
    const provider = make(fetch);

    const error = await provider.getObservations('NOEXISTE').catch((e: unknown) => e);
    expect(isMarketDataError(error, 'not-found')).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('mapea un 400 de clave inválida a auth', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(error400ApiKey, 400));
    const provider = make(fetch);
    const error = await provider.getObservations('DFF').catch((e: unknown) => e);
    expect(isMarketDataError(error, 'auth')).toBe(true);
  });

  it('mapea un 400 de serie inexistente a not-found', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(error400Series, 400));
    // El catálogo incluye DGS2, pero FRED responde 400 si la serie desaparece.
    const provider = make(fetch);
    const error = await provider.getObservations('DGS2').catch((e: unknown) => e);
    expect(isMarketDataError(error, 'not-found')).toBe(true);
  });

  it('mapea 401/403 a auth y no filtra la clave al mensaje', async () => {
    const body = { error_message: `Forbidden for key ${API_KEY}` };
    const { fetch } = fetchReturning(() => jsonResponse(body, 403));
    const provider = make(fetch);
    const error = await provider.getObservations('DFF').catch((e: unknown) => e);
    expect(isMarketDataError(error, 'auth')).toBe(true);
    expect((error as Error).message).not.toContain(API_KEY);
  });

  it('mapea 429 a rate-limit y lee Retry-After', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(error429, 429, { 'Retry-After': '90' }));
    const provider = make(fetch);
    const error = await provider.getObservations('VIXCLS').catch((e: unknown) => e);
    expect(isMarketDataError(error, 'rate-limit')).toBe(true);
    expect((error as { retryAfterMs?: number }).retryAfterMs).toBe(90_000);
    expect((error as { retryable?: boolean }).retryable).toBe(true);
  });

  it('mapea 500 y fallos de transporte a network', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(error500, 500));
    const provider = make(fetch);
    const error = await provider.getObservations('DFF').catch((e: unknown) => e);
    expect(isMarketDataError(error, 'network')).toBe(true);

    const transport: typeof globalThis.fetch = async () => {
      throw new TypeError('fetch failed');
    };
    const providerDown = make(transport);
    const transportError = await providerDown.getObservations('DFF').catch((e: unknown) => e);
    expect(isMarketDataError(transportError, 'network')).toBe(true);
  });

  it('rechaza respuestas sin lista de observaciones o con filas malformadas', async () => {
    const { fetch } = fetchReturning(() => jsonResponse({ realtime_start: '2026-10-08' }));
    const provider = make(fetch);
    const error = await provider.getObservations('DFF').catch((e: unknown) => e);
    expect(isMarketDataError(error, 'bad-data')).toBe(true);

    const { fetch: fetchBad } = fetchReturning(() => jsonResponse(malformedObservations));
    const badRows = make(fetchBad);
    const rowError = await badRows.getObservations('DFF').catch((e: unknown) => e);
    expect(isMarketDataError(rowError, 'bad-data')).toBe(true);
  });

  it('la clave nunca aparece en el log ni en los errores de red', async () => {
    const logger = { warn: vi.fn() };
    const body = { error_message: `Bad key ${API_KEY} rejected` };
    const { fetch } = fetchReturning(() => jsonResponse(body, 500));
    const provider = make(fetch, { logger });
    await provider.getObservations('DFF').catch(() => undefined);
    expect(logger.warn).toHaveBeenCalledOnce();
    const logged = String(logger.warn.mock.calls[0]![0]);
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain('api_key');
  });
});
