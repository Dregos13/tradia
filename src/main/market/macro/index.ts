/**
 * Registro del servicio macro en el proceso principal.
 *
 * - Proveedor: el adaptador FRED real (`api_key` leída del servicio
 *   secrets con la clave 'fred'), o el simulado solo cuando la app corre
 *   en modo de pruebas (`isE2eEnabled`: TRADIA_E2E y sin empaquetar).
 * - Handler IPC `macro:get-series` con la guarda `isMacroSeriesQuery`.
 * - `service.start()` arma el refresco al arrancar y el diario programado;
 *   `will-quit` debe llamar a `service.stop()` (ver `main/index.ts`).
 */
import { app, ipcMain, powerMonitor } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isE2eEnabled,
  isMacroSeriesQuery,
} from '../../../shared/ipc';
import type { ServiceContext } from '../../services';
import { createMarketRepository } from '../repository';
import { FRED_SECRETS_KEY, createFredProvider } from './fred';
import { createMacroService, type MacroService } from './service';
import { createSimulatedMacroProvider, type SimulatedMacroProvider } from './simulated';
import type { MacroDataProvider } from './types';

export type { MacroService } from './service';

export interface RegisterMacroOptions {
  /** Proveedor inyectado (pruebas); por defecto FRED o el simulado E2E. */
  provider?: MacroDataProvider;
  /** false para registrar el handler sin lanzar el refresco; por defecto true. */
  autoStart?: boolean;
  /** Reloj inyectable del servicio; por defecto Date.now. */
  now?: () => number;
}

export function registerMacro(
  ctx: ServiceContext,
  options: RegisterMacroOptions = {},
): MacroService {
  const db = ctx.services.storage?.getDb() ?? null;
  const repository = db ? createMarketRepository(db) : null;
  if (!repository) {
    console.warn('[macro] sin base de datos: las series macro quedan desactivadas');
  }

  const e2e = isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E);
  const provider =
    options.provider ??
    (e2e
      ? createSimulatedMacroProvider({ seed: 'tradia-e2e' })
      : createFredProvider({
          fetch: (...args) => globalThis.fetch(...args),
          getApiKey: async () => {
            const secrets = ctx.services.secrets;
            if (!secrets) return null;
            try {
              return await secrets.getKey(FRED_SECRETS_KEY);
            } catch {
              // Sin almacén o sin cifrado equivale a no tener clave.
              return null;
            }
          },
        }));

  const service = createMacroService({
    provider,
    repository,
    broadcast: ctx.broadcast,
    now: options.now,
    isOnline: () => ctx.services.connectivity?.getState().status !== 'offline',
    // Al despertar el equipo se pone al día igual que al reconectar.
    powerMonitor,
    // Sin clave de FRED el proveedor es 'sin configurar': los refrescos se
    // omiten sin estados de fallo (un perfil vacío no enseña aviso rojo).
    isConfigured:
      options.provider !== undefined || e2e
        ? undefined
        : async () => {
            const secrets = ctx.services.secrets;
            if (!secrets) return false;
            try {
              return await secrets.hasKey(FRED_SECRETS_KEY);
            } catch {
              return false;
            }
          },
    logger: console,
  });

  // Gancho de desarrollo para `market/health.ts` (simulateProviderFailure):
  // solo los proveedores simulados saben fallar a demanda.
  if (typeof (provider as { setFailing?: unknown }).setFailing === 'function') {
    service.setProviderFailure = (kind) => {
      (provider as SimulatedMacroProvider).setFailing(kind);
    };
  }

  // Puesta al día sin esperar al horario: al volver la conexión y al
  // guardar la clave de FRED (mismo patrón de envoltura que market).
  let connectivityWasDown = ctx.services.connectivity?.getState().status === 'offline';
  const innerBroadcast = ctx.broadcast;
  ctx.broadcast = (channel, payload) => {
    innerBroadcast(channel, payload);
    if (channel === IPC_CHANNELS.connectivity.changed) {
      const status = (payload as { status?: unknown }).status;
      if (status === 'online' && connectivityWasDown) {
        void service.refreshNow();
      }
      if (status === 'offline') connectivityWasDown = true;
      else if (status === 'online') connectivityWasDown = false;
    } else if (channel === IPC_CHANNELS.secrets.changed) {
      if ((payload as { provider?: unknown }).provider === FRED_SECRETS_KEY) {
        void service.refreshNow();
      }
    }
  };

  ipcMain.handle(IPC_CHANNELS.macro.getSeries, (_event, query: unknown) => {
    if (!isMacroSeriesQuery(query)) {
      throw new IpcValidationError(
        IPC_CHANNELS.macro.getSeries,
        "se espera { desde?: 'YYYY-MM-DD' } o nada",
      );
    }
    return service.getSeries(query);
  });
  ipcMain.handle(IPC_CHANNELS.macro.refreshNow, () => service.refreshNow());

  if (options.autoStart ?? true) service.start();
  return service;
}
