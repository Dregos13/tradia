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
import { DELIVERY_TEST_EVIDENCE_KEY, formatLiveDate } from './checklist';
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
      secrets: { hasKey: () => Promise.resolve(false) } as never,
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
    makeCtx();
    await invoke(IPC_CHANNELS.live.setLimits, VALID_LIMITS);
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
