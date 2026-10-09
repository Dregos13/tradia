/**
 * Servicio de estrategias — Fase 2.
 *
 * Registra los canales `strategies:*` del contrato sobre el repositorio de
 * `repository.ts`. Toda entrada del renderer se valida con los guardas de
 * `shared/ipc.ts` antes de tocar la base; las reglas de versionado (nota
 * obligatoria, estados válidos) las reafirma el propio repositorio.
 *
 * Solo depende de `storage`: sin almacén se degrada a una base en memoria
 * para que el resto de la app siga arrancando (mismo patrón que sources).
 */
import type Database from 'better-sqlite3';
import { ipcMain } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isCreateStrategyRequest,
  isGetStrategyRequest,
  isSetStrategyStatusRequest,
  isStrategyId,
  isUpdateStrategyRequest,
} from '../../shared/ipc';
import { createBacktestRepository } from '../backtest/repository';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import { createStrategiesRepository, type StrategiesRepository } from './repository';

export function registerStrategies(ctx: ServiceContext): StrategiesRepository {
  let db: Database.Database | null = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[strategies] almacén no disponible: las estrategias solo vivirán en memoria');
    db = openDatabase(':memory:');
  }
  const runs = createBacktestRepository(db);
  const repo = createStrategiesRepository(db, (id) => runs.implementationKey(id) !== null);

  ipcMain.handle(IPC_CHANNELS.strategies.list, () => repo.list());
  ipcMain.handle(IPC_CHANNELS.strategies.get, (_event, request: unknown) => {
    if (!isGetStrategyRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.strategies.get, 'consulta de ficha inválida');
    }
    return repo.get(request.id, request.version);
  });
  ipcMain.handle(IPC_CHANNELS.strategies.create, (_event, request: unknown) => {
    if (!isCreateStrategyRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.strategies.create, 'alta de estrategia inválida');
    }
    return repo.create(request);
  });
  ipcMain.handle(IPC_CHANNELS.strategies.update, (_event, request: unknown) => {
    if (!isUpdateStrategyRequest(request)) {
      throw new IpcValidationError(
        IPC_CHANNELS.strategies.update,
        'edición de estrategia inválida (nota obligatoria y al menos un campo)',
      );
    }
    return repo.update(request);
  });
  ipcMain.handle(IPC_CHANNELS.strategies.setStatus, (_event, request: unknown) => {
    if (!isSetStrategyStatusRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.strategies.setStatus, 'cambio de estado inválido');
    }
    return repo.setStatus(request);
  });
  ipcMain.handle(IPC_CHANNELS.strategies.history, (_event, id: unknown) => {
    if (!isStrategyId(id)) {
      throw new IpcValidationError(IPC_CHANNELS.strategies.history, 'id de estrategia inválido');
    }
    return repo.history(id);
  });

  return repo;
}
