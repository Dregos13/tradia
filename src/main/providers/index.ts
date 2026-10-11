/**
 * Prueba de conexión de los proveedores de datos — contrato IPC.
 *
 * `providers:test-connection` responde al «Probar conexión» de Ajustes
 * para Tiingo y FRED (`ProviderTestResult`: estado, mensaje legible en
 * español, fecha del último dato y latencia; nunca la clave).
 *
 * Este registro deja el canal operado por el contrato con un stub
 * determinista: valida la entrada con las guardas compartidas y devuelve
 * el estado 'error' con un motivo legible hasta que llegue la
 * implementación real (petición mínima contra el proveedor, clasificación
 * del resultado y actualización de `provider:<id>` en data-status). El
 * gancho E2E `providers:simulate-test` ya queda registrado solo con
 * TRADIA_E2E y sin empaquetar, como el resto de ganchos.
 */
import { app, ipcMain } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isE2eEnabled,
  isProviderSimulateTestRequest,
  isProviderTestRequest,
  type ProviderSimulateTestResult,
  type ProviderTestResult,
} from '../../shared/ipc';
import type { ServiceContext } from '../services';

export interface ProvidersService {
  /** Handler de `providers:test-connection` (stub del contrato). */
  testConnection(request: unknown): Promise<ProviderTestResult>;
}

export function registerProviders(_ctx: ServiceContext): ProvidersService {
  const service: ProvidersService = {
    testConnection: async (request: unknown): Promise<ProviderTestResult> => {
      if (!isProviderTestRequest(request)) {
        throw new IpcValidationError(
          IPC_CHANNELS.providers.testConnection,
          "se esperaba { provider: 'tiingo' | 'fred' }",
        );
      }
      // Stub del contrato: la comprobación real del proveedor llega en la
      // tarea de conexión de proveedores; el canal ya responde con la
      // forma tipada y nunca con la clave.
      return {
        provider: request.provider,
        status: 'error',
        message: 'La comprobación del proveedor todavía no está disponible.',
        latestDataDate: null,
        checkedAt: new Date().toISOString(),
        latencyMs: null,
      };
    },
  };

  ipcMain.handle(IPC_CHANNELS.providers.testConnection, (_event, request: unknown) =>
    service.testConnection(request),
  );

  // Gancho de desarrollo: solo con TRADIA_E2E y sin empaquetar. Arma el
  // estado que devolverá la próxima prueba cuando la implementación real
  // lo consuma; el stub solo valida y confirma lo armado.
  if (isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E)) {
    ipcMain.handle(
      IPC_CHANNELS.providers.simulateTest,
      (_event, request: unknown): ProviderSimulateTestResult => {
        if (!isProviderSimulateTestRequest(request)) {
          throw new IpcValidationError(
            IPC_CHANNELS.providers.simulateTest,
            'se esperaba { provider, status } con un estado del contrato',
          );
        }
        return { provider: request.provider, armed: request.status };
      },
    );
  }

  return service;
}
