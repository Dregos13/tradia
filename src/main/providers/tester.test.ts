import { describe, expect, it, vi } from 'vitest';

import vixclsObservations from '../market/macro/__fixtures__/vixcls-observations.json';
import fredError400ApiKey from '../market/macro/__fixtures__/error-400-apikey.json';
import aaplLatest from '../market/providers/__fixtures__/aapl-latest.json';
import {
  INVALID_STORED_KEY_MESSAGE,
  InvalidStoredKeyError,
  MarketDataError,
} from '../market/providers/types';
import type { DataProviderId } from '../../shared/ipc';
import {
  classifyProbeError,
  createProviderProbes,
  FRED_PROBE_SERIES,
  PROVIDER_TEST_MESSAGES,
  testProviderConnection,
  TIINGO_PROBE_TICKER,
  type ProviderProbe,
} from './tester';

const TIINGO_KEY = 'tk-SECRETO-de-prueba-12345';
const FRED_KEY = 'abcdef0123456789abcdef0123456789';
/** Instante fijo de las pruebas: 2026-10-09 (viernes), mediodía UTC. */
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const now = () => NOW;

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

/** Sondeos reales con fetch falso y clave fija, como en producción. */
function realProbes(fetch: typeof globalThis.fetch, key: string | null = TIINGO_KEY) {
  return createProviderProbes({ fetch, getApiKey: async () => key, now });
}

const runProbe = (
  provider: DataProviderId,
  probe: ProviderProbe,
  extra: { isOnline?: () => boolean } = {},
) => testProviderConnection(provider, { probe, now, ...extra });

describe('providers tester — Tiingo', () => {
  it('ok: una petición mínima a SPY devuelve la fecha del último dato', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(aaplLatest));
    const result = await runProbe('tiingo', realProbes(fetch).tiingo);

    expect(result.status).toBe('ok');
    expect(result.latestDataDate).toBe('2026-10-07');
    expect(result.message).toBe('Conectado · último dato 2026-10-07');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.checkedAt).toBe(new Date(NOW).toISOString());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(`/tiingo/daily/${TIINGO_PROBE_TICKER}/prices`);
  });

  it('sin-clave: no llama a la red y no fabrica datos', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(aaplLatest));
    const result = await runProbe('tiingo', realProbes(fetch, null).tiingo);

    expect(result.status).toBe('sin-clave');
    expect(result.message).toBe(PROVIDER_TEST_MESSAGES['sin-clave']);
    expect(result.latestDataDate).toBeNull();
    expect(result.latencyMs).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('clave-rechazada: un 401 del proveedor se clasifica sin exponer la clave', async () => {
    const { fetch } = fetchReturning(() =>
      jsonResponse({ detail: `Invalid token ${TIINGO_KEY}` }, 401),
    );
    const result = await runProbe('tiingo', realProbes(fetch).tiingo);

    expect(result.status).toBe('clave-rechazada');
    expect(result.message).toBe(PROVIDER_TEST_MESSAGES['clave-rechazada']);
    expect(result.latencyMs).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(TIINGO_KEY);
  });

  it('cuota: un 429 se clasifica como cuota agotada', async () => {
    const { fetch } = fetchReturning(() =>
      jsonResponse({ detail: 'Rate limit exceeded' }, 429, { 'Retry-After': '30' }),
    );
    const result = await runProbe('tiingo', realProbes(fetch).tiingo);

    expect(result.status).toBe('cuota');
    expect(result.message).toBe(PROVIDER_TEST_MESSAGES.cuota);
    expect(result.latencyMs).not.toBeNull();
  });

  it('cuota también sale del limitador local, sin llegar a la red', async () => {
    const probe: ProviderProbe = async () => {
      throw new MarketDataError('rate-limit', 'cuota local agotada', {
        provider: 'tiingo',
        retryAfterMs: 60_000,
      });
    };
    const result = await runProbe('tiingo', probe);

    expect(result.status).toBe('cuota');
    expect(result.latencyMs).toBeNull();
  });

  it('sin-red: un fallo de transporte se clasifica sin latencia', async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError('fetch failed: ENOTFOUND api.tiingo.com');
    };
    const result = await runProbe('tiingo', realProbes(fetch).tiingo);

    expect(result.status).toBe('sin-red');
    expect(result.message).toBe(PROVIDER_TEST_MESSAGES['sin-red']);
    expect(result.latencyMs).toBeNull();
  });

  it('sin-red sin salir a la red: la conectividad corta antes del sondeo', async () => {
    const probe = vi.fn<ProviderProbe>(async () => '2026-10-07');
    const result = await runProbe('tiingo', probe, { isOnline: () => false });

    expect(result.status).toBe('sin-red');
    expect(result.latencyMs).toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });

  it('clave-rechazada: una clave guardada con un carácter de control no sale a la red y pide volver a pegarla', async () => {
    const dirtyKey = 'tk-SECRETO-de-prueba\r12345';
    const { fetch, calls } = fetchReturning(() => jsonResponse(aaplLatest));
    const result = await runProbe('tiingo', realProbes(fetch, dirtyKey).tiingo);

    expect(result.status).toBe('clave-rechazada');
    expect(result.message).toBe(INVALID_STORED_KEY_MESSAGE);
    expect(result.message).toContain('vuelve a pegarla');
    expect(result.message).not.toContain('Sin conexión');
    expect(result.latestDataDate).toBeNull();
    expect(result.latencyMs).toBeNull();
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('SECRETO');
  });

  it('error: una respuesta malformada se clasifica con el motivo saneado', async () => {
    const { fetch } = fetchReturning(() => new Response('<html>caído</html>', { status: 200 }));
    const result = await runProbe('tiingo', realProbes(fetch).tiingo);

    expect(result.status).toBe('error');
    expect(result.message).toContain('El proveedor no respondió como se esperaba');
    expect(JSON.stringify(result)).not.toContain(TIINGO_KEY);
  });

  it('error: un 5xx cuenta como error del proveedor, no como sin-red', async () => {
    const { fetch } = fetchReturning(() => jsonResponse({ detail: 'boom' }, 500));
    const result = await runProbe('tiingo', realProbes(fetch).tiingo);

    expect(result.status).toBe('error');
    expect(result.message).toContain('HTTP 500');
    expect(result.latencyMs).not.toBeNull();
  });

  it('la clave viaja en Authorization y no aparece en la URL ni en el resultado', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(aaplLatest));
    const result = await runProbe('tiingo', realProbes(fetch).tiingo);

    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Token ${TIINGO_KEY}`);
    expect(calls[0]!.url).not.toContain(TIINGO_KEY);
    expect(JSON.stringify(result)).not.toContain(TIINGO_KEY);
  });
});

describe('providers tester — FRED', () => {
  it('ok: una petición mínima a VIXCLS devuelve la fecha de la última observación', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(vixclsObservations));
    const result = await runProbe('fred', realProbes(fetch, FRED_KEY).fred);

    expect(result.status).toBe('ok');
    expect(result.latestDataDate).toBe('2026-10-08');
    expect(result.message).toBe('Conectado · último dato 2026-10-08');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('series/observations');
    expect(calls[0]!.url).toContain(`series_id=${FRED_PROBE_SERIES}`);
  });

  it('sin-clave: no llama a la red y no fabrica datos', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(vixclsObservations));
    const result = await runProbe('fred', realProbes(fetch, null).fred);

    expect(result.status).toBe('sin-clave');
    expect(result.message).toBe(PROVIDER_TEST_MESSAGES['sin-clave']);
    expect(result.latencyMs).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('clave-rechazada: el 400 de api_key de FRED se clasifica sin exponer la clave', async () => {
    const { fetch } = fetchReturning(() => jsonResponse(fredError400ApiKey, 400));
    const result = await runProbe('fred', realProbes(fetch, FRED_KEY).fred);

    expect(result.status).toBe('clave-rechazada');
    expect(result.message).toBe(PROVIDER_TEST_MESSAGES['clave-rechazada']);
    expect(result.latencyMs).not.toBeNull();
    expect(JSON.stringify(result)).not.toContain(FRED_KEY);
  });

  it('clave-rechazada: una clave guardada con un carácter de control no sale a la red y pide volver a pegarla', async () => {
    const dirtyKey = 'abcdef0123456789\rabcdef0123456789';
    const { fetch, calls } = fetchReturning(() => jsonResponse(vixclsObservations));
    const result = await runProbe('fred', realProbes(fetch, dirtyKey).fred);

    expect(result.status).toBe('clave-rechazada');
    expect(result.message).toBe(INVALID_STORED_KEY_MESSAGE);
    expect(result.message).toContain('vuelve a pegarla');
    expect(result.message).not.toContain('Sin conexión');
    expect(result.latestDataDate).toBeNull();
    expect(result.latencyMs).toBeNull();
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('abcdef');
  });

  it('cuota: un 429 se clasifica como cuota agotada', async () => {
    const { fetch } = fetchReturning(() =>
      jsonResponse({ error_message: 'Too many requests' }, 429),
    );
    const result = await runProbe('fred', realProbes(fetch, FRED_KEY).fred);

    expect(result.status).toBe('cuota');
    expect(result.message).toBe(PROVIDER_TEST_MESSAGES.cuota);
  });

  it('sin-red: un fallo de transporte se clasifica sin latencia', async () => {
    const fetch: typeof globalThis.fetch = async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    };
    const result = await runProbe('fred', realProbes(fetch, FRED_KEY).fred);

    expect(result.status).toBe('sin-red');
    expect(result.message).toBe(PROVIDER_TEST_MESSAGES['sin-red']);
    expect(result.latencyMs).toBeNull();
  });

  it('error: una respuesta sin observaciones es error, nunca un ok vacío', async () => {
    const { fetch } = fetchReturning(() => jsonResponse({ observations: [] }));
    const result = await runProbe('fred', realProbes(fetch, FRED_KEY).fred);

    expect(result.status).toBe('error');
    expect(result.message).toBe('El proveedor respondió sin datos recientes.');
    expect(result.latestDataDate).toBeNull();
  });

  it('la clave viaja en api_key y ni el resultado ni el mensaje la exponen', async () => {
    const { fetch, calls } = fetchReturning(() => jsonResponse(vixclsObservations));
    const result = await runProbe('fred', realProbes(fetch, FRED_KEY).fred);

    // FRED solo admite la clave en la URL: se comprueba que llega pero que
    // ninguna parte del resultado la copia.
    expect(calls[0]!.url).toContain(`api_key=${FRED_KEY}`);
    expect(result.message).not.toContain(FRED_KEY);
    expect(JSON.stringify(result)).not.toContain(FRED_KEY);
  });

  it('un detalle de error que repite la clave sale saneado del mensaje', async () => {
    const { fetch } = fetchReturning(() =>
      jsonResponse({ error_message: `petición rara con ${FRED_KEY} dentro` }, 400),
    );
    const result = await runProbe('fred', realProbes(fetch, FRED_KEY).fred);

    expect(result.status).toBe('error');
    expect(result.message).not.toContain(FRED_KEY);
    expect(result.message).toContain('***');
  });
});

describe('classifyProbeError', () => {
  it('cubre los seis estados del contrato desde errores tipados', () => {
    const cases: Array<[MarketDataError, string]> = [
      [new MarketDataError('auth', 'sin clave', { provider: 'x' }), 'sin-clave'],
      [new MarketDataError('auth', 'rechazada', { provider: 'x', status: 401 }), 'clave-rechazada'],
      [new MarketDataError('rate-limit', 'cuota', { provider: 'x', status: 429 }), 'cuota'],
      [new MarketDataError('network', 'transporte', { provider: 'x' }), 'sin-red'],
      [new MarketDataError('network', 'servidor', { provider: 'x', status: 503 }), 'error'],
      [new MarketDataError('bad-data', 'mal', { provider: 'x' }), 'error'],
      [new MarketDataError('not-found', 'no', { provider: 'x', status: 404 }), 'error'],
    ];
    for (const [error, expected] of cases) {
      expect(classifyProbeError(error).status).toBe(expected);
    }
    expect(classifyProbeError(new Error('otro')).status).toBe('error');
    expect(classifyProbeError('texto').status).toBe('error');
  });

  it('una clave guardada con un carácter de control es «clave-rechazada», nunca «sin-red»', () => {
    // Reproduce el fallo del cierre R1: la clave de antes de la validación
    // de setKey provocaba un TypeError de cabecera clasificado como
    // 'sin-red'. Ahora se rechaza antes de la petición con su propio motivo.
    const classified = classifyProbeError(new InvalidStoredKeyError({ provider: 'tiingo' }));

    expect(classified.status).toBe('clave-rechazada');
    expect(classified.message).toBe(INVALID_STORED_KEY_MESSAGE);
    expect(classified.message).toContain('vuelve a pegarla');
    expect(classified.message).not.toContain('Sin conexión');
    expect(classified.reachedNetwork).toBe(false);
  });
});
