// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../adapters/simulated';
import { useSystemState } from '../hooks/useSystemState';
import { OfflineBanner } from './OfflineBanner';
import { StatusBar } from './SystemStatus';

let adapter: ReturnType<typeof createSimulatedAdapter>;
const checked = '2026-10-08T08:00:00.000Z';
const retry = '2026-10-08T08:00:03.000Z';
function Surface() {
  const state = useSystemState();
  return (
    <>
      <OfflineBanner state={state} />
      <StatusBar state={state} />
    </>
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(checked);
  adapter = createSimulatedAdapter();
  window.tradia = adapter.api;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function mount() {
  await act(async () => {
    render(<Surface />);
  });
}
function offline() {
  act(() => {
    adapter.emitConnectivity({
      status: 'offline',
      lastCheckedAt: checked,
      nextRetryAt: retry,
      attempt: 1,
    });
    adapter.emitAgents({ paused: true, pauseReason: 'sin-conexion', lastHeartbeatAt: checked });
  });
}
it('cuenta hacia atrás, conserva el aviso durante la comprobación y se recupera por eventos', async () => {
  await mount();
  offline();
  expect(screen.getByText('Reintentando en 3 s.')).toBeInTheDocument();
  const banner = screen
    .getByText('Sin conexión: las decisiones están en pausa.')
    .closest('[role=status]');
  expect(banner).toHaveAttribute('aria-live', 'polite');
  const bar = within(screen.getByRole('contentinfo'));
  expect(bar.getByText('Agentes en pausa')).toBeInTheDocument();
  expect(bar.getByText('· Sin conexión')).toBeInTheDocument();
  expect(screen.getByRole('contentinfo').querySelectorAll('time')[0]).toHaveAttribute(
    'datetime',
    checked,
  );
  expect(screen.getByRole('contentinfo').querySelectorAll('time')[1]).toHaveAttribute(
    'datetime',
    retry,
  );
  expect(screen.getByText('Reintentando en 3 s.')).toHaveAttribute('aria-live', 'off');
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(screen.getByText('Reintentando en 1 s.')).toBeInTheDocument();
  act(() =>
    adapter.emitConnectivity({
      status: 'checking',
      lastCheckedAt: checked,
      nextRetryAt: null,
      attempt: 1,
    }),
  );
  expect(bar.getByText('Sin conexión')).toBeInTheDocument();
  expect(screen.getByText('Reintentando ahora…')).toBeInTheDocument();
  act(() => {
    adapter.emitConnectivity({
      status: 'online',
      lastCheckedAt: retry,
      nextRetryAt: null,
      attempt: 0,
    });
    adapter.emitAgents({ paused: false, pauseReason: null, lastHeartbeatAt: checked });
    adapter.emitHeartbeat(retry);
  });
  expect(screen.queryByRole('button', { name: 'Comprobar ahora' })).not.toBeInTheDocument();
  expect(bar.getByText('En línea')).toBeInTheDocument();
  expect(bar.getByText('Agentes activos')).toBeInTheDocument();
  cleanup();
  expect(adapter.listenerCount()).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it('permite comprobar ahora, bloquea duplicados y muestra errores recuperables', async () => {
  await mount();
  offline();
  let reject!: (reason: Error) => void;
  const check = vi.spyOn(adapter.api.connectivity, 'checkNow').mockReturnValue(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Comprobar ahora' }));
  expect(screen.getByRole('button', { name: 'Comprobando…' })).toBeDisabled();
  await act(async () => {
    reject(new Error('IPC'));
  });
  expect(
    screen.getByText('No pudimos comprobar la conexión. Vuelve a intentarlo.'),
  ).toBeInTheDocument();
  check.mockResolvedValue({
    status: 'offline',
    lastCheckedAt: checked,
    nextRetryAt: retry,
    attempt: 1,
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Comprobar ahora' }));
  });
  expect(
    screen.queryByText('No pudimos comprobar la conexión. Vuelve a intentarlo.'),
  ).not.toBeInTheDocument();
});
it('mantiene la pausa manual al reconectar y no inventa un banner ante errores IPC', async () => {
  vi.spyOn(adapter.api.connectivity, 'getState').mockRejectedValue(new Error('IPC'));
  await mount();
  expect(screen.getByText('Conexión no disponible')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  offline();
  act(() => {
    adapter.emitConnectivity({
      status: 'online',
      lastCheckedAt: checked,
      nextRetryAt: null,
      attempt: 0,
    });
    adapter.emitAgents({ paused: true, pauseReason: 'usuario', lastHeartbeatAt: null });
  });
  expect(screen.getByText('Agentes en pausa')).toBeInTheDocument();
  expect(screen.getByText('· Pausa manual')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
