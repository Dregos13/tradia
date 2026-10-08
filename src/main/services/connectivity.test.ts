import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS, type ConnectivityState, type NotificationPayload } from '../../shared/ipc';
import {
  backoffDelayMs,
  createConnectivityService,
  DEFAULT_CONNECTIVITY_ENDPOINTS,
  ONLINE_INTERVAL_MS,
  resolveEndpoints,
  type ConnectivityDeps,
  type PowerMonitorLike,
} from './connectivity';

/** powerMonitor simulado: registra listeners y permite emitir eventos. */
class FakePowerMonitor implements PowerMonitorLike {
  private listeners = new Map<string, Set<() => void>>();

  on(event: 'resume' | 'unlock-screen', listener: () => void): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  removeListener(event: 'resume' | 'unlock-screen', listener: () => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: 'resume' | 'unlock-screen'): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  listenerCount(event: 'resume' | 'unlock-screen'): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

interface Sent {
  channel: string;
  payload: unknown;
}

interface Harness {
  deps: ConnectivityDeps;
  sent: Sent[];
  notifications: NotificationPayload[];
  scheduler: {
    pauseDecisions: ReturnType<typeof vi.fn>;
    resumeDecisions: ReturnType<typeof vi.fn>;
  };
  isOnline: ReturnType<typeof vi.fn>;
  probe: ReturnType<typeof vi.fn>;
  refreshTray: ReturnType<typeof vi.fn>;
  powerMonitor: FakePowerMonitor;
  /** Estado simulado: red del SO y respuesta por endpoint. */
  net: { online: boolean; answers: Map<string, boolean>; defaultAnswer: boolean };
}

function makeDeps(overrides: Partial<ConnectivityDeps> = {}): Harness {
  const sent: Sent[] = [];
  const notifications: NotificationPayload[] = [];
  const scheduler = { pauseDecisions: vi.fn(), resumeDecisions: vi.fn() };
  const refreshTray = vi.fn();
  const powerMonitor = new FakePowerMonitor();
  const net = {
    online: true,
    answers: new Map<string, boolean>(),
    defaultAnswer: true,
  };
  const isOnline = vi.fn(() => net.online);
  const probe = vi.fn((url: string) => Promise.resolve(net.answers.get(url) ?? net.defaultAnswer));
  const deps: ConnectivityDeps = {
    isOnline,
    probe,
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    scheduler,
    notify: (payload) => notifications.push(payload),
    refreshTray,
    powerMonitor,
    endpoints: ['https://a.example/ping', 'https://b.example/ping'],
    // random fijo en 0.5 → esperas exactas 2 s, 4 s, 8 s… sin fluctuación.
    random: () => 0.5,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  };
  return { deps, sent, notifications, scheduler, isOnline, probe, refreshTray, powerMonitor, net };
}

/** Deja correr las microtareas sin mover el reloj (resuelve las comprobaciones). */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const changedEvents = (sent: Sent[]): ConnectivityState[] =>
  sent
    .filter((s) => s.channel === IPC_CHANNELS.connectivity.changed)
    .map((s) => s.payload as ConnectivityState);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('vigilancia de conexión', () => {
  it('en línea comprueba los dos endpoints cada 30 s', async () => {
    const { deps, probe } = makeDeps();
    const service = createConnectivityService(deps);
    service.start();
    await flush();

    // Una comprobación inicial lanza una petición por endpoint.
    expect(probe).toHaveBeenCalledTimes(2);
    expect(service.getState()).toMatchObject({ status: 'online', attempt: 0, nextRetryAt: null });

    await vi.advanceTimersByTimeAsync(ONLINE_INTERVAL_MS);
    expect(probe).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(ONLINE_INTERVAL_MS - 1);
    expect(probe).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(probe).toHaveBeenCalledTimes(6);
    service.stop();
  });

  it('hay conexión si responde al menos un endpoint', async () => {
    const { deps, net } = makeDeps();
    net.answers.set('https://a.example/ping', false);
    const service = createConnectivityService(deps);
    service.start();
    await flush();

    expect(service.getState().status).toBe('online');
    service.stop();
  });

  it('net.isOnline falso da sin conexión sin lanzar peticiones', async () => {
    const { deps, net, probe, scheduler, notifications, sent, refreshTray } = makeDeps();
    net.online = false;
    const service = createConnectivityService(deps);
    service.start();
    await flush();

    expect(probe).not.toHaveBeenCalled();
    expect(service.getState()).toMatchObject({ status: 'offline', attempt: 1 });

    // Transición a sin conexión: pausa de decisiones, aviso 'alerta',
    // evento connectivity:changed y repintado de la bandeja.
    expect(scheduler.pauseDecisions).toHaveBeenCalledWith('sin-conexion');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ level: 'alerta' });
    expect(refreshTray).toHaveBeenCalled();
    const events = changedEvents(sent);
    expect(events.at(-1)?.status).toBe('offline');
    // El estado 'checking' también se anuncia antes del resultado.
    expect(events.map((e) => e.status)).toEqual(['checking', 'offline']);
    service.stop();
  });

  it('sin conexión reintenta con espera exponencial 2 s, 4 s, 8 s… hasta 5 min', async () => {
    const { deps, net } = makeDeps();
    net.online = false;
    const service = createConnectivityService(deps);
    service.start();
    await flush();

    const expectedDelays = [
      2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
    ];
    let previous = Date.now();
    for (let i = 0; i < expectedDelays.length; i += 1) {
      const state = service.getState();
      expect(state.status).toBe('offline');
      expect(state.attempt).toBe(i + 1);
      expect(state.nextRetryAt).not.toBeNull();
      const retryIn = new Date(state.nextRetryAt!).getTime() - previous;
      expect(retryIn).toBe(expectedDelays[i]);
      await vi.advanceTimersByTimeAsync(expectedDelays[i]!);
      previous = Date.now();
    }
    expect(service.getState().attempt).toBe(expectedDelays.length + 1);
    service.stop();
  });

  it('los eventos resume y unlock-screen comprueban al instante', async () => {
    const { deps, net, probe, powerMonitor } = makeDeps();
    net.online = false;
    const service = createConnectivityService(deps);
    service.start();
    await flush();
    expect(probe).toHaveBeenCalledTimes(0);
    net.online = true;

    powerMonitor.emit('resume');
    await flush();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(service.getState().status).toBe('online');

    powerMonitor.emit('unlock-screen');
    await flush();
    expect(probe).toHaveBeenCalledTimes(4);
    service.stop();
  });

  it('no notifica dos veces la misma transición', async () => {
    const { deps, net, notifications } = makeDeps();
    net.online = false;
    const service = createConnectivityService(deps);
    service.start();
    await flush();
    expect(notifications).toHaveLength(1);

    // Varios reintentos fallidos seguidos: sigue habiendo un solo 'alerta'.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.level).toBe('alerta');

    // Vuelve la conexión: un solo 'info' por la transición de vuelta.
    net.online = true;
    await vi.advanceTimersByTimeAsync(16_000);
    expect(notifications).toHaveLength(2);
    expect(notifications[1]!.level).toBe('info');

    // Comprobaciones en línea no repiten el aviso.
    await vi.advanceTimersByTimeAsync(ONLINE_INTERVAL_MS);
    expect(notifications).toHaveLength(2);
    service.stop();
  });

  it('pausa al perder la conexión y reanuda al recuperarla', async () => {
    const { deps, net, scheduler } = makeDeps();
    const service = createConnectivityService(deps);
    service.start();
    await flush();
    expect(scheduler.pauseDecisions).not.toHaveBeenCalled();

    net.online = false;
    await vi.advanceTimersByTimeAsync(ONLINE_INTERVAL_MS);
    expect(scheduler.pauseDecisions).toHaveBeenCalledTimes(1);
    expect(scheduler.resumeDecisions).not.toHaveBeenCalled();

    net.online = true;
    await vi.advanceTimersByTimeAsync(2_000);
    // resumeDecisions no levanta la pausa manual: eso lo garantiza el
    // planificador; connectivity solo levanta la pausa automática.
    expect(scheduler.resumeDecisions).toHaveBeenCalledTimes(1);
    service.stop();
  });

  it('la simulación fuerza sin conexión aunque la red responda', async () => {
    const { deps, probe, notifications } = makeDeps();
    const service = createConnectivityService(deps);
    service.start();
    await flush();
    expect(service.getState().status).toBe('online');
    expect(service.isSimulatedOffline()).toBe(false);

    service.setSimulatedOffline(true);
    await flush();
    expect(service.isSimulatedOffline()).toBe(true);
    expect(service.getState().status).toBe('offline');
    // La simulación corta antes de lanzar peticiones.
    expect(probe).toHaveBeenCalledTimes(2);
    expect(notifications.map((n) => n.level)).toEqual(['alerta']);

    service.setSimulatedOffline(false);
    await flush();
    expect(service.getState().status).toBe('online');
    expect(notifications.map((n) => n.level)).toEqual(['alerta', 'info']);
    service.stop();
  });

  it('la simulación inicial deja la app sin conexión al arrancar', async () => {
    const { deps } = makeDeps({ simulateOfflineInitially: true });
    const service = createConnectivityService(deps);
    service.start();
    await flush();

    expect(service.isSimulatedOffline()).toBe(true);
    expect(service.getState().status).toBe('offline');
    service.stop();
  });

  it('checkNow concurrente comparte la misma comprobación', async () => {
    const { deps, probe } = makeDeps();
    const service = createConnectivityService(deps);
    service.start();
    await flush();

    const [a, b] = await Promise.all([service.checkNow(), service.checkNow()]);
    expect(a).toEqual(b);
    // Una sola ronda de peticiones aunque hubo dos llamadas.
    expect(probe).toHaveBeenCalledTimes(4);
    service.stop();
  });

  it('stop detiene reintentos y desuscribe los eventos del SO', async () => {
    const { deps, net, probe, powerMonitor } = makeDeps();
    net.online = false;
    const service = createConnectivityService(deps);
    service.start();
    await flush();

    service.stop();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(probe).toHaveBeenCalledTimes(0);
    expect(powerMonitor.listenerCount('resume')).toBe(0);
    expect(powerMonitor.listenerCount('unlock-screen')).toBe(0);
    powerMonitor.emit('resume');
    await flush();
    expect(probe).toHaveBeenCalledTimes(0);
  });
});

describe('backoffDelayMs', () => {
  const fixed = () => 0.5;

  it('da la secuencia 2 s, 4 s, 8 s… con el tope de 5 min', () => {
    const expected = [
      2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
    ];
    for (let i = 0; i < expected.length; i += 1) {
      expect(backoffDelayMs(i + 1, 2_000, 300_000, fixed)).toBe(expected[i]);
    }
  });

  it('aplica una fluctuación del ±25 %', () => {
    expect(backoffDelayMs(1, 2_000, 300_000, () => 0)).toBe(1_500);
    expect(backoffDelayMs(1, 2_000, 300_000, () => 0.999)).toBeLessThanOrEqual(2_500);
    const jittered = backoffDelayMs(4, 2_000, 300_000, () => 0.25);
    expect(jittered).toBeGreaterThan(12_000);
    expect(jittered).toBeLessThan(16_000);
  });
});

describe('resolveEndpoints', () => {
  it('acepta un array JSON de URL http(s)', () => {
    const urls = resolveEndpoints('["https://x.test/a","https://y.test/b"]');
    expect(urls).toEqual(['https://x.test/a', 'https://y.test/b']);
  });

  it('acepta una lista por comas (variable de entorno)', () => {
    const urls = resolveEndpoints(' https://x.test/a , http://y.test/b ');
    expect(urls).toEqual(['https://x.test/a', 'http://y.test/b']);
  });

  it('usa los valores por defecto si no hay al menos dos URL válidas', () => {
    const logger = { warn: vi.fn() };
    expect(resolveEndpoints('no-es-una-url', logger)).toEqual([...DEFAULT_CONNECTIVITY_ENDPOINTS]);
    expect(resolveEndpoints('["https://x.test/a"]', logger)).toEqual([
      ...DEFAULT_CONNECTIVITY_ENDPOINTS,
    ]);
    expect(resolveEndpoints('["ftp://x.test/a","https://y.test/b"]', logger)).toEqual([
      ...DEFAULT_CONNECTIVITY_ENDPOINTS,
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('usa los valores por defecto sin configuración', () => {
    expect(resolveEndpoints(null)).toEqual([...DEFAULT_CONNECTIVITY_ENDPOINTS]);
    expect(resolveEndpoints(undefined)).toEqual([...DEFAULT_CONNECTIVITY_ENDPOINTS]);
  });
});
