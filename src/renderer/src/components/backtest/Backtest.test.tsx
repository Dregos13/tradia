// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
const metrics = {
  totalReturn: 0.1,
  annualizedReturn: 0.05,
  maxDrawdown: {
    pct: 0.08,
    peakDate: '2020-01-01',
    troughDate: '2020-02-01',
    recoveryDate: null,
    durationDays: 31,
  },
  sharpe: 1.2,
  sharpeInfinite: null,
  profitFactor: 2,
  profitFactorInfinite: false,
  winRate: 0.5,
  expectancy: 10,
  maxLosingStreak: 2,
  tradeCount: 21,
  winningTrades: 11,
  losingTrades: 10,
  grossProfit: 200,
  grossLoss: 100,
} as const;
const range = { startDate: '2020-01-01', endDate: '2020-12-31' };
const report: BacktestReport = {
  id: 7,
  strategyId: 1,
  version: 1,
  kind: 'completo',
  dataSource: 'simulated',
  providerId: 'simulated',
  totalReturn: 0.1,
  maxDrawdownPct: 0.08,
  sharpe: 1.2,
  tradeCount: 21,
  durationMs: 100,
  createdAt: '2021-01-01T00:00:00Z',
  config: {
    desde: '2020-01-01',
    hasta: '2022-12-31',
    ejecutadoHasta: '2021-12-31',
    markets: ['SPY'],
    initialCash: 10000,
    riskPerTrade: 0.01,
    maxPositions: 5,
    parameters: { fast: 20, slow: 50 },
    warmupSessions: 200,
    split: { train: 0.6, validation: 0.2, test: 0.2 },
    walkForward: {},
    sensitivity: { xParam: 'fast', yParam: 'slow' },
    monteCarlo: { seed: 1, simulations: 1000, method: 'permutation' },
  },
  costs: { commissionPct: 0.05, commissionMin: 1, slippageBps: 5, spreadBps: 2 },
  split: {
    train: range,
    validation: range,
    test: range,
    counts: { train: 150, validation: 50, test: 50 },
    sessionCount: 250,
  },
  metrics,
  equityCurve: [
    { date: '2020-01-01', equity: 10000, cash: 10000, positions: 0 },
    { date: '2020-12-31', equity: 11000, cash: 11000, positions: 0 },
  ],
  benchmark: {
    ticker: 'SPY',
    totalReturn: 0.2,
    curve: [{ date: '2020-01-01', equity: 10000, cash: 10000, positions: 0 }],
  },
  trades: Array.from({ length: 21 }, (_, i) => ({
    ticker: `T${i}`,
    signalDate: '2020-01-01',
    entryDate: '2020-01-02',
    exitDate: '2020-02-01',
    entryPrice: 100,
    exitPrice: 110,
    shares: 1,
    commission: 2,
    slippage: 1,
    grossPnl: 10,
    pnl: 8,
    exitReason: 'signal',
  })),
  walkForward: {
    objective: 'sharpe',
    trainSize: 126,
    testSize: 63,
    step: 63,
    windows: [
      {
        index: 0,
        train: range,
        test: range,
        params: { fast: 20 },
        inSampleMetric: 1.2,
        inSampleMetrics: metrics,
        outOfSampleMetric: 0.5,
        outOfSampleMetrics: metrics,
        candidates: 4,
      },
    ],
    meanInSampleMetric: 1.2,
    meanOutOfSampleMetric: 0.5,
    outOfSampleTrades: 21,
  },
  sensitivity: {
    metric: 'sharpe',
    xParam: 'fast',
    xValues: [20, 30],
    yParam: 'slow',
    yValues: [50],
    cells: [[1.2, null]],
    baseCell: { x: 0, y: 0 },
    baseValue: 1.2,
  },
  monteCarlo: {
    method: 'permutation',
    seed: 1,
    simulations: 1000,
    tradeCount: 21,
    initialCash: 10000,
    returnPercentiles: { p5: 0.1, p50: 0.1, p95: 0.1 },
    drawdownPercentiles: { p5: 0.02, p50: 0.05, p95: 0.1 },
    distribution: [
      { totalReturn: 0.1, maxDrawdown: 0.02 },
      { totalReturn: 0.1, maxDrawdown: 0.1 },
    ],
  },
  warnings: [
    {
      rule: 'sesgo-supervivencia',
      severity: 'method',
      message: 'El universo puede excluir activos desaparecidos.',
    },
  ],
  finalTest: { status: 'disponible', runId: null, executedAt: null },
};
const strategy: Strategy = {
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
  let listener: (event: BacktestProgressEvent) => void = () => {};
  const off = vi.fn();
  vi.spyOn(window.tradia.backtest, 'onProgress').mockImplementation((fn) => {
    listener = fn;
    return off;
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
