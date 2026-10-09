// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { JournalEntry, JournalUpdatedEvent } from '../../../../shared/journal';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { JournalPage } from './JournalPage';
const entry: JournalEntry = {
  id: 1,
  type: 'senal',
  createdAt: '2026-10-09T14:00:00Z',
  ticker: 'AAPL',
  strategies: [{ strategyId: 1, name: 'Tendencia', version: 3 }],
  reason: 'Cierre sobre la media',
  dataUsed: { barCount: 250, source: 'simulated' },
  result: 'aprobada',
  errors: [],
  ruleChecks: [
    { code: 'STOP', label: 'Stop obligatorio', cumplida: true, observed: '219', limit: '220' },
  ],
  signalId: 1,
};
beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
  vi.spyOn(window.tradia.journal, 'list').mockResolvedValue({
    entries: [entry],
    limit: 20,
    offset: 0,
    total: 21,
  });
  vi.spyOn(window.tradia.journal, 'get').mockResolvedValue(entry);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('combina filtros, valida fechas y exporta el conjunto sin paginación', async () => {
  const user = userEvent.setup();
  await window.tradia.strategies.create({
    name: 'Tendencia',
    hypothesis: 'Persistencia',
    rules: { entry: 'Cruce', exit: 'Cruce inverso', stop: '5 %', target: '10 %' },
    markets: ['AAPL'],
    parameters: {},
    regime: 'Tendencial',
  });
  const list = vi.mocked(window.tradia.journal.list);
  const exportCsv = vi
    .spyOn(window.tradia.journal, 'exportCsv')
    .mockResolvedValue({ canceled: false, path: '/tmp/diario.csv', entries: 21 });
  render(<JournalPage />);
  await screen.findByText(entry.reason);
  await user.type(screen.getByLabelText('Desde'), '2026-10-01');
  await user.type(screen.getByLabelText('Hasta'), '2026-10-09');
  await user.selectOptions(screen.getByLabelText('Tipo'), 'senal');
  await user.type(screen.getByLabelText('Activo'), 'aapl');
  await user.selectOptions(screen.getByLabelText('Resultado'), 'aprobada');
  await user.selectOptions(screen.getByLabelText('Estrategia'), '1');
  await user.click(screen.getByRole('button', { name: 'Aplicar' }));
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith({
      desde: '2026-10-01',
      hasta: '2026-10-09',
      type: 'senal',
      ticker: 'AAPL',
      result: 'aprobada',
      strategyId: 1,
      limit: 20,
      offset: 0,
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Siguiente' }));
  await waitFor(() =>
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 20 })),
  );
  await user.click(screen.getByRole('button', { name: 'Exportar CSV · 21 entradas' }));
  expect(exportCsv).toHaveBeenCalledWith({
    query: {
      desde: '2026-10-01',
      hasta: '2026-10-09',
      type: 'senal',
      ticker: 'AAPL',
      result: 'aprobada',
      strategyId: 1,
    },
  });
  expect(await screen.findByText('CSV guardado en /tmp/diario.csv')).toBeVisible();
  await user.clear(screen.getByLabelText('Desde'));
  await user.type(screen.getByLabelText('Desde'), '2026-10-10');
  const count = list.mock.calls.length;
  await user.click(screen.getByRole('button', { name: 'Aplicar' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Desde debe ser anterior');
  expect(list).toHaveBeenCalledTimes(count);
});
it('abre detalle por teclado, contiene foco y lo devuelve al cerrar', async () => {
  const user = userEvent.setup();
  render(<JournalPage />);
  const trigger = await screen.findByRole('button', { name: /Ver detalle de Señal de AAPL/ });
  trigger.focus();
  await user.keyboard('{Enter}');
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('heading', { level: 2 })).toHaveFocus();
  expect(await within(dialog).findByText('250')).toBeVisible();
  for (const name of ['Motivo', 'Datos usados', 'Resultado', 'Errores', 'Cumplimiento de reglas'])
    expect(within(dialog).getByRole('heading', { name })).toBeVisible();
  expect(within(dialog).getByText('✓ Cumplida · Stop obligatorio')).toBeVisible();
  await user.tab({ shift: true });
  expect(within(dialog).getByText('Ver datos técnicos JSON')).toHaveFocus();
  await user.tab();
  expect(within(dialog).getByRole('button', { name: 'Cerrar detalle' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
it('distingue vacío inicial y filtrado y permite limpiar', async () => {
  vi.mocked(window.tradia.journal.list).mockResolvedValue({
    entries: [],
    limit: 20,
    offset: 0,
    total: 0,
  });
  const user = userEvent.setup();
  render(<JournalPage />);
  expect(await screen.findByText('El diario todavía está vacío')).toBeVisible();
  await user.type(screen.getByLabelText('Activo'), 'SPY');
  await user.click(screen.getByRole('button', { name: 'Aplicar' }));
  expect(await screen.findByText('No hay entradas con estos filtros')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Limpiar filtros' }));
  expect(await screen.findByText('El diario todavía está vacío')).toBeVisible();
  expect(screen.getByLabelText('Activo')).toHaveValue('');
});
it('muestra error de exportación y trata la cancelación silenciosamente', async () => {
  const exportCsv = vi
    .spyOn(window.tradia.journal, 'exportCsv')
    .mockRejectedValue(new Error('disk'));
  const user = userEvent.setup();
  render(<JournalPage />);
  await screen.findByText(entry.reason);
  await user.click(screen.getByRole('button', { name: 'Exportar CSV · 21 entradas' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'No se pudo exportar el CSV. No se creó ningún archivo.',
  );
  exportCsv.mockResolvedValue({ canceled: true, path: null, entries: 0 });
  await user.click(screen.getByRole('button', { name: 'Exportar CSV · 21 entradas' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});
it('refresca en vivo sin mover foco y libera la suscripción', async () => {
  let listener: ((event: JournalUpdatedEvent) => void) | undefined;
  const off = vi.fn();
  vi.spyOn(window.tradia.journal, 'onUpdated').mockImplementation((callback) => {
    listener = callback;
    return off;
  });
  const view = render(<JournalPage />);
  await screen.findByText(entry.reason);
  screen.getByLabelText('Activo').focus();
  vi.mocked(window.tradia.journal.list).mockResolvedValue({
    entries: [{ ...entry, id: 2, reason: 'Nueva entrada' }],
    limit: 20,
    offset: 0,
    total: 22,
  });
  act(() => listener?.({ entry }));
  expect(await screen.findByText('Nueva entrada')).toBeVisible();
  expect(screen.getByLabelText('Activo')).toHaveFocus();
  view.unmount();
  expect(off).toHaveBeenCalledOnce();
});
it('permite reintentar los errores de lista y detalle', async () => {
  vi.mocked(window.tradia.journal.list).mockRejectedValueOnce(new Error('offline'));
  const user = userEvent.setup();
  render(<JournalPage />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar el diario');
  await user.click(screen.getByRole('button', { name: 'Reintentar' }));
  await screen.findByText(entry.reason);
  vi.mocked(window.tradia.journal.get).mockRejectedValueOnce(new Error('offline'));
  await user.click(screen.getByRole('button', { name: /Ver detalle de Señal/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo consultar la entrada');
  await user.click(screen.getByRole('button', { name: 'Reintentar detalle' }));
  expect(await within(screen.getByRole('dialog')).findByText('250')).toBeVisible();
});
