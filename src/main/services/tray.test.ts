import { describe, expect, it } from 'vitest';

import type { AgentsState, ConnectivityState, KillSwitchState } from '../../shared/ipc';
import { killSwitchTrayLabel, resolveTrayVisualState, TOOLTIPS } from './tray';

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

const killSwitch = (patch: Partial<KillSwitchState>): KillSwitchState => ({
  active: false,
  cause: null,
  actor: null,
  activatedAt: null,
  detail: null,
  ...patch,
});

describe('estado visual de la bandeja', () => {
  it('la parada de emergencia manda sobre la pausa y la conexión', () => {
    const stopped = killSwitch({ active: true, cause: 'manual', actor: 'usuario' });
    expect(
      resolveTrayVisualState(
        agents({ paused: true, pauseReason: 'usuario' }),
        connectivity('offline'),
        stopped,
      ),
    ).toBe('stopped');
    expect(resolveTrayVisualState(agents({}), connectivity('online'), stopped)).toBe('stopped');
  });

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
        killSwitch({}),
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

  it('el tooltip de la parada es el fijado por la guía de diseño', () => {
    expect(TOOLTIPS.stopped).toBe('Tradia — Parada activa');
  });
});

describe('elemento de la parada en el menú de la bandeja', () => {
  it('en estado normal ofrece «Parada de emergencia»', () => {
    expect(killSwitchTrayLabel(killSwitch({}))).toBe('Parada de emergencia');
    expect(killSwitchTrayLabel(undefined)).toBe('Parada de emergencia');
  });

  it('con la parada activa ofrece «Reanudar (requiere confirmar)»', () => {
    expect(killSwitchTrayLabel(killSwitch({ active: true }))).toBe('Reanudar (requiere confirmar)');
  });
});
