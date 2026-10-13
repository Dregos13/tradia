/**
 * Auditoría adversarial del modo real (fase 7).
 *
 * Los intentos de activación, las declaraciones y los límites entran por
 * los handlers IPC de `registerLive` (lo que haría un renderer
 * comprometido); las órdenes recorren el broker real cableado contra su
 * adaptador falso E2E (`live:use-simulated-broker`). Garantías atacadas:
 *
 * - El modo real no se activa sin la lista completa ni sin la frase
 *   literal de los límites; los requisitos automáticos no se marcan por
 *   IPC ni con evidencia manipulada fuera de E2E.
 * - Los techos fijos (`LIVE_FIXED_CAPS`) no se superan ni al guardar
 *   límites ni al enviar órdenes (por orden, capital, posiciones).
 * - Parada, desconexión, cambio de límites o un requisito vencido
 *   suspenden y ninguna orden nueva llega al broker.
 * - Los ganchos E2E no existen en la app empaquetada.
 *
 * Los hallazgos H1 y H2 de docs/qa/fase-6-7-auditoria.md están cerrados y
 * sus pruebas corren como `it`. Los hallazgos nuevos de la auditoría de
 * cierre (docs/qa/auditoria-continuacion-fase-6-7.md) llevan «HALLAZGO
 * Cn» en el nombre y se declaran como fallo esperado (`fails` de vitest):
 * pasan mientras el bug exista y se ponen en rojo al corregirlo; en ese
 * momento hay que quitarles el `.fails`.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

import { IPC_CHANNELS, IpcValidationError } from '../../../shared/ipc';
import type { JournalRecordInput } from '../../../shared/journal';
import type { RiskDecision } from '../../../shared/risk';
import {
  LIVE_BROKER_SECRET_KEYS,
  LIVE_FIXED_CAPS,
  LIVE_REQUIREMENTS,
  liveConfirmationPhrase,
  type LiveActivateResult,
  type LiveLimits,
} from '../../../shared/live';
import { openDatabase } from '../../db/database';
import { createBrokerRepository } from '../../broker/repository';
import { createMarketRepository } from '../../market/repository';
import { createSignalsRepository, type NewSignal } from '../../signals/repository';
import type { ServiceContext } from '../../services';
import { createSettingsService } from '../../services/settings';
import { registerLive } from '../index';
import { LIVE_EVIDENCE_KEY } from '../service';

const LIVE_KEYS = { apiKeyId: 'AKAUDITKEY01', apiSecret: 'SK-audit-secret' };
const LIVE_LIMITS: LiveLimits = {
  capitalUsd: 200,
  orderUsd: 100,
  dailyLossUsd: 20,
  openPositions: 1,
  shortOrderUsd: 0,
  shortExposureUsd: 0,
  shortPositions: 0,
};
/** Precio al que el servidor falso ejecuta las órdenes de mercado. */
const FAKE_FILL_PRICE = 250;
const NOW = Date.parse('2026-10-09T15:00:00.000Z');

let db: Database.Database;
let handlers: typeof electron.handlers;
let journal: JournalRecordInput[];
let secrets: Map<string, string>;
let registered: ReturnType<typeof registerLive>[];
let signalRepository: ReturnType<typeof createSignalsRepository>;
let settings: ReturnType<typeof createSettingsService>;

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`handler no registrado: ${channel}`);
  return handler({}, ...args);
};

const makeLive = () => {
  const ctx = {
    broadcast: () => undefined,
    services: {
      storage: { getDb: () => db },
      settings,
      secrets: {
        setKey: async (provider: string, value: string) => void secrets.set(provider, value),
        hasKey: async (provider: string) => secrets.has(provider),
        deleteKey: async (provider: string) => void secrets.delete(provider),
        getKey: async (provider: string) => secrets.get(provider) ?? null,
      },
      journal: { record: (entry: JournalRecordInput) => journal.push(entry) },
      signals: { engine: { getSignal: (id: number) => signalRepository.getSignal(id) } },
      connectivity: {
        getState: () => ({
          status: 'online',
          lastCheckedAt: new Date(NOW).toISOString(),
          nextRetryAt: null,
          attempt: 0,
        }),
      },
    },
  } as unknown as ServiceContext;
  const live = registerLive(ctx);
  registered.push(live);
  return { live, ctx };
};

const completeChecklist = async (): Promise<void> => {
  await invoke(IPC_CHANNELS.live.seedProgress, {
    paperMonths: 4,
    paperTrades: 40,
    deviationPct: -12,
    finalTestDone: true,
    killSwitchTested: true,
    alertsTested: true,
    paperShortTrades: 5,
    paperShortWeeks: 5,
  });
  for (const requirement of [
    'claves-sin-retirada',
    'plan-contingencia',
    'revision-legal',
    'revision-legal-corto',
  ]) {
    await invoke(IPC_CHANNELS.live.declare, { requirement, confirmed: true });
  }
};

/** Lista completa, límites confirmados, modo activo y cuenta simulada conectada. */
const activeLiveAccount = async (limits: LiveLimits = LIVE_LIMITS) => {
  const handle = makeLive();
  await completeChecklist();
  await invoke(IPC_CHANNELS.live.setLimits, limits);
  const result = (await invoke(IPC_CHANNELS.live.activate, {
    phrase: liveConfirmationPhrase(limits),
  })) as LiveActivateResult;
  expect(result.activated).toBe(true);
  await invoke(IPC_CHANNELS.live.useSimulatedBroker, { enabled: true });
  await invoke(IPC_CHANNELS.live.connect, LIVE_KEYS);
  expect(handle.live.liveExecutionActive()).toBe(true);
  return handle;
};

const approved = (size: number, notional: number): RiskDecision => ({
  status: 'aprobada',
  size,
  sizeFactor: 1,
  riskAmount: 5,
  notional,
  reasons: [],
  decidedAt: new Date(NOW).toISOString(),
});

type SignalPatch = {
  ticker?: string;
  entry?: number;
  direction?: 'largo' | 'corto';
  stop?: number;
  target?: number;
};

const signalInput = (decision: RiskDecision, patch: SignalPatch = {}): NewSignal => {
  const entry = patch.entry ?? 50;
  const direction = patch.direction ?? 'largo';
  const short = direction === 'corto';
  return {
    ticker: patch.ticker ?? 'AAPL',
    direction,
    entry,
    stop: patch.stop ?? (short ? entry * 1.1 : entry * 0.9),
    target: patch.target ?? (short ? entry * 0.7 : entry * 1.3),
    confidence: 0.8,
    reason: 'orden de auditoría',
    strategies: [
      {
        strategyId: 1,
        name: 'Estrategia auditada',
        version: 1,
        direction,
        confidence: 0.8,
        reason: 'fixture controlada',
      },
    ],
    dataUsed: {
      barDate: '2026-10-09',
      desde: '2026-10-01',
      hasta: '2026-10-09',
      barCount: 7,
      batchId: null,
      batchVersion: null,
      source: 'simulado',
    },
    decision,
    barDate: '2026-10-09',
  };
};

const sendSignal = async (
  live: ReturnType<typeof registerLive>,
  decision: RiskDecision,
  patch: SignalPatch = {},
) => {
  const signal = signalRepository.insertSignal(signalInput(decision, patch)).signal;
  await live.broker.handleSignalEvent({ signal });
  return signal;
};

const liveOrders = () =>
  createBrokerRepository(db, { ordersTable: 'broker_orders_live' }).listOrders();
const liveEntries = () => liveOrders().filter((order) => order.leg === 'entrada');
const executedEntries = () => liveEntries().filter((order) => order.status === 'ejecutada');
const modeOf = async () => ((await invoke(IPC_CHANNELS.live.state)) as { mode: string }).mode;

beforeEach(() => {
  db = openDatabase(':memory:');
  electron.isPackaged = false;
  electron.handlers.clear();
  handlers = electron.handlers;
  journal = [];
  secrets = new Map();
  registered = [];
  signalRepository = createSignalsRepository(db);
  settings = createSettingsService(db);
  vi.stubEnv('TRADIA_E2E', '1');
});

afterEach(() => {
  for (const live of registered) live.broker.stop();
  vi.unstubAllEnvs();
  db.close();
});

// ---------------------------------------------------------------------------
// Activación: lista, declaraciones, frase
// ---------------------------------------------------------------------------

describe('auditoría · activación y límites vía IPC', () => {
  it('rechaza requisitos automáticos falsificados, límites fuera de techo y activación incompleta', async () => {
    makeLive();

    const initial = (await invoke(IPC_CHANNELS.live.activate, {
      phrase: 'ACTIVAR',
    })) as LiveActivateResult;
    expect(initial.activated).toBe(false);
    expect(initial.state.mode).toBe('bloqueado');
    // Cada requisito pendiente aparece, con al menos un motivo legible.
    expect(initial.pendingRequirements).toEqual([...LIVE_REQUIREMENTS]);
    expect(initial.reasons.length).toBeGreaterThanOrEqual(LIVE_REQUIREMENTS.length);
    expect(
      journal.some((entry) => entry.type === 'limite' && /rechazada/.test(String(entry.reason))),
    ).toBe(true);

    for (const forged of [
      { requirement: 'paper-continuo', confirmed: true },
      { requirement: 'parada-probada', confirmed: true },
      { requirement: 'validacion-fuera-muestra', confirmed: true },
      { requirement: 'alertas-activas', confirmed: true },
      { requirement: 'revision-legal', confirmed: true, state: 'cumplido' },
      { requirement: 'revision-legal', confirmed: 'yes' },
      { requirement: 'revision-legal', confirmed: true, detail: 'x'.repeat(1_001) },
      { requirement: 'inventado', confirmed: true },
    ]) {
      await expect(invoke(IPC_CHANNELS.live.declare, forged)).rejects.toBeInstanceOf(
        IpcValidationError,
      );
    }

    const overCaps = [
      { ...LIVE_LIMITS, capitalUsd: LIVE_FIXED_CAPS.capitalUsd + 1 },
      { ...LIVE_LIMITS, orderUsd: LIVE_FIXED_CAPS.orderUsd + 0.01 },
      { ...LIVE_LIMITS, dailyLossUsd: LIVE_FIXED_CAPS.dailyLossUsd + 1 },
      { ...LIVE_LIMITS, openPositions: LIVE_FIXED_CAPS.openPositions + 1 },
    ];
    for (const limits of overCaps) {
      await expect(invoke(IPC_CHANNELS.live.setLimits, limits)).rejects.toBeInstanceOf(
        IpcValidationError,
      );
    }
    const state = (await invoke(IPC_CHANNELS.live.state)) as { limits: unknown; mode: string };
    expect(state.limits).toBeNull();
    expect(state.mode).toBe('bloqueado');
  });

  it('cargas útiles manipuladas en set-limits y activate se rechazan en el borde', async () => {
    makeLive();
    const malformedLimits: unknown[] = [
      null,
      [],
      { ...LIVE_LIMITS, capitalUsd: '200' },
      { ...LIVE_LIMITS, orderUsd: Number.NaN },
      { ...LIVE_LIMITS, orderUsd: Number.POSITIVE_INFINITY },
      { ...LIVE_LIMITS, dailyLossUsd: -5 },
      { ...LIVE_LIMITS, capitalUsd: 0 },
      { ...LIVE_LIMITS, openPositions: 1.5 },
      { ...LIVE_LIMITS, openPositions: 0 },
      { ...LIVE_LIMITS, confirmed: true },
      { capitalUsd: 200, orderUsd: 100, dailyLossUsd: 20 },
    ];
    for (const payload of malformedLimits) {
      await expect(invoke(IPC_CHANNELS.live.setLimits, payload)).rejects.toBeInstanceOf(
        IpcValidationError,
      );
    }
    for (const payload of [
      null,
      { phrase: 42 },
      { phrase: '   ' },
      { phrase: 'x'.repeat(501) },
      { phrase: 'ACTIVO', force: true },
    ]) {
      await expect(invoke(IPC_CHANNELS.live.activate, payload)).rejects.toBeInstanceOf(
        IpcValidationError,
      );
    }
  });

  it('exige checklist completa y frase literal de límites antes de activar', async () => {
    makeLive();
    await completeChecklist();

    // Lista completa pero sin límites guardados: no activa.
    const noLimits = (await invoke(IPC_CHANNELS.live.activate, {
      phrase: liveConfirmationPhrase(LIVE_LIMITS),
    })) as LiveActivateResult;
    expect(noLimits.activated).toBe(false);

    const saved = (await invoke(IPC_CHANNELS.live.setLimits, LIVE_LIMITS)) as {
      confirmationPhrase: string;
      confirmed: boolean;
    };
    expect(saved.confirmed).toBe(false);

    const otherLimits = { ...LIVE_LIMITS, capitalUsd: LIVE_FIXED_CAPS.capitalUsd };
    for (const phrase of [
      saved.confirmationPhrase + ' (aprobado)',
      saved.confirmationPhrase.toLowerCase(),
      saved.confirmationPhrase.replace(' ', '​ '),
      liveConfirmationPhrase(otherLimits),
      'ACTIVO DINERO REAL',
    ]) {
      const attempt = (await invoke(IPC_CHANNELS.live.activate, { phrase })) as LiveActivateResult;
      expect(attempt.activated).toBe(false);
      expect(attempt.state.mode).toBe('listo');
      expect(attempt.reasons.join(' ')).toContain('frase de confirmación');
    }

    const accepted = (await invoke(IPC_CHANNELS.live.activate, {
      phrase: `  ${liveConfirmationPhrase(LIVE_LIMITS)}  `,
    })) as LiveActivateResult;
    expect(accepted.activated).toBe(true);
    expect(accepted.state.mode).toBe('activo');
    expect(accepted.state.limits).toEqual(LIVE_LIMITS);
  });

  it('retirar una declaración tras activar suspende y no se reactiva solo', async () => {
    makeLive();
    await completeChecklist();
    await invoke(IPC_CHANNELS.live.setLimits, LIVE_LIMITS);
    await invoke(IPC_CHANNELS.live.activate, { phrase: liveConfirmationPhrase(LIVE_LIMITS) });

    await invoke(IPC_CHANNELS.live.declare, { requirement: 'revision-legal', confirmed: false });
    expect(await modeOf()).toBe('suspendido');

    await invoke(IPC_CHANNELS.live.declare, { requirement: 'revision-legal', confirmed: true });
    expect(await modeOf()).toBe('suspendido');
  });

  it('HALLAZGO H1 · fuera de E2E, una evidencia «live.evidence» manipulada en la base no cumple los requisitos automáticos', async () => {
    // App empaquetada: el gancho live:seed-progress no existe…
    electron.isPackaged = true;
    vi.stubEnv('TRADIA_E2E', '');
    // …pero la evidencia vive en settings: una base restaurada de una
    // copia de seguridad o editada a mano puede traerla escrita.
    const at = new Date().toISOString();
    settings.setValue(
      LIVE_EVIDENCE_KEY,
      JSON.stringify({
        paperDays: 400,
        paperTrades: 500,
        deviationPct: 0,
        finalTestDoneAt: at,
        killSwitchTestedAt: at,
        alertTestedAt: at,
        alertChannel: 'simulado',
      }),
    );
    makeLive();
    expect(handlers.has(IPC_CHANNELS.live.seedProgress)).toBe(false);

    for (const requirement of ['claves-sin-retirada', 'plan-contingencia', 'revision-legal']) {
      await invoke(IPC_CHANNELS.live.declare, { requirement, confirmed: true });
    }
    await invoke(IPC_CHANNELS.live.setLimits, LIVE_LIMITS);
    const result = (await invoke(IPC_CHANNELS.live.activate, {
      phrase: liveConfirmationPhrase(LIVE_LIMITS),
    })) as LiveActivateResult;

    // Sin una sola orden paper, ni estrategia candidata, ni prueba de
    // parada, ni canal de alertas configurado, la activación debe fallar.
    expect(result.activated).toBe(false);
    expect(result.pendingRequirements).toEqual(
      expect.arrayContaining([
        'validacion-fuera-muestra',
        'paper-continuo',
        'parada-probada',
        'alertas-activas',
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// Conexión de la cuenta real
// ---------------------------------------------------------------------------

describe('auditoría · conexión de la cuenta real', () => {
  it('sin la lista no se conecta ni se guardan claves; las claves paper se rechazan', async () => {
    makeLive();
    await invoke(IPC_CHANNELS.live.useSimulatedBroker, { enabled: true });
    await expect(invoke(IPC_CHANNELS.live.connect, LIVE_KEYS)).rejects.toThrow(
      /lista de comprobación/,
    );
    expect(secrets.has(LIVE_BROKER_SECRET_KEYS.apiKeyId)).toBe(false);

    await completeChecklist();
    await expect(
      invoke(IPC_CHANNELS.live.connect, { apiKeyId: 'PKPAPERKEY01', apiSecret: 'paper-secret' }),
    ).rejects.toThrow(/AK/);
    expect(secrets.has(LIVE_BROKER_SECRET_KEYS.apiKeyId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Guarda de órdenes reales: techos, suspensiones, requisitos vencidos
// ---------------------------------------------------------------------------

describe('auditoría · guarda de órdenes reales', () => {
  it('una señal por encima del techo por orden no llega al broker simulado', async () => {
    const { live } = await activeLiveAccount();
    await sendSignal(live, approved(3, 150)); // 3 × 50 = 150 USD > 100 USD por orden

    expect(liveOrders()).toHaveLength(0);
    expect(
      journal.some(
        (entry) => entry.type === 'error' && String(entry.reason).includes('límite por orden'),
      ),
    ).toBe(true);
  });

  it('una segunda posición que excede el capital escrito se bloquea antes del broker', async () => {
    const limits: LiveLimits = {
      capitalUsd: 250,
      orderUsd: 200,
      dailyLossUsd: 20,
      openPositions: 2,
      shortOrderUsd: 0,
      shortExposureUsd: 0,
      shortPositions: 0,
    };
    const { live } = await activeLiveAccount(limits);

    await sendSignal(live, approved(0.6, 150), { ticker: 'AAPL', entry: FAKE_FILL_PRICE });
    expect(executedEntries()).toHaveLength(1);

    await sendSignal(live, approved(0.6, 150), { ticker: 'MSFT', entry: FAKE_FILL_PRICE });
    expect(liveEntries().filter((order) => order.ticker === 'MSFT')).toHaveLength(0);
    expect(
      journal.some(
        (entry) =>
          entry.type === 'error' && String(entry.reason).includes('límite de capital real'),
      ),
    ).toBe(true);
  });

  it('con el máximo de posiciones abiertas no se abre otra', async () => {
    const limits: LiveLimits = {
      capitalUsd: 1_000,
      orderUsd: 200,
      dailyLossUsd: 20,
      openPositions: 1,
      shortOrderUsd: 0,
      shortExposureUsd: 0,
      shortPositions: 0,
    };
    const { live } = await activeLiveAccount(limits);
    await sendSignal(live, approved(0.4, 100), { ticker: 'AAPL', entry: FAKE_FILL_PRICE });
    await sendSignal(live, approved(0.4, 100), { ticker: 'MSFT', entry: FAKE_FILL_PRICE });
    expect(liveEntries().map((order) => order.ticker)).toEqual(['AAPL']);
  });

  it('una señal vetada por el riesgo nunca se envía aunque el modo real esté activo', async () => {
    const { live } = await activeLiveAccount();
    await sendSignal(live, { ...approved(1, 50), status: 'vetada' });
    await sendSignal(live, approved(0, 0), { ticker: 'MSFT' });
    expect(liveOrders()).toHaveLength(0);
  });

  it.each([
    {
      label: 'la parada de emergencia',
      trigger: (ctx: ServiceContext) =>
        ctx.broadcast(IPC_CHANNELS.risk.changed, {
          killSwitch: { active: true, cause: 'manual' },
        }),
    },
    {
      label: 'la pérdida de conexión',
      trigger: (ctx: ServiceContext) =>
        ctx.broadcast(IPC_CHANNELS.connectivity.changed, { status: 'offline' }),
    },
    {
      label: 'un cambio de límites con el modo activo',
      trigger: () => void invoke(IPC_CHANNELS.live.setLimits, { ...LIVE_LIMITS, orderUsd: 90 }),
    },
  ])('$label suspende y bloquea las órdenes nuevas', async ({ trigger }) => {
    const { live, ctx } = await activeLiveAccount();
    trigger(ctx);
    await Promise.resolve();
    expect(await modeOf()).toBe('suspendido');
    expect(live.liveExecutionActive()).toBe(false);

    await sendSignal(live, approved(1, 50));
    expect(liveOrders()).toHaveLength(0);
  });

  it('un requisito que vence sin reevaluación previa no deja pasar una orden real', async () => {
    const { live } = await activeLiveAccount();
    // El canal de alertas deja de valer sin que nadie haya llamado aún a
    // live:checklist/live:state (escritura directa, sin evaluate()).
    const evidence = JSON.parse(settings.getValue(LIVE_EVIDENCE_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    delete evidence.alertTestedAt;
    delete evidence.alertChannel;
    settings.setValue(LIVE_EVIDENCE_KEY, JSON.stringify(evidence));

    await sendSignal(live, approved(1, 50));
    expect(executedEntries()).toHaveLength(0);
    expect(await modeOf()).toBe('suspendido');
  });

  it('HALLAZGO H2 · una orden de mercado no puede ejecutarse por encima del techo por orden', async () => {
    const limits: LiveLimits = {
      capitalUsd: 1_000,
      orderUsd: 200,
      dailyLossUsd: 20,
      openPositions: 2,
      shortOrderUsd: 0,
      shortExposureUsd: 0,
      shortPositions: 0,
    };
    const { live } = await activeLiveAccount(limits);
    // La señal se calculó con el cierre de ayer (199 USD); el mercado
    // abre con hueco al alza y el servidor ejecuta a 250 USD.
    await sendSignal(live, approved(1, 199), { entry: 199 });

    // La orden no sale de mercado a ciegas: sale limitada con un tope
    // que impide ejecutar por encima del límite por orden escrito.
    for (const order of liveEntries()) {
      if (order.type === 'limit' && order.limitPrice !== null) {
        expect(order.limitPrice * order.quantity).toBeLessThanOrEqual(limits.orderUsd);
      }
    }
    const executedNotional = executedEntries().map(
      (order) => order.filledQuantity * (order.execution.executedPrice ?? 0),
    );
    for (const notional of executedNotional) {
      expect(notional).toBeLessThanOrEqual(limits.orderUsd);
    }
  });
});

describe('auditoría · prueba de humo', () => {
  it('sin confirmación explícita o sin modo activo no se lanza', async () => {
    makeLive();
    for (const payload of [undefined, {}, { confirm: false }, { confirm: 'true' }]) {
      await expect(invoke(IPC_CHANNELS.live.smokeTest, payload)).rejects.toBeInstanceOf(
        IpcValidationError,
      );
    }
    await expect(invoke(IPC_CHANNELS.live.smokeTest, { confirm: true })).rejects.toThrow();
    expect(liveOrders()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Ganchos E2E fuera de la app empaquetada
// ---------------------------------------------------------------------------

describe('auditoría · ganchos E2E del dinero real no registrados en producción', () => {
  it.each([
    { label: 'app empaquetada con TRADIA_E2E=1', packaged: true, env: '1' },
    { label: 'sin empaquetar y sin TRADIA_E2E', packaged: false, env: '' },
  ])('$label: live:seed-progress y live:use-simulated-broker no existen', ({ packaged, env }) => {
    electron.isPackaged = packaged;
    vi.stubEnv('TRADIA_E2E', env);
    const { live } = makeLive();
    expect(handlers.has(IPC_CHANNELS.live.activate)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.live.seedProgress)).toBe(false);
    expect(handlers.has(IPC_CHANNELS.live.useSimulatedBroker)).toBe(false);
    return expect(live.broker.useSimulatedBroker(true)).rejects.toThrow(/E2E/);
  });
});

// ---------------------------------------------------------------------------
// Auditoría de cierre (continuación de la fase 6-7)
// ---------------------------------------------------------------------------

describe('auditoría de cierre · copia restaurada con dinero real activo', () => {
  let dir: string | null = null;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (dir !== null) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('una copia con live.evidence, la lista cumplida y el modo «activo», restaurada en la app empaquetada, no deja el dinero real activo', async () => {
    // 1. Perfil de desarrollo (E2E): lista sembrada, límites confirmados,
    //    modo activo y claves live guardadas. Es el estado que acabaría en
    //    una copia de seguridad hecha con TRADIA_E2E o editada a mano.
    await activeLiveAccount();
    expect(await modeOf()).toBe('activo');
    expect(settings.getValue(LIVE_EVIDENCE_KEY)).not.toBeNull();
    for (const live of registered) live.broker.stop();
    registered = [];

    // 2. Copia con la API online de better-sqlite3 (la misma que usa
    //    backup:create) y restauración: la app arranca sobre ese archivo.
    dir = mkdtempSync(join(tmpdir(), 'tradia-audit-restore-'));
    const file = join(dir, 'tradia-restaurada.db');
    await db.backup(file);
    db.close();
    db = openDatabase(file);
    signalRepository = createSignalsRepository(db);
    settings = createSettingsService(db);

    // 3. App empaquetada, sin ganchos E2E. Si algo intentara reconectar la
    //    cuenta real con las claves restauradas, iría a la red: se vigila.
    electron.isPackaged = true;
    vi.stubEnv('TRADIA_E2E', '');
    const network = vi.fn(async () => {
      throw new Error('red no permitida en la auditoría');
    });
    vi.stubGlobal('fetch', network);
    electron.handlers.clear();
    const { live } = makeLive();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // La evidencia restaurada no cumple nada y el modo deja de estar activo.
    const state = (await invoke(IPC_CHANNELS.live.state)) as { mode: string };
    expect(state.mode).not.toBe('activo');
    expect(live.liveExecutionActive()).toBe(false);
    const checklist = (await invoke(IPC_CHANNELS.live.checklist)) as {
      allComplete: boolean;
      items: { requirement: string; state: string }[];
    };
    expect(checklist.allComplete).toBe(false);
    for (const requirement of [
      'validacion-fuera-muestra',
      'paper-continuo',
      'parada-probada',
      'alertas-activas',
    ]) {
      expect(checklist.items.find((item) => item.requirement === requirement)?.state).not.toBe(
        'cumplido',
      );
    }
    // Reactivar con la misma frase tampoco funciona.
    const retry = (await invoke(IPC_CHANNELS.live.activate, {
      phrase: liveConfirmationPhrase(LIVE_LIMITS),
    })) as LiveActivateResult;
    expect(retry.activated).toBe(false);
    // Ninguna orden llega a la red con las claves restauradas.
    await sendSignal(live, approved(1, 50));
    expect(liveOrders()).toHaveLength(0);
    expect(network).not.toHaveBeenCalled();
  });
});

describe('auditoría de cierre · techo por orden con hueco de apertura', () => {
  const limits: LiveLimits = {
    capitalUsd: 1_000,
    orderUsd: 200,
    dailyLossUsd: 20,
    openPositions: 2,
    shortOrderUsd: 0,
    shortExposureUsd: 0,
    shortPositions: 0,
  };

  it('con una referencia muy desfasada a la baja, la compra sale limitada y no ejecuta por encima del techo', async () => {
    const { live } = await activeLiveAccount(limits);
    // Señal calculada con un cierre de 60 USD (3 × 60 = 180 USD, dentro
    // del techo); el servidor cotiza a 250 USD (hueco de +317 %).
    await sendSignal(live, approved(3, 180), { entry: 60 });

    const entries = liveEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe('limit');
    expect(entries[0]!.limitPrice! * entries[0]!.quantity).toBeLessThanOrEqual(limits.orderUsd);
    for (const order of executedEntries()) {
      expect(order.filledQuantity * (order.execution.executedPrice ?? 0)).toBeLessThanOrEqual(
        limits.orderUsd,
      );
    }
  });

  it('HALLAZGO C4 · con el corto habilitado la entrada en corto sale como stop a la referencia y un hueco al alza no la ejecuta', async () => {
    const limitsConCorto: LiveLimits = {
      ...limits,
      shortOrderUsd: 100,
      shortExposureUsd: 200,
      shortPositions: 1,
    };
    const { live } = await activeLiveAccount(limitsConCorto);
    // Señal corta calculada con el cierre de ayer (180 USD, stop al 5 %):
    // el mercado abre con hueco al alza y el servidor cotiza a 250 USD.
    // La entrada sale como venta STOP con activación en 180 —una venta
    // limitada ejecutaría a 250 y no puede acotar el nocional por arriba—
    // así que con el mercado por encima no se dispara jamás: el corto no
    // ejecuta por encima de su referencia y el nominal real nunca supera
    // el estimado (0,5 × 180 = 90 USD, dentro del techo del corto).
    await sendSignal(live, approved(0.5, 90), {
      entry: 180,
      direction: 'corto',
      stop: 189,
      target: 150,
    });

    const entries = liveEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.type).toBe('stop');
    expect(entries[0]!.stopPrice).toBe(180);
    // El mercado del falso cotiza por encima de la activación (250 > 180):
    // la entrada nunca ejecuta —queda enviada, no ejecutada— y ningún
    // corto abre por encima de la referencia ni del techo por orden.
    expect(entries[0]!.status).toBe('enviada');
    expect(executedEntries()).toHaveLength(0);
  });
});

describe('auditoría de cierre · prueba de humo con referencia desfasada (P7)', () => {
  it('con el último cierre de SPY de hace semanas no envía ninguna orden real', async () => {
    await activeLiveAccount();
    const market = createMarketRepository(db);
    const batch = market.createBatch({
      version: 1,
      hash: 'audit-spy-viejo',
      provider: 'audit',
      scope: 'bars',
      ticker: 'SPY',
      rangeStart: '2026-09-18',
      rangeEnd: '2026-09-18',
    });
    // Referencia del QA de la fase (1.451,93 USD) y de hace semanas.
    market.upsertBars('SPY', 'audit', batch.id, [
      { date: '2026-09-18', open: 1450, high: 1455, low: 1448, close: 1451.93, volume: 1_000 },
    ]);

    const outcome = await Promise.resolve(
      invoke(IPC_CHANNELS.live.smokeTest, { confirm: true }),
    ).then(
      (result) => ({ result: result as { state: string; errorCode?: string | null } }),
      (error: unknown) => ({ error }),
    );

    // Falla antes de la red: ni compra ni cierre en broker_orders_live.
    expect(liveOrders()).toHaveLength(0);
    if ('result' in outcome) expect(outcome.result.state).not.toBe('cerrada-conciliada');
  });
});
