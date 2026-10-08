// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../adapters/simulated';
import { ProviderBanner, lastCorrectDate } from './ProviderBanner';
import { MarketDataPage } from './MarketDataPage';

let simulation: ReturnType<typeof createSimulatedAdapter>;
const failure = {
  key: 'provider:simulated',
  state: 'no-fiable' as const,
  lastOkAt: '2026-10-07T20:00:00Z',
  consecutiveFailures: 3,
  reason: 'Proveedor caído',
  updatedAt: '2026-10-08T20:00:00Z',
};
beforeEach(() => {
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  vi.spyOn(simulation.api.secrets, 'hasKey').mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('muestra banner y tarjeta no fiable al emitir cambios y los recupera', async () => {
  const refresh = vi.spyOn(simulation.api.market, 'refreshNow');
  render(
    <>
      <ProviderBanner />
      <MarketDataPage kind="macro" />
    </>,
  );
  const card = await screen.findByRole('article', { name: 'Tipo efectivo federal' });
  act(() => {
    simulation.emitDataStatus(failure);
    simulation.emitDataStatus({ ...failure, key: 'macro:DFF' });
  });
  const banner = await screen.findByRole('alert', { name: 'Estado de Proveedor simulado' });
  expect(within(banner).getByText('Proveedor caído')).toBeTruthy();
  expect(within(banner).getByText(/Último dato correcto/).textContent).toContain('22:00 (Madrid)');
  expect(within(card).getByText('No fiable')).toBeTruthy();
  expect(card.classList.contains('data-unreliable')).toBe(true);
  expect(within(card).getByText(/Datos simulados/)).toBeTruthy();
  await userEvent.click(within(banner).getByRole('button', { name: 'Reintentar' }));
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(screen.getByText(/Actualización solicitada/)).toBeTruthy();
  expect(screen.getByRole('alert', { name: 'Estado de Proveedor simulado' })).toBeTruthy();
  act(() => {
    simulation.emitDataStatus({
      ...failure,
      state: 'fiable',
      reason: null,
      consecutiveFailures: 0,
    });
    simulation.emitDataStatus({
      ...failure,
      key: 'macro:DFF',
      state: 'fiable',
      reason: null,
      consecutiveFailures: 0,
    });
  });
  await waitFor(() =>
    expect(screen.queryByRole('alert', { name: 'Estado de Proveedor simulado' })).toBeNull(),
  );
  expect(within(card).getByText('Fiable')).toBeTruthy();
  expect(card.classList.contains('data-unreliable')).toBe(false);
});
it('lee fallos iniciales, conserva otros proveedores y limpia la suscripción', async () => {
  simulation.emitDataStatus(failure);
  simulation.emitDataStatus({
    ...failure,
    key: 'provider:fred',
    state: 'desactualizado',
    lastOkAt: null,
  });
  const { unmount } = render(<ProviderBanner />);
  await screen.findByRole('alert', { name: 'Estado de FRED' });
  expect(screen.getByText(/No hay un dato correcto registrado/)).toBeTruthy();
  act(() => simulation.emitDataStatus({ ...failure, state: 'fiable' }));
  await waitFor(() =>
    expect(screen.queryByRole('alert', { name: 'Estado de Proveedor simulado' })).toBeNull(),
  );
  expect(screen.getByRole('alert', { name: 'Estado de FRED' })).toBeTruthy();
  unmount();
  expect(simulation.listenerCount()).toBe(0);
});
it('explica el rechazo y el error de reintento sin ocultar la alerta', async () => {
  simulation.emitDataStatus(failure);
  const refresh = vi
    .spyOn(simulation.api.market, 'refreshNow')
    .mockResolvedValueOnce({ accepted: false, reason: 'en-curso' })
    .mockRejectedValueOnce(new Error('detalle privado'));
  render(<ProviderBanner />);
  const button = await screen.findByRole('button', { name: 'Reintentar' });
  await userEvent.click(button);
  expect(screen.getByText('Ya hay una actualización en curso.')).toBeTruthy();
  await userEvent.click(button);
  expect(screen.getByText(/No pudimos iniciar/)).toBeTruthy();
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('detalle privado')).toBeNull();
});
it('no presenta una fecha inválida como dato correcto', () => {
  expect(lastCorrectDate('fecha inválida')).toBe('No hay un dato correcto registrado.');
});
