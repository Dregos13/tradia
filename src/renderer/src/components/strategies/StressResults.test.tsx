// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StressResultDto } from '../../../../shared/backtest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { StressResults } from './StressResults';

const rows: StressResultDto[] = ['2008', '2020', '2022'].map((id, index) => ({
  crisisId: id,
  crisisName: `Crisis ${id}`,
  desde: `${id}-01-01`,
  hasta: `${id}-12-31`,
  sessions: 252,
  totalReturn: [-0.048, 0.081, -0.029][index]!,
  maxDrawdown: [0.132, 0.095, 0.076][index]!,
  trades: [6, 4, 5][index]!,
  benchmarkTicker: 'SPY',
  benchmarkReturn: [-0.37, 0.054, -0.182][index]!,
  dataSource: 'simulated',
  providerId: 'simulated',
  createdAt: '2026-10-09',
  equityCurve: [
    { date: `${id}-01-02`, cash: 10000, equity: 10000, positions: 0 },
    { date: `${id}-12-31`, cash: 9520, equity: 9520, positions: 0 },
  ],
}));
beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('muestra las tres crisis con cifras, comparación SPY y curvas accesibles', async () => {
  const get = vi.spyOn(window.tradia.stress, 'get').mockResolvedValue(rows);
  render(<StressResults strategyId={7} version={2} />);
  expect(screen.getByRole('status')).toHaveTextContent('Cargando');
  const expected = [
    ['-4,8 %', '-13,2 %', '6', '-37 %', '+32,2 pp'],
    ['8,1 %', '-9,5 %', '4', '5,4 %', '+2,7 pp'],
    ['-2,9 %', '-7,6 %', '5', '-18,2 %', '+15,3 pp'],
  ];
  for (const [index, row] of rows.entries()) {
    const crisis = within(await screen.findByRole('article', { name: row.crisisId }));
    for (const value of expected[index]!) expect(crisis.getByText(value)).toBeInTheDocument();
    expect(crisis.getByText('Comprar y mantener SPY')).toBeInTheDocument();
    expect(crisis.getByText('Datos simulados')).toBeInTheDocument();
    expect(crisis.getByRole('img')).toHaveAccessibleName(new RegExp(`Capital en ${row.crisisId}`));
  }
  expect(get).toHaveBeenCalledWith({ strategyId: 7, version: 2 });
});
it('el vacío permite ejecutar y guarda los resultados de la versión', async () => {
  vi.spyOn(window.tradia.stress, 'get').mockResolvedValue([]);
  let finish!: (rows: StressResultDto[]) => void;
  const run = vi.spyOn(window.tradia.stress, 'run').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<StressResults strategyId={7} version={2} />);
  expect(await screen.findByText(/Aún no hay pruebas/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Ejecutar pruebas de estrés' }));
  expect(run).toHaveBeenCalledWith({ strategyId: 7, version: 2 });
  expect(screen.getByRole('button', { name: 'Ejecutando pruebas de estrés…' })).toBeDisabled();
  await act(async () => finish(rows));
  expect(await screen.findByRole('article', { name: '2008' })).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('Pruebas de estrés guardadas');
});
it('recupera una consulta fallida y conserva resultados si la ejecución falla', async () => {
  vi.spyOn(window.tradia.stress, 'get')
    .mockRejectedValueOnce(new Error('IPC'))
    .mockResolvedValue(rows);
  vi.spyOn(window.tradia.stress, 'run').mockRejectedValue(new Error('Sin conexión'));
  render(<StressResults strategyId={7} version={2} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos consultar');
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar consulta de estrés' }));
  await screen.findByRole('article', { name: '2008' });
  await userEvent.click(screen.getByRole('button', { name: 'Ejecutar pruebas de estrés' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Sin conexión');
  expect(screen.getAllByRole('article')).toHaveLength(3);
  expect(screen.getByRole('button', { name: 'Ejecutar pruebas de estrés' })).toBeEnabled();
});
it('distingue datos reales y resultados ausentes sin convertirlos en ceros', async () => {
  vi.spyOn(window.tradia.stress, 'get').mockResolvedValue([
    {
      ...rows[0]!,
      dataSource: 'real',
      providerId: 'tiingo',
      totalReturn: null,
      maxDrawdown: null,
      benchmarkReturn: null,
      sessions: 0,
      equityCurve: [],
    },
  ]);
  render(<StressResults strategyId={7} version={2} />);
  const crisis = within(await screen.findByRole('article', { name: '2008' }));
  expect(crisis.getByText('Datos reales')).toBeInTheDocument();
  expect(crisis.getByText('Fuente: tiingo')).toBeInTheDocument();
  expect(crisis.getAllByText('Sin datos')).toHaveLength(4);
  expect(crisis.getByText('Sin curva de capital disponible')).toBeInTheDocument();
  expect(screen.getAllByText('Sin resultado guardado para esta crisis.')).toHaveLength(2);
  expect(screen.queryByText('Datos simulados')).not.toBeInTheDocument();
});
it('consulta versiones históricas sin ofrecer ejecución', async () => {
  vi.spyOn(window.tradia.stress, 'get').mockResolvedValue(rows);
  render(<StressResults strategyId={7} version={1} readOnly />);
  await screen.findByRole('article', { name: '2008' });
  expect(
    screen.queryByRole('button', { name: 'Ejecutar pruebas de estrés' }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/pruebas guardadas en solo lectura/)).toBeInTheDocument();
});
it('ignora una ejecución pendiente al cambiar de versión', async () => {
  vi.spyOn(window.tradia.stress, 'get').mockResolvedValue([]);
  let finish!: (rows: StressResultDto[]) => void;
  vi.spyOn(window.tradia.stress, 'run').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<StressResults key="v1" strategyId={7} version={1} />);
  await screen.findByText(/Aún no hay pruebas/);
  await userEvent.click(screen.getByRole('button', { name: 'Ejecutar pruebas de estrés' }));
  view.rerender(<StressResults key="v2" strategyId={7} version={2} />);
  await screen.findByText(/Aún no hay pruebas/);
  await act(async () => finish(rows));
  expect(screen.queryByRole('article')).not.toBeInTheDocument();
  expect(screen.queryByText('Pruebas de estrés guardadas.')).not.toBeInTheDocument();
});

it('muestra drawdown cero en un resultado antiguo sin operaciones y con curva plana', async () => {
  vi.spyOn(window.tradia.stress, 'get').mockResolvedValue([
    {
      ...rows[1]!,
      totalReturn: 0,
      maxDrawdown: null,
      trades: 0,
      equityCurve: rows[1]!.equityCurve.map((point) => ({ ...point, equity: 10000, cash: 10000 })),
    },
  ]);
  render(<StressResults strategyId={7} version={2} />);
  const crisis = within(await screen.findByRole('article', { name: '2020' }));
  expect(crisis.getAllByText('0 %')).toHaveLength(2);
  expect(crisis.queryByText('Sin datos')).not.toBeInTheDocument();
});
