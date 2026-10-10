/**
 * Pruebas del servicio de análisis de noticias (`service.ts` + `repository.ts`):
 * la cola solo procesa titulares CONFIRMADOS, persiste por activo en
 * `news_analysis`, elige el LLM solo cuando está autorizado y cae al
 * clasificador local ante cualquier fallo del LLM (tope incluido) con un
 * aviso. También los ajustes IPC y «probar conexión» sin filtrar la clave.
 */
import { describe, expect, it, vi } from 'vitest';

import { openDatabase } from '../../db/database';
import { createNewsAnalysisRepository } from './repository';
import { createNewsAiService, NEWS_LLM_SETTINGS_KEYS } from './service';
import { NewsLlmError, type KeyValueStore, type NewsHeadlineAnalyzer } from './types';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');

const memoryStore = (): KeyValueStore => {
  const map = new Map<string, string>();
  return { getValue: (k) => map.get(k) ?? null, setValue: (k, v) => void map.set(k, v) };
};

const analyzerStub = (
  impl?: NewsHeadlineAnalyzer['analyze'],
  label: 'llm' | 'local' = 'local',
): NewsHeadlineAnalyzer & { analyze: ReturnType<typeof vi.fn> } => ({
  analyzer: label,
  model: label === 'llm' ? 'claude-haiku-4-5-20251001' : null,
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
  llm?: NewsHeadlineAnalyzer | null;
  local?: NewsHeadlineAnalyzer;
  hasKey?: boolean;
  useSimulated?: boolean;
  simulated?: NewsHeadlineAnalyzer | null;
}) {
  const db = openDatabase(':memory:');
  const repo = createNewsAnalysisRepository(db);
  const store = memoryStore();
  const broadcast = vi.fn();
  const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
  const hasKey = options.hasKey ?? false;
  const secrets = {
    hasKey: vi.fn(async () => hasKey),
    getKey: vi.fn(async () => (hasKey ? 'sk-ant-prueba' : null)),
  };
  const usage = { load: vi.fn(() => ({ day: '', usedToday: 0, month: '', spentMonthEur: 0 })) };
  const service = createNewsAiService({
    repo,
    localAnalyzer: options.local ?? analyzerStub(),
    llmAnalyzer: options.llm ?? null,
    simulatedAnalyzer: options.simulated ?? null,
    useSimulated: options.useSimulated ?? false,
    secrets,
    store,
    usage,
    broadcast,
    now: () => NOW,
    logger,
  });
  return { db, repo, store, service, broadcast, logger, secrets };
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

describe('elección de analizador y respaldo local', () => {
  const enable = (store: KeyValueStore): void => {
    store.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, 'true');
    store.setValue(NEWS_LLM_SETTINGS_KEYS.monthlyBudgetEur, '5');
  };

  it('usa el LLM solo si está activado, hay clave y hay presupuesto', async () => {
    const llm = analyzerStub(undefined, 'llm');
    const local = analyzerStub();
    const { db, service, store } = setup({ llm, local, hasKey: true });
    const id = insertItem(db, { confirmed: true, assets: ['AAPL'] });
    store.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, 'true');
    service.enqueueItem({ id, confirmed: true });
    await service.drain();
    // Sin presupuesto (0 € = sin gasto autorizado): local aunque esté activado.
    expect(llm.analyze).not.toHaveBeenCalled();
    expect(local.analyze).toHaveBeenCalledTimes(1);

    enable(store);
    const id2 = insertItem(db, { confirmed: true, assets: ['MSFT'] });
    service.enqueueItem({ id: id2, confirmed: true });
    await service.drain();
    expect(llm.analyze).toHaveBeenCalledTimes(1);
  });

  it('sin clave guardada el LLM nunca se llama', async () => {
    const llm = analyzerStub(undefined, 'llm');
    const { db, service, store } = setup({ llm, hasKey: false });
    enable(store);
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
      confirmed: true,
    });
    await service.drain();
    expect(llm.analyze).not.toHaveBeenCalled();
  });

  it('el tope diario (quota) detiene el LLM y pasa al local con un aviso', async () => {
    const llm = analyzerStub(async () => {
      throw new NewsLlmError('quota', 'tope diario alcanzado (200/200): se usa análisis local');
    }, 'llm');
    const local = analyzerStub();
    const { db, service, store, logger } = setup({ llm, local, hasKey: true });
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

  it('cualquier error del LLM cae al local, con un aviso por clase de fallo', async () => {
    const llm = analyzerStub(async () => {
      throw new NewsLlmError('auth', 'clave rechazada');
    }, 'llm');
    const local = analyzerStub();
    const { db, service, store, logger } = setup({ llm, local, hasKey: true });
    enable(store);
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
      confirmed: true,
    });
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['MSFT'] }),
      confirmed: true,
    });
    await service.drain();
    expect(local.analyze).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1); // un aviso por clase 'auth'
  });

  it('en E2E siempre usa el analizador simulado', async () => {
    const simulated = analyzerStub(undefined, 'llm');
    const llm = analyzerStub(undefined, 'llm');
    const { db, service, store } = setup({ llm, simulated, useSimulated: true, hasKey: true });
    enable(store);
    service.enqueueItem({
      id: insertItem(db, { confirmed: true, assets: ['AAPL'] }),
      confirmed: true,
    });
    await service.drain();
    expect(simulated.analyze).toHaveBeenCalledTimes(1);
    expect(llm.analyze).not.toHaveBeenCalled();
  });
});

describe('ajustes del LLM y probar conexión', () => {
  it('persiste los ajustes con márgenes y devuelve el estado', async () => {
    const { service, store } = setup({});
    const saved = await service.setLlmSettings({
      enabled: true,
      dailyCap: 50,
      monthlyBudgetEur: 10,
    });
    expect(saved).toMatchObject({ enabled: true, dailyCap: 50, monthlyBudgetEur: 10 });
    expect(store.getValue(NEWS_LLM_SETTINGS_KEYS.enabled)).toBe('true');
    // Los márgenes se imponen: tope diario ≤ 2000 y presupuesto ≤ 30 €.
    const clamped = await service.setLlmSettings({ dailyCap: 99_999, monthlyBudgetEur: 100 });
    expect(clamped.dailyCap).toBe(2_000);
    expect(clamped.monthlyBudgetEur).toBe(30);
  });

  it('getLlmSettings informa uso del día y del mes sin revelar la clave', async () => {
    const { service } = setup({ hasKey: true });
    const settings = await service.getLlmSettings();
    expect(settings.hasKey).toBe(true);
    expect(settings).not.toHaveProperty('apiKey');
    expect(settings.usedToday).toBe(0);
    expect(settings.dailyCap).toBe(200);
  });

  it('testLlm: sin llavero, sin clave, con éxito y con error saneado', async () => {
    const noSecrets = createNewsAiService({
      repo: createNewsAnalysisRepository(openDatabase(':memory:')),
      localAnalyzer: analyzerStub(),
      secrets: null,
      store: memoryStore(),
    });
    expect((await noSecrets.testLlm()).ok).toBe(false);

    const { service: noKey } = setup({ hasKey: false });
    const result = await noKey.testLlm();
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No hay una clave');

    const { service: ok } = setup({
      hasKey: true,
      llm: Object.assign(analyzerStub(undefined, 'llm'), { ping: async () => 42 }),
    });
    const success = await ok.testLlm();
    expect(success).toEqual({ ok: true, error: null, latencyMs: 42 });

    const { service: failing } = setup({
      hasKey: true,
      llm: Object.assign(analyzerStub(undefined, 'llm'), {
        ping: async (): Promise<number> => {
          throw new NewsLlmError('auth', 'clave rechazada (HTTP 401)');
        },
      }),
    });
    const failure = await failing.testLlm();
    expect(failure.ok).toBe(false);
    expect(failure.error).toContain('401');
    expect(failure.error).not.toContain('sk-ant');
  });
});

describe('la interfaz nunca crea señales', () => {
  it('ni el servicio ni los analizadores exponen métodos de señal u orden', () => {
    const { service } = setup({});
    const all = [
      ...Object.keys(service),
      ...Object.keys(analyzerStub()),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(service)),
    ];
    expect(all.filter((name) => /signal|order|submit|trade|risk/i.test(name))).toEqual([]);
  });
});
