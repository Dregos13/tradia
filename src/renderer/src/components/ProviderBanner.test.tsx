// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../adapters/simulated';
import { ProviderBanner, sessionDateLabel } from './ProviderBanner';
import { MarketDataPage } from './MarketDataPage';

let simulation: ReturnType<typeof createSimulatedAdapter>;
const staleTicker = {
  key: 'ticker:AAPL',
  state: 'desactualizado' as const,
  lastOkAt: '2026-10-07T20:00:00Z',
  consecutiveFailures: 1,
  reason: `falta la vela del ${sessionDateLabel('2026-10-08')} (+2 más); último dato: ${sessionDateLabel('2026-10-06')}`,
  updatedAt: '2026-10-08T20:00:00Z',
};
const staleFred = {
  key: 'macro:DGS10',
  state: 'desactualizado' as const,
  lastOkAt: '2026-10-07T20:00:00Z',
  consecutiveFailures: 2,
  reason: `falta la observación esperada; último dato: ${sessionDateLabel('2026-10-06')}`,
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

it('muestra un único aviso «desactualizado desde …» y lo retira al recuperarse', async () => {
  render(<ProviderBanner />);
  act(() => simulation.emitDataStatus(staleTicker));

  const banner = await screen.findByRole('region', { name: 'Estado de los datos' });
  expect(within(banner).getByText(/Datos desactualizados desde el/)).toBeTruthy();
  expect(within(banner).getByText(/falta la vela del 8 oct 2026/, { selector: 'p' })).toBeTruthy();
  expect(
    within(banner).getByText(/no se calculan régimen, predicciones ni señales nuevas/),
  ).toBeTruthy();

  act(() =>
    simulation.emitDataStatus({
      ...staleTicker,
      state: 'fiable',
      reason: null,
      consecutiveFailures: 0,
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Estado de los datos' })).toBeNull(),
  );
});

it('«Actualizar ahora» refresca mercado cuando fallan tickers y macro cuando falla FRED', async () => {
  const marketRefresh = vi.spyOn(simulation.api.market, 'refreshNow');
  const macroRefresh = vi.spyOn(simulation.api.macro, 'refreshNow');
  render(<ProviderBanner />);

  act(() => simulation.emitDataStatus(staleTicker));
  await screen.findByRole('region', { name: 'Estado de los datos' });
  await userEvent.click(screen.getByRole('button', { name: 'Actualizar ahora' }));
  expect(marketRefresh).toHaveBeenCalledTimes(1);
  expect(macroRefresh).not.toHaveBeenCalled();
  expect(screen.getByText(/Actualización solicitada/)).toBeTruthy();

  act(() => simulation.emitDataStatus(staleFred));
  await userEvent.click(screen.getByRole('button', { name: 'Actualizar ahora' }));
  await waitFor(() => expect(macroRefresh).toHaveBeenCalledTimes(1));
});

it('un estado no fiable muestra «Datos no fiables desde …»', async () => {
  render(<ProviderBanner />);
  act(() =>
    simulation.emitDataStatus({
      ...staleTicker,
      state: 'no-fiable',
      consecutiveFailures: 0,
      reason: 'valor anómalo grave en el último lote',
    }),
  );
  const banner = await screen.findByRole('region', { name: 'Estado de los datos' });
  expect(within(banner).getByText(/Datos no fiables desde el/)).toBeTruthy();
  expect(within(banner).getByText(/valor anómalo grave/, { selector: 'p' })).toBeTruthy();
});

it('las tarjetas de Datos siguen marcando su propio estado', async () => {
  render(<MarketDataPage kind="macro" />);
  const card = await screen.findByRole('article', { name: 'Tipo efectivo federal' });
  act(() => {
    simulation.emitDataStatus({
      key: 'macro:DFF',
      state: 'no-fiable',
      lastOkAt: '2026-10-07T20:00:00Z',
      consecutiveFailures: 3,
      reason: 'Proveedor caído',
      updatedAt: '2026-10-08T20:00:00Z',
    });
  });
  expect(within(card).getByText('No fiable')).toBeTruthy();
  expect(card.classList.contains('data-unreliable')).toBe(true);
});

it('explica el rechazo del refresco sin ocultar el aviso', async () => {
  simulation.emitDataStatus(staleTicker);
  vi.spyOn(simulation.api.market, 'refreshNow').mockResolvedValueOnce({
    accepted: false,
    reason: 'en-curso',
  });
  render(<ProviderBanner />);
  const button = await screen.findByRole('button', { name: 'Actualizar ahora' });
  await userEvent.click(button);
  expect(screen.getByText('Actualización ya en curso.')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Estado de los datos' })).toBeTruthy();
});

it('limpia la suscripción al desmontar', async () => {
  const { unmount } = render(<ProviderBanner />);
  await waitFor(() => expect(simulation.listenerCount()).toBe(1));
  unmount();
  expect(simulation.listenerCount()).toBe(0);
});

it('la franja nombra solo el activo sin cobertura y desaparece al recibir el resumen nuevo', async () => {
  const summary = {
    state: 'current' as const,
    sinceDate: null,
    expectedSessionDate: '2026-10-09',
    missingSessions: 0,
    items: [],
    uncovered: [{ ticker: 'EUR', reason: 'Sin cobertura', suggestion: 'FXE' }],
    updatedAt: staleTicker.updatedAt,
  };
  const freshness = vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue(summary);
  const remove = vi.spyOn(simulation.api.watchlist, 'remove').mockResolvedValue([]);
  render(<ProviderBanner />);
  const banner = await screen.findByRole('region', { name: 'Estado de los datos' });
  expect(
    within(banner).getByRole('heading', { name: 'EUR no está disponible en Tiingo' }),
  ).toBeVisible();
  expect(within(banner).getByRole('button', { name: 'Cambiar por FXE para EUR' })).toBeEnabled();
  expect(banner).not.toHaveTextContent('Régimen, predicciones y señales en pausa');
  await userEvent.click(within(banner).getByRole('button', { name: 'Quitar EUR de la lista' }));
  expect(remove).toHaveBeenCalledExactlyOnceWith('EUR');
  expect(screen.getByRole('region', { name: 'Estado de los datos' })).toBeVisible();
  freshness.mockResolvedValue({ ...summary, uncovered: [] });
  act(() => simulation.emitDataStatus({ ...staleTicker, state: 'fiable' }));
  await waitFor(() =>
    expect(screen.queryByRole('region', { name: 'Estado de los datos' })).not.toBeInTheDocument(),
  );
});

it('al recuperarse el resto mantiene EUR visible sin anunciar éxito completo', async () => {
  const summary = {
    state: 'stale' as const,
    sinceDate: '2026-10-06',
    expectedSessionDate: '2026-10-09',
    missingSessions: 3,
    items: [
      {
        key: 'ticker:AAPL',
        label: 'AAPL',
        state: 'desactualizado' as const,
        lastDataDate: '2026-10-06',
        reason: 'Faltan cierres.',
      },
    ],
    uncovered: [{ ticker: 'EUR', reason: 'Sin cobertura', suggestion: 'FXE' }],
    updatedAt: staleTicker.updatedAt,
  };
  const freshness = vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue(summary);
  render(<ProviderBanner />);
  await screen.findByText(/no se calculan régimen, predicciones ni señales nuevas/);
  freshness.mockResolvedValue({ ...summary, state: 'current', items: [], sinceDate: null });
  act(() => simulation.emitDataStatus({ ...staleTicker, state: 'fiable' }));
  expect(await screen.findByText(/Solo EUR queda en pausa/)).toBeVisible();
  expect(screen.queryByText('Datos al día.')).not.toBeInTheDocument();
  expect(screen.queryByText('Datos actualizados.')).not.toBeInTheDocument();
});

it('formatea la fecha de sesión en corto español', () => {
  expect(sessionDateLabel('2026-10-06')).toContain('oct');
  expect(sessionDateLabel(null)).toBe('sin datos');
  expect(sessionDateLabel('no-es-fecha')).toBe('no-es-fecha');
});
