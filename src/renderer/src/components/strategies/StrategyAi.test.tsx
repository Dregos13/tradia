// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { StrategiesPage } from './StrategiesPage';
import { RegimeBacktestComparison } from './RegimeBacktestComparison';
import { StrategyHealth } from './StrategyHealth';
import { report } from '../backtest/testFixtures';
import type { Strategy, StrategyDraft } from '../../../../shared/strategy';
import type { RegimeComparison } from '../../../../shared/ai';

const draft: StrategyDraft = {
  name: 'Régimen probado',
  hypothesis: 'Tendencia persistente',
  rules: { entry: 'Comprar', exit: 'Vender', stop: 'Cinco por ciento', target: 'Salida por señal' },
  markets: ['SPY'],
  parameters: {},
  regime: 'Tendencia',
  worksIn: ['tendencia'],
  failsIn: ['lateral'],
};
let strategy: Strategy;
const comparison: RegimeComparison = {
  strategyId: 1,
  version: 1,
  period: {
    desde: report.config.desde,
    hasta: report.config.ejecutadoHasta ?? report.config.hasta,
  },
  markets: report.config.markets,
  withoutFilter: {
    runId: 10,
    totalReturnPct: 10,
    maxDrawdownPct: 8,
    sharpe: 1,
    trades: 20,
    winRatePct: 50,
  },
  withFilter: {
    runId: 11,
    totalReturnPct: 12,
    maxDrawdownPct: 6,
    sharpe: 1.2,
    trades: 15,
    winRatePct: 60,
  },
  comparable: true,
  createdAt: '2026-10-10T12:00:00Z',
};
beforeEach(async () => {
  window.tradia = createSimulatedAdapter().api;
  const connection = await window.tradia.connectivity.getState();
  vi.spyOn(window.tradia.connectivity, 'getState').mockResolvedValue({
    ...connection,
    status: 'online',
  });
  strategy = await window.tradia.strategies.create(draft);
  window.location.hash = '#estrategias/1';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('edita los regímenes en v2 sin alterar v1 y rechaza solapamientos', async () => {
  window.location.hash = '#estrategias/1/editar';
  render(<StrategiesPage />);
  const works = await screen.findByRole('group', { name: 'Funciona en' });
  const fails = screen.getByRole('group', { name: 'Falla en' });
  expect(within(works).getByLabelText('Tendencia')).toBeChecked();
  expect(within(fails).getByLabelText('Lateral')).toBeChecked();
  await userEvent.click(within(fails).getByLabelText('Tendencia'));
  await userEvent.type(
    screen.getByLabelText('Nota del cambio'),
    'Documento los regímenes de volatilidad',
  );
  await userEvent.click(screen.getByRole('button', { name: 'Guardar nueva versión' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Tendencia no puede estar a la vez');
  await userEvent.click(within(fails).getByLabelText('Tendencia'));
  await userEvent.click(within(works).getByLabelText('Volatilidad baja'));
  await userEvent.click(screen.getByRole('button', { name: 'Guardar nueva versión' }));
  await screen.findByRole('heading', { name: draft.name });
  expect((await window.tradia.strategies.get({ id: 1 }))?.worksIn).toEqual([
    'tendencia',
    'volatilidad-baja',
  ]);
  expect((await window.tradia.strategies.get({ id: 1, version: 1 }))?.worksIn).toEqual([
    'tendencia',
  ]);
});
it('compara las cinco métricas con periodo, universo y costes ejecutados', async () => {
  vi.spyOn(window.tradia.backtest, 'regimeComparison').mockResolvedValue(comparison);
  vi.spyOn(window.tradia.backtest, 'get').mockImplementation(async (id) => ({
    ...report,
    id,
    strategyId: 1,
    version: 1,
  }));
  render(<RegimeBacktestComparison strategy={strategy} readOnly={false} />);
  const table = await screen.findByRole('table');
  expect(within(table).getAllByRole('row')).toHaveLength(6);
  expect(within(table).getByText('+2 pp')).toBeInTheDocument();
  expect(within(table).getByText('-5 operaciones')).toBeInTheDocument();
  expect(screen.getByText(/Mismos datos, periodo y costes/)).toHaveTextContent(
    comparison.period.desde,
  );
  expect(screen.getByText(/Comisión/)).toHaveTextContent('slippage');
});
it('rechaza costes distintos aunque el par se declare comparable', async () => {
  vi.spyOn(window.tradia.backtest, 'regimeComparison').mockResolvedValue(comparison);
  vi.spyOn(window.tradia.backtest, 'get').mockImplementation(async (id) => ({
    ...report,
    id,
    strategyId: 1,
    version: 1,
    costs: { ...report.costs, slippageBps: id },
  }));
  render(<RegimeBacktestComparison strategy={strategy} readOnly={false} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Comparación no válida');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
it('ejecuta el par ausente para la versión concreta y evita envíos duplicados', async () => {
  const run = vi.spyOn(window.tradia.backtest, 'runRegimeComparison');
  render(
    <RegimeBacktestComparison strategy={{ ...strategy, executable: true }} readOnly={false} />,
  );
  await userEvent.click(await screen.findByRole('button', { name: 'Ejecutar comparación' }));
  await screen.findByRole('table');
  expect(run).toHaveBeenCalledExactlyOnceWith({ strategyId: 1, version: 1 });
  expect(screen.getByText(/Costes ejecutados no disponibles/)).toBeVisible();
});
it('recupera un error de carga y respeta la lectura histórica', async () => {
  const read = vi
    .spyOn(window.tradia.backtest, 'regimeComparison')
    .mockRejectedValueOnce(new Error('IPC'));
  render(<RegimeBacktestComparison strategy={strategy} readOnly />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar la comparación');
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar comparación' }));
  await screen.findByText('No puedes ejecutar comparaciones desde una versión histórica.');
  expect(read).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: 'Ejecutar comparación' })).not.toBeInTheDocument();
});
it('muestra motivo y fecha de revisión de degradación y libera la suscripción', async () => {
  await window.tradia.strategies.setStatus({ id: 1, status: 'degradada' });
  strategy = (await window.tradia.strategies.get({ id: 1 }))!;
  const off = vi.fn();
  vi.spyOn(window.tradia.ai, 'onChanged').mockReturnValue(off);
  const view = render(<StrategyHealth strategy={strategy} />);
  expect(
    await screen.findByText('Drift sostenido. No se debe a una sola racha perdedora.'),
  ).toBeVisible();
  expect(screen.getByText(/Última revisión/).querySelector('time')).toHaveAttribute('dateTime');
  expect(screen.getByRole('link', { name: 'Salud de modelos' })).toHaveAttribute(
    'href',
    '#salud-modelos',
  );
  view.unmount();
  expect(off).toHaveBeenCalledOnce();
});
it('conserva la comparación al perder conexión', async () => {
  vi.spyOn(window.tradia.backtest, 'regimeComparison').mockResolvedValue({
    ...comparison,
    withoutFilter: { ...comparison.withoutFilter, runId: null },
    withFilter: { ...comparison.withFilter, runId: null },
  });
  let listener: Parameters<typeof window.tradia.connectivity.onChanged>[0] | undefined;
  vi.spyOn(window.tradia.connectivity, 'onChanged').mockImplementation((cb) => {
    listener = cb;
    return () => {};
  });
  render(<RegimeBacktestComparison strategy={strategy} readOnly={false} />);
  await screen.findByRole('table');
  const state = await window.tradia.connectivity.getState();
  act(() => listener?.({ ...state, status: 'offline' }));
  expect(screen.getByText(/Sin conexión/)).toBeVisible();
  expect(screen.getByRole('table')).toBeVisible();
});

it('no muestra diferencias cuando el periodo ejecutado no coincide', async () => {
  vi.spyOn(window.tradia.backtest, 'regimeComparison').mockResolvedValue(comparison);
  vi.spyOn(window.tradia.backtest, 'get').mockResolvedValue({
    ...report,
    strategyId: 1,
    version: 1,
    config: { ...report.config, desde: '2000-01-01' },
  });
  render(<RegimeBacktestComparison strategy={strategy} readOnly={false} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Comparación no válida');
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
});
it('mantiene la insignia degradada si falla la consulta del motivo', async () => {
  vi.spyOn(window.tradia.ai, 'health').mockRejectedValue(new Error('IPC'));
  render(<StrategyHealth strategy={{ ...strategy, status: 'degradada' }} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar la salud');
  expect(screen.getByText('Degradada')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Salud de modelos' })).toBeVisible();
});
