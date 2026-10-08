import type Database from 'better-sqlite3';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IPC_CHANNELS,
  IpcValidationError,
  type AddSourceRequest,
  type NewsSource,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import rssFeed from './connectors/__fixtures__/rss20.xml?raw';
import error404Body from './connectors/__fixtures__/error-404.html?raw';

// electron solo aporta ipcMain; se captura el mapa de handlers registrados.
const env = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      env.handlers.set(channel, handler),
  },
}));

import { createConnectorRegistry, type ConnectorFetch } from './connectors';
import {
  createSourcesRepository,
  createSourcesService,
  registerSources,
  SourcesError,
  SOURCE_DEFAULT_INTERVAL_SECONDS,
} from './sources';

const FIXED_NOW = Date.parse('2026-10-08T12:00:00.000Z');

const dbs: Database.Database[] = [];
const db = (): Database.Database => {
  const instance = openDatabase(':memory:');
  dbs.push(instance);
  return instance;
};

afterEach(() => {
  for (const instance of dbs.splice(0)) {
    if (instance.open) instance.close();
  }
});

/** fetch simulado que sirve el cuerpo/estado indicados a cualquier URL. */
function fetchReturning(body: string, status = 200): ConnectorFetch {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(body),
  });
}

function makeService(fetch: ConnectorFetch = fetchReturning(rssFeed)) {
  const repo = createSourcesRepository(db());
  const connectors = createConnectorRegistry({ fetch, now: () => FIXED_NOW });
  return {
    repo,
    service: createSourcesService({ repo, connectors, now: () => FIXED_NOW }),
  };
}

const addRequest = (overrides: Partial<AddSourceRequest> = {}): AddSourceRequest => ({
  name: 'Feed de prueba',
  kind: 'rss',
  connector: 'rss',
  url: 'https://example.com/feed.xml',
  reliability: 'prensa',
  ...overrides,
});

describe('repositorio de fuentes (news_sources)', () => {
  it('inserta, lee, actualiza y borra una fuente', () => {
    const repo = createSourcesRepository(db());
    const created = repo.insert({
      name: 'Fed RSS',
      kind: 'oficial',
      connector: 'rss',
      url: 'https://www.federalreserve.gov/feeds/press_all.xml',
      params: { tags: ['fomc', 'minutas'] },
      reliability: 'oficial',
      intervalSeconds: 300,
    });
    expect(created.id).toBeGreaterThan(0);
    expect(created.params).toEqual({ tags: ['fomc', 'minutas'] });
    expect(created.active).toBe(true);
    expect(created.lastStatus).toBe('pendiente');

    const updated = repo.update(created.id, { id: created.id, name: 'Fed (todo)', active: false });
    expect(updated).toMatchObject({ name: 'Fed (todo)', active: false });
    expect(repo.listActive().map((s) => s.id)).not.toContain(created.id);

    expect(repo.delete(created.id)).toBe(true);
    expect(repo.get(created.id)).toBeNull();
    expect(repo.delete(created.id)).toBe(false);
  });

  it('al borrar una fuente caen sus enlaces pero los titulares se quedan', () => {
    const database = db();
    const repo = createSourcesRepository(database);
    const source = repo.insert({
      name: 'Feed',
      kind: 'rss',
      connector: 'rss',
      url: 'https://example.com/rss',
      params: {},
      reliability: 'prensa',
      intervalSeconds: 300,
    });
    const itemId = Number(
      database
        .prepare(
          `INSERT INTO news_items (titulo, url, publicado, hash) VALUES ('t', 'https://x', '2026-10-08T10:00:00Z', 'h1')`,
        )
        .run().lastInsertRowid,
    );
    database
      .prepare('INSERT INTO news_item_sources (item_id, source_id, visto_en) VALUES (?, ?, ?)')
      .run(itemId, source.id, '2026-10-08T10:00:00Z');

    repo.delete(source.id);

    expect(
      database.prepare('SELECT COUNT(*) AS n FROM news_item_sources').get() as { n: number },
    ).toEqual({ n: 0 });
    expect(
      (database.prepare('SELECT COUNT(*) AS n FROM news_items').get() as { n: number }).n,
    ).toBe(1);
  });
});

describe('servicio de fuentes', () => {
  it('ciclo completo: alta → probar → titulares → quitar', async () => {
    const { service } = makeService();

    const added = service.add(addRequest());
    expect(added).toMatchObject({
      name: 'Feed de prueba',
      connector: 'rss',
      reliability: 'prensa',
      intervalSeconds: SOURCE_DEFAULT_INTERVAL_SECONDS,
      lastStatus: 'pendiente',
    });

    // Probar conexión sobre la fuente guardada: cuenta titulares y marca ok.
    const result = await service.test({ id: added.id });
    expect(result).toMatchObject({ ok: true, itemsFound: 3, error: null });
    const afterTest = service.list().find((s) => s.id === added.id)!;
    expect(afterTest.lastStatus).toBe('ok');
    expect(afterTest.lastFetchedAt).toBe('2026-10-08T12:00:00.000Z');

    const remaining = service.remove(added.id);
    expect(remaining).toEqual([]);
  });

  it('«probar» sobre un borrador no guarda nada', async () => {
    const { service } = makeService();
    const result = await service.test(addRequest({ name: 'Borrador' }));
    expect(result.ok).toBe(true);
    expect(result.itemsFound).toBe(3);
    expect(service.list()).toEqual([]);
  });

  it('«probar» informa del motivo del error y lo deja en la fuente', async () => {
    const { service } = makeService(fetchReturning(error404Body, 404));
    const added = service.add(addRequest());
    const result = await service.test({ id: added.id });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('404');
    const after = service.list()[0]!;
    expect(after.lastStatus).toBe('error');
    expect(after.lastError).toContain('404');
    expect(after.lastFetchedAt).toBeNull();
  });

  it('rechaza conectores desconocidos y altas de RSS sin URL', async () => {
    const { service } = makeService();
    expect(() => service.add(addRequest({ connector: 'benzinga' }))).toThrowError(SourcesError);
    expect(() => service.add(addRequest({ connector: 'benzinga' }))).toThrowError(
      /no está registrado/,
    );
    const noUrl = { ...addRequest() } as Record<string, unknown>;
    delete noUrl.url;
    expect(() => service.add(noUrl as unknown as AddSourceRequest)).toThrowError(
      /necesita una URL/,
    );
    await expect(service.test(addRequest({ connector: 'desconocido' }))).resolves.toMatchObject({
      ok: false,
      itemsFound: 0,
      error: expect.stringContaining('no está registrado'),
    });
  });

  it('rechaza claves de API en params: las credenciales van a secrets', () => {
    const { service } = makeService();
    for (const key of ['apiKey', 'api_key', 'token', 'secret', 'clave']) {
      expect(() => service.add(addRequest({ params: { [key]: 'x' } }))).toThrowError(
        /gestor de claves/,
      );
    }
    // Un param inocuo sí pasa.
    const ok = service.add(addRequest({ params: { categoria: 'monetary' } }));
    expect(ok.params).toEqual({ categoria: 'monetary' });
  });

  it('edita nombre, fiabilidad e intervalo; falla si la fuente no existe', () => {
    const { service } = makeService();
    const added = service.add(addRequest());
    const updated = service.update({
      id: added.id,
      name: 'Nombre nuevo',
      reliability: 'agencia',
      intervalSeconds: 600,
      active: false,
    });
    expect(updated).toMatchObject({
      name: 'Nombre nuevo',
      reliability: 'agencia',
      intervalSeconds: 600,
      active: false,
    });
    expect(() => service.update({ id: 999, name: 'x' })).toThrowError(/no existe/);
    return expect(service.test({ id: 999 })).rejects.toThrowError(/no existe/);
  });

  it('expone al programador las activas, el conector y el registro de lecturas', () => {
    const { service } = makeService();
    const a = service.add(addRequest({ name: 'A' }));
    const b = service.add(addRequest({ name: 'B' }));
    service.update({ id: b.id, active: false });

    expect(service.listActive().map((s) => s.id)).toEqual([a.id]);
    expect(service.connectorFor(a)?.id).toBe('rss');
    expect(service.toConnectorConfig(a)).toMatchObject({ id: a.id, kind: 'rss' });

    service.recordFetch(a.id, { ok: false, error: 'timeout' });
    expect(service.list()[0]).toMatchObject({ lastStatus: 'error', lastError: 'timeout' });
  });
});

describe('handlers IPC sources:*', () => {
  beforeEach(() => env.handlers.clear());

  const ctx = (database: Database.Database) => ({
    broadcast: vi.fn(),
    services: {
      storage: { getDb: () => database },
      secrets: { getKey: async () => null },
    },
  });

  const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!(null, ...args);

  it('registra los cinco canales y valida la entrada', () => {
    registerSources(ctx(db()) as never);

    for (const channel of Object.values(IPC_CHANNELS.sources)) {
      expect(env.handlers.has(channel), `falta handler ${channel}`).toBe(true);
    }
    expect(() => invoke(IPC_CHANNELS.sources.add, { name: '' })).toThrowError(IpcValidationError);
    expect(() => invoke(IPC_CHANNELS.sources.remove, -3)).toThrowError(IpcValidationError);
    expect(() => invoke(IPC_CHANNELS.sources.test, {})).toThrowError(IpcValidationError);
    expect(() => invoke(IPC_CHANNELS.sources.update, { id: 1 })).toThrowError(IpcValidationError);
  });

  it('alta → probar → quitar por IPC con un feed file:// local', async () => {
    const service = registerSources(ctx(db()) as never);
    const feedUrl = new URL('./connectors/__fixtures__/rss20.xml', import.meta.url).href;

    const added = (await invoke(IPC_CHANNELS.sources.add, {
      ...addRequest({ name: 'Feed local E2E', url: feedUrl }),
    })) as NewsSource;
    expect(added.id).toBeGreaterThan(0);

    const result = (await invoke(IPC_CHANNELS.sources.test, { id: added.id })) as {
      ok: boolean;
      itemsFound: number;
    };
    expect(result).toMatchObject({ ok: true, itemsFound: 3 });

    const listed = (await invoke(IPC_CHANNELS.sources.list)) as NewsSource[];
    expect(listed).toHaveLength(1);

    const afterRemove = (await invoke(IPC_CHANNELS.sources.remove, added.id)) as NewsSource[];
    expect(afterRemove).toEqual([]);
    expect(service.list()).toEqual([]);
  });
});
