/**
 * Servicio de detección de degradación — Fase 6 (registro).
 *
 * `createDriftService` (service.ts) es el núcleo testeable; aquí se
 * cablea sobre la base de datos real y los servicios ya registrados:
 *
 * - Disparo: `routine.onPostMarket` (tras la conciliación del día corre
 *   la revisión diaria: una 'datos' y una 'resultados' del modelo por
 *   día civil de Nueva York y una 'rendimiento' por mes y estrategia)
 *   más una pasada inicial al registrarse; `ai:health` evalúa lo que
 *   falte antes de servir la vista.
 * - Fuentes: las mismas velas ajustadas que predicción (una sola fuente
 *   por serie), `predictions`/`model_cards` vía el repositorio de drift,
 *   `broker_orders` para las operaciones cerradas y la expectativa del
 *   último backtest vía `services.backtest` (mismo cableado que el
 *   informe de desviación del broker).
 * - Efectos: la degradación escribe la ficha (`strategies.setStatus` o
 *   `model_cards`), el Diario, una notificación crítica y `ai:changed`
 *   ('salud'); sin conexión la revisión queda en pausa.
 *
 * IPC propio: `ai:health`, `ai:retrain-proposals`, `ai:resolve-retrain`
 * y, solo en desarrollo/E2E sin empaquetar, `ai:simulate-drift`.
 */
import { app, ipcMain } from 'electron';

import {
  BROKER_ORDERS_MAX_LIMIT,
  IPC_CHANNELS,
  IpcValidationError,
  isE2eEnabled,
  isRetrainResolveRequest,
  isSimulateDriftRequest,
} from '../../../shared/ipc';
import type { JournalRecordInput } from '../../../shared/journal';
import type { StoredBar } from '../../market/repository';
import { createMarketRepository } from '../../market/repository';
import { createBrokerRepository } from '../../broker/repository';
import { closedTradesFromOrders, expectationFromReport } from '../../broker/deviation';
import { openDatabase } from '../../db/database';
import type { ServiceContext } from '../../services';
import type { PredictionCandle } from '../prediction/features';
import { createDriftRepository } from './repository';
import { createDriftService, type DriftService } from './service';

export interface AiDriftService {
  /** El núcleo, expuesto para pruebas del propio servicio. */
  service: DriftService;
  stop(): void;
}

/** La vela sobre la que se calculan las variables: serie ajustada, cruda de respaldo. */
function toPredictionCandle(bar: StoredBar): PredictionCandle {
  return {
    date: bar.date,
    open: bar.adjOpen ?? bar.open,
    high: bar.adjHigh ?? bar.high,
    low: bar.adjLow ?? bar.low,
    close: bar.adjClose ?? bar.close,
    volume: bar.adjVolume ?? bar.volume,
  };
}

/** IPC del servicio: salud, propuestas, resolución y el gancho E2E. */
export function registerDriftIpc(service: DriftService): void {
  ipcMain.handle(IPC_CHANNELS.ai.health, () => service.health());
  ipcMain.handle(IPC_CHANNELS.ai.retrainProposals, () => service.proposals());
  ipcMain.handle(IPC_CHANNELS.ai.resolveRetrain, (_event, request: unknown) => {
    if (!isRetrainResolveRequest(request)) {
      throw new IpcValidationError(
        IPC_CHANNELS.ai.resolveRetrain,
        'se esperaba {id, action: aprobar|posponer, postponeUntil?, note?}',
      );
    }
    return service.resolve(request);
  });

  // Gancho de desarrollo/E2E: la app empaquetada no lo registra (mismo
  // patrón que ai:simulate-regime).
  if (isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E)) {
    ipcMain.handle(IPC_CHANNELS.ai.simulateDrift, (_event, request: unknown) => {
      if (!isSimulateDriftRequest(request)) {
        throw new IpcValidationError(
          IPC_CHANNELS.ai.simulateDrift,
          'se esperaba {kind: datos|resultados|rendimiento, subjectId?, streak?}',
        );
      }
      return service.simulateDrift(request);
    });
  }
}

export function registerDrift(ctx: ServiceContext): AiDriftService {
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[ai/drift] almacén no disponible: la salud solo vivirá en memoria');
    db = openDatabase(':memory:');
  }
  const repo = createDriftRepository(db);
  const market = createMarketRepository(db);
  const broker = createBrokerRepository(db);

  const journal = ctx.services.journal as
    { record?(input: JournalRecordInput): unknown } | undefined;

  // Una sola fuente por serie (mismo criterio que régimen y predicción).
  const barsFor = (ticker: string): PredictionCandle[] => {
    const all = market.getBars(ticker);
    const source = all[all.length - 1]?.source;
    const rows = source === undefined ? [] : all.filter((bar) => bar.source === source);
    return rows.map(toPredictionCandle);
  };

  const service = createDriftService({
    repo,
    barsFor,
    listWatchlistTickers: () =>
      ctx.services.market?.listWatchlist().map((item) => item.ticker) ?? [],
    listStrategies: () => ctx.services.strategies?.list() ?? [],
    setStrategyStatus: (request) => ctx.services.strategies?.setStatus(request),
    closedTrades: () => {
      const orders = [];
      let offset = 0;
      for (;;) {
        const page = broker.listOrders({
          status: 'ejecutada',
          limit: BROKER_ORDERS_MAX_LIMIT,
          offset,
        });
        orders.push(...page);
        if (page.length < BROKER_ORDERS_MAX_LIMIT) break;
        offset += BROKER_ORDERS_MAX_LIMIT;
      }
      return closedTradesFromOrders(orders);
    },
    expectationFor: (strategyId) => {
      const latest = ctx.services.backtest?.listRuns({ strategyId, limit: 1 })[0];
      return expectationFromReport(
        latest === undefined ? null : (ctx.services.backtest?.getRun(latest.id) ?? null),
      );
    },
    recordJournal: (input) => journal?.record?.(input),
    notify: (payload) => ctx.services.notifications?.notify(payload),
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
    isOnline: () => ctx.services.connectivity?.getState().status !== 'offline',
  });

  // Disparo diario: tras la conciliación de la rutina corre la revisión.
  const unsubscribePostMarket = ctx.services.routine?.onPostMarket(() => {
    try {
      service.evaluate();
    } catch (error: unknown) {
      console.error(`[ai/drift] falló la revisión postmercado: ${String(error)}`);
    }
  });

  // Pasada inicial: si el día aún no tiene revisiones se hacen ahora
  // (la deduplicación por día/mes la hace idempotente).
  try {
    service.evaluate();
  } catch (error: unknown) {
    console.error(`[ai/drift] falló la revisión inicial: ${String(error)}`);
  }

  registerDriftIpc(service);

  return {
    service,
    stop: () => {
      unsubscribePostMarket?.();
    },
  };
}
