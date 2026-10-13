/**
 * Pruebas del registro `registerNewsAi` (`index.ts`): canales IPC propios
 * con guardas de entrada, el cableado con el lector (`onItemsStored` solo
 * encola confirmados) y el analizador simulado en modo E2E.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const os = vi.hoisted(() => ({
  isPackaged: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return os.isPackaged;
    },
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      os.handlers.set(channel, handler),
  },
}));

import type Database from 'better-sqlite3';

import { IPC_CHANNELS, NEWS_LLM_MODEL, type NewsItem } from '../../../shared/ipc';
import { openDatabase } from '../../db/database';
import type { ServiceContext } from '../../services';
import type { StorageService } from '../../services/storage';
import type { SettingsService } from '../../services/settings';
import type { SecretsService } from '../../services/secrets';
import type { NewsPollerService, NewsItemsStoredEvent } from '../../news/poller';
import type { NotificationsService } from '../../services/notifications';
import { NEWS_LLM_SETTINGS_KEYS, registerNewsAi } from './index';

const NOW_ISO = '2026-10-10T10:00:00.000Z';

let db: Database.Database;
let itemSeq = 0;

function insertItem(input: { title: string; confirmed: boolean; assets?: string[] }): NewsItem {
  const id = Number(
    db
      .prepare(
        `INSERT INTO news_items (titulo, url, publicado, resumen, prioridad, confirmada, hash)
         VALUES (?, NULL, ?, NULL, 'activo', ?, ?)`,
      )
      .run(input.title, NOW_ISO, input.confirmed ? 1 : 0, `hash-${++itemSeq}`).lastInsertRowid,
  );
  for (const ticker of input.assets ?? []) {
    db.prepare('INSERT INTO news_item_assets (item_id, ticker) VALUES (?, ?)').run(id, ticker);
  }
  return {
    id,
    title: input.title,
    url: null,
    publishedAt: NOW_ISO,
    summary: null,
    priority: 'activo',
    confirmed: input.confirmed,
    sources: [],
    assets: input.assets ?? [],
  };
}

function setup(
  options: {
    packaged?: boolean;
    e2e?: boolean;
    hasKey?: boolean;
    settings?: Record<string, string>;
  } = {},
) {
  os.isPackaged = options.packaged ?? false;
  if (options.e2e) process.env.TRADIA_E2E = '1';
  else delete process.env.TRADIA_E2E;

  const hasKey = options.hasKey ?? false;
  const settingsMap = new Map<string, string>(Object.entries(options.settings ?? {}));
  const notify = vi.fn();
  const pollerListener: { current: ((event: NewsItemsStoredEvent) => void) | null } = {
    current: null,
  };
  const ctx: ServiceContext = {
    broadcast: vi.fn(),
    services: {
      storage: {
        ready: true,
        dbPath: ':memory:',
        getDb: () => db,
        init: async () => undefined,
        close: () => undefined,
      } satisfies StorageService,
      settings: {
        get: () => ({
          autostart: false,
          disclaimerAcceptedVersion: null,
          disclaimerAcceptedAt: null,
          brokerExecutionEnabled: true,
          deviationMarginPp: 30,
          deviationSlippageBps: 25,
          onboardingTourVersion: null,
          onboardingTourCompletedAt: null,
        }),
        set: (patch) => patch as never,
        getNotificationPrefs: () => ({ info: true, alerta: true, critica: true }),
        setNotificationPrefs: () => undefined,
        getValue: (key) => settingsMap.get(key) ?? null,
        setValue: (key, value) => void settingsMap.set(key, value),
      } satisfies SettingsService,
      secrets: {
        setKey: async () => undefined,
        hasKey: async () => hasKey,
        deleteKey: async () => undefined,
        getKey: async () => (hasKey ? 'sk-ant-prueba' : null),
      } satisfies SecretsService,
      poller: {
        onItemsStored: (listener: (event: NewsItemsStoredEvent) => void) => {
          pollerListener.current = listener;
          return () => undefined;
        },
      } as unknown as NewsPollerService,
      notifications: { notify } as unknown as NotificationsService,
    },
  };
  const service = registerNewsAi(ctx);
  return { ctx, service, pollerListener, settingsMap, notify };
}

beforeEach(() => {
  db = openDatabase(':memory:');
  os.handlers.clear();
});

afterEach(() => {
  db.close();
  delete process.env.TRADIA_E2E;
});

describe('canales IPC propios', () => {
  it('registra los canales con guardas de entrada', async () => {
    setup();
    for (const channel of [
      IPC_CHANNELS.ai.newsAnalysis,
      IPC_CHANNELS.ai.newsStatus,
      IPC_CHANNELS.ai.getLlmSettings,
      IPC_CHANNELS.ai.setLlmSettings,
      IPC_CHANNELS.ai.testLlm,
    ]) {
      expect(os.handlers.has(channel), `falta el canal ${channel}`).toBe(true);
    }
    expect(() => os.handlers.get(IPC_CHANNELS.ai.newsAnalysis)!(null, { limit: -3 })).toThrow(
      /entrada inválida/,
    );
    expect(() => os.handlers.get(IPC_CHANNELS.ai.setLlmSettings)!(null, { dailyCap: -1 })).toThrow(
      /entrada inválida/,
    );
    // El proveedor 'llm' (API de pago retirada) ya no pasa la guarda.
    expect(() =>
      os.handlers.get(IPC_CHANNELS.ai.setLlmSettings)!(null, { provider: 'llm' }),
    ).toThrow(/entrada inválida/);
    expect(os.handlers.get(IPC_CHANNELS.ai.newsAnalysis)!(null, undefined)).toEqual([]);
  });

  it('ai:news-status devuelve el estado del proveedor', async () => {
    setup();
    const status = await os.handlers.get(IPC_CHANNELS.ai.newsStatus)!(null);
    expect(status).toMatchObject({ provider: expect.any(String), state: expect.any(String) });
  });

  it('al arrancar con la suscripción activada y sin CLI llega UNA notificación', async () => {
    const { service, notify, ctx } = setup({
      settings: {
        [NEWS_LLM_SETTINGS_KEYS.provider]: 'suscripcion',
        [NEWS_LLM_SETTINGS_KEYS.enabled]: 'true',
        // Una ruta configurada que no existe: la CLI no se encuentra en
        // ningún equipo, tenga o no Claude Code instalado.
        [NEWS_LLM_SETTINGS_KEYS.cliPath]: '/ruta/que/no/existe/claude',
      },
    });
    await service.start();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      level: 'alerta',
      body: 'No se encontró Claude Code. Abre Ajustes › Análisis de noticias para resolverlo.',
    });
    expect(ctx.broadcast).toHaveBeenCalledWith(
      IPC_CHANNELS.ai.newsStatusChanged,
      expect.objectContaining({ state: 'cli-no-encontrada' }),
    );
  });

  it('al arrancar con el analizador local no notifica', async () => {
    const { service, notify } = setup({
      settings: {
        [NEWS_LLM_SETTINGS_KEYS.provider]: 'local',
        [NEWS_LLM_SETTINGS_KEYS.enabled]: 'false',
      },
    });
    await service.start();
    expect(notify).not.toHaveBeenCalled();
  });

  it('setLlmSettings persiste y devuelve el estado sin presupuesto de API', async () => {
    const { settingsMap } = setup({ hasKey: true });
    // Sin CLI localizable: una ruta configurada inválida fija la detección.
    settingsMap.set('newsLlm.cliPath', '/no/existe/claude');
    const saved = await os.handlers.get(IPC_CHANNELS.ai.setLlmSettings)!(null, {
      enabled: true,
      dailyCap: 25,
      monthlyBudgetEur: 10,
    });
    expect(saved).toMatchObject({ dailyCap: 25, monthlyBudgetEur: 0 });
    const settings = await os.handlers.get(IPC_CHANNELS.ai.getLlmSettings)!(null);
    expect(settings).toMatchObject({ dailyCap: 25 });
  });
});

describe('cableado con el lector', () => {
  it('onItemsStored encola solo los titulares confirmados', async () => {
    const { pollerListener, service } = setup();
    const confirmed = insertItem({
      title: 'Apple beats estimates',
      confirmed: true,
      assets: ['AAPL'],
    });
    const pending = insertItem({ title: 'Rumor sin verificar', confirmed: false });
    pollerListener.current!({ added: [confirmed, pending], updated: [] });
    await service.drain();
    const rows = service.listAnalyses();
    expect(rows.every((r) => r.newsItemId === confirmed.id)).toBe(true);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.analyzer === 'local')).toBe(true);
  });

  it('los titulares actualizados también se procesan', async () => {
    const { pollerListener, service } = setup();
    const item = insertItem({ title: 'Broadcom soars', confirmed: true, assets: ['AVGO'] });
    pollerListener.current!({ added: [], updated: [item] });
    await service.drain();
    expect(service.listAnalyses({ newsItemId: item.id })).toHaveLength(1);
  });
});

describe('modo E2E', () => {
  it('con TRADIA_E2E usa el analizador simulado determinista', async () => {
    const { pollerListener, service } = setup({ e2e: true, hasKey: true });
    const item = insertItem({ title: 'Apple surges', confirmed: true, assets: ['AAPL'] });
    pollerListener.current!({ added: [item], updated: [] });
    await service.drain();
    const rows = service.listAnalyses();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.analyzer).toBe('llm');
    expect(rows[0]!.model).toBe(NEWS_LLM_MODEL);
  });

  it('la app empaquetada nunca usa el simulado aunque TRADIA_E2E=1', async () => {
    const { pollerListener, service } = setup({ e2e: true, packaged: true });
    const item = insertItem({ title: 'Apple surges', confirmed: true, assets: ['AAPL'] });
    pollerListener.current!({ added: [item], updated: [] });
    await service.drain();
    expect(service.listAnalyses()[0]!.analyzer).toBe('local');
  });
});
