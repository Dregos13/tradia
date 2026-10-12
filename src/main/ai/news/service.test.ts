/**
 * Pruebas del servicio de análisis de noticias (`service.ts` + `repository.ts`):
 * la cola solo procesa titulares CONFIRMADOS, persiste por activo en
 * `news_analysis`, usa la suscripción (CLI de Claude Code) cuando está
 * elegida y cae al clasificador local ante cualquier fallo de la CLI
 * (tope incluido) con un aviso. También los ajustes IPC, «probar
 * conexión», la migración del proveedor 'llm' retirado (con su clave) y
 * el estado de la suscripción con su notificación única por transición.
 */
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { openDatabase } from '../../db/database';
import { createClaudeCliAnalyzer } from './claudeCli';
import { createNewsAnalysisRepository } from './repository';
import { createNewsAiService, NEWS_LLM_SETTINGS_KEYS } from './service';
import {
  createMemoryUsageStore,
  NewsLlmError,
  type KeyValueStore,
  type NewsHeadlineAnalyzer,
} from './types';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');

const memoryStore = (): KeyValueStore => {
  const map = new Map<string, string>();
  return { getValue: (k) => map.get(k) ?? null, setValue: (k, v) => void map.set(k, v) };
};

const analyzerStub = (
  impl?: NewsHeadlineAnalyzer['analyze'],
  label: 'llm' | 'local' | 'suscripcion' = 'local',
): NewsHeadlineAnalyzer & { analyze: ReturnType<typeof vi.fn> } => ({
  analyzer: label,
  model:
    label === 'llm'
      ? 'claude-haiku-4-5-20251001'
      : label === 'suscripcion'
        ? 'claude-code-cli'
        : null,
  analyze: vi.fn(
    impl ??
      (async (input) => ({
        assets: (input.candidateTickers ?? []).map((ticker: string) => ({
          ticker,
          summary: `resumen ${ticker}`,
          sentiment: 'positivo' as const,
        })),
      })),
  ),
});

function setup(options: {
  confirmed?: boolean;
  assets?: string[];
  local?: NewsHeadlineAnalyzer;
  sub?: (NewsHeadlineAnalyzer & { ping?(): Promise<number>; available?(): boolean }) | null;
  hasKey?: boolean;
  useSimulated?: boolean;
  simulated?: NewsHeadlineAnalyzer | null;
  notify?: (payload: unknown) => void;
}) {
  const db = openDatabase(':memory:');
  const repo = createNewsAnalysisRepository(db);
  const store = memoryStore();
  const broadcast = vi.fn();
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const hasKey = options.hasKey ?? false;
  const deletedKeys: string[] = [];
  const secrets = {
    hasKey: vi.fn(async () => hasKey),
    deleteKey: vi.fn(async (provider: string) => {
      deletedKeys.push(provider);
    }),
  };
  const usage = { load: vi.fn(() => ({ day: '', usedToday: 0, month: '', spentMonthEur: 0 })) };
  const notify = vi.fn(options.notify ?? (() => undefined));
  const service = createNewsAiService({
    repo,
    localAnalyzer: options.local ?? analyzerStub(),
    subscriptionAnalyzer: options.sub ?? null,
    simulatedAnalyzer: options.simulated ?? null,
    useSimulated: options.useSimulated ?? false,
    secrets,
    store,
    usage,
    notify,
    broadcast,
    now: () => NOW,
    logger,
  });
  return { db, repo, store, service, broadcast, logger, secrets, deletedKeys, notify };
}

let seq = 0;
function insertItem(
  db: ReturnType<typeof openDatabase>,
  input: { title?: string; confirmed: boolean; assets?: string[] },
): number {
  const id = Number(
    db
      .prepare(
        `INSERT INTO news_items (titulo, url, publicado, resumen, prioridad, confirmada, hash)
         VALUES (?, NULL, '2026-10-10T10:00:00.000Z', NULL, 'activo', ?, ?)`,
      )
      .run(input.title ?? `Titular ${++seq}`, input.confirmed ? 1 : 0, `hash-${seq}`)
      .lastInsertRowid,
  );
  for (const ticker of input.assets ?? []) {
    db.prepare('INSERT INTO news_item_assets (item_id, ticker) VALUES (?, ?)').run(id, ticker);
  }
  return id;
}

describe('cola de análisis: solo titulares confirmados', () => {
  it('una noticia no confirmada nunca se encola ni se analiza', async () => {
    const local = analyzerStub();
    const { db, service } = setup({ local });
    const id = insertItem(db, { confirmed: false, assets: ['AAPL'] });
    service.enqueueItem({ id, confirmed: false });
    service.enqueueItem({ id, confirmed: true }); // la fila dice lo contrario: manda el disco
    await service.drain();
    expect(local.analyze).not.toHaveBeenCalled();
    expect(service.listAnalyses()).toEqual([]);
  });

  it('un titular confirmado se analiza y persiste por activo', async () => {
    const local = analyzerStub();
    const { db, repo, service, broadcast } = setup({ local });
    const id = insertItem(db, {
      title: 'Apple beats estimates',
      confirmed: true,
      assets: ['AAPL', 'MSFT'],
    });
    service.enqueueItem({ id, confirmed: true });
    await service.drain();
    expect(local.analyze).toHaveBeenCalledWith(
      expect.objectContaining({ candidateTickers: ['AAPL', 'MSFT'] }),
    );
    const rows = repo.list();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.analyzer === 'local' && r.model === null)).toBe(true);
    expect(broadcast).toHaveBeenCalledWith('ai:changed', {
      kind: 'noticias',
      at: new Date(NOW).toISOString(),
    });
  });

  it('solo analiza los activos que aún no tienen fila', async () => {
    const local = analyzerStub();
    const { db, repo, service } = setup({ local });
    const id = insertItem(db, { confirmed: true, assets: ['AAPL', 'MSFT'] });
    repo.insertAnalysis({
      newsItemId: id,
      ticker: 'AAPL',
      summary: 'previo',
      sentiment: 'positivo',
      analyzer: 'local',
      model: null,
      analyzedAt: '2026-10-10T11:00:00.000Z',
    });
    service.enqueueItem({ id, confirmed: true });
    await service.drain();
    expect(local.analyze).toHaveBeenCalledWith(
      expect.objectContaining({ candidateTickers: ['MSFT'] }),
    );
    expect(repo.list()).toHaveLength(2);
  });

  it('con todos los activos analizados no llama al analizador', async () => {
    const local = analyzerStub();
    const { db, repo, service } = setup({ local });
    const id = insertItem(db, { confirmed: true, assets: ['AAPL'] });
    repo.insertAnalysis({
      newsItemId: id,
      ticker: 'AAPL',
      summary: 'previo',
      sentiment: 'neutro',
      analyzer: 'local',
      model: null,
      analyzedAt: '2026-10-10T11:00:00.000Z',
    });
    service.enqueueItem({ id, confirmed: true });
    await service.drain();
    expect(local.analyze).not.toHaveBeenCalled();
  });
});

describe('proveedor por suscripción (CLI de Claude Code)', () => {
  const subStub = (
    overrides: {
      analyze?: NewsHeadlineAnalyzer['analyze'];
      available?: boolean;
      ping?: () => Promise<number>;
    } = {},
  ) =>
    Object.assign(analyzerStub(overrides.analyze, 'suscripcion'), {
      available: vi.fn(() => overrides.available ?? true),
      ...(overrides.ping ? { ping: vi.fn(overrides.ping) } : {}),
    });

  const enable = (store: KeyValueStore): void => {
    store.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'suscripcion');
    store.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, 'true');
  };

  it('usa la CLI cuando el proveedor es suscripcion y está activada', async () => {
    const sub = subStub();
    const local = analyzerStub();
    const { db, repo, service, store } = setup({ sub, local });
    enable(store);
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
      confirmed: true,
    });
    await service.drain();
    expect(sub.analyze).toHaveBeenCalledTimes(1);
    expect(local.analyze).not.toHaveBeenCalled();
    // La fila queda rotulada con el método de suscripción.
    expect(repo.list().map((row) => row.analyzer)).toEqual(['suscripcion']);
    expect(repo.list()[0]!.model).toBe('claude-code-cli');
  });

  it('sin CLI localizable cae al local con un aviso', async () => {
    const sub = subStub({ available: false });
    const local = analyzerStub();
    const { db, service, store, logger } = setup({ sub, local });
    enable(store);
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
      confirmed: true,
    });
    await service.drain();
    expect(sub.analyze).not.toHaveBeenCalled();
    expect(local.analyze).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toContain('no encuentra la CLI');
  });

  it('un fallo de la CLI cae al local con un aviso por clase de fallo', async () => {
    const sub = subStub({
      analyze: async () => {
        throw new NewsLlmError('timeout', 'la CLI no respondió en 120000 ms');
      },
    });
    const local = analyzerStub();
    const { db, service, store, logger } = setup({ sub, local });
    enable(store);
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
      confirmed: true,
    });
    await service.drain();
    expect(local.analyze).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toContain('la CLI no respondió');
  });

  it('el tope diario (quota) detiene la suscripción y pasa al local con un aviso', async () => {
    const sub = subStub({
      analyze: async () => {
        throw new NewsLlmError('quota', 'tope diario alcanzado (200/200): se usa análisis local');
      },
    });
    const local = analyzerStub();
    const { db, service, store, logger } = setup({ sub, local });
    enable(store);
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
      confirmed: true,
    });
    await service.drain();
    expect(local.analyze).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toContain('tope diario');
  });

  it('en E2E siempre usa el analizador simulado', async () => {
    const simulated = analyzerStub(undefined, 'llm');
    const sub = subStub();
    const { db, service, store } = setup({ sub, simulated, useSimulated: true });
    enable(store);
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
      confirmed: true,
    });
    await service.drain();
    expect(simulated.analyze).toHaveBeenCalledTimes(1);
    expect(sub.analyze).not.toHaveBeenCalled();
  });

  it('sin nada guardado el proveedor por defecto es suscripcion con CLI y local sin ella', async () => {
    const { service: conCli } = setup({ sub: subStub() });
    const settings = await conCli.getLlmSettings();
    expect(settings.provider).toBe('suscripcion');
    expect(settings.cliAvailable).toBe(true);

    const { service: sinCli } = setup({});
    const sinSettings = await sinCli.getLlmSettings();
    expect(sinSettings.provider).toBe('local');
    expect(sinSettings.cliAvailable).toBe(false);
  });

  it('activar el interruptor sin proveedor guardado elige el detectado', async () => {
    // Con CLI: activar guarda 'suscripcion'.
    const { service: conCli, store: conCliStore } = setup({ sub: subStub() });
    const saved = await conCli.setLlmSettings({ enabled: true });
    expect(saved.provider).toBe('suscripcion');
    expect(conCliStore.getValue(NEWS_LLM_SETTINGS_KEYS.provider)).toBe('suscripcion');

    // Sin CLI: el único proveedor que queda sin suscripción es el local.
    const { service: sinCli, store: sinCliStore } = setup({});
    const savedSin = await sinCli.setLlmSettings({ enabled: true });
    expect(savedSin.provider).toBe('local');
    expect(sinCliStore.getValue(NEWS_LLM_SETTINGS_KEYS.provider)).toBe('local');
  });

  it('testLlm con suscripcion prueba la CLI y distingue sus motivos', async () => {
    const okSub = subStub({ ping: async () => 321 });
    const { service: ok, store: okStore } = setup({ sub: okSub });
    okStore.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'suscripcion');
    expect(await ok.testLlm()).toEqual({ ok: true, error: null, latencyMs: 321 });
    expect(okSub.ping).toHaveBeenCalledTimes(1);

    const authSub = subStub({
      ping: async () => {
        throw new NewsLlmError('auth', 'sesión no iniciada: ejecuta «claude» y completa /login');
      },
    });
    const { service: noAuth, store: noAuthStore } = setup({ sub: authSub });
    noAuthStore.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'suscripcion');
    const noAuthResult = await noAuth.testLlm();
    expect(noAuthResult.ok).toBe(false);
    expect(noAuthResult.error).toContain('sesión no iniciada');

    const missingSub = subStub({
      ping: async () => {
        throw new NewsLlmError('network', 'CLI no encontrada: instala Claude Code');
      },
    });
    const { service: missing, store: missingStore } = setup({ sub: missingSub });
    missingStore.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'suscripcion');
    const missingResult = await missing.testLlm();
    expect(missingResult.ok).toBe(false);
    expect(missingResult.error).toContain('CLI no encontrada');
  });
});

describe('migración del proveedor retirado (la API de pago)', () => {
  const subStub = (available = true) =>
    Object.assign(analyzerStub(undefined, 'suscripcion'), {
      available: vi.fn(() => available),
    });

  it('un ajuste «llm» guardado migra a suscripcion con CLI y a local sin ella', async () => {
    // Con CLI localizable: 'llm' → 'suscripcion' conservando el interruptor.
    const { service: conCli, store: conCliStore } = setup({ sub: subStub(), hasKey: true });
    conCliStore.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'llm');
    conCliStore.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, 'true');
    const migrated = await conCli.getLlmSettings();
    expect(migrated.provider).toBe('suscripcion');
    expect(migrated.enabled).toBe(true);
    expect(conCliStore.getValue(NEWS_LLM_SETTINGS_KEYS.provider)).toBe('suscripcion');

    // Sin CLI: 'llm' → 'local' (suscripción imposible).
    const { service: sinCli, store: sinCliStore } = setup({ sub: subStub(false) });
    sinCliStore.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'llm');
    sinCliStore.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, 'true');
    const migratedSin = await sinCli.getLlmSettings();
    expect(migratedSin.provider).toBe('local');
    expect(migratedSin.enabled).toBe(false);
    expect(sinCliStore.getValue(NEWS_LLM_SETTINGS_KEYS.provider)).toBe('local');
    expect(sinCliStore.getValue(NEWS_LLM_SETTINGS_KEYS.enabled)).toBe('false');
  });

  it('la migración borra la clave cifrada de la API retirada', async () => {
    const { service, store, secrets, deletedKeys } = setup({ sub: subStub(), hasKey: true });
    store.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'llm');
    await service.getLlmSettings();
    expect(secrets.deleteKey).toHaveBeenCalledWith('news-llm-anthropic');
    expect(deletedKeys).toEqual(['news-llm-anthropic']);
  });

  it('la migración corre también desde la cola de análisis', async () => {
    const local = analyzerStub();
    const { db, service, store } = setup({ sub: subStub(false), local });
    store.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'llm');
    store.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, 'true');
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
      confirmed: true,
    });
    await service.drain();
    expect(store.getValue(NEWS_LLM_SETTINGS_KEYS.provider)).toBe('local');
    expect(local.analyze).toHaveBeenCalledTimes(1);
  });

  it('un proveedor «llm» escrito directamente en la base de datos se migra', async () => {
    const db = openDatabase(':memory:');
    // El ajuste heredado entra por SQL, como quedó guardado la versión
    // anterior: nada pasa por setLlmSettings (que ya no admite 'llm').
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`).run(
      NEWS_LLM_SETTINGS_KEYS.provider,
      'llm',
      NOW.toString(),
    );
    db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`).run(
      NEWS_LLM_SETTINGS_KEYS.enabled,
      'true',
      NOW.toString(),
    );
    const store: KeyValueStore = {
      getValue: (key) =>
        (
          db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
            { value: string } | undefined
        )?.value ?? null,
      setValue: (key, value) => {
        db.prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(key, value, NOW.toString());
      },
    };
    const service = createNewsAiService({
      repo: createNewsAnalysisRepository(db),
      localAnalyzer: analyzerStub(),
      subscriptionAnalyzer: subStub(),
      secrets: { hasKey: async () => false, deleteKey: async () => undefined },
      store,
      now: () => NOW,
    });
    const settings = await service.getLlmSettings();
    expect(settings.provider).toBe('suscripcion');
    expect(store.getValue(NEWS_LLM_SETTINGS_KEYS.provider)).toBe('suscripcion');
    db.close();
  });
});

describe('ajustes del análisis y probar conexión', () => {
  it('persiste los ajustes con márgenes y devuelve el estado', async () => {
    const { service, store } = setup({});
    const saved = await service.setLlmSettings({ enabled: true, dailyCap: 50 });
    expect(saved).toMatchObject({ enabled: false, dailyCap: 50, provider: 'local' });
    expect(store.getValue(NEWS_LLM_SETTINGS_KEYS.enabled)).toBe('false');
    // Los márgenes se imponen: tope diario ≤ 2000.
    const clamped = await service.setLlmSettings({ dailyCap: 99_999 });
    expect(clamped.dailyCap).toBe(2_000);
    // El presupuesto de la API retirada se acepta y se ignora: siempre 0.
    const ignored = await service.setLlmSettings({ monthlyBudgetEur: 10 });
    expect(ignored.monthlyBudgetEur).toBe(0);
    expect(store.getValue('newsLlm.monthlyBudgetEur')).toBeNull();
  });

  it('getLlmSettings informa uso del día sin clave ni presupuesto', async () => {
    const { service } = setup({ hasKey: false });
    const settings = await service.getLlmSettings();
    expect(settings.hasKey).toBe(false);
    expect(settings).not.toHaveProperty('apiKey');
    expect(settings.usedToday).toBe(0);
    expect(settings.dailyCap).toBe(200);
    expect(settings.monthlyBudgetEur).toBe(0);
  });

  it('testLlm prueba el proveedor elegido: local y suscripción', async () => {
    // 'local' no tiene nada que conectar: la prueba siempre sale bien.
    const { service: local } = setup({});
    expect(await local.testLlm()).toEqual({ ok: true, error: null, latencyMs: null });

    // 'suscripcion' sin la CLI instalada (cliAvailable false) da el motivo.
    const { service: suscripcion, store: susStore } = setup({});
    susStore.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'suscripcion');
    susStore.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, 'true');
    const susResult = await suscripcion.testLlm();
    expect(susResult.ok).toBe(false);
    expect(susResult.error).toContain('CLI no encontrada');
  });
});

describe('estado de la suscripción y notificación única', () => {
  const subStub = (
    overrides: {
      analyze?: NewsHeadlineAnalyzer['analyze'];
      available?: boolean;
      ping?: () => Promise<number>;
    } = {},
  ) =>
    Object.assign(analyzerStub(overrides.analyze, 'suscripcion'), {
      available: vi.fn(() => overrides.available ?? true),
      ...(overrides.ping ? { ping: vi.fn(overrides.ping) } : {}),
    });

  const enable = (store: KeyValueStore): void => {
    store.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'suscripcion');
    store.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, 'true');
  };

  it('con la suscripción sana el estado es ok', async () => {
    const { service, store } = setup({ sub: subStub() });
    enable(store);
    const status = await service.getNewsStatus();
    expect(status.provider).toBe('suscripcion');
    expect(status.state).toBe('ok');
    expect(status.message).toBeNull();
  });

  it('sin sesión devuelve sin-sesion, emite el evento y notifica UNA vez en 10 fallos', async () => {
    const sub = subStub({
      analyze: async () => {
        throw new NewsLlmError('auth', 'sesión no iniciada: ejecuta «claude» y completa /login');
      },
    });
    const { db, service, store, broadcast, notify } = setup({ sub });
    enable(store);
    for (let i = 0; i < 10; i += 1) {
      service.enqueueItem({
        id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
        confirmed: true,
      });
    }
    await service.drain();

    const status = await service.getNewsStatus();
    expect(status.provider).toBe('suscripcion');
    expect(status.state).toBe('sin-sesion');
    expect(status.message).toContain('/login');
    // El evento de cambio llegó al renderer…
    expect(broadcast).toHaveBeenCalledWith(
      'ai:news-status-changed',
      expect.objectContaining({ provider: 'suscripcion', state: 'sin-sesion' }),
    );
    // …y la notificación del sistema se mandó UNA sola vez, no diez.
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0]).toMatchObject({
      level: 'alerta',
      title: 'Tradia usa el analizador local',
      navigateTo: 'ajustes',
    });
    // Los diez titulares se analizaron igualmente con el clasificador local.
    expect(service.listAnalyses()).toHaveLength(10);
  });

  it('la recuperación a ok notifica una vez más', async () => {
    let fail = true;
    const sub = subStub({
      analyze: async (input) => {
        if (fail) throw new NewsLlmError('auth', 'sesión no iniciada');
        return {
          assets: (input.candidateTickers ?? []).map((ticker: string) => ({
            ticker,
            summary: `resumen ${ticker}`,
            sentiment: 'positivo' as const,
          })),
        };
      },
    });
    const { db, service, store, notify } = setup({ sub });
    enable(store);
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
      confirmed: true,
    });
    await service.drain();
    expect(notify).toHaveBeenCalledTimes(1);

    fail = false;
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['MSFT'] }),
      confirmed: true,
    });
    await service.drain();
    const status = await service.getNewsStatus();
    expect(status.state).toBe('ok');
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]![0]).toMatchObject({
      level: 'info',
      title: 'Suscripción de Claude recuperada',
      navigateTo: 'ajustes',
    });
  });

  it('la CLI no encontrada se refleja como cli-no-encontrada sin notificar en el arranque', async () => {
    const sub = subStub({ available: false });
    const { db, service, store, notify } = setup({ sub });
    enable(store);
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
      confirmed: true,
    });
    await service.drain();
    const status = await service.getNewsStatus();
    expect(status.state).toBe('cli-no-encontrada');
    expect(status.message).toContain('Claude Code');
    // La CLI nunca estuvo bien en esta sesión: no hay caída que anunciar.
    expect(notify).not.toHaveBeenCalled();
  });

  it('el tope diario se refleja como tope-diario', async () => {
    const sub = subStub({
      analyze: async () => {
        throw new NewsLlmError('quota', 'tope diario alcanzado (200/200)');
      },
    });
    const { db, service, store } = setup({ sub });
    enable(store);
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
      confirmed: true,
    });
    await service.drain();
    expect((await service.getNewsStatus()).state).toBe('tope-diario');
  });
});

// -- Estado con la CLI falsa de verdad (proceso de Node con spawn) -----

const CLI_FIXTURE = fileURLToPath(new URL('./__fixtures__/fake-claude-cli.mjs', import.meta.url));
const ON_WINDOWS = process.platform === 'win32';

describe.skipIf(ON_WINDOWS)('estado de la suscripción con la CLI falsa', () => {
  let root: string;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('en modo «sin sesión» ai:news-status devuelve sin-sesion con una sola notificación', async () => {
    root = mkdtempSync(join(tmpdir(), 'tradia-news-status-'));
    const binDir = join(root, 'bin');
    const home = join(root, 'home');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(home, { recursive: true });
    const cliPath = join(binDir, 'claude');
    copyFileSync(CLI_FIXTURE, cliPath);
    chmodSync(cliPath, 0o755);
    // La CLI falsa lee su modo de ${TMPDIR}/tradia-fake-claude.json.
    const configPath = join(root, 'tradia-fake-claude.json');
    writeFileSync(configPath, JSON.stringify({ mode: 'noauth' }));

    const sandboxedIsExecutable = (path: string): boolean => {
      if (!path.startsWith(root)) return false;
      try {
        if (!statSync(path).isFile()) return false;
        accessSync(path, fsConstants.X_OK);
        return true;
      } catch {
        return false;
      }
    };

    const sub = createClaudeCliAnalyzer({
      cliPath: () => cliPath,
      // El PATH lleva la CLI falsa y el directorio de node (el shebang).
      env: {
        HOME: home,
        TMPDIR: root,
        PATH: `${binDir}${delimiter}${dirname(process.execPath)}`,
      },
      isExecutableFile: sandboxedIsExecutable,
      listDir: () => [],
      usage: createMemoryUsageStore(),
      dailyCap: () => 200,
      now: () => NOW,
    });

    const local = analyzerStub();
    const { db, service, store, broadcast, notify } = setup({ sub, local });
    store.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'suscripcion');
    store.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, 'true');

    for (let i = 0; i < 10; i += 1) {
      service.enqueueItem({
        id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
        confirmed: true,
      });
    }
    await service.drain();

    const status = await service.getNewsStatus();
    expect(status).toMatchObject({ provider: 'suscripcion', state: 'sin-sesion' });
    expect(status.message).toContain('/login');
    expect(broadcast).toHaveBeenCalledWith(
      'ai:news-status-changed',
      expect.objectContaining({ state: 'sin-sesion' }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
    // Los titulares cayeron al clasificador local.
    expect(service.listAnalyses()).toHaveLength(10);
  });
});

describe('filtro de activos del resultado (solo ligados o mencionados)', () => {
  it('sin activos ligados descarta el ticker que el titular no menciona', async () => {
    const local = analyzerStub(async () => ({
      assets: [
        { ticker: 'MSFT', summary: 'Microsoft cae.', sentiment: 'negativo' as const },
        { ticker: 'AAPL', summary: 'El analizador lo inventa.', sentiment: 'positivo' as const },
      ],
    }));
    const { db, repo, service } = setup({ local });
    const id = insertItem(db, {
      title: 'Microsoft drops after cloud growth misses estimates',
      confirmed: true,
      assets: [],
    });
    service.enqueueItem({ id, confirmed: true });
    await service.drain();
    expect(repo.list().map((row) => row.ticker)).toEqual(['MSFT']);
  });

  it('sin activos ligados acepta un cashtag que el titular sí menciona', async () => {
    const local = analyzerStub(async () => ({
      assets: [
        { ticker: 'NVDA', summary: 'Nvidia sube.', sentiment: 'positivo' as const },
        { ticker: 'AAPL', summary: 'No aparece.', sentiment: 'positivo' as const },
      ],
    }));
    const { db, repo, service } = setup({ local });
    const id = insertItem(db, {
      title: '$NVDA soars on earnings beat',
      confirmed: true,
      assets: [],
    });
    service.enqueueItem({ id, confirmed: true });
    await service.drain();
    expect(repo.list().map((row) => row.ticker)).toEqual(['NVDA']);
  });
});
