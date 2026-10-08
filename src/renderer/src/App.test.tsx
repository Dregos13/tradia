// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { RISK_DISCLAIMER_VERSION } from '../../shared/riskDisclaimer';
import { createSimulatedAdapter } from './adapters/simulated';

let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(async () => {
  window.location.hash = '';
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  await simulation.api.settings.set({ disclaimerAcceptedVersion: RISK_DISCLAIMER_VERSION });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const statusbar = () => within(screen.getByRole('contentinfo', { name: 'Estado del sistema' }));

describe('Estructura de Tradia', () => {
  it('navega entre Inicio y Ajustes con teclado y conserva la barra de estado', async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByRole('link', { name: 'Inicio' })).toHaveAttribute('aria-current', 'page');
    const settings = screen.getByRole('link', { name: 'Ajustes' });
    settings.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Ajustes' })).toHaveFocus();
    expect(settings).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('region', { name: 'Preferencias' })).toBeInTheDocument();
    expect(statusbar().getByText('Comprobando conexión')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Inicio' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Estado del sistema' }),
    ).toBeInTheDocument();
  });

  it('muestra carga sin atribuir conexión o actividad antes de recibir datos', async () => {
    vi.spyOn(simulation.api.connectivity, 'getState').mockReturnValue(new Promise(() => {}));
    vi.spyOn(simulation.api.agents, 'getState').mockReturnValue(new Promise(() => {}));
    await act(async () => {
      render(<App />);
    });
    expect(statusbar().getByText('Cargando conexión…')).toBeInTheDocument();
    expect(statusbar().getByText('Cargando agentes…')).toBeInTheDocument();
    expect(statusbar().queryByText('En línea')).not.toBeInTheDocument();
    expect(statusbar().getAllByText('Pendiente')).toHaveLength(2);
  });

  it('actualiza conexión, pausa y latido mediante eventos del adaptador', async () => {
    await act(async () => {
      render(<App />);
    });
    await statusbar().findByText('Comprobando conexión');
    act(() => {
      simulation.emitConnectivity({
        status: 'offline',
        attempt: 1,
        lastCheckedAt: null,
        nextRetryAt: null,
      });
      simulation.emitAgents({ paused: true, pauseReason: 'sin-conexion', lastHeartbeatAt: null });
      simulation.emitHeartbeat('2026-10-08T08:42:00Z');
    });
    expect(statusbar().getByText('Sin conexión')).toBeInTheDocument();
    expect(statusbar().getByText('Agentes en pausa')).toBeInTheDocument();
    expect(
      statusbar().getByText(
        new Date('2026-10-08T08:42:00Z').toLocaleTimeString('es-ES', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      ),
    ).toHaveAttribute('datetime', '2026-10-08T08:42:00Z');
    act(() => {
      simulation.emitConnectivity({
        status: 'online',
        attempt: 0,
        lastCheckedAt: null,
        nextRetryAt: null,
      });
      simulation.emitAgents({
        paused: false,
        pauseReason: null,
        lastHeartbeatAt: '2026-10-08T08:42:00Z',
      });
    });
    expect(statusbar().getByText('En línea')).toBeInTheDocument();
    expect(statusbar().getByText('Agentes activos')).toBeInTheDocument();
  });

  it('muestra fallos de consulta y se recupera con eventos posteriores', async () => {
    vi.spyOn(simulation.api.connectivity, 'getState').mockRejectedValue(new Error('IPC'));
    vi.spyOn(simulation.api.agents, 'getState').mockRejectedValue(new Error('IPC'));
    await act(async () => {
      render(<App />);
    });
    expect(await statusbar().findByText('Conexión no disponible')).toBeInTheDocument();
    expect(await statusbar().findByText('Agentes no disponibles')).toBeInTheDocument();
    act(() =>
      simulation.emitConnectivity({
        status: 'online',
        attempt: 0,
        lastCheckedAt: null,
        nextRetryAt: null,
      }),
    );
    expect(statusbar().getByText('En línea')).toBeInTheDocument();
  });

  it('no permite que una consulta antigua sobrescriba eventos recientes y limpia suscripciones', async () => {
    let resolveConnection!: (
      state: Awaited<ReturnType<typeof simulation.api.connectivity.getState>>,
    ) => void;
    vi.spyOn(simulation.api.connectivity, 'getState').mockReturnValue(
      new Promise((resolve) => {
        resolveConnection = resolve;
      }),
    );
    const { unmount } = render(<App />);
    await act(async () => {});
    act(() =>
      simulation.emitConnectivity({
        status: 'offline',
        attempt: 1,
        lastCheckedAt: null,
        nextRetryAt: null,
      }),
    );
    await act(async () =>
      resolveConnection({ status: 'online', attempt: 0, lastCheckedAt: null, nextRetryAt: null }),
    );
    expect(statusbar().getByText('Sin conexión')).toBeInTheDocument();
    expect(simulation.listenerCount()).toBe(4);
    unmount();
    expect(simulation.listenerCount()).toBe(0);
  });
});

it('navega a Mercado y Macro con teclado y muestra el vacío sin claves', async () => {
  const user = userEvent.setup();
  await act(async () => {
    render(<App />);
  });
  for (const [name, heading] of [
    ['Mercado', 'Mercado'],
    ['Macro', 'Contexto macro'],
  ]) {
    const link = screen.getByRole('link', { name });
    link.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toHaveFocus();
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByText('Conecta tus fuentes de datos.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configurar claves' })).toHaveAttribute(
      'href',
      '#ajustes',
    );
  }
  await user.click(screen.getByRole('link', { name: 'Configurar claves' }));
  expect(await screen.findByRole('region', { name: 'Proveedores de datos' })).toBeInTheDocument();
});

it('prioriza configurar fuentes sin clave aunque fallen las consultas de datos', async () => {
  vi.spyOn(simulation.api.dataStatus, 'get').mockRejectedValue(new Error('IPC'));
  window.location.hash = '#mercado';
  await act(async () => {
    render(<App />);
  });
  expect(await screen.findByText('Conecta tus fuentes de datos.')).toBeInTheDocument();
});
