// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { MarketDataPage } from '../MarketDataPage';
import { MacroPanel } from './MacroPanel';
import { displayObservations, formatDate, indicators } from './model';
import type { MacroSeriesSnapshot } from '../../../../shared/ipc';
let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(() => {
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  vi.spyOn(simulation.api.secrets, 'hasKey').mockResolvedValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('muestra las seis series en E2E sin una clave FRED guardada', async () => {
  vi.mocked(simulation.api.secrets.hasKey).mockResolvedValue(false);
  window.tradia = {
    ...simulation.api,
    testing: {
      simulateOffline: vi.fn(),
      getContextIsolation: vi.fn(),
      advanceMarketClock: vi.fn(),
      simulateProviderFailure: vi.fn(),
      pollNewsNow: vi.fn(),
      advanceNewsClock: vi.fn(),
      risk: {
        simulateCause: vi.fn(),
        simulateCalendarEvent: vi.fn(),
        seedPortfolio: vi.fn(),
      },
    },
  };
  render(<MarketDataPage kind="macro" />);
  const panel = await screen.findByRole('region', { name: 'Indicadores macroeconómicos' });
  expect(within(panel).getAllByRole('article')).toHaveLength(6);
  expect(screen.queryByText('Conecta tus fuentes de datos.')).toBeNull();
  expect(simulation.api.secrets.hasKey).toHaveBeenCalledWith('fred');
});
it('exige la clave FRED fuera de E2E aunque haya series almacenadas', async () => {
  vi.mocked(simulation.api.secrets.hasKey).mockResolvedValue(false);
  window.tradia = { ...simulation.api, testing: undefined };
  render(<MarketDataPage kind="macro" />);
  expect(await screen.findByText('Conecta tus fuentes de datos.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Configurar claves' })).toBeTruthy();
  expect(screen.queryAllByRole('article')).toHaveLength(0);
});
it('muestra los seis indicadores simulados con fecha, estado y curva invertida', async () => {
  render(<MarketDataPage kind="macro" />);
  const panel = await screen.findByRole('region', { name: 'Indicadores macroeconómicos' });
  const series = await simulation.api.macro.getSeries();
  for (const indicator of indicators) {
    const card = within(panel).getByRole('article', { name: indicator.name });
    expect(within(card).getByText(indicator.id)).toBeTruthy();
    expect(
      within(card).getByText(
        formatDate(series.find((s) => s.id === indicator.id)!.observations.at(-1)!.date),
      ),
    ).toBeTruthy();
    expect(within(card).getByText('Fiable')).toBeTruthy();
    expect(within(card).getByRole('img')).toBeTruthy();
  }
  expect(screen.getByText(/Curva invertida/)).toBeTruthy();
  expect(screen.getByText(/Banda baja/)).toBeTruthy();
  expect(screen.getByText('2,60 %')).toBeTruthy();
});
it('reconcilia el estado de una serie recibido en segundo plano', async () => {
  render(<MarketDataPage kind="macro" />);
  await screen.findByRole('region', { name: 'Indicadores macroeconómicos' });
  act(() =>
    simulation.emitDataStatus({
      key: 'macro:DFF',
      state: 'no-fiable',
      lastOkAt: null,
      consecutiveFailures: 1,
      reason: 'Proveedor caído',
      updatedAt: new Date().toISOString(),
    }),
  );
  await waitFor(() => expect(screen.getByText('No fiable')).toBeTruthy());
  expect(screen.getByText('Proveedor caído')).toBeTruthy();
});
it('mantiene seis tarjetas vacías sin inventar valores ni fechas', () => {
  render(<MacroPanel series={[]} />);
  expect(screen.getAllByRole('article')).toHaveLength(6);
  expect(screen.getAllByText('Sin dato')).toHaveLength(6);
  expect(screen.getAllByText('Sin fecha de observación')).toHaveLength(6);
  expect(screen.queryByText(/Curva invertida/)).toBeNull();
});
it.each([
  [19.99, 'baja'],
  [20, 'media'],
  [29.99, 'media'],
  [30, 'alta'],
])('clasifica VIX %s en banda %s', async (value, band) => {
  const series = await simulation.api.macro.getSeries();
  const vix = series.find((s) => s.id === 'VIXCLS')!;
  render(<MacroPanel series={[{ ...vix, observations: [{ date: '2026-10-07', value }] }]} />);
  expect(screen.getByText(`Banda ${band}`)).toBeTruthy();
});
it('calcula IPC interanual por mes y omite meses sin base anual', () => {
  const series: MacroSeriesSnapshot = {
    id: 'CPIAUCSL',
    name: 'IPC',
    unit: '%',
    frequency: 'monthly',
    status: null,
    observations: [
      { date: '2024-09-01', value: 100 },
      { date: '2025-08-01', value: 110 },
      { date: '2025-09-01', value: 103 },
    ],
  };
  expect(displayObservations(series)).toEqual([
    { date: '2025-09-01', value: expect.closeTo(3, 8) },
  ]);
});
it('muestra el error de consulta y permite reintentar', async () => {
  vi.spyOn(simulation.api.macro, 'getSeries').mockRejectedValueOnce(new Error('privado'));
  render(<MarketDataPage kind="macro" />);
  expect(await screen.findByRole('alert')).toBeTruthy();
  act(() => screen.getByRole('button', { name: 'Reintentar' }).click());
  expect(await screen.findByRole('region', { name: 'Indicadores macroeconómicos' })).toBeTruthy();
});
