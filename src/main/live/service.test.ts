import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IPC_CHANNELS,
  IpcValidationError,
  type ConnectivityState,
  type JournalRecordInput,
  type NotificationPayload,
  type RiskOverview,
} from '../../shared/ipc';
import {
  LIVE_DECLARATION_TEXTS,
  LIVE_FIXED_CAPS,
  liveConfirmationPhrase,
  type LiveActivateResult,
  type LiveChecklist,
  type LiveLimitsInput,
  type LiveState,
} from '../../shared/live';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import { createSettingsService } from '../services/settings';
import { createKillSwitchService, createKillSwitchStore } from '../risk/killSwitch';
import { DELIVERY_CONFIG_KEY } from '../delivery';
import { DELIVERY_TEST_EVIDENCE_KEY, formatLiveDate, type ShortAccountReading } from './checklist';
import { registerLive, type LiveService } from './index';
import {
  LiveServiceError,
  createLiveEvidenceStore,
  createLiveService,
  createLiveStore,
  type LiveServiceDeps,
} from './service';

// electron solo aporta app/ipcMain a registerLive; se captura el mapa de
// handlers como en las demás pruebas de servicios del proceso principal.
const electron = vi.hoisted(() => ({
  isPackaged: true,
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

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-10-09T15:00:00.000Z');

let db: Database.Database;
let nowMs: number;
let sent: { channel: string; payload: unknown }[];
let journal: JournalRecordInput[];
let notifications: NotificationPayload[];
let secretKeys: Map<string, string>;

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`handler no registrado: ${channel}`);
  return handler({}, ...args);
};

// ---------------------------------------------------------------------------
// Montaje
// ---------------------------------------------------------------------------

interface Harness {
  service: LiveService;
  ctx: ServiceContext;
  handlers: Map<string, (...args: unknown[]) => unknown>;
}

/** Servicio montado sobre la base real con todas las fuentes inyectadas. */
const makeService = (extra: Partial<LiveServiceDeps> = {}): LiveService => {
  const killSwitch = createKillSwitchService({
    store: createKillSwitchStore(db),
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    pauseAgents: () => undefined,
    resumeAgents: () => undefined,
    now: () => nowMs,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  return createLiveService({
    store: createLiveStore(db),
    evidence: createLiveEvidenceStore(undefined, undefined),
    // El arnés opta por el contexto E2E: la semilla de seedProgress cuenta
    // aquí igual que con TRADIA_E2E y la app sin empaquetar.
    allowSeededEvidence: () => true,
    killSwitch,
    recordJournal: (input) => journal.push(input),
    notify: (payload) => notifications.push(payload),
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    now: () => nowMs,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    ...extra,
  });
};

/** registerLive sobre ctx real con los servicios mínimos cableados. */
const makeCtx = (extra: Partial<ServiceContext['services']> = {}): Harness => {
  const settings = createSettingsService(db);
  const ctx: ServiceContext = {
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    services: {
      // La misma base que el resto de servicios: sin ella registerLive
      // monta el almacén en memoria y no ve kill_switch_events.
      storage: { getDb: () => db } as never,
      settings,
      killSwitch: createKillSwitchService({
        store: createKillSwitchStore(db),
        broadcast: (channel, payload) => ctx.broadcast(channel, payload),
        pauseAgents: () => undefined,
        resumeAgents: () => undefined,
        now: () => nowMs,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
      journal: { record: (input: JournalRecordInput) => journal.push(input) } as never,
      notifications: { notify: (p: NotificationPayload) => notifications.push(p) } as never,
      // Ranura de claves en memoria: permite conectar la cuenta live
      // simulada en las pruebas IPC (la real cifra en el llavero del SO).
      secrets: {
        hasKey: async (provider: string) => secretKeys.has(provider),
        getKey: async (provider: string) => secretKeys.get(provider) ?? null,
        setKey: async (provider: string, apiKey: string) => {
          secretKeys.set(provider, apiKey);
        },
        deleteKey: async (provider: string) => {
          secretKeys.delete(provider);
        },
      } as never,
      ...extra,
    },
  };
  const service = registerLive(ctx);
  return { service, ctx, handlers: electron.handlers };
};

// ---------------------------------------------------------------------------
// Fixtures de dominio
// ---------------------------------------------------------------------------

const seedStrategyWithFinalTest = (estado = 'paper'): void => {
  db.prepare('INSERT INTO strategies (estado) VALUES (?)').run(estado);
  const id = (db.prepare('SELECT MAX(id) AS id FROM strategies').get() as { id: number }).id;
  db.prepare(
    `INSERT INTO strategy_versions (strategy_id, version, nombre, hipotesis,
       regla_entrada, regla_salida, regla_stop, regla_objetivo, regimen, costes, nota)
     VALUES (?, 1, 'Estrategia T', 'h', 'e', 's', 'st', 'o', 'x', '{}', 'n')`,
  ).run(id);
  db.prepare(
    `INSERT INTO backtest_runs (strategy_id, version, kind, config, costes,
       metricas, fuente, proveedor)
     VALUES (?, 1, 'prueba-final', '{}', '{}', '{}', 'simulated', 'sim')`,
  ).run(id);
};

const seedDeliveryTest = (channel = 'telegram'): void => {
  const settings = createSettingsService(db);
  settings.setValue(
    DELIVERY_CONFIG_KEY,
    JSON.stringify({
      telegram: { enabled: true, chatId: '1234', events: ['senal-aprobada'] },
      email: {
        enabled: false,
        host: '',
        port: 587,
        security: 'starttls',
        user: '',
        to: '',
        events: [],
      },
    }),
  );
  settings.setValue(
    DELIVERY_TEST_EVIDENCE_KEY,
    JSON.stringify({ channel, at: new Date(nowMs).toISOString() }),
  );
};

/** Deja los siete requisitos cumplidos con evidencia sembrada + declaraciones. */
const completeChecklist = async (service: LiveService): Promise<void> => {
  service.seedProgress({
    paperMonths: 4,
    paperTrades: 40,
    deviationPct: -12,
    finalTestDone: true,
    killSwitchTested: true,
    alertsTested: true,
  });
  for (const requirement of [
    'claves-sin-retirada',
    'plan-contingencia',
    'revision-legal',
  ] as const) {
    service.declare({ requirement, confirmed: true, detail: 'ok' });
  }
};

/**
 * Deja la cuenta live conectada contra el broker falso E2E (exige la
 * lista del largo completa): la checklist ve entonces
 * `short.account.state === 'cumplido'`. Solo con TRADIA_E2E activo.
 */
const connectSimulatedLiveAccount = async (service: LiveService): Promise<void> => {
  await invoke(IPC_CHANNELS.live.useSimulatedBroker, { enabled: true });
  await completeChecklist(service);
  await invoke(IPC_CHANNELS.live.connect, {
    apiKeyId: 'AKTESTKEY01',
    apiSecret: 'SK-test-secret',
  });
};

const VALID_LIMITS: LiveLimitsInput = {
  capitalUsd: 500,
  orderUsd: 100,
  dailyLossUsd: 10,
  openPositions: 1,
  shortOrderUsd: 0,
  shortExposureUsd: 0,
  shortPositions: 0,
};

beforeEach(() => {
  db = openDatabase(':memory:');
  nowMs = NOW;
  sent = [];
  journal = [];
  notifications = [];
  secretKeys = new Map();
  electron.handlers.clear();
  electron.isPackaged = true;
  delete process.env.TRADIA_E2E;
});

afterEach(() => {
  db.close();
});

// ---------------------------------------------------------------------------
// Lista de comprobación
// ---------------------------------------------------------------------------

describe('live:checklist', () => {
  it('arranca con los siete requisitos pendientes y modo bloqueado', async () => {
    makeCtx();
    const checklist = (await invoke(IPC_CHANNELS.live.checklist)) as LiveChecklist;
    expect(checklist.total).toBe(7);
    expect(checklist.completedCount).toBe(0);
    expect(checklist.allComplete).toBe(false);
    expect(checklist.items.map((i) => i.state)).toEqual(Array(7).fill('pendiente'));

    const state = (await invoke(IPC_CHANNELS.live.state)) as LiveState;
    expect(state.mode).toBe('bloqueado');
    expect(state.caps).toEqual(LIVE_FIXED_CAPS);
  });

  it('evalúa la validación fuera de muestra desde backtest_runs', async () => {
    seedStrategyWithFinalTest('paper');
    db.prepare(`INSERT INTO strategies (estado) VALUES ('paper')`).run();
    const id = (db.prepare('SELECT MAX(id) AS id FROM strategies').get() as { id: number }).id;
    db.prepare(
      `INSERT INTO strategy_versions (strategy_id, version, nombre, hipotesis,
         regla_entrada, regla_salida, regla_stop, regla_objetivo, regimen, costes, nota)
       VALUES (?, 1, 'Sin probar', 'h', 'e', 's', 'st', 'o', 'x', '{}', 'n')`,
    ).run(id);

    const service = makeService();
    const checklist = service.getChecklist();
    const item = checklist.items.find((i) => i.requirement === 'validacion-fuera-muestra')!;
    expect(item.state).toBe('pendiente');
    expect(item.evidence).toContain('1 de 2');
  });

  it('marca cumplida la validación cuando toda candidata tiene prueba final', () => {
    seedStrategyWithFinalTest('activa');
    const service = makeService();
    const item = service
      .getChecklist()
      .items.find((i) => i.requirement === 'validacion-fuera-muestra')!;
    expect(item.state).toBe('cumplido');
    expect(item.evidence).toContain('1 de 1');
  });

  it('recupera los límites guardados sin confirmar y la evidencia de cada declaración', async () => {
    makeCtx();
    // Los límites guardados sin confirmar viajan con la lista: la
    // pantalla recupera el borrador al volver a «Dinero real».
    await invoke(IPC_CHANNELS.live.setLimits, VALID_LIMITS);
    const checklist = (await invoke(IPC_CHANNELS.live.checklist)) as LiveChecklist;
    expect(checklist.limits.limits).toEqual(VALID_LIMITS);
    expect(checklist.limits.confirmed).toBe(false);
    expect(checklist.limits.confirmationPhrase).toBe(liveConfirmationPhrase(VALID_LIMITS));
    expect(checklist.limits.savedAt).not.toBeNull();

    // Cada declaración cumplida trae su evidencia: el texto suscrito y
    // la fecha local de la firma (nunca «Sin evidencia guardada.»).
    await invoke(IPC_CHANNELS.live.declare, {
      requirement: 'plan-contingencia',
      confirmed: true,
      detail: '/ruta/plan.md',
    });
    const declared = (await invoke(IPC_CHANNELS.live.checklist)) as LiveChecklist;
    const item = declared.items.find((i) => i.requirement === 'plan-contingencia')!;
    expect(item.state).toBe('cumplido');
    expect(item.evidence).toContain(LIVE_DECLARATION_TEXTS['plan-contingencia']);
    expect(item.evidence).toContain(`suscrita el ${formatLiveDate(item.markedAt!)}`);
  });
});

// ---------------------------------------------------------------------------
// Declaraciones
// ---------------------------------------------------------------------------

describe('live:declare', () => {
  it('suscribe una declaración con texto fijo, detalle y fecha', async () => {
    makeCtx();
    const checklist = (await invoke(IPC_CHANNELS.live.declare, {
      requirement: 'claves-sin-retirada',
      confirmed: true,
      detail: 'Cuenta Alpaca solo-trading',
    })) as LiveChecklist;
    const item = checklist.items.find((i) => i.requirement === 'claves-sin-retirada')!;
    expect(item.state).toBe('cumplido');
    expect(item.declaration).toBe(LIVE_DECLARATION_TEXTS['claves-sin-retirada']);
    expect(item.declarationDetail).toBe('Cuenta Alpaca solo-trading');
    expect(item.markedAt).not.toBeNull();
  });

  it('rechaza por IPC marcar un requisito automático', async () => {
    makeCtx();
    await expect(
      invoke(IPC_CHANNELS.live.declare, {
        requirement: 'paper-continuo',
        confirmed: true,
      }),
    ).rejects.toBeInstanceOf(IpcValidationError);
    // El estado no cambió: sigue pendiente.
    const checklist = (await invoke(IPC_CHANNELS.live.checklist)) as LiveChecklist;
    expect(checklist.items.find((i) => i.requirement === 'paper-continuo')!.state).toBe(
      'pendiente',
    );
  });

  it('el servicio también rechaza una declaración sobre un automático', () => {
    const service = makeService();
    expect(() =>
      service.declare({ requirement: 'parada-probada' as never, confirmed: true }),
    ).toThrow(LiveServiceError);
  });

  it('retirar una declaración la devuelve a pendiente', async () => {
    makeCtx();
    await invoke(IPC_CHANNELS.live.declare, {
      requirement: 'plan-contingencia',
      confirmed: true,
    });
    const checklist = (await invoke(IPC_CHANNELS.live.declare, {
      requirement: 'plan-contingencia',
      confirmed: false,
    })) as LiveChecklist;
    const item = checklist.items.find((i) => i.requirement === 'plan-contingencia')!;
    expect(item.state).toBe('pendiente');
    expect(item.declaration).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Límites escritos
// ---------------------------------------------------------------------------

describe('live:set-limits', () => {
  it('guarda límites válidos y devuelve la frase generada', async () => {
    makeCtx();
    const result = (await invoke(IPC_CHANNELS.live.setLimits, VALID_LIMITS)) as {
      limits: LiveLimitsInput;
      confirmationPhrase: string;
      confirmed: boolean;
    };
    expect(result.confirmed).toBe(false);
    expect(result.confirmationPhrase).toBe(liveConfirmationPhrase(VALID_LIMITS));
    expect(result.confirmationPhrase).toBe(
      'ACTIVO DINERO REAL CON 500 USD, 100 USD POR ORDEN, 10 USD DE PÉRDIDA DIARIA Y 1 POSICIÓN; CORTO 0 USD POR ORDEN, 0 USD DE EXPOSICIÓN Y 0 POSICIONES EN CORTO',
    );
  });

  it.each([
    { ...VALID_LIMITS, capitalUsd: 1_001 },
    { ...VALID_LIMITS, orderUsd: 201 },
    { ...VALID_LIMITS, dailyLossUsd: 21 },
    { ...VALID_LIMITS, openPositions: 3 },
    { ...VALID_LIMITS, capitalUsd: 0 },
    { ...VALID_LIMITS, orderUsd: -5 },
  ])('rechaza por IPC unos límites fuera de techo: %o', async (input) => {
    makeCtx();
    await expect(invoke(IPC_CHANNELS.live.setLimits, input)).rejects.toBeInstanceOf(
      IpcValidationError,
    );
  });

  it('el servicio vuelve a comprobar los techos aunque se cuele la entrada', () => {
    const service = makeService();
    expect(() => service.setLimits({ ...VALID_LIMITS, capitalUsd: 9_999 })).toThrow(
      LiveServiceError,
    );
    expect(() => service.setLimits({ ...VALID_LIMITS, openPositions: 9 })).toThrow(
      LiveServiceError,
    );
    expect(() => service.setLimits({ ...VALID_LIMITS, shortOrderUsd: 101 })).toThrow(
      LiveServiceError,
    );
    expect(() => service.setLimits({ ...VALID_LIMITS, shortExposureUsd: 201 })).toThrow(
      LiveServiceError,
    );
    expect(() => service.setLimits({ ...VALID_LIMITS, shortPositions: 2 })).toThrow(
      LiveServiceError,
    );
  });

  it('los límites del corto entran en la frase: cambiarlos exige confirmar de nuevo', async () => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    const { service } = makeCtx();
    await invoke(IPC_CHANNELS.live.setLimits, VALID_LIMITS);
    // Los requisitos propios del corto deben cumplirse para guardar > 0:
    // la declaración, la evidencia paper y la cuenta live lista.
    await connectSimulatedLiveAccount(service);
    await invoke(IPC_CHANNELS.live.seedProgress, { paperShortTrades: 5, paperShortWeeks: 5 });
    await invoke(IPC_CHANNELS.live.declare, {
      requirement: 'revision-legal-corto',
      confirmed: true,
    });
    const conCorto = {
      ...VALID_LIMITS,
      shortOrderUsd: 50,
      shortExposureUsd: 100,
      shortPositions: 1,
    };
    const result = (await invoke(IPC_CHANNELS.live.setLimits, conCorto)) as {
      confirmationPhrase: string;
      confirmed: boolean;
    };
    // La frase nueva incluye los límites del corto y la confirmación de
    // los límites anteriores ya no vale para esta escritura.
    expect(result.confirmationPhrase).toBe(liveConfirmationPhrase(conCorto));
    expect(result.confirmationPhrase).toContain('CORTO 50 USD POR ORDEN');
    expect(result.confirmed).toBe(false);
    const activation = (await invoke(IPC_CHANNELS.live.activate, {
      phrase: liveConfirmationPhrase(VALID_LIMITS),
    })) as { activated: boolean };
    expect(activation.activated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Prueba de parada
// ---------------------------------------------------------------------------

describe('live:test-kill-switch', () => {
  it('activa y reanuda la parada, deja sello y Diario, y marca el requisito', async () => {
    makeCtx();
    const result = (await invoke(IPC_CHANNELS.live.testKillSwitch)) as {
      ok: boolean;
      testedAt: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.testedAt).not.toBeNull();

    const checklist = (await invoke(IPC_CHANNELS.live.checklist)) as LiveChecklist;
    expect(checklist.items.find((i) => i.requirement === 'parada-probada')!.state).toBe('cumplido');

    // La parada volvió a reposo y el ciclo quedó en kill_switch_events.
    const events = db.prepare(`SELECT accion FROM kill_switch_events ORDER BY id`).all() as {
      accion: string;
    }[];
    expect(events.map((e) => e.accion)).toEqual(['activada', 'reanudada']);
    expect(journal.some((j) => j.reason.includes('Parada de emergencia probada'))).toBe(true);
  });

  it('rechaza la prueba si la parada ya está activa', async () => {
    const { ctx } = makeCtx();
    ctx.services.killSwitch!.activate('manual', 'usuario');
    const result = (await invoke(IPC_CHANNELS.live.testKillSwitch)) as { ok: boolean };
    expect(result.ok).toBe(false);
    // No se reanudó una parada que el usuario había activado.
    expect(ctx.services.killSwitch!.getState().active).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Alertas externas
// ---------------------------------------------------------------------------

describe('requisito alertas-activas', () => {
  it('cumple con prueba correcta y canal activo en delivery.config', () => {
    seedDeliveryTest('telegram');
    const service = makeService({
      alertChannels: () => [{ channel: 'telegram', enabled: true, configured: true }],
      alertTest: () => ({
        channel: 'telegram',
        at: new Date(nowMs).toISOString(),
      }),
    });
    const item = service.getChecklist().items.find((i) => i.requirement === 'alertas-activas')!;
    expect(item.state).toBe('cumplido');
    expect(item.evidence).toContain('Telegram');
  });

  it('vuelve a pendiente si el canal probado se desactiva', () => {
    const service = makeService({
      alertChannels: () => [{ channel: 'telegram', enabled: false, configured: true }],
      alertTest: () => ({ channel: 'telegram', at: new Date(nowMs).toISOString() }),
    });
    const item = service.getChecklist().items.find((i) => i.requirement === 'alertas-activas')!;
    expect(item.state).toBe('pendiente');
  });

  it('registerLive lee la evidencia que delivery dejó en settings', async () => {
    makeCtx();
    seedDeliveryTest('telegram');
    const checklist = (await invoke(IPC_CHANNELS.live.checklist)) as LiveChecklist;
    expect(checklist.items.find((i) => i.requirement === 'alertas-activas')!.state).toBe(
      'cumplido',
    );
  });
});

// ---------------------------------------------------------------------------
// Activación y bloqueo
// ---------------------------------------------------------------------------

describe('live:activate', () => {
  it('sin la lista devuelve los requisitos pendientes y no cambia el estado', async () => {
    makeCtx();
    const result = (await invoke(IPC_CHANNELS.live.activate, {
      phrase: 'ACTIVO DINERO REAL',
    })) as LiveActivateResult;
    expect(result.activated).toBe(false);
    expect(result.pendingRequirements).toHaveLength(7);
    expect(result.reasons.length).toBeGreaterThanOrEqual(7);
    expect(result.reasons.join(' ')).toContain('30 operaciones');
    const state = (await invoke(IPC_CHANNELS.live.state)) as LiveState;
    expect(state.mode).toBe('bloqueado');
    // El intento quedó en el Diario.
    expect(journal.some((j) => j.result === 'alcanzado' && j.reason.includes('rechazada'))).toBe(
      true,
    );
  });

  it('con la lista cumplida pero sin límites lo pide como motivo', async () => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    const { service } = makeCtx();
    await completeChecklist(service);
    const result = (await invoke(IPC_CHANNELS.live.activate, {
      phrase: 'cualquiera',
    })) as LiveActivateResult;
    expect(result.activated).toBe(false);
    expect(result.pendingRequirements).toHaveLength(0);
    expect(result.reasons[0]).toContain('límites');
  });

  it('rechaza una frase de confirmación incorrecta', async () => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    const { service } = makeCtx();
    await completeChecklist(service);
    await invoke(IPC_CHANNELS.live.setLimits, VALID_LIMITS);
    const result = (await invoke(IPC_CHANNELS.live.activate, {
      phrase: 'ACTIVO DINERO REAL CON 999 USD',
    })) as LiveActivateResult;
    expect(result.activated).toBe(false);
    expect(result.reasons[0]).toContain('frase de confirmación');
    expect((await service.getState()).mode).not.toBe('activo');
  });

  it('con todo cumplido y la frase exacta activa el modo real', async () => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    const { service } = makeCtx();
    await completeChecklist(service);
    await invoke(IPC_CHANNELS.live.setLimits, VALID_LIMITS);

    const result = (await invoke(IPC_CHANNELS.live.activate, {
      phrase: liveConfirmationPhrase(VALID_LIMITS),
    })) as LiveActivateResult;
    expect(result.activated).toBe(true);
    expect(result.state.mode).toBe('activo');
    expect(result.state.limits).toEqual(VALID_LIMITS);
    expect(result.state.activatedAt).not.toBeNull();

    // Evento live:changed con el modo activo y auditoría en el Diario.
    const lastChanged = sent.filter((s) => s.channel === IPC_CHANNELS.live.changed).at(-1)
      ?.payload as LiveState;
    expect(lastChanged.mode).toBe('activo');
    expect(journal.some((j) => j.reason.includes('Modo real ACTIVADO'))).toBe(true);
  });
});

describe('live:deactivate', () => {
  it('vuelve a listo conservando la lista y los límites', async () => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    const { service } = makeCtx();
    await completeChecklist(service);
    await invoke(IPC_CHANNELS.live.setLimits, VALID_LIMITS);
    await invoke(IPC_CHANNELS.live.activate, {
      phrase: liveConfirmationPhrase(VALID_LIMITS),
    });
    const state = (await invoke(IPC_CHANNELS.live.deactivate)) as LiveState;
    expect(state.mode).toBe('listo');
    expect(state.suspension).toBeNull();
    expect(journal.some((j) => j.reason.includes('vuelve a paper'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suspensión
// ---------------------------------------------------------------------------

describe('suspensión del modo real', () => {
  const activateReal = async (service: LiveService): Promise<void> => {
    await completeChecklist(service);
    service.setLimits(VALID_LIMITS);
    await service.activate({ phrase: liveConfirmationPhrase(VALID_LIMITS) });
  };

  it('un requisito automático que vence suspende y notifica', async () => {
    const service = makeService();
    await activateReal(service);
    expect((await service.getState()).mode).toBe('activo');

    // La prueba de parada caduca a los 31 días.
    nowMs += 31 * DAY_MS;
    const checklist = service.getChecklist();
    expect(checklist.items.find((i) => i.requirement === 'parada-probada')!.state).toBe(
      'pendiente',
    );

    const state = await service.getState();
    expect(state.mode).toBe('suspendido');
    expect(state.suspension?.reason).toBe('requisito-vencido');
    expect(notifications.some((n) => n.level === 'critica')).toBe(true);
    expect(journal.some((j) => j.reason.includes('Modo real suspendido'))).toBe(true);
  });

  it('la parada de emergencia suspende el modo real al instante', async () => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    const { service, ctx } = makeCtx();
    await activateReal(service);

    ctx.services.killSwitch!.activate('manual', 'usuario');
    const state = await service.getState();
    expect(state.mode).toBe('suspendido');
    expect(state.suspension?.reason).toBe('parada-emergencia');
  });

  it('perder la conexión suspende el modo real', async () => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    const { service, ctx } = makeCtx();
    await activateReal(service);

    ctx.broadcast(IPC_CHANNELS.connectivity.changed, {
      status: 'offline',
      lastCheckedAt: null,
      nextRetryAt: null,
      attempt: 1,
    } satisfies ConnectivityState);
    const state = await service.getState();
    expect(state.mode).toBe('suspendido');
    expect(state.suspension?.reason).toBe('sin-conexion');
  });

  it('retirar una declaración con el modo activo lo suspende', async () => {
    const service = makeService();
    await activateReal(service);
    service.declare({ requirement: 'revision-legal', confirmed: false });
    const state = await service.getState();
    expect(state.mode).toBe('suspendido');
    expect(state.suspension?.reason).toBe('requisito-vencido');
  });

  it('cambiar los límites con el modo activo lo suspende', async () => {
    const service = makeService();
    await activateReal(service);
    service.setLimits({ ...VALID_LIMITS, capitalUsd: 400 });
    const state = await service.getState();
    expect(state.mode).toBe('suspendido');
  });

  it('el modo suspendido no se reactiva solo; exige live:activate con frase', async () => {
    const service = makeService();
    await activateReal(service);
    service.suspend('sin-conexion', 'test');

    // La lista sigue cumplida pero el modo no vuelve a activo por sí solo.
    service.reevaluate();
    expect((await service.getState()).mode).toBe('suspendido');

    const result = await service.activate({
      phrase: liveConfirmationPhrase(VALID_LIMITS),
    });
    expect(result.activated).toBe(true);
    expect(result.state.mode).toBe('activo');
  });

  it('un risk:changed sin parada activa no suspende nada', async () => {
    const service = makeService();
    await activateReal(service);
    service.handleRiskChanged({
      limits: {},
      killSwitch: { active: false, cause: null, actor: null, activatedAt: null, detail: null },
      caution: {},
    } as unknown as RiskOverview);
    expect((await service.getState()).mode).toBe('activo');
  });
});

// ---------------------------------------------------------------------------
// Gancho E2E live:seed-progress
// ---------------------------------------------------------------------------

describe('live:seed-progress', () => {
  it('no existe el handler fuera de TRADIA_E2E', () => {
    makeCtx();
    expect(electron.handlers.has(IPC_CHANNELS.live.seedProgress)).toBe(false);
  });

  it('con TRADIA_E2E y sin empaquetar siembra la evidencia automática', async () => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    makeCtx();
    const checklist = (await invoke(IPC_CHANNELS.live.seedProgress, {
      paperMonths: 3,
      paperTrades: 30,
      deviationPct: 0,
      finalTestDone: true,
      killSwitchTested: true,
      alertsTested: true,
    })) as LiveChecklist;
    const automatic = checklist.items.filter((i) => i.kind === 'automatica');
    expect(automatic.every((i) => i.state === 'cumplido')).toBe(true);
    // Las declaraciones jamás las siembra el gancho.
    expect(
      checklist.items.filter((i) => i.kind === 'declaracion').every((i) => i.state === 'pendiente'),
    ).toBe(true);
  });

  it('la semilla parcial deja pendiente lo que falte', async () => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    makeCtx();
    const checklist = (await invoke(IPC_CHANNELS.live.seedProgress, {
      paperMonths: 1,
      paperTrades: 10,
      deviationPct: -5,
    })) as LiveChecklist;
    const paper = checklist.items.find((i) => i.requirement === 'paper-continuo')!;
    expect(paper.state).toBe('pendiente');
    expect(checklist.items.find((i) => i.requirement === 'parada-probada')!.state).toBe(
      'pendiente',
    );
  });
});

// ---------------------------------------------------------------------------
// Persistencia y eventos
// ---------------------------------------------------------------------------

describe('persistencia', () => {
  it('el modo real sobrevive al reinicio del servicio', async () => {
    // Evidencia en settings (persistente), como en la app real.
    const settings = createSettingsService(db);
    const evidence = () =>
      createLiveEvidenceStore(
        (key) => settings.getValue(key),
        (key, value) => settings.setValue(key, value),
      );
    const service = makeService({ evidence: evidence() });
    await completeChecklist(service);
    service.setLimits(VALID_LIMITS);
    await service.activate({ phrase: liveConfirmationPhrase(VALID_LIMITS) });

    // Nueva instancia sobre la misma base y la misma evidencia: sigue 'activo'.
    const revived = makeService({ evidence: evidence() });
    const state = await revived.getState();
    expect(state.mode).toBe('activo');
    expect(state.limits).toEqual(VALID_LIMITS);
  });

  it('perder la evidencia automática suspende el modo activo (a prueba de fallos)', async () => {
    const service = makeService();
    await completeChecklist(service);
    service.setLimits(VALID_LIMITS);
    await service.activate({ phrase: liveConfirmationPhrase(VALID_LIMITS) });

    // Nueva instancia con evidencia en memoria vacía: no puede verificar
    // los automáticos y suspende en vez de asumir que siguen vigentes.
    const revived = makeService();
    const state = await revived.getState();
    expect(state.mode).toBe('suspendido');
    expect(state.suspension?.reason).toBe('requisito-vencido');
  });

  it('una declaración guardada se conserva entre instancias', () => {
    const service = makeService();
    service.declare({ requirement: 'plan-contingencia', confirmed: true, detail: '/ruta/plan.md' });
    const revived = makeService();
    const item = revived.getChecklist().items.find((i) => i.requirement === 'plan-contingencia')!;
    expect(item.state).toBe('cumplido');
    expect(item.declarationDetail).toBe('/ruta/plan.md');
  });
});

// ---------------------------------------------------------------------------
// Requisitos propios del corto con dinero real
// ---------------------------------------------------------------------------

import type { BrokerOrder } from '../../shared/ipc';

let shortOrderSeq = 0;

/** Orden paper ejecutada para la muestra de cortos. */
const shortOrder = (patch: {
  signalId: number;
  leg: 'entrada' | 'salida';
  side: 'buy' | 'sell';
  executedAt: string;
}): BrokerOrder => {
  shortOrderSeq += 1;
  return {
    id: 10_000 + shortOrderSeq,
    clientOrderId: `tradia-${patch.signalId}-${patch.leg}`,
    brokerOrderId: `b${shortOrderSeq}`,
    signalId: patch.signalId,
    strategyId: 1,
    leg: patch.leg,
    ticker: 'SPY',
    type: 'market',
    side: patch.side,
    mode: 'paper',
    quantity: 1,
    filledQuantity: 1,
    limitPrice: null,
    stopPrice: null,
    ocoGroupId: null,
    execution: {
      requestedAt: patch.executedAt,
      requestedPrice: 100,
      executedAt: patch.executedAt,
      executedPrice: 100,
      slippageBps: 0,
    },
    status: 'ejecutada',
    attempts: 1,
    rejectReason: null,
    createdAt: patch.executedAt,
    updatedAt: patch.executedAt,
  };
};

/** N cortos cerrados en paper repartidos entre hace `spanDays` y hoy. */
const paperShortOrders = (count: number, spanDays: number): BrokerOrder[] => {
  const orders: BrokerOrder[] = [];
  for (let i = 0; i < count; i += 1) {
    const exitDay = Math.round((spanDays * (count - 1 - i)) / Math.max(1, count - 1));
    const exitAt = new Date(nowMs - exitDay * DAY_MS).toISOString();
    const entryAt = new Date(nowMs - (exitDay + 1) * DAY_MS).toISOString();
    orders.push(
      shortOrder({ signalId: 100 + i, leg: 'entrada', side: 'sell', executedAt: entryAt }),
      shortOrder({ signalId: 100 + i, leg: 'salida', side: 'buy', executedAt: exitAt }),
    );
  }
  return orders;
};

/** Descuadre abierto de una pasada de conciliación de la cuenta dada. */
const openDiscrepancy = (cuenta: 'paper' | 'live'): void => {
  const run = db
    .prepare(`INSERT INTO reconcile_runs (origen, iniciada_en, cuenta) VALUES ('manual', ?, ?)`)
    .run(new Date(nowMs).toISOString(), cuenta);
  db.prepare(
    `INSERT INTO reconcile_discrepancies (run_id, tipo, ticker, detalle)
     VALUES (?, 'posicion-faltante-app', 'SPY', 'descuadre de prueba')`,
  ).run(run.lastInsertRowid);
};

/** Límites válidos con el corto habilitado en sus techos escritos. */
const SHORT_LIMITS: LiveLimitsInput = {
  ...VALID_LIMITS,
  shortOrderUsd: 100,
  shortExposureUsd: 200,
  shortPositions: 1,
};

/**
 * Retrato de una cuenta live lista para el corto (margen,
 * `shortingEnabled` y capital ≥ 2.000 USD), como la que deja en caché
 * el broker real tras leer `getAccount()`.
 */
const READY_ACCOUNT: ShortAccountReading = {
  paper: false,
  shortingEnabled: true,
  equityUsd: 10_000,
  readError: false,
  checkedAt: new Date(NOW).toISOString(),
};

const accountReading = (patch: Partial<ShortAccountReading> = {}): ShortAccountReading => ({
  ...READY_ACCOUNT,
  ...patch,
});

/** Cumple los dos requisitos propios del corto con evidencia sembrada. */
const completeShortRequirements = (service: LiveService): void => {
  service.declare({ requirement: 'revision-legal-corto', confirmed: true });
  service.seedProgress({ paperShortTrades: 5, paperShortWeeks: 5 });
};

describe('requisitos propios del corto (corto-requisitos)', () => {
  it('la lista expone los dos requisitos del corto aparte de los siete del largo', async () => {
    const service = makeService();
    await completeChecklist(service);
    const checklist = service.getChecklist();
    // El largo queda completo mientras el corto sigue bloqueado.
    expect(checklist.allComplete).toBe(true);
    expect(checklist.total).toBe(7);
    expect(checklist.short.total).toBe(2);
    expect(checklist.short.allComplete).toBe(false);
    expect(checklist.short.blockReason).toContain('ventas en corto');
    const kinds = Object.fromEntries(checklist.short.items.map((i) => [i.requirement, i.kind]));
    expect(kinds['revision-legal-corto']).toBe('declaracion');
    expect(kinds['paper-cortos']).toBe('automatica');
    const state = await service.getState();
    expect(state.short.allComplete).toBe(false);
    expect(state.short.blockReason).toContain('corto');
  });

  it('guardar límites del corto > 0 por IPC sin requisitos devuelve «[corto-requisitos] …»', async () => {
    makeCtx();
    await expect(invoke(IPC_CHANNELS.live.setLimits, SHORT_LIMITS)).rejects.toThrow(
      /^\[corto-requisitos\]/,
    );
    // Nada quedó guardado.
    const checklist = (await invoke(IPC_CHANNELS.live.checklist)) as LiveChecklist;
    expect(checklist.limits.limits).toBeNull();
  });

  it('con los requisitos cumplidos los límites del corto sí se guardan', async () => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    const { service } = makeCtx();
    await connectSimulatedLiveAccount(service);
    await invoke(IPC_CHANNELS.live.seedProgress, { paperShortTrades: 5, paperShortWeeks: 5 });
    await invoke(IPC_CHANNELS.live.declare, {
      requirement: 'revision-legal-corto',
      confirmed: true,
    });
    const saved = (await invoke(IPC_CHANNELS.live.setLimits, SHORT_LIMITS)) as {
      limits: { shortOrderUsd: number };
      confirmationPhrase: string;
    };
    expect(saved.limits.shortOrderUsd).toBe(100);
    expect(saved.confirmationPhrase).toContain('CORTO');
  });

  it('guardar los límites del largo con el corto a 0 no pide los requisitos', () => {
    const service = makeService();
    const saved = service.setLimits(VALID_LIMITS);
    expect(saved.limits?.shortOrderUsd).toBe(0);
  });

  it('activar con corto > 0 sin requisitos rechaza con «[corto-requisitos]» y no confirma', async () => {
    const service = makeService({ shortAccount: () => READY_ACCOUNT });
    await completeChecklist(service);
    completeShortRequirements(service);
    service.setLimits(SHORT_LIMITS);
    // La declaración del corto se retira entre guardar y confirmar.
    service.declare({ requirement: 'revision-legal-corto', confirmed: false });
    const result = await service.activate({ phrase: liveConfirmationPhrase(SHORT_LIMITS) });
    expect(result.activated).toBe(false);
    expect(result.reasons.join(' ')).toContain('[corto-requisitos]');
    expect(result.pendingRequirements).toContain('revision-legal-corto');
    // Los valores escritos se conservan pero no se confirman.
    const row = db
      .prepare('SELECT confirmados, corto_orden_usd FROM live_limits WHERE id = 1')
      .get() as {
      confirmados: number;
      corto_orden_usd: number;
    };
    expect(row.confirmados).toBe(0);
    expect(row.corto_orden_usd).toBe(100);
  });

  it('con todo cumplido la activación confirma los límites del corto', async () => {
    const service = makeService({ shortAccount: () => READY_ACCOUNT });
    await completeChecklist(service);
    completeShortRequirements(service);
    service.setLimits(SHORT_LIMITS);
    const result = await service.activate({ phrase: liveConfirmationPhrase(SHORT_LIMITS) });
    expect(result.activated).toBe(true);
    const row = db.prepare('SELECT confirmados FROM live_limits WHERE id = 1').get() as {
      confirmados: number;
    };
    expect(row.confirmados).toBe(1);
  });

  it('una cuenta con el corto ya confirmado lo conserva aunque falten requisitos', () => {
    // La fila se escribe directamente, sin pasar por setLimits: así
    // quedó cualquier cuenta que confirmó sus límites antes de la 017.
    db.prepare(
      `INSERT INTO live_limits (id, capital_usd, orden_usd, perdida_diaria_usd,
         posiciones_max, corto_orden_usd, corto_exposicion_usd, corto_posiciones_max,
         confirmados, guardados_en, confirmados_en)
       VALUES (1, 500, 100, 10, 1, 100, 200, 1, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z')`,
    ).run();
    const service = makeService();
    const checklist = service.getChecklist();
    expect(checklist.limits.limits?.shortOrderUsd).toBe(100);
    expect(checklist.limits.confirmed).toBe(true);
    expect(checklist.short.allComplete).toBe(false);
    expect(checklist.short.blockReason).not.toBeNull();
  });

  it('paper-cortos mide los cortos cerrados en paper reales, no la semilla fuera de E2E', () => {
    const service = makeService({
      listExecutedOrders: () => paperShortOrders(5, 35),
    });
    const item = service.getChecklist().short.items.find((i) => i.requirement === 'paper-cortos')!;
    expect(item.state).toBe('cumplido');
    expect(item.evidence).toContain('5 de 5 cortos cerrados');
    expect(item.evidence).toContain('conciliación cuadrada');
  });

  it('un descuadre abierto de la conciliación paper deja paper-cortos pendiente; uno live no cuenta', () => {
    const service = makeService({
      listExecutedOrders: () => paperShortOrders(5, 35),
    });
    openDiscrepancy('live');
    let item = service.getChecklist().short.items.find((i) => i.requirement === 'paper-cortos')!;
    expect(item.state).toBe('cumplido');
    openDiscrepancy('paper');
    item = service.getChecklist().short.items.find((i) => i.requirement === 'paper-cortos')!;
    expect(item.state).toBe('pendiente');
    expect(item.evidence).toContain('1 descuadre abierto');
  });

  it('la evidencia sembrada de paper-cortos no cuenta fuera del contexto E2E', () => {
    const service = makeService({
      allowSeededEvidence: () => false,
      listExecutedOrders: () => paperShortOrders(2, 10),
    });
    service.seedProgress({ paperShortTrades: 9, paperShortWeeks: 9 });
    const item = service.getChecklist().short.items.find((i) => i.requirement === 'paper-cortos')!;
    expect(item.state).toBe('pendiente');
    expect(item.evidence).toContain('2 de 5 cortos cerrados');
  });

  it('live:declare suscribe la declaración del corto y la retira a pendiente', async () => {
    makeCtx();
    const checklist = (await invoke(IPC_CHANNELS.live.declare, {
      requirement: 'revision-legal-corto',
      confirmed: true,
    })) as LiveChecklist;
    const item = checklist.short.items.find((i) => i.requirement === 'revision-legal-corto')!;
    expect(item.state).toBe('cumplido');
    expect(item.declaration).toBe(LIVE_DECLARATION_TEXTS['revision-legal-corto']);
    const withdrawn = (await invoke(IPC_CHANNELS.live.declare, {
      requirement: 'revision-legal-corto',
      confirmed: false,
    })) as LiveChecklist;
    expect(withdrawn.short.items.find((i) => i.requirement === 'revision-legal-corto')!.state).toBe(
      'pendiente',
    );
  });

  it('live:declare sigue rechazando marcar a mano un requisito automático del corto', async () => {
    makeCtx();
    await expect(
      invoke(IPC_CHANNELS.live.declare, { requirement: 'paper-cortos', confirmed: true }),
    ).rejects.toBeInstanceOf(IpcValidationError);
  });
});

// ---------------------------------------------------------------------------
// Control de cuenta live del corto (checklist.short.account)
// ---------------------------------------------------------------------------

describe('cuenta live de Alpaca para el corto (checklist.short.account)', () => {
  it('sin lectura queda en revisar, el corto bloqueado y el largo intacto', async () => {
    const service = makeService();
    await completeChecklist(service);
    completeShortRequirements(service);
    const checklist = service.getChecklist();
    // Los dos requisitos cumplidos pero sin cuenta leída: 'revisar'.
    expect(checklist.short.items.every((i) => i.state === 'cumplido')).toBe(true);
    expect(checklist.short.account).toMatchObject({
      state: 'revisar',
      paper: null,
      shortingEnabled: null,
      equityUsd: null,
      minEquityUsd: 2000,
    });
    expect(checklist.short.allComplete).toBe(false);
    expect(checklist.short.blockReason).toContain('No se pudo comprobar la cuenta de Alpaca');
    // El largo sigue midiendo solo sus siete requisitos.
    expect(checklist.allComplete).toBe(true);
    const state = await service.getState();
    expect(state.short.allComplete).toBe(false);
    expect(state.short.blockReason).toContain('cuenta de Alpaca');
  });

  it('una cuenta live con corto habilitado y capital suficiente queda cumplido', async () => {
    const service = makeService({ shortAccount: () => READY_ACCOUNT });
    await completeChecklist(service);
    completeShortRequirements(service);
    const checklist = service.getChecklist();
    expect(checklist.short.account.state).toBe('cumplido');
    expect(checklist.short.account.evidence).toContain('Cuenta live con margen');
    expect(checklist.short.account.evidence).toContain('10.000,00 USD');
    expect(checklist.short.account.evidence).toContain('2.000,00 USD');
    expect(checklist.short.allComplete).toBe(true);
    expect(checklist.short.blockReason).toBeNull();
    const saved = service.setLimits(SHORT_LIMITS);
    expect(saved.limits?.shortOrderUsd).toBe(100);
  });

  it.each([
    ['shortingEnabled en false', { shortingEnabled: false }],
    ['capital por debajo del mínimo', { equityUsd: 1_999.99 }],
    ['cuenta paper', { paper: true }],
  ])('una cuenta con %s queda pendiente y rechaza los límites del corto', async (_label, patch) => {
    const service = makeService({ shortAccount: () => accountReading(patch) });
    await completeChecklist(service);
    completeShortRequirements(service);
    const checklist = service.getChecklist();
    expect(checklist.short.account.state).toBe('pendiente');
    expect(checklist.short.account.evidence).toContain('2.000,00 USD');
    expect(checklist.short.allComplete).toBe(false);
    expect(() => service.setLimits(SHORT_LIMITS)).toThrow(/^\[corto-requisitos\] /);
    expect(() => service.setLimits(SHORT_LIMITS)).toThrow(
      /cuenta live de Alpaca debe tener margen/,
    );
    // El corto a 0 sigue guardando los límites del largo.
    expect(service.setLimits(VALID_LIMITS).limits?.shortOrderUsd).toBe(0);
  });

  it.each([
    ['sin lectura', null],
    ['lectura fallida', { readError: true, paper: null, shortingEnabled: null, equityUsd: null }],
    ['shortingEnabled ausente', { shortingEnabled: null }],
    ['capital ausente', { equityUsd: null }],
    ['paper desconocido', { paper: null }],
  ])('con %s queda revisar y la lista no lanza', async (_label, reading) => {
    const service = makeService({
      shortAccount: () => (reading === null ? null : accountReading(reading)),
    });
    await completeChecklist(service);
    completeShortRequirements(service);
    const checklist = service.getChecklist();
    expect(checklist.short.account.state).toBe('revisar');
    expect(checklist.short.account.evidence).toContain('No se pudo comprobar la cuenta de Alpaca');
    expect(checklist.short.allComplete).toBe(false);
    expect(checklist.short.blockReason).toContain('permanece bloqueado');
  });

  it('los límites cortos confirmados se conservan con la cuenta pendiente', async () => {
    // La fila se escribe directamente, sin pasar por setLimits: una
    // cuenta que confirmó el corto antes de perder el margen lo
    // conserva escrito, pero bloqueado.
    db.prepare(
      `INSERT INTO live_limits (id, capital_usd, orden_usd, perdida_diaria_usd,
         posiciones_max, corto_orden_usd, corto_exposicion_usd, corto_posiciones_max,
         confirmados, guardados_en, confirmados_en)
       VALUES (1, 500, 100, 10, 1, 100, 200, 1, 1, '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z')`,
    ).run();
    const service = makeService({
      shortAccount: () => accountReading({ shortingEnabled: false }),
    });
    await completeChecklist(service);
    completeShortRequirements(service);
    const checklist = service.getChecklist();
    expect(checklist.limits.limits?.shortOrderUsd).toBe(100);
    expect(checklist.limits.confirmed).toBe(true);
    expect(checklist.short.account.state).toBe('pendiente');
    expect(checklist.short.allComplete).toBe(false);
    const result = await service.activate({ phrase: liveConfirmationPhrase(SHORT_LIMITS) });
    expect(result.activated).toBe(false);
    expect(result.reasons.join(' ')).toContain('[corto-requisitos]');
    expect(result.reasons.join(' ')).toContain('cuenta live de Alpaca');
    // Los valores siguen guardados tras el rechazo.
    expect(service.getChecklist().limits.limits?.shortOrderUsd).toBe(100);
  });

  it('por IPC la conexión deja la cuenta lista y set-limits del corto guarda', async () => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    const { service } = makeCtx();
    // Antes de conectar la cuenta queda 'revisar'.
    let checklist = (await invoke(IPC_CHANNELS.live.checklist)) as LiveChecklist;
    expect(checklist.short.account.state).toBe('revisar');
    await connectSimulatedLiveAccount(service);
    checklist = (await invoke(IPC_CHANNELS.live.checklist)) as LiveChecklist;
    expect(checklist.short.account).toMatchObject({
      state: 'cumplido',
      paper: false,
      shortingEnabled: true,
      minEquityUsd: 2000,
    });
    expect(checklist.short.account.equityUsd).toBeGreaterThanOrEqual(2000);
  });

  it('una cuenta no lista por IPC también rechaza con «[corto-requisitos] …»', async () => {
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    const { service } = makeCtx();
    // La cuenta falsa acredita corto deshabilitado: pendiente.
    await invoke(IPC_CHANNELS.live.useSimulatedBroker, {
      enabled: true,
      account: { shortingEnabled: false },
    });
    await completeChecklist(service);
    await invoke(IPC_CHANNELS.live.connect, {
      apiKeyId: 'AKTESTKEY01',
      apiSecret: 'SK-test-secret',
    });
    await invoke(IPC_CHANNELS.live.seedProgress, { paperShortTrades: 5, paperShortWeeks: 5 });
    await invoke(IPC_CHANNELS.live.declare, {
      requirement: 'revision-legal-corto',
      confirmed: true,
    });
    const checklist = (await invoke(IPC_CHANNELS.live.checklist)) as LiveChecklist;
    expect(checklist.short.account.state).toBe('pendiente');
    await expect(invoke(IPC_CHANNELS.live.setLimits, SHORT_LIMITS)).rejects.toThrow(
      /\[corto-requisitos\]/,
    );
  });
});
