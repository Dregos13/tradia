/**
 * Laboratorio de estrategias: registra `lab:*` (generador con IA) y
 * `forward:*` (pruebas en vivo).
 */
import { app, ipcMain } from 'electron';

import { IPC_CHANNELS, IpcValidationError, isE2eEnabled } from '../../shared/ipc';
import { isForwardId, isForwardStartRequest, isLabGenerateRequest } from '../../shared/lab';
import { createBacktestRepository } from '../backtest/repository';
import { resolveStressSource } from '../backtest/stress';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import { createStrategiesRepository } from '../strategies/repository';
import { createForwardRepository, createForwardService, type ForwardService } from './forward';
import { createStrategyGenerator, type StrategyGenerator } from './generator';
import { createSimulatedLabEngine } from './simulated';

export interface LabServices {
  generator: StrategyGenerator;
  forward: ForwardService;
}

const MISSING_ENGINE_HINT =
  'Conecta una IA para generar estrategias: instala Claude Code o Codex, inicia sesión y elígela en Ajustes → IA.';

export function registerLab(
  ctx: ServiceContext,
  options: { now?: () => number } = {},
): LabServices {
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[lab] almacén no disponible: las pruebas en vivo solo vivirán en memoria');
    db = openDatabase(':memory:');
  }
  const e2e = isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E);
  const runs = createBacktestRepository(db);
  const strategies = ctx.services.strategies ?? createStrategiesRepository(db);
  const secrets = ctx.services.secrets ?? null;
  const simulated = createSimulatedLabEngine();

  const engine = () => (e2e ? simulated : (ctx.services.newsAi?.textEngine?.() ?? null));
  const generator = createStrategyGenerator({ engine, missingHint: () => MISSING_ENGINE_HINT });
  const forward = createForwardService({
    repo: createForwardRepository(db),
    strategies,
    runs,
    resolveSource: () =>
      resolveStressSource({ secrets, simulated: { seed: e2e ? 'tradia-e2e' : 'tradia' } }),
    now: options.now,
  });

  ipcMain.handle(IPC_CHANNELS.lab.engine, () => {
    const current = engine();
    return current
      ? { available: true, label: current.label, hint: null }
      : { available: false, label: null, hint: MISSING_ENGINE_HINT };
  });
  ipcMain.handle(IPC_CHANNELS.lab.generate, (_event, request: unknown) => {
    if (!isLabGenerateRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.lab.generate, 'idea inválida');
    }
    return generator.generate(request);
  });
  ipcMain.handle(IPC_CHANNELS.forward.list, () => forward.list());
  ipcMain.handle(IPC_CHANNELS.forward.get, (_event, id: unknown) => {
    if (!isForwardId(id)) throw new IpcValidationError(IPC_CHANNELS.forward.get, 'id inválido');
    return forward.get(id);
  });
  ipcMain.handle(IPC_CHANNELS.forward.start, (_event, request: unknown) => {
    if (!isForwardStartRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.forward.start, 'petición inválida');
    }
    return forward.start(request);
  });
  ipcMain.handle(IPC_CHANNELS.forward.stop, (_event, id: unknown) => {
    if (!isForwardId(id)) throw new IpcValidationError(IPC_CHANNELS.forward.stop, 'id inválido');
    return forward.stop(id);
  });
  ipcMain.handle(IPC_CHANNELS.forward.remove, (_event, id: unknown) => {
    if (!isForwardId(id)) throw new IpcValidationError(IPC_CHANNELS.forward.remove, 'id inválido');
    forward.remove(id);
  });

  return { generator, forward };
}
