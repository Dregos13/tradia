// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CalendarPage } from './CalendarPage';
import { createSimulatedAdapter } from '../../adapters/simulated';
import type { CalendarEvent } from '../../../../shared/ipc';

let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T10:00:00Z'));
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
async function mount() {
  await act(async () => {
    render(<CalendarPage />);
  });
}
function fixtures(): CalendarEvent[] {
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  return [
    {
      id: 1,
      kind: 'otro',
      title: 'Dato publicado',
      dateUtc: new Date(Date.now() - 60000).toISOString(),
      impact: 'bajo',
      country: 'US',
      asset: null,
      origin: 'oficial',
    },
    {
      id: 2,
      kind: 'otro',
      title: 'Evento próximo',
      dateUtc: new Date(Date.now() + 60000).toISOString(),
      impact: 'alto',
      country: 'US',
      asset: null,
      origin: 'oficial',
    },
    {
      id: 3,
      kind: 'resultados',
      title: 'Resultados de AAPL',
      dateUtc: today.toISOString(),
      impact: 'medio',
      country: 'US',
      asset: 'AAPL',
      origin: 'finnhub',
    },
  ];
}
it('muestra impacto, hora local, resultados, pasado y próximo con el adaptador simulado', async () => {
  await mount();
  expect(screen.getAllByTestId('calendar-event').length).toBeGreaterThan(0);
  expect(screen.getAllByTestId('event-impact-high').length).toBeGreaterThan(0);
  expect(screen.getByText(/Hora local:/)).toBeInTheDocument();
  expect(screen.getByTestId('earnings-event')).toHaveTextContent('AAPL');
  expect(screen.getByRole('link', { name: 'Ajustes' })).toHaveAttribute('href', '#ajustes');
});
it('filtra los tres impactos y resultados y marca pasado y próximo', async () => {
  vi.spyOn(simulation.api.calendar, 'list').mockResolvedValue(fixtures());
  await mount();
  expect(screen.getByText('Dato publicado').closest('article')).toHaveClass('calendar-past');
  expect(screen.getByTestId('event-upcoming')).toHaveTextContent('Próximo');
  const filter = screen.getByLabelText('Filtrar por impacto');
  for (const [value, title] of [
    ['alto', 'Evento próximo'],
    ['medio', 'Resultados de AAPL'],
    ['bajo', 'Dato publicado'],
    ['resultados', 'Resultados de AAPL'],
  ] as const) {
    await userEvent.selectOptions(filter, value);
    expect(screen.getAllByTestId('calendar-event')).toHaveLength(1);
    expect(screen.getByText(title)).toBeInTheDocument();
  }
});
it('navega semanas, vuelve a la actual y oculta el aviso cuando hay clave', async () => {
  vi.spyOn(simulation.api.secrets, 'hasKey').mockResolvedValue(true);
  const list = vi.spyOn(simulation.api.calendar, 'list');
  await mount();
  const initial = list.mock.calls[0]![0];
  expect(screen.queryByRole('link', { name: 'Ajustes' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Semana siguiente ›' }));
  expect(
    await screen.findByText('No hay eventos programados para esta semana.'),
  ).toBeInTheDocument();
  expect(list.mock.lastCall?.[0].desde).not.toEqual(initial.desde);
  await userEvent.click(screen.getByRole('button', { name: 'Esta semana' }));
  expect(list.mock.lastCall?.[0]).toEqual(initial);
  await userEvent.click(screen.getByRole('button', { name: '‹ Semana anterior' }));
  expect(list.mock.lastCall?.[0].desde).not.toEqual(initial.desde);
});
it('muestra carga, error y permite reintentar', async () => {
  const list = vi.spyOn(simulation.api.calendar, 'list').mockRejectedValueOnce(new Error('IPC'));
  await mount();
  expect(screen.getByRole('alert')).toHaveTextContent('No pudimos consultar');
  list.mockResolvedValue(fixtures());
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
  expect(await screen.findByText('Evento próximo')).toBeInTheDocument();
});
it('muestra carga sin datos inventados y limpia la suscripción al salir', async () => {
  vi.spyOn(simulation.api.calendar, 'list').mockImplementation(() => new Promise(() => {}));
  const view = render(<CalendarPage />);
  expect(
    within(screen.getByRole('region', { name: 'Calendario económico' })).getByText(
      'Cargando calendario económico…',
    ),
  ).toBeInTheDocument();
  expect(screen.queryByTestId('calendar-event')).not.toBeInTheDocument();
  view.unmount();
  expect(simulation.listenerCount()).toBe(0);
});
