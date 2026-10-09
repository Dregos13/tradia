import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IPC_CHANNELS,
  IpcValidationError,
  RISK_DEFAULTS,
  type ConnectivityState,
  type DataStatusEntry,
  type NotificationPayload,
  type RiskOverview,
  type SignalIntent,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import {
  createKillSwitchService,
  createKillSwitchStore,
  KillSwitchError,
  KILL_SWITCH_NOTIFICATION_TITLE,
  registerKillSwitch,
  type KillSwitchDeps,
  type KillSwitchService,
  type TimerHandle,
} from './killSwitch';

// electron solo aporta app/ipcMain a registerKillSwitch; se captura el mapa
// de handlers como en las demás pruebas de servicios.
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

const NOW = Date.parse('2026-10-09T15:00:00.000Z');

let db: Database.Database;
let nowMs: number;
let sent: { channel: string; payload: unknown }[];
let notifications: NotificationPayload[];
let pauses: number;
let resumes: number;
let trayRefreshes: number;
let timers: { cb: () => void; delayMs: number }[];
let connectivityStatus: ConnectivityState['status'];

const lastRiskChanged = (): RiskOverview =>
  sent.filter((s) => s.channel === IPC_CHANNELS.risk.changed).at(-1)?.payload as RiskOverview;

const eventCount = (action?: string): number => {
  const row = (
    action === undefined
      ? db.prepare('SELECT COUNT(*) AS n FROM kill_switch_events').get()
      : db.prepare('SELECT COUNT(*) AS n FROM kill_switch_events WHERE accion = ?').get(action)
  ) as { n: number };
  return row.n;
};

const signal = (patch: Partial<SignalIntent> = {}): SignalIntent => ({
  ticker: 'AAPL',
  direction: 'largo',
  entry: 100,
  stop: 95,
  target: 110,
  confidence: 0.7,
  origin: 'estrategia',
  ...patch,
});

const dataStatus = (patch: Partial<DataStatusEntry> = {}): DataStatusEntry => ({
  key: 'ticker:AAPL',
  state: 'fiable',
  lastOkAt: null,
  consecutiveFailures: 0,
  reason: null,
  updatedAt: new Date(nowMs).toISOString(),
  ...patch,
});

const connectivity = (): ConnectivityState => ({
  status: connectivityStatus,
  lastCheckedAt: null,
  nextRetryAt: null,
  attempt: 0,
});

const makeService = (overrides: Partial<KillSwitchDeps> = {}): KillSwitchService =>
  createKillSwitchService({
    // Por defecto comparten el almacén de la prueba (persistencia); para un
    // servicio independiente se pasa `store` en overrides.
    store: createKillSwitchStore(db),
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    pauseAgents: () => {
      pauses += 1;
    },
    resumeAgents: () => {
      resumes += 1;
    },
    notify: (payload) => notifications.push(payload),
    refreshTray: () => {
      trayRefreshes += 1;
    },
    now: () => nowMs,
    getConnectivityState: () => connectivity(),
    setTimer: (cb, delayMs) => {
      // Temporizador de un disparo: al ejecutarse sale de la lista de
      // pendientes, como un setTimeout real.
      const handle = {
        delayMs,
        cb: () => {
          const index = timers.indexOf(handle);
          if (index >= 0) timers.splice(index, 1);
          cb();
        },
      };
      timers.push(handle);
      return handle as unknown as TimerHandle;
    },
    clearTimer: (handle) => {
      const index = timers.indexOf(handle as unknown as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
    ...overrides,
  });

beforeEach(() => {
  electron.handlers.clear();
  electron.isPackaged = true;
  db = openDatabase(':memory:');
  nowMs = NOW;
  sent = [];
  notifications = [];
  pauses = 0;
  resumes = 0;
  trayRefreshes = 0;
  timers = [];
  connectivityStatus = 'online';
});

afterEach(() => {
  delete process.env.TRADIA_E2E;
  db.close();
});

describe('parada de emergencia · activación', () => {
  it('activate(manual) pausa los agentes, registra el evento y notifica en crítica', () => {
    const service = makeService();

    const state = service.activate('manual', 'usuario');

    expect(state).toMatchObject({ active: true, cause: 'manual', actor: 'usuario' });
    expect(state.activatedAt).toBe(new Date(NOW).toISOString());
    expect(pauses).toBe(1);
    expect(eventCount('activada')).toBe(1);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      level: 'critica',
      title: KILL_SWITCH_NOTIFICATION_TITLE,
      navigateTo: 'riesgo',
    });
    expect(notifications[0]?.body).toContain('Parada manual');
    expect(notifications[0]?.body).toContain('Señales y órdenes detenidas');

    // risk:changed lleva el RiskOverview completo y la bandeja se repinta.
    const overview = lastRiskChanged();
    expect(overview.killSwitch.active).toBe(true);
    expect(overview.limits).toEqual(RISK_DEFAULTS);
    expect(overview.caution).toMatchObject({ active: false, effect: 'ninguno' });
    expect(trayRefreshes).toBe(1);
  });

  it('activate es idempotente: ni duplica eventos ni repite la notificación', () => {
    const service = makeService();

    service.activate('manual', 'usuario');
    const again = service.activate('perdida-anomala', 'automatico', 'detalle ignorado');

    expect(again.cause).toBe('manual');
    expect(eventCount()).toBe(1);
    expect(pauses).toBe(1);
    expect(notifications).toHaveLength(1);
  });
});

describe('parada de emergencia · disparadores automáticos', () => {
  it('pérdida anómala: pérdida diaria ≥ 1,5 × límite o drawdown ≥ límite', () => {
    const service = makeService();
    // Por defecto 2 % diario → umbral 3 %; drawdown máximo 10 %.
    service.observeDailyLoss(2.99);
    expect(service.getState().active).toBe(false);
    service.observeDailyLoss(3);
    expect(service.getState()).toMatchObject({
      active: true,
      cause: 'perdida-anomala',
      actor: 'automatico',
    });
    expect(notifications[0]?.body).toContain('Pérdida anómala');

    const other = makeService({ store: createKillSwitchStore(openDatabase(':memory:')) });
    other.observeDrawdown(9.9);
    expect(other.getState().active).toBe(false);
    other.observeDrawdown(10);
    expect(other.getState().cause).toBe('perdida-anomala');
  });

  it('dato anómalo: data-status no-fiable y saltos de precio ≥ 20 %', () => {
    const service = makeService();
    service.observeDataStatus(dataStatus({ state: 'desactualizado' }));
    expect(service.getState().active).toBe(false);

    service.observeDataStatus(
      dataStatus({ state: 'no-fiable', reason: 'valor anómalo grave en el último lote' }),
    );
    expect(service.getState()).toMatchObject({ active: true, cause: 'dato-anomalo' });
    expect(service.getState().detail).toContain('valor anómalo grave');
    expect(notifications[0]?.body).toContain('Dato de mercado anómalo');

    const other = makeService({ store: createKillSwitchStore(openDatabase(':memory:')) });
    other.observePriceJump('TSLA', 19.9);
    expect(other.getState().active).toBe(false);
    other.observePriceJump('TSLA', -25);
    expect(other.getState().cause).toBe('dato-anomalo');
  });

  it('sin conexión: más de 60 s offline seguidos, con reloj inyectable', () => {
    const service = makeService();
    connectivityStatus = 'offline';

    service.checkConnectivity(); // empieza el conteo
    nowMs += 59_000;
    service.checkConnectivity();
    expect(service.getState().active).toBe(false);

    nowMs += 2_000;
    service.checkConnectivity();
    expect(service.getState()).toMatchObject({
      active: true,
      cause: 'sin-conexion',
      actor: 'automatico',
    });
    expect(notifications[0]?.body).toContain('Sin conexión durante más de 60 s');
  });

  it('volver en línea reinicia el conteo; checking no lo toca', () => {
    const service = makeService();
    connectivityStatus = 'offline';
    service.checkConnectivity();
    nowMs += 30_000;
    connectivityStatus = 'checking';
    service.checkConnectivity(); // transitorio: el conteo sigue
    connectivityStatus = 'online';
    service.checkConnectivity(); // en línea: conteo a cero

    nowMs += 61_000;
    connectivityStatus = 'offline';
    service.checkConnectivity(); // vuelve a empezar
    nowMs += 61_000;
    service.checkConnectivity();
    expect(service.getState().cause).toBe('sin-conexion');
  });

  it('modelo errático: ráfaga de más de 20 señales en una hora', () => {
    const service = makeService();
    for (let i = 0; i < 20; i += 1) {
      service.observeSignal(signal());
      nowMs += 60_000;
    }
    expect(service.getState().active).toBe(false);

    service.observeSignal(signal());
    expect(service.getState()).toMatchObject({ active: true, cause: 'modelo-erratico' });
    expect(service.getState().detail).toContain('señales en 1 h');
  });

  it('modelo errático: cinco señales inválidas seguidas (una válida corta la racha)', () => {
    const service = makeService();
    const invalid = () => service.observeSignal(signal({ entry: -5 }));
    for (let i = 0; i < 4; i += 1) invalid();
    service.observeSignal(signal()); // válida: racha a cero
    for (let i = 0; i < 4; i += 1) invalid();
    expect(service.getState().active).toBe(false);

    invalid();
    expect(service.getState()).toMatchObject({ active: true, cause: 'modelo-erratico' });
    expect(service.getState().detail).toContain('inválidas seguidas');
  });

  it('modelo errático: una confianza fuera de 0–1 dispara al instante', () => {
    const service = makeService();
    service.observeSignal(signal({ confidence: 1.4 }));
    expect(service.getState()).toMatchObject({ active: true, cause: 'modelo-erratico' });
    expect(service.getState().detail).toContain('confianza fuera de rango');
    expect(notifications[0]?.body).toContain('Comportamiento errático del modelo');
  });
});

describe('parada de emergencia · reanudación', () => {
  it('resume exige confirmación explícita y registra el evento', () => {
    const service = makeService();
    service.activate('manual', 'usuario');

    const state = service.resume({ confirm: true, note: 'revisado' });

    expect(state.active).toBe(false);
    // Causa, actor y hora de la última activación se conservan.
    expect(state).toMatchObject({ cause: 'manual', actor: 'usuario' });
    expect(state.activatedAt).toBe(new Date(NOW).toISOString());
    expect(resumes).toBe(1);
    expect(eventCount('reanudada')).toBe(1);
    expect(lastRiskChanged().killSwitch.active).toBe(false);
  });

  it('lanza error si la confirmación no es true (nunca reanuda sola)', () => {
    const service = makeService();
    service.activate('manual', 'usuario');

    expect(() => service.resume({ confirm: false } as unknown as { confirm: true })).toThrowError(
      KillSwitchError,
    );
    expect(service.getState().active).toBe(true);
    expect(resumes).toBe(0);
  });

  it('resume sin parada activa es inofensivo y no escribe evento', () => {
    const service = makeService();
    service.resume({ confirm: true });
    expect(eventCount()).toBe(0);
    expect(resumes).toBe(0);
  });

  it('recuperarse la conexión o el dato no reanuda la parada', () => {
    const service = makeService();
    connectivityStatus = 'offline';
    service.checkConnectivity();
    nowMs += 61_000;
    service.checkConnectivity();
    expect(service.getState().active).toBe(true);

    connectivityStatus = 'online';
    service.checkConnectivity();
    service.observeDataStatus(dataStatus({ state: 'fiable' }));
    expect(service.getState().active).toBe(true); // sigue parada: jamás automática
  });
});

describe('parada de emergencia · persistencia y ciclo de vida', () => {
  it('el estado sobrevive a un reinicio y start() reaplica la pausa', () => {
    // El «reinicio» es un servicio nuevo sobre el mismo almacén: el estado
    // se deriva del último evento de kill_switch_events, no de memoria.
    makeService().activate('perdida-anomala', 'automatico', 'pérdida diaria del 4 %');

    const rebooted = makeService();
    expect(rebooted.getState()).toMatchObject({
      active: true,
      cause: 'perdida-anomala',
      actor: 'automatico',
      detail: 'pérdida diaria del 4 %',
      activatedAt: new Date(NOW).toISOString(),
    });

    rebooted.start();
    // Una pausa por la activación y otra al reaplicarla tras el reinicio.
    expect(pauses).toBe(2);
    rebooted.stop();
  });

  it('una reanudación también queda persistida: el reinicio arranca inactivo', () => {
    const service = makeService();
    service.activate('manual', 'usuario');
    service.resume({ confirm: true });

    const rebooted = makeService();
    const state = rebooted.getState();
    expect(state.active).toBe(false);
    expect(state).toMatchObject({ cause: 'manual', actor: 'usuario' });
    pauses = 0;
    rebooted.start();
    expect(pauses).toBe(0); // start() no pausa si no hay parada activa
    rebooted.stop();
  });

  it('start() es idempotente y arma el sondeo de conectividad', () => {
    const service = makeService();
    service.start();
    service.start();
    expect(timers).toHaveLength(1);

    connectivityStatus = 'offline';
    timers[0]?.cb(); // una pasada del sondeo real
    nowMs += 61_000;
    // El temporizador se rearma solo tras cada pasada.
    timers.at(-1)?.cb();
    expect(service.getState().cause).toBe('sin-conexion');
    service.stop();
    expect(timers).toHaveLength(0);
  });
});

describe('registerKillSwitch · IPC y cableado', () => {
  const makeCtx = (): ServiceContext => ({
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    services: {
      storage: { getDb: () => db },
      scheduler: {
        pause: () => {
          pauses += 1;
        },
        resume: () => {
          resumes += 1;
        },
      },
      notifications: { notify: (p: NotificationPayload) => notifications.push(p) },
      tray: {
        refresh: () => {
          trayRefreshes += 1;
        },
      },
      connectivity: { getState: () => connectivity() },
    } as unknown as ServiceContext['services'],
  });

  it('expone el estado y los canales de activación y reanudación', () => {
    const ctx = makeCtx();
    const service = registerKillSwitch(ctx);

    const get = electron.handlers.get(IPC_CHANNELS.risk.getKillSwitch);
    expect(get?.(null)).toMatchObject({ active: false });

    electron.handlers.get(IPC_CHANNELS.risk.activateKillSwitch)?.(null);
    expect(get?.(null)).toMatchObject({ active: true, cause: 'manual', actor: 'usuario' });
    expect(pauses).toBe(1);
    expect(notifications[0]?.navigateTo).toBe('riesgo');

    expect(() =>
      electron.handlers.get(IPC_CHANNELS.risk.resumeKillSwitch)?.(null, { confirm: false }),
    ).toThrowError(IpcValidationError);
    expect(service.getState().active).toBe(true);

    electron.handlers.get(IPC_CHANNELS.risk.resumeKillSwitch)?.(null, { confirm: true });
    expect(service.getState().active).toBe(false);
    expect(resumes).toBe(1);
    service.stop();
  });

  it('sin TRADIA_E2E no registra el gancho simulate-cause; con él simula la causa', () => {
    const ctx = makeCtx();
    registerKillSwitch(ctx).stop();
    expect(electron.handlers.has(IPC_CHANNELS.risk.simulateCause)).toBe(false);

    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    const ctx2 = makeCtx();
    const service = registerKillSwitch(ctx2);
    electron.handlers.get(IPC_CHANNELS.risk.simulateCause)?.call(null, null, 'modelo-erratico');
    expect(service.getState()).toMatchObject({
      active: true,
      cause: 'modelo-erratico',
      actor: 'automatico',
    });
    delete process.env.TRADIA_E2E;
    service.stop();
  });

  it('observa los data-status:changed que atraviesan ctx.broadcast', () => {
    const ctx = makeCtx();
    const service = registerKillSwitch(ctx);

    ctx.broadcast(IPC_CHANNELS.dataStatus.changed, dataStatus({ state: 'desactualizado' }));
    expect(service.getState().active).toBe(false);

    ctx.broadcast(
      IPC_CHANNELS.dataStatus.changed,
      dataStatus({ state: 'no-fiable', reason: 'fallo del proveedor' }),
    );
    expect(service.getState().cause).toBe('dato-anomalo');
    service.stop();
  });
});
