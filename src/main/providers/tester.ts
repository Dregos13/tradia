/**
 * Núcleo de «Probar conexión» de los proveedores de datos (Tiingo y FRED).
 *
 * Sin dependencias de Electron: la misma lógica sirve al handler IPC
 * (`providers:test-connection`, ver `index.ts`) y al script de terminal
 * `scripts/qa-providers.mjs` (`npm run qa:providers`).
 *
 * - La prueba es UNA petición mínima real con la clave guardada: la última
 *   cotización de SPY en Tiingo y la observación más reciente de VIXCLS
 *   (la serie diaria que antes publica) en FRED.
 * - El resultado se clasifica en los seis estados del contrato
 *   (`ProviderTestStatus`): 'ok' con la fecha del último dato, 'sin-clave',
 *   'clave-rechazada', 'cuota', 'sin-red' y 'error' con el motivo legible.
 * - La clave nunca aparece en el resultado: este módulo no la lee jamás
 *   (llega al proveedor por `getApiKey` y los adaptadores ya sanean todo
 *   texto externo con `redact`); los mensajes propios son fijos.
 * - `latencyMs` solo se informa cuando la petición llegó a la red (éxito
 *   o respuesta HTTP de error); un fallo local (sin clave, transporte,
 *   cuota local) lo deja en null.
 */
import {
  type DataProviderId,
  type ProviderTestResult,
  type ProviderTestStatus,
} from '../../shared/ipc';
import { createFredProvider, type FredProviderDeps } from '../market/macro/fred';
import type { MacroDataProvider } from '../market/macro/types';
import { createTiingoProvider, type TiingoProviderDeps } from '../market/providers/tiingo';
import {
  isMarketDataError,
  type MarketDataProvider,
  type SessionDate,
} from '../market/providers/types';

/** Ticker del sondeo de Tiingo: referencia siempre listada, una petición. */
export const TIINGO_PROBE_TICKER = 'SPY';
/**
 * Serie del sondeo de FRED: VIXCLS es diaria y de publicación casi
 * inmediata, así su última observación es la fecha «más fresca» posible.
 */
export const FRED_PROBE_SERIES = 'VIXCLS';
/** Ventana del sondeo de FRED (días hacia atrás) para hallar la última observación. */
export const FRED_PROBE_LOOKBACK_DAYS = 14;

/** Mensajes fijos en español por estado; nunca llevan la clave. */
export const PROVIDER_TEST_MESSAGES: Record<Exclude<ProviderTestStatus, 'ok' | 'error'>, string> = {
  'sin-clave': 'Sin clave guardada.',
  'clave-rechazada': 'El proveedor rechazó la clave.',
  cuota: 'Cuota agotada por hoy.',
  'sin-red': 'Sin conexión a internet.',
};

const DAY_MS = 86_400_000;

const toSessionDate = (ms: number): SessionDate => new Date(ms).toISOString().slice(0, 10);

const truncate = (text: string, max = 160): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Petición mínima al proveedor: devuelve la fecha del último dato o null. */
export type ProviderProbe = () => Promise<SessionDate | null>;

export interface ProviderProbesDeps {
  /** fetch real del proceso principal (o falso en pruebas). */
  fetch: typeof globalThis.fetch;
  /** Lee la clave guardada del proveedor; null si no hay. */
  getApiKey(provider: DataProviderId): Promise<string | null>;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?: () => number;
  /** Extra opcional para los adaptadores (p. ej. baseUrl en pruebas). */
  tiingo?: Partial<Omit<TiingoProviderDeps, 'fetch' | 'getApiKey'>>;
  fred?: Partial<Omit<FredProviderDeps, 'fetch' | 'getApiKey'>>;
}

/**
 * Sondeos reales: construyen los adaptadores de producción con la clave de
 * `secrets`. La petición elegida es la mínima que devuelve una fecha de
 * dato: `getQuote` en Tiingo y la última observación de VIXCLS en FRED.
 */
export function createProviderProbes(
  deps: ProviderProbesDeps,
): Record<DataProviderId, ProviderProbe> {
  const now = deps.now ?? (() => Date.now());
  let tiingo: MarketDataProvider | null = null;
  let fred: MacroDataProvider | null = null;
  return {
    tiingo: async () => {
      tiingo ??= createTiingoProvider({
        fetch: deps.fetch,
        getApiKey: () => deps.getApiKey('tiingo'),
        now,
        ...deps.tiingo,
      });
      const quote = await tiingo.getQuote(TIINGO_PROBE_TICKER);
      return quote.date;
    },
    fred: async () => {
      fred ??= createFredProvider({
        fetch: deps.fetch,
        getApiKey: () => deps.getApiKey('fred'),
        ...deps.fred,
      });
      const hasta = toSessionDate(now());
      const desde = toSessionDate(now() - FRED_PROBE_LOOKBACK_DAYS * DAY_MS);
      const observations = await fred.getObservations(FRED_PROBE_SERIES, desde, hasta);
      return observations.at(-1)?.date ?? null;
    },
  };
}

/** Clasificación de un fallo del sondeo a estado + mensaje del contrato. */
export interface ProviderTestClassification {
  status: ProviderTestStatus;
  message: string;
  /** true si el fallo ocurrió tras una respuesta del servidor (hay latencia). */
  reachedNetwork: boolean;
}

/**
 * Traduce el `MarketDataError` del adaptador al estado del contrato:
 * - 'auth' sin status → no se llegó a la red: falta la clave ('sin-clave');
 *   con status (401/403, o el 400 de `api_key` de FRED) → 'clave-rechazada'.
 * - 'rate-limit' → 'cuota' (remota 429 o rechazo del limitador local).
 * - 'network' sin status → fallo de transporte: 'sin-red'; con status (5xx)
 *   el servidor respondió mal: 'error'.
 * - 'not-found'/'bad-data' y cualquier error inesperado → 'error' con el
 *   motivo saneado (los adaptadores ya redactan la clave de sus textos).
 */
export function classifyProbeError(error: unknown): ProviderTestClassification {
  if (isMarketDataError(error)) {
    switch (error.kind) {
      case 'auth':
        return error.status === undefined
          ? {
              status: 'sin-clave',
              message: PROVIDER_TEST_MESSAGES['sin-clave'],
              reachedNetwork: false,
            }
          : {
              status: 'clave-rechazada',
              message: PROVIDER_TEST_MESSAGES['clave-rechazada'],
              reachedNetwork: true,
            };
      case 'rate-limit':
        return {
          status: 'cuota',
          message: PROVIDER_TEST_MESSAGES.cuota,
          reachedNetwork: error.status !== undefined,
        };
      case 'network':
        return error.status === undefined
          ? {
              status: 'sin-red',
              message: PROVIDER_TEST_MESSAGES['sin-red'],
              reachedNetwork: false,
            }
          : {
              status: 'error',
              message: `El proveedor no respondió como se esperaba (HTTP ${error.status}).`,
              reachedNetwork: true,
            };
      default:
        return {
          status: 'error',
          message: `El proveedor no respondió como se esperaba: ${truncate(error.message)}`,
          reachedNetwork: error.status !== undefined,
        };
    }
  }
  return {
    status: 'error',
    message: `No se pudo comprobar el proveedor: ${truncate(String(error))}`,
    reachedNetwork: false,
  };
}

export interface ProviderTesterDeps {
  /** Sondeo del proveedor (real, simulado E2E o falso en pruebas). */
  probe: ProviderProbe;
  /** Conectividad local; `false` corta antes de llamar a la red. */
  isOnline?: () => boolean;
  /** Reloj inyectable (ms epoch) para `checkedAt` y `latencyMs`. */
  now?: () => number;
}

/**
 * Ejecuta «Probar conexión» de un proveedor: corta en local si no hay red,
 * lanza el sondeo mínimo y clasifica el resultado. Devuelve siempre un
 * `ProviderTestResult` completo; los fallos del sondeo se convierten en
 * estado, nunca en excepción.
 */
export async function testProviderConnection(
  provider: DataProviderId,
  deps: ProviderTesterDeps,
): Promise<ProviderTestResult> {
  const now = deps.now ?? (() => Date.now());
  const checkedAt = (): string => new Date(now()).toISOString();

  if (deps.isOnline?.() === false) {
    return {
      provider,
      status: 'sin-red',
      message: PROVIDER_TEST_MESSAGES['sin-red'],
      latestDataDate: null,
      checkedAt: checkedAt(),
      latencyMs: null,
    };
  }

  const startedAt = now();
  try {
    const latestDataDate = await deps.probe();
    const latencyMs = Math.max(0, Math.round(now() - startedAt));
    if (latestDataDate === null) {
      return {
        provider,
        status: 'error',
        message: 'El proveedor respondió sin datos recientes.',
        latestDataDate: null,
        checkedAt: checkedAt(),
        latencyMs,
      };
    }
    return {
      provider,
      status: 'ok',
      message: `Conectado · último dato ${latestDataDate}`,
      latestDataDate,
      checkedAt: checkedAt(),
      latencyMs,
    };
  } catch (error) {
    const elapsed = Math.max(0, Math.round(now() - startedAt));
    const { status, message, reachedNetwork } = classifyProbeError(error);
    return {
      provider,
      status,
      message,
      latestDataDate: null,
      checkedAt: checkedAt(),
      latencyMs: reachedNetwork ? elapsed : null,
    };
  }
}
