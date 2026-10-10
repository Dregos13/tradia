/**
 * Servicio de régimen de mercado — Fase 6 (registro).
 *
 * `createRegimeService` (service.ts) es el núcleo testeable; aquí se
 * cablea sobre la base de datos real y los servicios ya registrados:
 *
 * - Disparo: `market.onBarsStored` (cada lote guardado recalcula el
 *   ticker; si es SPY también el ámbito 'mercado') y
 *   `market.onWatchlistChanged` (un alta recalcula lo que falte). Al
 *   registrarse se hace una pasada inicial sobre los datos ya guardados.
 * - Series: las velas guardadas en su serie ajustada (`adj*` con
 *   respaldo crudo), una sola fuente por serie — la del lote disparador
 *   o la más reciente del activo, mismo criterio que signals.
 * - Diario y avisos: `journal.record` (opcional) y `ctx.broadcast`
 *   perezoso para `ai:changed`.
 *
 * IPC propio: `ai:regime-overview` y, solo en desarrollo/E2E sin
 * empaquetar, `ai:simulate-regime`.
 */
import { app, ipcMain } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isE2eEnabled,
  isSimulateRegimeRequest,
} from '../../../shared/ipc';
import type { JournalRecordInput } from '../../../shared/journal';
import type { StoredBar } from '../../market/repository';
import { createMarketRepository } from '../../market/repository';
import { openDatabase } from '../../db/database';
import type { ServiceContext } from '../../services';
import { createRegimeRepository } from './repository';
import { createRegimeService, type RegimeCandle, type RegimeService } from './service';

export interface AiRegimeService {
  /** El núcleo, expuesto para pruebas del propio servicio. */
  service: RegimeService;
  stop(): void;
}

/** La vela que clasifica el régimen: serie ajustada, cruda de respaldo. */
function toRegimeCandle(bar: StoredBar): RegimeCandle {
  return {
    date: bar.date,
    open: bar.adjOpen ?? bar.open,
    high: bar.adjHigh ?? bar.high,
    low: bar.adjLow ?? bar.low,
    close: bar.adjClose ?? bar.close,
  };
}

/** IPC del régimen: lectura del overview y el gancho E2E de simulación. */
export function registerRegimeIpc(service: RegimeService): void {
  ipcMain.handle(IPC_CHANNELS.ai.regimeOverview, () => service.overview());

  // Gancho de desarrollo/E2E: la app empaquetada no lo registra (mismo
  // patrón que signals:evaluate-now y risk:simulate-*).
  if (isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E)) {
    ipcMain.handle(IPC_CHANNELS.ai.simulateRegime, (_event, request: unknown) => {
      if (!isSimulateRegimeRequest(request)) {
        throw new IpcValidationError(
          IPC_CHANNELS.ai.simulateRegime,
          'se esperaba {scope?, ticker?, direction?, volatility?, sessionDate?}',
        );
      }
      return service.simulateRegime(request);
    });
  }
}

export function registerRegime(ctx: ServiceContext): AiRegimeService {
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[ai/regime] almacén no disponible: el régimen solo vivirá en memoria');
    db = openDatabase(':memory:');
  }
  const repo = createRegimeRepository(db);
  const market = createMarketRepository(db);

  const journal = ctx.services.journal as
    | { record?(input: JournalRecordInput): unknown }
    | undefined;

  // Una sola fuente por serie: la del lote disparador si la tiene, si no
  // la más reciente que tenga datos (mismo criterio que signals/index).
  const barsFor = (ticker: string, preferSource: string | null): RegimeCandle[] => {
    let rows: StoredBar[] = preferSource ? market.getBars(ticker, { source: preferSource }) : [];
    if (rows.length === 0) {
      const all = market.getBars(ticker);
      const source = all[all.length - 1]?.source;
      rows = source === undefined ? [] : all.filter((bar) => bar.source === source);
    }
    return rows.map(toRegimeCandle);
  };

  const service = createRegimeService({
    repo,
    barsFor,
    lastBarDate: (ticker) => market.lastBarDate(ticker),
    listWatchlistTickers: () =>
      ctx.services.market?.listWatchlist().map((item) => item.ticker) ?? [],
    listStrategies: () => ctx.services.strategies?.list() ?? [],
    recordJournal: (input) => journal?.record?.(input),
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
  });

  // Disparo: cada lote guardado recalcula el régimen del activo (y del
  // mercado si el lote es de la referencia SPY).
  const unsubscribeBars = ctx.services.market?.onBarsStored((event) => {
    service.handleBarStored(event);
  });
  // Un alta en el seguimiento recalcula lo que falte con sus datos ya
  // guardados; una baja conserva el historial (sirve al backtest).
  const unsubscribeWatchlist = ctx.services.market?.onWatchlistChanged(() => {
    service.recalculateAll();
  });

  // Pasada inicial: los datos anteriores al servicio no emiten evento.
  try {
    service.recalculateAll();
  } catch (error: unknown) {
    console.error(`[ai/regime] falló el cálculo inicial del régimen: ${String(error)}`);
  }

  registerRegimeIpc(service);

  return {
    service,
    stop: () => {
      unsubscribeBars?.();
      unsubscribeWatchlist?.();
    },
  };
}
