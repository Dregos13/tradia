// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { sma, rsi, atr } from '../../../../shared/indicators';
import { adjustedCandles, chartData, rangeStart } from './chartData';
import { MarketWorkspace } from './MarketWorkspace';

const charts = vi.hoisted(() => ({
  instances: [] as {
    series: {
      data: unknown;
      setData: ReturnType<typeof vi.fn>;
      applyOptions: ReturnType<typeof vi.fn>;
    }[];
    remove: ReturnType<typeof vi.fn>;
    setVisibleRange: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock('lightweight-charts', () => ({
  CandlestickSeries: 'candles',
  LineSeries: 'line',
  ColorType: { Solid: 'solid' },
  LineStyle: { Dashed: 2 },
  createChart: vi.fn(() => {
    const instance = {
      series: [] as (typeof charts.instances)[number]['series'],
      remove: vi.fn(),
      setVisibleRange: vi.fn(),
    };
    charts.instances.push(instance);
    return {
      addSeries: vi.fn(() => {
        const series = {
          data: undefined as unknown,
          setData: vi.fn((data: unknown) => {
            series.data = data;
          }),
          applyOptions: vi.fn(),
          createPriceLine: vi.fn(),
        };
        instance.series.push(series);
        return series;
      }),
      panes: () => [0, 1, 2].map(() => ({ setStretchFactor: vi.fn() })),
      timeScale: () => ({ setVisibleRange: instance.setVisibleRange }),
      subscribeCrosshairMove: vi.fn(),
      remove: instance.remove,
    };
  }),
}));
let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(() => {
  charts.instances.length = 0;
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  vi.stubGlobal('matchMedia', () => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const add = async (ticker: string) => {
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText('Ticker'));
  await user.type(screen.getByLabelText('Ticker'), ticker);
  await user.click(screen.getByRole('button', { name: 'Añadir' }));
};

describe('Lista y gráfico con adaptador simulado', () => {
  it('normaliza el ticker, dibuja OHLC ajustado e indicadores y confirma la baja', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<MarketWorkspace />);
    await screen.findByText('Tu lista está vacía.');
    await add('aapl');
    await screen.findByRole('img', { name: /Velas diarias ajustadas de AAPL/ });
    const result = await simulation.api.market.getBars({ ticker: 'AAPL' });
    const candles = adjustedCandles(result.bars);
    const chart = charts.instances.at(-1)!;
    expect(chart.series[0]!.data).toEqual(candles);
    for (const [index, period] of [20, 50, 200].entries()) {
      const values = chart.series[index + 1]!.data as { time: string; value: number }[];
      expect(values.at(-1)?.value).toBe(sma(candles, period).at(-1));
    }
    expect((chart.series[4]!.data as { value: number }[]).at(-1)?.value).toBe(rsi(candles).at(-1));
    expect((chart.series[5]!.data as { value: number }[]).at(-1)?.value).toBe(atr(candles).at(-1));
    expect(screen.getByText(/Última vela:/).textContent).toContain(candles.at(-1)!.time);
    expect(screen.getAllByText(/Datos simulados/)).toHaveLength(2);
    await user.click(screen.getByRole('checkbox', { name: 'SMA 20' }));
    expect(chart.series[1]!.applyOptions).toHaveBeenLastCalledWith({ visible: false });
    await user.click(screen.getByRole('button', { name: '1A' }));
    expect(screen.getByRole('button', { name: '1A' }).getAttribute('aria-pressed')).toBe('true');
    const range = charts.instances.at(-1)!.setVisibleRange.mock.calls[0]![0];
    expect(range.from >= rangeStart(candles.at(-1)!.time, 1)).toBe(true);
    await user.click(screen.getByText(/Ver tabla de datos/));
    fireEvent(screen.getByText(/Ver tabla de datos/).closest('details')!, new Event('toggle'));
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Quitar AAPL' }));
    expect(await simulation.api.watchlist.list()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('button', { name: 'Confirmar quitar AAPL' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Quitar AAPL' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar quitar AAPL' }));
    await screen.findByText('Tu lista está vacía.');
    expect(await simulation.api.watchlist.list()).toHaveLength(0);
    unmount();
    expect(simulation.listenerCount()).toBe(0);
    expect(charts.instances.every((instance) => instance.remove.mock.calls.length === 1)).toBe(
      true,
    );
  });
  it('rechaza formato, duplicados y el límite de 25; añade el universo mediante IPC', async () => {
    const addSpy = vi.spyOn(simulation.api.watchlist, 'add');
    const universe = vi.spyOn(simulation.api.watchlist, 'addUniverse');
    const user = userEvent.setup();
    render(<MarketWorkspace />);
    await screen.findByText('Tu lista está vacía.');
    await add('AAP L');
    expect(screen.getByRole('alert').textContent).toContain('Introduce un ticker');
    expect(addSpy).not.toHaveBeenCalled();
    await add('SPY');
    await screen.findByRole('img');
    await add('spy');
    expect(screen.getByRole('alert').textContent).toBe('SPY ya está en tu lista.');
    expect(addSpy).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Añadir universo inicial · 25' }));
    await screen.findByText('25 / 25');
    expect(universe).toHaveBeenCalledTimes(1);
    await add('NEW');
    expect(screen.getByRole('alert').textContent).toContain('límite de 25');
    expect(addSpy).toHaveBeenCalledTimes(1);
  });
  it('recarga tras market:updated, muestra progreso indeterminado y conserva el gráfico', async () => {
    await simulation.api.watchlist.add('AAPL');
    const getBars = vi.spyOn(simulation.api.market, 'getBars');
    render(<MarketWorkspace />);
    await screen.findByRole('img');
    act(() =>
      simulation.emitDataStatus({
        key: 'ticker:AAPL',
        state: 'actualizando',
        reason: null,
        lastOkAt: null,
        consecutiveFailures: 0,
        updatedAt: '2026-10-08T12:00:00Z',
      }),
    );
    const progress = await screen.findByRole('progressbar');
    expect(progress.hasAttribute('value')).toBe(false);
    expect(screen.getByRole('img')).toBeTruthy();
    const calls = getBars.mock.calls.length;
    act(() =>
      simulation.emitMarketUpdated({
        ticker: 'AAPL',
        source: 'simulated',
        lastDate: '2026-10-08',
        updatedAt: '2026-10-08T12:00:00Z',
      }),
    );
    await waitFor(() => expect(getBars.mock.calls.length).toBeGreaterThan(calls));
    act(() =>
      simulation.emitDataStatus({
        key: 'ticker:AAPL',
        state: 'no-fiable',
        reason: 'Proveedor no disponible',
        lastOkAt: null,
        consecutiveFailures: 1,
        updatedAt: '2026-10-08T12:01:00Z',
      }),
    );
    await screen.findAllByText('No fiable');
    expect(screen.getByRole('img')).toBeTruthy();
  });
  it('selecciona el siguiente activo y maneja errores de alta sin exponer detalles IPC', async () => {
    await simulation.api.watchlist.add('AAPL');
    await simulation.api.watchlist.add('SPY');
    const user = userEvent.setup();
    render(<MarketWorkspace />);
    await screen.findByRole('img', { name: /AAPL/ });
    await user.click(screen.getByRole('button', { name: 'Quitar AAPL' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar quitar AAPL' }));
    await screen.findByRole('img', { name: /SPY/ });
    const watch = screen.getByRole('complementary', { name: 'Lista de seguimiento' });
    expect(within(watch).getByRole('button', { name: 'SPY' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    vi.spyOn(simulation.api.watchlist, 'add').mockRejectedValueOnce(
      new Error('private API detail'),
    );
    await add('MSFT');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'No pudimos actualizar la lista',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Ticker').value).toBe('MSFT');
    expect(screen.queryByText(/private API/)).toBeNull();
  });
});
it('no sustituye velas sin ajustar y prepara los indicadores sin look-ahead', async () => {
  const { bars } = await simulation.api.market.getBars({ ticker: 'AAPL' });
  const changed = bars.map((bar) => ({
    ...bar,
    open: bar.open * 4,
    high: bar.high * 4,
    low: bar.low * 4,
    close: bar.close * 4,
  }));
  changed[0] = { ...changed[0]!, adjClose: null };
  const data = chartData(changed);
  expect(data.candles).toHaveLength(bars.length - 1);
  expect(data.candles[0]!.close).toBe(bars[1]!.adjClose);
  expect(data.sma200[0]!.time).toBe(data.candles[199]!.time);
  expect(rangeStart('2024-02-29', 1)).toBe('2023-02-28');
});

it('mantiene el formulario bloqueado y muestra descarga mientras el alta ingiere el histórico', async () => {
  const original = simulation.api.watchlist.add;
  let finish!: () => void;
  const download = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(simulation.api.watchlist, 'add').mockImplementation(async (ticker) => {
    await download;
    return original(ticker);
  });
  render(<MarketWorkspace />);
  await screen.findByText('Tu lista está vacía.');
  await add('AAPL');
  expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false);
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Añadir' }).disabled).toBe(true);
  await act(async () => {
    finish();
  });
  await screen.findByRole('img');
  expect(screen.queryByRole('progressbar')).toBeNull();
});

it('marca lista y gráfico al fallar y restaura la confianza al recuperarse', async () => {
  await simulation.api.watchlist.add('AAPL');
  render(<MarketWorkspace />);
  const chart = await screen.findByRole('region', { name: 'Precio de AAPL' });
  await waitFor(() => expect(within(chart).getByText('Fiable')).toBeTruthy());
  const entry = {
    key: 'ticker:AAPL',
    state: 'no-fiable' as const,
    lastOkAt: '2026-10-07T20:00:00Z',
    consecutiveFailures: 3,
    reason: 'Tiingo no responde',
    updatedAt: '2026-10-08T20:00:00Z',
  };
  act(() => simulation.emitDataStatus(entry));
  await waitFor(() => expect(screen.getAllByText('No fiable')).toHaveLength(2));
  expect(chart.classList.contains('data-unreliable')).toBe(true);
  expect(within(chart).getByRole('alert').textContent).toContain('No se usarán para señales');
  act(() =>
    simulation.emitDataStatus({ ...entry, state: 'fiable', reason: null, consecutiveFailures: 0 }),
  );
  await waitFor(() => expect(screen.queryByText('No fiable')).toBeNull());
  expect(chart.classList.contains('data-unreliable')).toBe(false);
});
