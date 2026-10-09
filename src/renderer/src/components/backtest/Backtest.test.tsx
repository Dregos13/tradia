// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import type { BacktestReport, BacktestProgressEvent } from '../../../../shared/backtest';
import type { Strategy } from '../../../../shared/strategy';
import { BacktestLauncher } from './BacktestLauncher';
import { BacktestReportPage, Report } from './BacktestReportPage';
import { StrategiesPage } from '../strategies/StrategiesPage';
const chart = vi.hoisted(() => ({ setData: vi.fn(), remove: vi.fn() }));
vi.mock('lightweight-charts', () => ({
  LineSeries: 'line',
  LineStyle: { Dashed: 2 },
  ColorType: { Solid: 'solid' },
  createChart: () => ({
    addSeries: () => ({ setData: chart.setData }),
    timeScale: () => ({ fitContent: vi.fn() }),
    remove: chart.remove,
  }),
}));
import { metrics, report } from './testFixtures';
const strategy: Strategy = {
  executable: true,
  id: 1,
  version: 1,
  name: 'Cruce de medias',
  hypothesis: 'Tendencia',
  rules: { entry: 'Cruce', exit: 'Cruce', stop: '5 %', target: 'Señal' },
  parameters: { fast: 20, slow: 50 },
  parameterRanges: { fast: { min: 10, max: 40, step: 10 }, slow: { min: 50, max: 100, step: 10 } },
  markets: ['SPY'],
  trainingPeriod: { desde: '2020-01-01', hasta: '2020-12-31' },
  outOfSamplePeriod: { desde: '2021-01-01', hasta: '2022-12-31' },
  metricsSummary: null,
  regime: 'Tendencia',
  assumedCosts: report.costs,
  status: 'investigacion',
  changeNote: 'Alta',
  createdAt: report.createdAt,
  updatedAt: report.createdAt,
  versionCreatedAt: report.createdAt,
};
beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
  vi.spyOn(window.tradia.backtest, 'list').mockResolvedValue([report]);
  vi.stubGlobal('matchMedia', () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('renderiza todas las secciones, métricas, alternativas, gráfico y operaciones paginadas', async () => {
  render(<Report report={report} />);
  for (const name of [
    'Curva de capital',
    'Ventanas walk-forward',
    'Sensibilidad de parámetros',
    'Dispersión Monte Carlo',
    'Operaciones',
    'Configuración y división de datos',
  ])
    expect(screen.getByRole('heading', { name })).toBeInTheDocument();
  expect(screen.getByLabelText('Ocho métricas del backtest').querySelectorAll('dt')).toHaveLength(
    8,
  );
  expect(chart.setData).toHaveBeenCalledWith([
    { time: '2020-01-01', value: 10000 },
    { time: '2020-12-31', value: 11000 },
  ]);
  expect(screen.getByText('Datos simulados')).toBeVisible();
  expect(screen.getByLabelText('Aviso de riesgo')).toHaveTextContent(
    'No es asesoramiento financiero',
  );
  expect(
    screen.getByLabelText('fast 20, slow 50, sharpe 1,2, parámetros base'),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByText('Ver tabla alternativa de sensibilidad'));
  expect(screen.getByRole('table', { name: 'Sensibilidad · sharpe' })).toBeVisible();
  expect(screen.getByText('T0')).toBeVisible();
  expect(screen.queryByText('T20')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Siguiente' }));
  expect(screen.getByText('T20')).toBeVisible();
  expect(screen.queryByText('T0')).not.toBeInTheDocument();
  expect(await screen.findByRole('link', { name: /Informe #7/ })).toHaveAttribute(
    'href',
    '#estrategias/1/backtest/7',
  );
});
it('muestra sobreajuste solo cuando lo trae el informe y respeta valores indefinidos e infinitos', async () => {
  const { rerender } = render(<Report report={report} />);
  expect(screen.queryByText('Posible sobreajuste')).not.toBeInTheDocument();
  rerender(
    <Report
      report={{
        ...report,
        dataSource: 'real',
        warnings: [
          {
            rule: 'sobreajuste',
            severity: 'critical',
            message: 'Posible sobreajuste: Sharpe OOS menor que IS.',
          },
        ],
        metrics: {
          ...metrics,
          sharpe: null,
          sharpeInfinite: 'negative',
          profitFactor: null,
          profitFactorInfinite: true,
          winRate: null,
        },
      }}
    />,
  );
  expect(screen.getByText(/Posible sobreajuste/)).toBeVisible();
  expect(screen.getByText('Datos reales')).toBeVisible();
  expect(screen.getByText('−∞')).toBeVisible();
  expect(screen.getByText('∞')).toBeVisible();
});
it('cubre vacío, carga, error recuperable y ausencia de informe', async () => {
  const get = vi
    .spyOn(window.tradia.backtest, 'get')
    .mockRejectedValueOnce(new Error('IPC'))
    .mockResolvedValueOnce(null);
  render(<BacktestReportPage strategyId={1} runId={7} />);
  expect(screen.getByRole('status')).toHaveTextContent('Cargando informe');
  expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos cargar');
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar informe' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('no existe');
  expect(get).toHaveBeenCalledTimes(2);
  cleanup();
  render(
    <Report
      report={{
        ...report,
        trades: [],
        equityCurve: [],
        walkForward: null,
        sensitivity: null,
        monteCarlo: null,
      }}
    />,
  );
  expect(screen.getByText(/Aún no hay operaciones/)).toBeVisible();
  expect(screen.getByText(/Sin datos de walk-forward/)).toBeVisible();
});
it('envía periodo, parámetros y costes precargados, actualiza progreso y limpia suscripción', async () => {
  const listeners = new Set<(event: BacktestProgressEvent) => void>();
  const listener = (event: BacktestProgressEvent) => listeners.forEach((fn) => fn(event));
  const off = vi.fn();
  vi.spyOn(window.tradia.backtest, 'onProgress').mockImplementation((fn) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
      off();
    };
  });
  let finish: (r: BacktestReport) => void = () => {};
  const run = vi.spyOn(window.tradia.backtest, 'run').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = render(<BacktestLauncher strategy={strategy} />);
  expect(screen.getByLabelText('Comisión (%)')).toHaveValue(0.05);
  fireEvent.change(screen.getByLabelText('Spread (pb)'), { target: { value: '4' } });
  await userEvent.click(screen.getByRole('button', { name: 'Lanzar backtest' }));
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      strategyId: 1,
      version: 1,
      desde: '2020-01-01',
      hasta: '2022-12-31',
      params: { fast: 20, slow: 50 },
      costs: { ...report.costs, spreadBps: 4 },
    }),
  );
  act(() =>
    listener({
      ticket: 'a',
      strategyId: 2,
      stage: 'backtest',
      percent: 90,
      detail: null,
      elapsedMs: 1,
    }),
  );
  expect(screen.getByRole('progressbar')).toHaveValue(0);
  act(() =>
    listener({
      ticket: 'a',
      strategyId: 1,
      stage: 'walk-forward',
      percent: 62,
      detail: '4/7',
      elapsedMs: 1,
    }),
  );
  expect(screen.getByRole('progressbar')).toHaveValue(62);
  await act(async () => finish(report));
  expect(window.location.hash).toBe('#estrategias/1/backtest/7');
  unmount();
  expect(off).toHaveBeenCalled();
});
it('valida fechas y conserva entradas ante fallo IPC', async () => {
  const run = vi
    .spyOn(window.tradia.backtest, 'run')
    .mockRejectedValue(new Error('Periodo sin sesiones'));
  render(<BacktestLauncher strategy={strategy} />);
  fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2023-01-01' } });
  await userEvent.click(screen.getByRole('button', { name: 'Lanzar backtest' }));
  expect(screen.getByRole('alert')).toHaveTextContent('fecha inicial');
  expect(run).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2020-01-01' } });
  await userEvent.click(screen.getByRole('button', { name: 'Lanzar backtest' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Periodo sin sesiones');
  expect(screen.getByLabelText('Desde')).toHaveValue('2020-01-01');
});
it('exige confirmación separada y bloquea una prueba final consumida', async () => {
  const final = vi
    .spyOn(window.tradia.backtest, 'runFinalTest')
    .mockResolvedValue({ ...report, kind: 'prueba-final' });
  const { rerender } = render(<BacktestLauncher strategy={strategy} />);
  await screen.findByRole('link', { name: /Informe #7/ });
  await userEvent.click(screen.getByRole('button', { name: 'Ejecutar prueba final' }));
  expect(final).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
  expect(final).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Ejecutar prueba final' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar y ejecutar prueba final' }));
  expect(final).toHaveBeenCalledWith({ strategyId: 1, version: 1 });
  vi.mocked(window.tradia.backtest.list).mockResolvedValue([{ ...report, kind: 'prueba-final' }]);
  rerender(<BacktestLauncher key="consumed" strategy={strategy} />);
  expect(await screen.findByRole('link', { name: 'Ver prueba final' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Ejecutar prueba final' })).not.toBeInTheDocument();
});
it('integra la ruta de informe y rechaza un run de otra estrategia', async () => {
  vi.spyOn(window.tradia.backtest, 'get').mockResolvedValue(report);
  window.location.hash = '#estrategias/1/backtest/7';
  render(<StrategiesPage />);
  expect(await screen.findByRole('heading', { name: 'Informe de backtest' })).toBeVisible();
  cleanup();
  render(<BacktestReportPage strategyId={2} runId={7} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('no existe para esta estrategia');
});
it('no redirige al completar una ejecución si el usuario salió del lanzador', async () => {
  let finish: (r: BacktestReport) => void = () => {};
  vi.spyOn(window.tradia.backtest, 'run').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = render(<BacktestLauncher strategy={strategy} />);
  await userEvent.click(screen.getByRole('button', { name: 'Lanzar backtest' }));
  unmount();
  window.location.hash = '#mercado';
  await act(async () => finish(report));
  expect(window.location.hash).toBe('#mercado');
});
it('mantiene el historial consultable en versiones históricas y deshabilita el lanzador', async () => {
  render(<BacktestLauncher strategy={strategy} readOnly />);
  expect(screen.getByLabelText('Comisión (%)')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Lanzar backtest' })).toBeDisabled();
  expect(await screen.findByRole('link', { name: /Informe #7/ })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Ejecutar prueba final' })).toBeDisabled();
});

it('avisa y bloquea backtest y prueba final sin implementación, incluso con historial', async () => {
  const run = vi.spyOn(window.tradia.backtest, 'run');
  const final = vi.spyOn(window.tradia.backtest, 'runFinalTest');
  render(<BacktestLauncher strategy={{ ...strategy, executable: false }} />);
  expect(
    screen.getByText(/Sin implementación ejecutable: el backtest de estrategias propias/),
  ).toBeInTheDocument();
  const launch = screen.getByRole('button', { name: 'Lanzar backtest' });
  const finalButton = screen.getByRole('button', { name: 'Ejecutar prueba final' });
  await waitFor(() => expect(window.tradia.backtest.list).toHaveBeenCalled());
  expect(launch).toBeDisabled();
  expect(finalButton).toBeDisabled();
  await userEvent.click(launch);
  await userEvent.click(finalButton);
  fireEvent.submit(launch.closest('form')!);
  expect(run).not.toHaveBeenCalled();
  expect(final).not.toHaveBeenCalled();
});
