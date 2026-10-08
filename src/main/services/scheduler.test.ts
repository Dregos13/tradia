import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '../../shared/ipc';
import { createSchedulerService, HEARTBEAT_INTERVAL_MS, type SchedulerService } from './scheduler';

interface Sent {
  channel: string;
  payload: unknown;
}

let service: SchedulerService;
let sent: Sent[];
let logs: string[];

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  logs = [];
  service = createSchedulerService({
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    logger: { info: (message) => logs.push(message) },
  });
});

afterEach(() => {
  service.stop();
  vi.useRealTimers();
});

const heartbeats = (): Sent[] => sent.filter((s) => s.channel === IPC_CHANNELS.agents.heartbeat);
const changes = (): Sent[] => sent.filter((s) => s.channel === IPC_CHANNELS.agents.changed);

describe('planificador de agentes', () => {
  it('emite un latido cada 30 s, lo registra en el log y lo expone en el estado', () => {
    service.start();

    expect(heartbeats()).toHaveLength(0);
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    expect(heartbeats()).toHaveLength(1);
    const at = heartbeats()[0]?.payload as string;
    expect(new Date(at).toISOString()).toBe(at);
    expect(service.getState().lastHeartbeatAt).toBe(at);
    expect(logs.some((l) => l.includes(at))).toBe(true);

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(heartbeats()).toHaveLength(2);
  });

  it('empieza sin pausa y sin latido previo', () => {
    expect(service.getState()).toEqual({
      paused: false,
      pauseReason: null,
      lastHeartbeatAt: null,
    });
  });

  it('la pausa manual detiene el latido y se anuncia por agents:changed', () => {
    service.start();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);

    const state = service.pause();
    expect(state).toMatchObject({ paused: true, pauseReason: 'usuario' });
    expect(changes()).toHaveLength(1);
    expect(changes()[0]?.payload).toMatchObject({ paused: true, pauseReason: 'usuario' });

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 3);
    expect(heartbeats()).toHaveLength(1);
  });

  it('la reanudación reactiva el latido', () => {
    service.start();
    service.pause();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(heartbeats()).toHaveLength(0);

    const state = service.resume();
    expect(state).toMatchObject({ paused: false, pauseReason: null });

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
    expect(heartbeats()).toHaveLength(1);
  });

  it('pauseDecisions pausa por conexión y resume() no levanta esa pausa', () => {
    service.pauseDecisions('sin-conexion');
    expect(service.getState()).toMatchObject({ paused: true, pauseReason: 'sin-conexion' });

    // Reanudar la pausa manual no pisa la pausa automática por conexión.
    service.resume();
    expect(service.getState()).toMatchObject({ paused: true, pauseReason: 'sin-conexion' });

    service.resumeDecisions();
    expect(service.getState()).toMatchObject({ paused: false, pauseReason: null });
  });

  it('con ambas pausas activas hacen falta las dos reanudaciones', () => {
    service.pause();
    service.pauseDecisions('sin-conexion');

    service.resumeDecisions();
    expect(service.getState()).toMatchObject({ paused: true, pauseReason: 'usuario' });

    service.resume();
    expect(service.getState()).toMatchObject({ paused: false, pauseReason: null });
  });

  it('notifica a los listeners internos y permite desuscribirse', () => {
    const seen: string[] = [];
    const off = service.onChanged((state) => seen.push(state.pauseReason ?? 'activo'));

    service.pause();
    off();
    service.resume();

    expect(seen).toEqual(['usuario']);
  });

  it('stop() detiene el latido', () => {
    service.start();
    service.stop();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS * 2);
    expect(heartbeats()).toHaveLength(0);
  });
});
