/**
 * Servicio de predicción ONNX en Node — Fase 6 (registro).
 *
 * `createPredictionService` (service.ts) es el núcleo testeable; aquí se
 * cablea sobre la base de datos real, los artefactos de
 * `resources/models/<version>/` (extraResources; el módulo nativo de
 * onnxruntime-node viaja fuera del asar, ver electron-builder.yml) y los
 * servicios ya registrados:
 *
 * - Modelo: `resources/models/current.json` fija la versión activa; se
 *   cargan `pipeline.json`, `model.onnx`, `vol.onnx` (con verificación
 *   SHA-256) y `model-card.json`, que se registra en `model_cards` con
 *   la aptitud recalculada por la app.
 * - Disparo: `market.onBarsStored` (cada lote guardado predice las
 *   sesiones pendientes del ticker y resuelve las que llegan a t+N) y
 *   `market.onWatchlistChanged` (un alta predice lo que falte). Al
 *   registrarse se hace una pasada inicial sobre los datos ya guardados.
 * - Estado del sistema: una clave `modelo:<version>` en `data_status`
 *   comunica si el modelo sirve ('fiable'), está degradado o no carga
 *   ('no-fiable'); `health` la observa y genera la notificación.
 *
 * IPC propio: `ai:predictions` y `ai:model-card`.
 */
import { ipcMain } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  dataStatusKey,
  IPC_CHANNELS,
  IpcValidationError,
  isPredictionsQuery,
  type DataStatusState,
} from '../../../shared/ipc';
import type { JournalRecordInput } from '../../../shared/journal';
import { openDatabase } from '../../db/database';
import { expectedSessionDateFor } from '../../market/assetCalendar';
import { createMarketRepository, type StoredBar } from '../../market/repository';
import { resourcePath } from '../../resources';
import type { ServiceContext } from '../../services';
import type { PredictionCandle } from './features';
import { loadPredictionModel } from './model';
import { createPredictionsRepository } from './repository';
import { createPredictionService, type PredictionService } from './service';

export interface AiPredictionService {
  /** El núcleo, expuesto para pruebas del propio servicio. */
  service: PredictionService;
  stop(): Promise<void>;
}

export interface RegisterPredictionOptions {
  /**
   * Directorio `resources/models` (con `current.json` y `<version>/`).
   * Por defecto el de la app (`resourcePath('models')`); las pruebas lo
   * apuntan a fixtures temporales.
   */
  modelsDir?: string;
  /**
   * Reloj compartido con la ingesta de mercado (adelantable por
   * `market:advance-clock`): fija la sesión esperada de la guarda de
   * frescura, así una vela vieja que llega en una puesta al día atrasada
   * no genera predicciones nuevas como si fueran vigentes. Por defecto,
   * el reloj real.
   */
  clock?: { now(): number };
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

/** Versión activa del modelo según `current.json`; null si no se puede leer. */
function currentModelVersion(modelsDir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(modelsDir, 'current.json'), 'utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { version?: unknown }).version === 'string' &&
      (parsed as { version: string }).version.trim() !== ''
    ) {
      return (parsed as { version: string }).version.trim();
    }
  } catch {
    // cae al null de debajo
  }
  return null;
}

/** IPC del servicio: predicciones guardadas y ficha del modelo vigente. */
export function registerPredictionIpc(service: PredictionService): void {
  ipcMain.handle(IPC_CHANNELS.ai.predictions, (_event, query: unknown) => {
    if (!isPredictionsQuery(query)) {
      throw new IpcValidationError(
        IPC_CHANNELS.ai.predictions,
        'se esperaba {ticker?, limit?} con limit entre 1 y 200',
      );
    }
    return service.predictions(query);
  });
  ipcMain.handle(IPC_CHANNELS.ai.modelCard, () => service.modelCard());
}

export function registerPrediction(
  ctx: ServiceContext,
  options: RegisterPredictionOptions = {},
): AiPredictionService {
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error(
      '[ai/prediction] almacén no disponible: las predicciones solo vivirán en memoria',
    );
    db = openDatabase(':memory:');
  }
  const repo = createPredictionsRepository(db);
  const market = createMarketRepository(db);

  const modelsDir = options.modelsDir ?? resourcePath('models');
  const version = currentModelVersion(modelsDir);
  const modelDir = version === null ? modelsDir : join(modelsDir, version);
  const statusKey = dataStatusKey.modelo(version ?? 'desconocido');

  const journal = ctx.services.journal as
    { record?(input: JournalRecordInput): unknown } | undefined;

  // Una sola fuente por serie (mismo criterio que régimen y señales).
  const barsFor = (ticker: string, preferSource: string | null): PredictionCandle[] => {
    let rows: StoredBar[] = preferSource ? market.getBars(ticker, { source: preferSource }) : [];
    if (rows.length === 0) {
      const all = market.getBars(ticker);
      const source = all[all.length - 1]?.source;
      rows = source === undefined ? [] : all.filter((bar) => bar.source === source);
    }
    return rows.map(toPredictionCandle);
  };

  const service = createPredictionService({
    repo,
    barsFor,
    listWatchlistTickers: () =>
      ctx.services.market?.listWatchlist().map((item) => item.ticker) ?? [],
    loadModel: () => loadPredictionModel(modelDir),
    loadCardJson: () => JSON.parse(readFileSync(join(modelDir, 'model-card.json'), 'utf8')),
    reportStatus: (patch: { state: DataStatusState; reason: string | null }) => {
      const entry = market.setDataStatus({
        key: statusKey,
        state: patch.state,
        reason: patch.reason,
        ...(patch.state === 'fiable' ? { lastOkAt: new Date().toISOString() } : {}),
        consecutiveFailures: 0,
      });
      ctx.broadcast(IPC_CHANNELS.dataStatus.changed, entry);
    },
    recordJournal: (input) => journal?.record?.(input),
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
    // Guarda de frescura: una serie por detrás de la última sesión
    // esperada no genera predicciones nuevas (datos viejos de una
    // puesta al día atrasada); la resolución de las pendientes sí corre.
    // Cada activo con su calendario: NYSE para acciones, 24/5 para divisas.
    expectedSessionDate: (_nowMs, ticker) =>
      expectedSessionDateFor(ticker, options.clock?.now() ?? Date.now()),
  });

  // Disparo: cada lote guardado predice lo pendiente del ticker y
  // resuelve las predicciones cuyo horizonte ya llegó.
  const unsubscribeBars = ctx.services.market?.onBarsStored((event) => {
    service.handleBarStored(event);
  });
  // Un alta en el seguimiento predice lo que falte con sus datos ya
  // guardados; una baja conserva el historial de predicciones.
  const unsubscribeWatchlist = ctx.services.market?.onWatchlistChanged(() => {
    void service.recalculateAll();
  });

  registerPredictionIpc(service);

  return {
    service,
    stop: async () => {
      unsubscribeBars?.();
      unsubscribeWatchlist?.();
      await service.stop();
    },
  };
}
