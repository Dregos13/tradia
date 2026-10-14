/**
 * Auditoría de seguridad de la retirada de la API de pago — misión
 * «completa-estas-partes» (tarea seguridad-reglas-noticias).
 *
 * El proveedor 'llm' (API de Anthropic de pago) se retiró: el análisis de
 * titulares solo va por la suscripción de Claude Code (CLI local) o por
 * el clasificador léxico local. Esta batería comprueba que la retirada
 * no deja claves ni rutas olvidadas:
 *
 * - Migración real: un ajuste 'llm' y la clave cifrada heredados se
 *   siembran en SQLite ESCRIBIENDO LAS FILAS DIRECTAMENTE (sin pasar por
 *   setKey ni por el IPC, como quedaron guardados en la versión
 *   anterior) y se comprueba que tras la migración no queda clave de
 *   Anthropic en la tabla `secrets` ni 'llm' en `settings`, y que el
 *   registro no filtra ni la clave ni su cifrado.
 * - Borde IPC: `ai:set-llm-settings` no admite 'llm' por ninguna vía.
 * - Rutas olvidadas: nada en el proceso principal vuelve a leer la clave
 *   retirada ni contacta con Anthropic; la evaluación `eval:news-llm`
 *   solo acepta 'local' y 'suscripcion'.
 *
 * Convención: cada garantía corre como `it` normal. Ningún hallazgo se
 * marca como fallo esperado: los que haya se describen en
 * `docs/qa/auditoria-reglas-noticias.md` con su gravedad y sus pasos.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const electron = vi.hoisted(() => ({
  isPackaged: false,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
  safeStorage: {},
}));

import {
  IPC_CHANNELS,
  isNewsLlmSettingsInput,
  isNewsProvider,
  NEWS_PROVIDERS,
} from '../../../shared/ipc';
import { NEWS_LLM_SECRET_PROVIDER } from '../../../shared/ai';
import { openDatabase } from '../../db/database';
import { createSecretsService, type SafeStorageLike } from '../../services/secrets';
import type { ServiceContext } from '../../services';
import { createNewsAiService, NEWS_LLM_SETTINGS_KEYS, registerNewsAi } from '../news';
import { createNewsAnalysisRepository } from '../news/repository';
import type { KeyValueStore, NewsHeadlineAnalyzer } from '../news/types';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
/** Clave que simula una credencial de Anthropic guardada antes de la retirada. */
const LEGACY_PLAINTEXT = 'sk-ant-api03-LEGACY-SECRET-KEY-DO-NOT-LEAK-0123456789';

let db: Database.Database;

/**
 * Cifrado falso del llavero: reversible y marcado, suficiente para
 * ejercer `secrets` de verdad (escribe y lee la tabla `secrets`).
 */
const fakeCrypto: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`, 'utf8'),
  decryptString: (encrypted) => {
    const text = encrypted.toString('utf8');
    if (!text.startsWith('enc:')) throw new Error('cifrado inválido');
    return text.slice(4);
  },
};

const sqliteStore = (): KeyValueStore => ({
  getValue: (key) =>
    (
      db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
        { value: string } | undefined
    )?.value ?? null,
  setValue: (key, value) => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(key, value, '2026-10-10T00:00:00.000Z');
  },
});

/** Escribe la fila cifrada heredada directamente, sin pasar por setKey. */
const seedLegacyKey = (): string => {
  const ciphertext = fakeCrypto.encryptString(LEGACY_PLAINTEXT).toString('base64');
  db.prepare(
    `INSERT INTO secrets (provider, ciphertext, created_at, updated_at)
     VALUES (?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
  ).run(NEWS_LLM_SECRET_PROVIDER, ciphertext);
  return ciphertext;
};

const analyzerStub = (): NewsHeadlineAnalyzer => ({
  analyzer: 'local',
  model: null,
  analyze: async () => ({ assets: [] }),
});

interface Harness {
  service: ReturnType<typeof createNewsAiService>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  ping: ReturnType<typeof vi.fn>;
  secrets: ReturnType<typeof createSecretsService>;
  store: KeyValueStore;
  logText: () => string;
}

const makeService = (options: { cliAvailable?: boolean } = {}): Harness => {
  const secrets = createSecretsService(db, fakeCrypto);
  const store = sqliteStore();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const ping = vi.fn(async () => 42);
  const subscriptionAnalyzer = {
    ...analyzerStub(),
    analyzer: 'suscripcion' as const,
    model: 'claude-code-cli',
    available: () => options.cliAvailable ?? true,
    ping,
  };
  const service = createNewsAiService({
    repo: createNewsAnalysisRepository(db),
    localAnalyzer: analyzerStub(),
    subscriptionAnalyzer,
    secrets,
    store,
    usage: { load: () => ({ day: '', usedToday: 0, month: '', spentMonthEur: 0 }) },
    now: () => NOW,
    logger,
  });
  const logText = () =>
    [logger.info, logger.warn, logger.error]
      .flatMap((spy) => spy.mock.calls.flatMap((call) => call.map(String)))
      .join('\n');
  return { service, logger, ping, secrets, store, logText };
};

const settingsValue = (key: string): string | null =>
  (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)
    ?.value ?? null;

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = electron.handlers.get(channel);
  if (handler === undefined) throw new Error(`handler no registrado: ${channel}`);
  return handler({}, ...args);
};

beforeEach(() => {
  db = openDatabase(':memory:');
  electron.handlers.clear();
  electron.isPackaged = false;
});

afterEach(() => {
  db.close();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Migración: ni clave en la base ni 'llm' en ajustes ni filtrado en registros
// ---------------------------------------------------------------------------

describe('auditoría · migración del proveedor retirado', () => {
  it('tras migrar un ajuste «llm» no queda clave de Anthropic en la base de datos', async () => {
    // Estado heredado sembrado por SQL, como quedó en la versión
    // anterior: proveedor 'llm' activado y la clave cifrada en `secrets`.
    const ciphertext = seedLegacyKey();
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      NEWS_LLM_SETTINGS_KEYS.provider,
      'llm',
      '2024-01-01T00:00:00.000Z',
    );
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      NEWS_LLM_SETTINGS_KEYS.enabled,
      'true',
      '2024-01-01T00:00:00.000Z',
    );
    const { service, secrets } = makeService({ cliAvailable: true });

    // La migración corre al primer uso del servicio (ajustes, análisis o
    // prueba): aquí por getLlmSettings con CLI localizable → 'suscripcion'.
    const migrated = await service.getLlmSettings();
    expect(migrated.provider).toBe('suscripcion');
    expect(migrated.enabled).toBe(true);

    // La clave heredada ya no está ni accesible por el servicio secrets.
    expect(
      db.prepare('SELECT 1 AS x FROM secrets WHERE provider = ?').get(NEWS_LLM_SECRET_PROVIDER),
    ).toBeUndefined();
    expect(await secrets.hasKey(NEWS_LLM_SECRET_PROVIDER)).toBe(false);
    expect(await secrets.getKey(NEWS_LLM_SECRET_PROVIDER)).toBeNull();
    expect(migrated.hasKey).toBe(false);

    // Ni 'llm' queda como proveedor guardado, ni la clave ni su cifrado
    // sobreviven en ninguna fila de las tablas.
    expect(settingsValue(NEWS_LLM_SETTINGS_KEYS.provider)).toBe('suscripcion');
    const remaining = db
      .prepare(
        `SELECT key FROM settings WHERE value LIKE '%' || ? || '%'
         UNION ALL
         SELECT provider FROM secrets WHERE ciphertext LIKE '%' || ? || '%'`,
      )
      .all(LEGACY_PLAINTEXT, ciphertext) as { key: string }[];
    expect(remaining).toHaveLength(0);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM settings WHERE value = 'llm'`).get() as {
        n: number;
      },
    ).toMatchObject({ n: 0 });
  });

  it('los registros de la migración no filtran la clave ni su cifrado', async () => {
    const ciphertext = seedLegacyKey();
    for (const [key, value] of [
      [NEWS_LLM_SETTINGS_KEYS.provider, 'llm'],
      [NEWS_LLM_SETTINGS_KEYS.enabled, 'true'],
    ] as const) {
      db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        key,
        value,
        '2024-01-01T00:00:00.000Z',
      );
    }
    const { service, logText } = makeService({ cliAvailable: true });

    await service.getLlmSettings();
    await service.testLlm();

    const logs = logText();
    expect(logs).not.toContain(LEGACY_PLAINTEXT);
    expect(logs).not.toContain(ciphertext);
    expect(logs).not.toContain('sk-ant');
    // El aviso de migración existe pero solo cuenta qué se hizo.
    expect(logs).toContain("migrado a 'suscripcion'");
  });

  it('una clave reescrita tras la migración se borra en el siguiente arranque', async () => {
    const { service, secrets } = makeService({ cliAvailable: false });
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      NEWS_LLM_SETTINGS_KEYS.provider,
      'llm',
      '2024-01-01T00:00:00.000Z',
    );
    // Sin CLI: 'llm' → 'local' y el interruptor se baja.
    await service.getLlmSettings();
    expect(settingsValue(NEWS_LLM_SETTINGS_KEYS.provider)).toBe('local');
    expect(settingsValue(NEWS_LLM_SETTINGS_KEYS.enabled)).toBe('false');

    // Alguien reescribe la clave muerta (p. ej. `secrets:set-key` admite
    // cualquier proveedor por nombre). La migración es por proceso, así
    // que el siguiente arranque la vuelve a borrar.
    await secrets.setKey(NEWS_LLM_SECRET_PROVIDER, LEGACY_PLAINTEXT);
    const restart = makeService({ cliAvailable: false });
    await restart.service.getLlmSettings();
    expect(await secrets.hasKey(NEWS_LLM_SECRET_PROVIDER)).toBe(false);
    expect(
      db.prepare('SELECT 1 AS x FROM secrets WHERE provider = ?').get(NEWS_LLM_SECRET_PROVIDER),
    ).toBeUndefined();
  });

  it('ninguna vía de servicio acepta «llm» ni lo activa de vuelta', async () => {
    const { service, store } = makeService();
    // Por debajo del guarda IPC: un 'llm' directo se ignora, no se guarda.
    await service.setLlmSettings({ provider: 'llm' } as never);
    expect(store.getValue(NEWS_LLM_SETTINGS_KEYS.provider)).not.toBe('llm');
    const settings = await service.getLlmSettings();
    expect(NEWS_PROVIDERS).toContain(settings.provider);
  });
});

// ---------------------------------------------------------------------------
// Borde IPC
// ---------------------------------------------------------------------------

describe('auditoría · la API retirada no tiene canal abierto', () => {
  it('ai:set-llm-settings rechaza «llm» por el handler real y el contrato solo admite suscripcion|local', async () => {
    const ctx = {
      broadcast: () => undefined,
      services: {
        storage: { getDb: () => db },
        settings: sqliteStore(),
        secrets: createSecretsService(db, fakeCrypto),
      },
    } as unknown as ServiceContext;
    registerNewsAi(ctx);

    // Proveedor retirado: rechazado en el borde IPC.
    await expect(invoke(IPC_CHANNELS.ai.setLlmSettings, { provider: 'llm' })).rejects.toThrow();
    // Tampoco de polizón dentro de un patch válido.
    await expect(
      invoke(IPC_CHANNELS.ai.setLlmSettings, { provider: 'llm', enabled: true }),
    ).rejects.toThrow();
    await expect(
      invoke(IPC_CHANNELS.ai.setLlmSettings, {
        provider: 'suscripcion',
        apiKey: 'sk-ant-colada',
      }),
    ).rejects.toThrow();

    // Los elegibles sí pasan y quedan solo entre los dos proveedores.
    for (const provider of NEWS_PROVIDERS) {
      await invoke(IPC_CHANNELS.ai.setLlmSettings, { provider });
    }
    const settings = (await invoke(IPC_CHANNELS.ai.getLlmSettings)) as {
      provider: string;
      hasKey: boolean;
    };
    expect(NEWS_PROVIDERS).toContain(settings.provider);
    expect(settings.hasKey).toBe(false);
  });

  it('isNewsLlmSettingsInput e isNewsProvider no dejan pasar «llm» ni claves sueltas', () => {
    expect(NEWS_PROVIDERS).toEqual(['suscripcion', 'local']);
    expect(isNewsProvider('llm')).toBe(false);
    expect(isNewsProvider('api')).toBe(false);
    for (const input of [
      { provider: 'llm' },
      { provider: 'api' },
      { provider: 'anthropic' },
      { provider: 'suscripcion', apiKey: 'x' },
      { monthlyBudgetEur: 5, provider: 'llm' },
      {},
    ]) {
      expect(isNewsLlmSettingsInput(input), JSON.stringify(input)).toBe(false);
    }
  });

  it('ai:test-llm con el ajuste migrado solo prueba la CLI, nunca una API', async () => {
    for (const [key, value] of [
      [NEWS_LLM_SETTINGS_KEYS.provider, 'llm'],
      [NEWS_LLM_SETTINGS_KEYS.enabled, 'true'],
    ] as const) {
      db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
        key,
        value,
        '2024-01-01T00:00:00.000Z',
      );
    }
    const { service, ping } = makeService({ cliAvailable: true });
    const result = await service.testLlm();
    // Migrado a 'suscripcion': la prueba es el ping de la CLI local.
    expect(result).toMatchObject({ ok: true, error: null });
    expect(ping).toHaveBeenCalledTimes(1);

    // Y en 'local' ni siquiera se consulta la CLI.
    const local = makeService({ cliAvailable: false });
    db.prepare(`UPDATE settings SET value = 'local' WHERE key = ?`).run(
      NEWS_LLM_SETTINGS_KEYS.provider,
    );
    const localResult = await local.service.testLlm();
    expect(localResult).toMatchObject({ ok: true });
    expect(local.ping).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rutas olvidadas en el código
// ---------------------------------------------------------------------------

describe('auditoría · la retirada no deja rutas olvidadas', () => {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

  /** Archivos de producción donde «anthropic» tiene justificación. */
  const ANTHROPIC_ALLOWLIST: Record<string, string> = {
    'src/shared/ai.ts': 'nombre del proveedor retirado, solo para borrar la clave',
    'src/shared/ipc.ts': 'comentario histórico de proveedores de claves',
    'src/main/ai/news/index.ts': 'documenta la migración y el borrado',
    'src/main/ai/news/claudeCli.ts':
      'borrado de ANTHROPIC_* del entorno del hijo y ruta del cli.js de npm en Windows',
    'src/main/ai/news/cliEngines.ts':
      'misma justificación que claudeCli.ts: el motor genérico no reenvía ANTHROPIC_* y conoce la ruta del cli.js de npm en Windows',
    'src/main/ai/news/service.ts': 'borrado de la clave en la migración (hasKey/deleteKey)',
  };

  it('ningún archivo de producción nombra a Anthropic fuera de los lugares justificados', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', 'dist', 'out', '__fixtures__', '__audit__'].includes(entry.name)) {
            continue;
          }
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx|mts|mjs)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
          continue;
        }
        const rel = full.slice(repoRoot.length);
        if (rel in ANTHROPIC_ALLOWLIST) continue;
        const hits = readFileSync(full, 'utf8')
          .split('\n')
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => /anthropic/i.test(line));
        for (const { index } of hits) offenders.push(`${rel}:${index + 1}`);
      }
    };
    walk(join(repoRoot, 'src'));
    expect(offenders, `referencias no justificadas: ${offenders.join(', ')}`).toEqual([]);
  });

  it('nadie vuelve a leer la clave retirada ni a llamar a la API', () => {
    // La clave solo se toca para hasKey/deleteKey en la migración: getKey
    // sobre el proveedor retirado está prohibido en todo el árbol.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', 'dist', 'out'].includes(entry.name)) continue;
          walk(full);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
          continue;
        }
        const rel = full.slice(repoRoot.length);
        const source = readFileSync(full, 'utf8');
        if (/getKey\(\s*NEWS_LLM_SECRET_PROVIDER/.test(source)) offenders.push(`${rel} (getKey)`);
        if (/api\.anthropic\.com|@anthropic-ai\/sdk|Anthropic SDK/.test(source)) {
          offenders.push(rel);
        }
      }
    };
    walk(join(repoRoot, 'src'));
    expect(offenders).toEqual([]);

    // La evaluación de titulares solo acepta los dos proveedores vivos.
    const evalScript = readFileSync(join(repoRoot, 'scripts/eval-news-llm.mjs'), 'utf8');
    expect(evalScript).toContain("const PROVIDERS = ['local', 'suscripcion']");

    // package.json no depende de ningún SDK de Anthropic.
    const pkg = readFileSync(join(repoRoot, 'package.json'), 'utf8');
    expect(pkg).not.toContain('@anthropic-ai');
    expect(pkg).not.toContain('anthropic');
  });
});
