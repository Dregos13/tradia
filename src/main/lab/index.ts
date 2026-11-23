/**
 * Laboratorio de estrategias: registra `lab:*` (generador con IA) y
 * `forward:*` (pruebas en vivo).
 */
import { app, ipcMain } from 'electron';

import { IPC_CHANNELS, IpcValidationError, isE2eEnabled } from '../../shared/ipc';
import {
  isForwardId,
  isForwardStartRequest,
  isLabBacktestRequest,
  isLabGenerateRequest,
} from '../../shared/lab';
import { parseStrategyRules } from '../../shared/strategyRules';
import { createCustomStrategy } from '../backtest/strategies/custom';
import { runHourlyBacktest } from './hourly';
import { createBacktestRepository } from '../backtest/repository';
import { resolveStressSource } from '../backtest/stress';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import { createStrategiesRepository } from '../strategies/repository';
import {
  createForwardRepository,
  createForwardService,
  executableMarkets,
  type ForwardService,
} from './forward';
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
  const DAY = 86_400_000;
  /** Velas de 1 hora de un rango, desde el servicio intradía del mercado. */
  const hourlyBars = async (ticker: string, fromMs: number, toMs: number) => {
    const intraday = ctx.services.market?.intraday;
    if (!intraday) return [];
    const days = Math.min(730, Math.max(1, Math.ceil((now() - fromMs) / DAY) + 1));
    const result = await intraday.get({ ticker, days });
    const from = new Date(fromMs).toISOString();
    const to = new Date(toMs).toISOString();
    return result.bars.filter((b) => b.time >= from && b.time <= to);
  };
  const now = options.now ?? (() => Date.now());

  const forward = createForwardService({
    hourlyBars,
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
  ipcMain.handle(IPC_CHANNELS.lab.backtest, async (_event, request: unknown) => {
    if (!isLabBacktestRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.lab.backtest, 'petición inválida');
    }
    const strategy = strategies.get(request.strategyId);
    if (!strategy) throw new Error(`No existe la estrategia ${request.strategyId}.`);
    const parsed = parseStrategyRules(strategy.rules, strategy.parameters);
    if (!parsed.ok) throw new Error(`Reglas no válidas: ${parsed.errors[0]!.message}`);
    const ticker = executableMarkets(strategy.markets)[0];
    if (!ticker) throw new Error('La estrategia no tiene un activo operable.');
    const intraday = ctx.services.market?.intraday;
    if (!intraday) throw new Error('El servicio de velas de 1 hora no está disponible.');
    const data = await intraday.get({ ticker, days: request.days });
    if (data.bars.length === 0) {
      throw new Error(data.error ?? `No hay velas de 1 hora de ${ticker}.`);
    }
    return runHourlyBacktest({
      strategy,
      create: () => createCustomStrategy(parsed.program, strategy.parameters),
      bars: data.bars,
      ticker,
      requestedDays: request.days,
    });
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
