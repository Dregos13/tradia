import { describe, expect, it } from 'vitest';

import type { AgentsState, ConnectivityState } from '../../shared/ipc';
import { resolveTrayVisualState } from './tray';

const agents = (patch: Partial<AgentsState>): AgentsState => ({
  paused: false,
  pauseReason: null,
  lastHeartbeatAt: null,
  ...patch,
});

const connectivity = (status: ConnectivityState['status']): ConnectivityState => ({
  status,
  lastCheckedAt: null,
  nextRetryAt: null,
  attempt: 0,
});

describe('estado visual de la bandeja', () => {
  it('la pausa manda sobre el estado de conexión', () => {
    expect(
      resolveTrayVisualState(
        agents({ paused: true, pauseReason: 'usuario' }),
        connectivity('offline'),
      ),
    ).toBe('paused');
    expect(
      resolveTrayVisualState(
        agents({ paused: true, pauseReason: 'sin-conexion' }),
        connectivity('offline'),
      ),
    ).toBe('paused');
  });

  it('sin conexión y sin pausa muestra offline', () => {
    expect(resolveTrayVisualState(agents({}), connectivity('offline'))).toBe('offline');
  });

  it('en línea, comprobando o sin servicios muestra online', () => {
    expect(resolveTrayVisualState(agents({}), connectivity('online'))).toBe('online');
    expect(resolveTrayVisualState(agents({}), connectivity('checking'))).toBe('online');
    expect(resolveTrayVisualState(undefined, undefined)).toBe('online');
  });
});
