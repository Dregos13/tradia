/**
 * Registro del análisis de noticias en la app — fase 6.
 *
 * `registerNewsAi` cablea el servicio (`service.ts`) en el proceso
 * principal y registra sus canales IPC propios: `ai:news-analysis`,
 * `ai:news-status`, `ai:get-llm-settings`, `ai:set-llm-settings` y
 * `ai:test-llm`. Consume `poller.onItemsStored` para encolar solo los
 * titulares confirmados que guarda cada pasada del lector, emite
 * `ai:changed` ('noticias') tras persistir cada análisis y
 * `ai:news-status-changed` cuando cambia la salud del proveedor —
 * además de UNA notificación del sistema al caer de 'ok' y otra al
 * recuperarla (cablea `notifications.notify`).
 *
 * Con `TRADIA_E2E` (app sin empaquetar) el servicio usa el analizador
 * simulado determinista: ningún titular sale hacia la CLI y los
 * resultados son reproducibles.
 *
 * La API de pago ('llm') se retiró: el servicio migra un proveedor
 * 'llm' guardado a 'suscripcion' si hay CLI o a 'local' si no, y borra
 * del llavero la clave que quedara (`news-llm-anthropic`).
 *
 * Cableado (tarea «be-servicios-ipc-e2e»): en `initServices`, tras
 * `poller`, `secrets`, `settings`, `notifications` y `storage`:
 *   services.newsAi = registerNewsAi(ctx);
 */
import { app, ipcMain } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isE2eEnabled,
  isNewsAnalysisQuery,
  isNewsLlmSettingsInput,
  NEWS_LLM_DAILY_CAP_DEFAULT,
} from '../../../shared/ipc';
import { openDatabase } from '../../db/database';
import type { ServiceContext } from '../../services';
import { createClaudeCliAnalyzer } from './claudeCli';
import { createLocalNewsAnalyzer } from './local';
import { createNewsAnalysisRepository } from './repository';
import { createNewsAiService, NEWS_LLM_SETTINGS_KEYS, type NewsAiService } from './service';
import { createSimulatedNewsAnalyzer } from './simulated';
import type { KeyValueStore, NewsLlmUsageStore } from './types';

export * from './types';
export * from './local';
export * from './prompt';
export * from './claudeCli';
export * from './simulated';
export * from './repository';
export * from './service';
export * from './eval';

const memoryStore = (): KeyValueStore => {
  const map = new Map<string, string>();
  return { getValue: (k) => map.get(k) ?? null, setValue: (k, v) => void map.set(k, v) };
};

/** Clave de `settings` donde viven los contadores del tope diario (JSON). */
export const NEWS_LLM_USAGE_KEY = 'newsLlm.usage';

/** Contadores del tope diario persistidos como JSON en `settings`. */
export function createSettingsUsageStore(store: KeyValueStore): NewsLlmUsageStore {
  return {
    load: () => {
      try {
        const raw = store.getValue(NEWS_LLM_USAGE_KEY);
        if (!raw) throw new Error('vacío');
        const parsed = JSON.parse(raw) as Partial<{
          day: string;
          usedToday: number;
          month: string;
          spentMonthEur: number;
        }>;
        return {
          day: typeof parsed.day === 'string' ? parsed.day : '',
          usedToday: typeof parsed.usedToday === 'number' ? parsed.usedToday : 0,
          month: typeof parsed.month === 'string' ? parsed.month : '',
          spentMonthEur: typeof parsed.spentMonthEur === 'number' ? parsed.spentMonthEur : 0,
        };
      } catch {
        return { day: '', usedToday: 0, month: '', spentMonthEur: 0 };
      }
    },
    save: (usage) => {
      store.setValue(NEWS_LLM_USAGE_KEY, JSON.stringify(usage));
    },
  };
}

const readNumber = (store: KeyValueStore, key: string, fallback: number): number => {
  const raw = Number(store.getValue(key));
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

export function registerNewsAi(ctx: ServiceContext): NewsAiService {
  // Sin base de datos el servicio degrada a memoria para no tumbar la app
  // (mismo patrón que el lector de noticias).
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[news-ai] almacén no disponible: el análisis solo vivirá en memoria');
    db = openDatabase(':memory:');
  }
  const repo = createNewsAnalysisRepository(db);
  const store: KeyValueStore = ctx.services.settings ?? memoryStore();
  const secrets = ctx.services.secrets ?? null;
  const usage = createSettingsUsageStore(store);
  const e2e = isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E);

  const subscriptionAnalyzer = createClaudeCliAnalyzer({
    // La ruta puede cambiar en Ajustes: se relee en cada resolución.
    cliPath: () => {
      const raw = store.getValue(NEWS_LLM_SETTINGS_KEYS.cliPath);
      return raw && raw.trim().length > 0 ? raw : null;
    },
    usage,
    dailyCap: () => readNumber(store, NEWS_LLM_SETTINGS_KEYS.dailyCap, NEWS_LLM_DAILY_CAP_DEFAULT),
  });

  const service = createNewsAiService({
    repo,
    localAnalyzer: createLocalNewsAnalyzer(),
    subscriptionAnalyzer,
    // E2E: el simulado con etiqueta 'llm' reproduce el método del diseño.
    simulatedAnalyzer: createSimulatedNewsAnalyzer({ analyzer: 'llm' }),
    useSimulated: e2e,
    secrets,
    store,
    usage,
    notify: (payload) => ctx.services.notifications?.notify(payload),
    broadcast: ctx.broadcast,
    logger: console,
  });

  // El lector entrega titulares de cada pasada; la cola descarta los no
  // confirmados en `enqueueItem` y relee `confirmada` antes de analizar.
  ctx.services.poller?.onItemsStored((event) => {
    for (const item of [...event.added, ...event.updated]) {
      service.enqueueItem(item);
    }
  });

  ipcMain.handle(IPC_CHANNELS.ai.newsAnalysis, (_event, query: unknown) => {
    if (!isNewsAnalysisQuery(query)) {
      throw new IpcValidationError(IPC_CHANNELS.ai.newsAnalysis, 'filtros del análisis inválidos');
    }
    return service.listAnalyses(query);
  });
  ipcMain.handle(IPC_CHANNELS.ai.newsStatus, () => service.getNewsStatus());
  ipcMain.handle(IPC_CHANNELS.ai.getLlmSettings, () => service.getLlmSettings());
  ipcMain.handle(IPC_CHANNELS.ai.setLlmSettings, (_event, input: unknown) => {
    if (!isNewsLlmSettingsInput(input)) {
      throw new IpcValidationError(IPC_CHANNELS.ai.setLlmSettings, 'ajustes del LLM inválidos');
    }
    return service.setLlmSettings(input);
  });
  ipcMain.handle(IPC_CHANNELS.ai.testLlm, () => service.testLlm());

  return service;
}
