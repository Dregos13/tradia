/**
 * Motor de señales programado al cierre de vela — Fase 4 (registro).
 *
 * `createSignalEngine` (engine.ts) es el núcleo testeable; aquí se cablea
 * sobre la base de datos real y los servicios ya registrados:
 *
 * - Disparo: `market.onBarsStored` (evento interno de market/ingestion,
 *   se emite al guardarse un lote con velas nuevas de un activo).
 * - Estrategias: `services.strategies` (fichas versionadas) filtradas a
 *   estado 'activa'/'paper' y ejecutables; la implementación se resuelve
 *   por `strategy_implementations` (repositorio de backtest) contra el
 *   catálogo `CLASSIC_STRATEGIES` — los mismos módulos del backtest.
 * - Pasarela única: `services.risk.submitSignal`. Sin motor de riesgo la
 *   evaluación se bloquea (degradación segura: mejor no emitir que
 *   emitir sin veto).
 * - Diario y avisos: `journal.record` estructural (opcional mientras el
 *   diario convive con su esqueleto) y `ctx.broadcast` perezoso, que
 *   delivery intercepta para `signals:new`.
 * - Guardas: `scheduler` en pausa, `connectivity` 'offline' o parada
 *   activa bloquean la evaluación.
 * - Idempotencia: marcas persistentes en settings ('signals.processed',
 *   lista acotada) más el UNIQUE (ticker, vela_fecha) de la tabla.
 *
 * IPC: `signals:list`, `signals:get`, `signals:strategies` y, solo en
 * desarrollo/E2E sin empaquetar, `signals:evaluate-now`.
 */
import { app, ipcMain } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isE2eEnabled,
  isSignalId,
  isSignalsListQuery,
  type MarketUpdatedEvent,
} from '../../shared/ipc';
import { SIGNAL_EMITTING_STRATEGY_STATUSES } from '../../shared/signals';
import type { JournalRecordInput } from '../../shared/journal';
import { openDatabase } from '../db/database';
import { createBacktestRepository } from '../backtest/repository';
import { CLASSIC_STRATEGIES } from '../backtest/strategies';
import { createMarketRepository, type StoredBar } from '../market/repository';
import type { ServiceContext } from '../services';
import {
  createSignalEngine,
  SIGNAL_PROCESSED_MARKS_LIMIT,
  type EvaluableStrategy,
  type SignalEngine,
  type SignalSourceBar,
} from './engine';
import { createSignalsRepository } from './repository';

export interface SignalsService {
  /** El núcleo, expuesto para pruebas del propio servicio. */
  engine: SignalEngine;
  stop(): void;
}

/** Clave de settings con las marcas «ticker|fecha» ya evaluadas. */
const PROCESSED_SETTINGS_KEY = 'signals.processedBars';

/** La vela que evalúa la estrategia: serie ajustada, cruda de respaldo. */
function toSourceBar(bar: StoredBar): SignalSourceBar {
  return {
    date: bar.date,
    open: bar.adjOpen ?? bar.open,
    high: bar.adjHigh ?? bar.high,
    low: bar.adjLow ?? bar.low,
    close: bar.adjClose ?? bar.close,
    volume: bar.adjVolume ?? bar.volume,
    batchId: bar.batchId,
    source: bar.source,
  };
}

export function registerSignals(ctx: ServiceContext): SignalsService {
  // Sin base de datos el motor degrada a memoria (mismo patrón que el
  // resto de servicios del proceso principal).
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[signals] almacén no disponible: las señales solo vivirán en memoria');
    db = openDatabase(':memory:');
  }
  const repo = createSignalsRepository(db);
  const market = createMarketRepository(db);
  const runs = createBacktestRepository(db);

  const settings = ctx.services.settings;
  let processedMarks: Set<string> | null = null;

  const loadMarks = (): Set<string> => {
    if (processedMarks !== null) return processedMarks;
    processedMarks = new Set<string>();
    const raw = settings?.getValue(PROCESSED_SETTINGS_KEY);
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const mark of parsed) {
            if (typeof mark === 'string') processedMarks.add(mark);
          }
        }
      } catch {
        console.warn('[signals] marcas de velas evaluadas ilegibles; se empieza de cero');
      }
    }
    return processedMarks;
  };

  const markProcessed = (ticker: string, barDate: string): void => {
    const marks = loadMarks();
    marks.add(`${ticker}|${barDate}`);
    if (settings && marks.size > SIGNAL_PROCESSED_MARKS_LIMIT) {
      // Acotado: conserva las últimas marcas (Set conserva el orden de alta).
      const keep = [...marks].slice(-SIGNAL_PROCESSED_MARKS_LIMIT);
      processedMarks = new Set(keep);
    }
    try {
      settings?.setValue(PROCESSED_SETTINGS_KEY, JSON.stringify([...processedMarks!]));
    } catch (error: unknown) {
      console.warn(`[signals] no se pudieron guardar las marcas de evaluación: ${String(error)}`);
    }
  };

  const listEvaluables = (): EvaluableStrategy[] => {
    const strategies = ctx.services.strategies;
    if (!strategies) return [];
    const evaluables: EvaluableStrategy[] = [];
    for (const summary of strategies.list()) {
      if (!(SIGNAL_EMITTING_STRATEGY_STATUSES as readonly string[]).includes(summary.status)) {
        continue;
      }
      const ficha = strategies.get(summary.id);
      if (ficha === null || !ficha.executable) continue;
      const implKey = runs.implementationKey(ficha.id);
      const impl =
        implKey === null ? undefined : CLASSIC_STRATEGIES.find((entry) => entry.key === implKey);
      if (impl === undefined) continue;
      evaluables.push({ ficha, create: impl.create });
    }
    return evaluables;
  };

  const barsFor = (
    ticker: string,
    hasta: string,
    preferSource: string | null,
  ): SignalSourceBar[] => {
    let rows: StoredBar[] = preferSource
      ? market.getBars(ticker, { hasta, source: preferSource })
      : [];
    if (rows.length === 0) {
      // Una sola fuente por serie: la más reciente que tenga datos.
      const all = market.getBars(ticker, { hasta });
      const source = all[all.length - 1]?.source;
      rows = source === undefined ? [] : all.filter((bar) => bar.source === source);
    }
    return rows.map(toSourceBar);
  };

  const journal = ctx.services.journal as
    { record?(input: JournalRecordInput): unknown } | undefined;

  const engine = createSignalEngine({
    repo,
    listEvaluables,
    listStrategies: () => ctx.services.strategies?.list() ?? [],
    listWatchlistTickers: () =>
      ctx.services.market?.listWatchlist().map((item) => item.ticker) ?? [],
    barsFor,
    lastBarDate: (ticker) => market.lastBarDate(ticker),
    getBatchVersion: (batchId) => market.getBatch(batchId)?.version ?? null,
    submitSignal: (intent) => {
      const risk = ctx.services.risk;
      if (!risk) {
        // Degradación segura: sin pasarela no se emite señal.
        throw new Error('la pasarela de riesgo no está disponible');
      }
      return risk.submitSignal(intent);
    },
    recordJournal: (input) => journal?.record?.(input),
    // Perezoso a propósito: delivery envuelve ctx.broadcast al registrarse
    // después y necesita ver los `signals:new`.
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
    isAgentsPaused: () => ctx.services.scheduler?.getState().paused ?? false,
    isOffline: () => ctx.services.connectivity?.getState().status === 'offline',
    isKillSwitchActive: () => ctx.services.killSwitch?.getState().active ?? false,
    wasProcessed: (ticker, barDate) => loadMarks().has(`${ticker}|${barDate}`),
    markProcessed,
  });

  // Disparo: cada lote guardado de un activo evalúa su última vela.
  const unsubscribe = ctx.services.market?.onBarsStored((event: MarketUpdatedEvent) => {
    engine.handleBarStored(event);
  });

  ipcMain.handle(IPC_CHANNELS.signals.list, (_event, query: unknown) => {
    if (!isSignalsListQuery(query)) {
      throw new IpcValidationError(
        IPC_CHANNELS.signals.list,
        'se esperaba {ticker?, decision?, strategyId?, desde?, hasta?, limit?, offset?}',
      );
    }
    return engine.listSignals(query);
  });
  ipcMain.handle(IPC_CHANNELS.signals.get, (_event, id: unknown) => {
    if (!isSignalId(id)) {
      throw new IpcValidationError(IPC_CHANNELS.signals.get, 'id de señal inválido');
    }
    return engine.getSignal(id);
  });
  ipcMain.handle(IPC_CHANNELS.signals.strategies, () => engine.listStrategyStates());

  // Gancho de desarrollo/E2E: la app empaquetada no lo registra (mismo
  // patrón que risk:simulate-* y market:advance-clock).
  if (isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E)) {
    ipcMain.handle(IPC_CHANNELS.signals.evaluateNow, () => engine.evaluateNow());
  }

  return {
    engine,
    stop: () => {
      unsubscribe?.();
      engine.stop();
    },
  };
}
