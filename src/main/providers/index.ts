/**
 * Prueba de conexión de los proveedores de datos — `providers:test-connection`.
 *
 * Responde al «Probar conexión» de Ajustes para Tiingo y FRED con una
 * petición mínima real (ver `tester.ts`): la última cotización de SPY y la
 * observación más reciente de VIXCLS. El resultado (`ProviderTestResult`)
 * lleva el estado, un mensaje legible en español, la fecha del último dato
 * y la latencia; nunca la clave.
 *
 * Cada prueba actualiza `provider:<id>` en `data_status` (emitido por
 * `data-status:changed`), siguiendo el semáforo de la ingesta:
 *
 * - 'ok' → 'fiable' con `lastOkAt` y contador a cero.
 * - 'sin-clave' → se borra el estado (proveedor «sin configurar», como en
 *   el servicio macro: un perfil vacío no enseña aviso rojo).
 * - 'clave-rechazada' → 'no-fiable': la credencial no se arregla sola.
 * - 'cuota', 'sin-red' y 'error' → 'desactualizado' con el contador de
 *   fallos seguidos +1 (a los 3, 'no-fiable'), como una pasada de ingesta.
 *
 * En modo E2E (`isE2eEnabled`) el sondeo usa los proveedores simulados y el
 * gancho `providers:simulate-test` arma el estado que devolverá la próxima
 * prueba (se consume una vez, como `broker:fail-next`).
 */
import { app, ipcMain } from 'electron';

import {
  dataStatusKey,
  IPC_CHANNELS,
  IpcValidationError,
  isE2eEnabled,
  isProviderSimulateTestRequest,
  isProviderTestRequest,
  type DataProviderId,
  type DataStatusEntry,
  type ProviderSimulateTestResult,
  type ProviderTestResult,
  type ProviderTestStatus,
} from '../../shared/ipc';
import { createSimulatedMacroProvider } from '../market/macro/simulated';
import { createSimulatedProvider } from '../market/providers/simulated';
import { isInvalidStoredKeyError } from '../market/providers/types';
import type { MarketRepository } from '../market/repository';
import { createMarketRepository } from '../market/repository';
import type { ServiceContext } from '../services';
import {
  createProviderProbes,
  FRED_PROBE_LOOKBACK_DAYS,
  FRED_PROBE_SERIES,
  PROVIDER_TEST_MESSAGES,
  testProviderConnection,
  TIINGO_PROBE_TICKER,
  type ProviderProbe,
} from './tester';

export interface ProvidersService {
  /** Handler de `providers:test-connection`. */
  testConnection(request: unknown): Promise<ProviderTestResult>;
  /**
   * Gancho E2E (`providers:simulate-test`): arma el estado que devolverá la
   * próxima prueba del proveedor; se consume una vez, como `broker:fail-next`.
   */
  armTestStatus(provider: DataProviderId, status: ProviderTestStatus): void;
}

/** Fallos seguidos a partir de los cuales el proveedor se declara 'no-fiable'. */
const PROVIDER_TEST_MAX_FAILURES = 3;

/** Dependencias inyectables del servicio (en la app las arma `registerProviders`). */
export interface ProvidersServiceDeps {
  /** Repositorio de data_status; null sin base de datos (no se publica). */
  repo: MarketRepository | null;
  /** Sondeos por proveedor: reales en producción, simulados en E2E. */
  probes: Record<DataProviderId, ProviderProbe>;
  /** Emite `data-status:changed` (el envuelto de health si está instalado). */
  broadcast(channel: string, payload: unknown): void;
  /** Conectividad local; `false` responde 'sin-red' sin llamar a la red. */
  isOnline?: () => boolean;
  /**
   * Reloj del dominio (mercado): gobierna las fechas de datos del sondeo
   * y de los proveedores simulados. Por defecto Date.now.
   */
  now?: () => number;
  /**
   * Reloj de pared para `checkedAt` y la latencia: «cuándo se pulsó
   * Probar» es el tiempo real del usuario, no el del mercado simulado.
   * Por defecto Date.now.
   */
  wallNow?: () => number;
}

export function createProvidersService(deps: ProvidersServiceDeps): ProvidersService {
  const now = deps.now ?? (() => Date.now());
  const wallNow = deps.wallNow ?? (() => Date.now());
  /** Estados armados por el gancho E2E; se consumen en la próxima prueba. */
  const armed = new Map<DataProviderId, ProviderTestStatus>();

  const publish = (patch: Parameters<MarketRepository['setDataStatus']>[0]): void => {
    if (!deps.repo) return;
    const entry: DataStatusEntry = deps.repo.setDataStatus(patch);
    deps.broadcast(IPC_CHANNELS.dataStatus.changed, entry);
  };

  /** Escribe el resultado en `provider:<id>` con el semáforo de la ingesta. */
  const applyToDataStatus = (result: ProviderTestResult): void => {
    if (!deps.repo) return;
    const key = dataStatusKey.provider(result.provider);
    switch (result.status) {
      case 'ok': {
        const current = deps.repo.getDataStatus(key);
        if (current?.state === 'fiable' && current.consecutiveFailures === 0) return;
        publish({
          key,
          state: 'fiable',
          lastOkAt: result.checkedAt,
          consecutiveFailures: 0,
          reason: null,
        });
        return;
      }
      case 'sin-clave':
        // Proveedor «sin configurar»: sin estado (mismo criterio que macro).
        deps.repo.deleteDataStatus(key);
        return;
      case 'clave-rechazada': {
        const current = deps.repo.getDataStatus(key);
        publish({
          key,
          state: 'no-fiable',
          consecutiveFailures: (current?.consecutiveFailures ?? 0) + 1,
          reason: result.message,
        });
        return;
      }
      default: {
        const current = deps.repo.getDataStatus(key);
        const failures = (current?.consecutiveFailures ?? 0) + 1;
        publish({
          key,
          state: failures >= PROVIDER_TEST_MAX_FAILURES ? 'no-fiable' : 'desactualizado',
          consecutiveFailures: failures,
          reason: result.message,
        });
      }
    }
  };

  /**
   * Resultado forzado por el gancho E2E: la misma forma que una prueba
   * real, con fecha y latencia deterministas.
   */
  const forcedResult = (
    provider: DataProviderId,
    status: ProviderTestStatus,
  ): ProviderTestResult => {
    const today = new Date(now()).toISOString().slice(0, 10);
    return {
      provider,
      status,
      message:
        status === 'ok'
          ? `Conectado · último dato ${today}`
          : status === 'error'
            ? 'El proveedor no respondió como se esperaba.'
            : PROVIDER_TEST_MESSAGES[status],
      latestDataDate: status === 'ok' ? today : null,
      checkedAt: new Date(wallNow()).toISOString(),
      latencyMs: status === 'ok' ? 1 : null,
    };
  };

  const service: ProvidersService = {
    testConnection: async (request: unknown): Promise<ProviderTestResult> => {
      if (!isProviderTestRequest(request)) {
        throw new IpcValidationError(
          IPC_CHANNELS.providers.testConnection,
          "se esperaba { provider: 'tiingo' | 'fred' }",
        );
      }
      const forced = armed.get(request.provider);
      const result =
        forced !== undefined
          ? (armed.delete(request.provider), forcedResult(request.provider, forced))
          : await testProviderConnection(request.provider, {
              probe: deps.probes[request.provider],
              isOnline: deps.isOnline,
              // `checkedAt` y la latencia van con el reloj de pared: la
              // fecha del sondeo es la del clic, no la del mercado
              // simulado (en E2E el reloj de datos va anclado atrás).
              now: wallNow,
            });
      applyToDataStatus(result);
      return result;
    },

    armTestStatus: (provider, status) => {
      armed.set(provider, status);
    },
  };

  return service;
}

// ---------------------------------------------------------------------------
// Registro en la app
// ---------------------------------------------------------------------------

/** Sondeos del modo E2E: los mismos proveedores simulados del resto de la app. */
function createSimulatedProbes(now: () => number): Record<DataProviderId, ProviderProbe> {
  const market = createSimulatedProvider({ seed: 'tradia-e2e', now });
  const macro = createSimulatedMacroProvider({ seed: 'tradia-e2e', now });
  return {
    tiingo: async () => (await market.getQuote(TIINGO_PROBE_TICKER)).date,
    fred: async () => {
      const hasta = new Date(now()).toISOString().slice(0, 10);
      const desde = new Date(now() - FRED_PROBE_LOOKBACK_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const observations = await macro.getObservations(FRED_PROBE_SERIES, desde, hasta);
      return observations.at(-1)?.date ?? null;
    },
  };
}

export interface RegisterProvidersOptions {
  /** Reloj inyectable (ms epoch) para pruebas; por defecto Date.now. */
  now?: () => number;
}

export function registerProviders(
  ctx: ServiceContext,
  options: RegisterProvidersOptions = {},
): ProvidersService {
  const db = ctx.services.storage?.getDb() ?? null;
  const repo = db ? createMarketRepository(db) : null;
  const e2e = isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E);
  const now = options.now ?? (() => Date.now());

  const probes = e2e
    ? createSimulatedProbes(now)
    : createProviderProbes({
        fetch: (...args) => globalThis.fetch(...args),
        getApiKey: async (provider) => {
          const secrets = ctx.services.secrets;
          if (!secrets) return null;
          try {
            // La clave de secrets se llama como el proveedor ('tiingo', 'fred').
            return await secrets.getKey(provider);
          } catch (error) {
            // Una clave guardada no válida se propaga: el sondeo debe
            // decir «vuelve a pegarla», no «sin clave» ni «sin red».
            if (isInvalidStoredKeyError(error)) throw error;
            // Sin almacén o sin cifrado equivale a no tener clave.
            return null;
          }
        },
        now,
      });

  const service = createProvidersService({
    repo,
    probes,
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
    isOnline: () => ctx.services.connectivity?.getState().status !== 'offline',
    now,
  });

  ipcMain.handle(IPC_CHANNELS.providers.testConnection, (_event, request: unknown) =>
    service.testConnection(request),
  );

  // Gancho de desarrollo: solo con TRADIA_E2E y sin empaquetar. Arma el
  // estado de la próxima prueba del proveedor (se consume una vez).
  if (e2e) {
    ipcMain.handle(
      IPC_CHANNELS.providers.simulateTest,
      (_event, request: unknown): ProviderSimulateTestResult => {
        if (!isProviderSimulateTestRequest(request)) {
          throw new IpcValidationError(
            IPC_CHANNELS.providers.simulateTest,
            'se esperaba { provider, status } con un estado del contrato',
          );
        }
        service.armTestStatus(request.provider, request.status);
        return { provider: request.provider, armed: request.status };
      },
    );
  }

  return service;
}
