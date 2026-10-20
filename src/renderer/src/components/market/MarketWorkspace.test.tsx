// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChart } from 'lightweight-charts';
import base from '../../design/base.tokens.json';
import market from '../../design/market.tokens.json';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { sma, rsi, atr } from '../../../../shared/indicators';
import { adjustedCandles, chartData, rangeStart } from './chartData';
import { MarketWorkspace } from './MarketWorkspace';
import { PriceChart } from './PriceChart';
import { ProviderBanner } from '../ProviderBanner';
import type { DataFreshnessSummary } from '../../../../shared/ipc';

const charts = vi.hoisted(() => ({
  instances: [] as {
    series: {
      data: unknown;
      setData: ReturnType<typeof vi.fn>;
      applyOptions: ReturnType<typeof vi.fn>;
    }[];
    addSeries: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    setVisibleRange: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock('lightweight-charts', () => ({
  CandlestickSeries: 'candles',
  LineSeries: 'line',
  ColorType: { Solid: 'solid' },
  LineStyle: { Solid: 0, Dashed: 2, Dotted: 1 },
  createChart: vi.fn(() => {
    const instance = {
      series: [] as (typeof charts.instances)[number]['series'],
      addSeries: vi.fn(),
      remove: vi.fn(),
      setVisibleRange: vi.fn(),
    };
    charts.instances.push(instance);
    return {
      addSeries: instance.addSeries.mockImplementation(() => {
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
    // El nodo accesible aparece antes de que useEffect cree las series del gráfico.
    await waitFor(() => {
      const chart = charts.instances.at(-1);
      expect(chart).toBeDefined();
      expect(chart!.series[0]!.data).toEqual(candles);
      for (const [index, period] of [20, 50, 200].entries()) {
        const values = chart!.series[index + 1]!.data as { time: string; value: number }[];
        expect(values.at(-1)?.value).toBe(sma(candles, period).at(-1));
      }
      expect((chart!.series[4]!.data as { value: number }[]).at(-1)?.value).toBe(
        rsi(candles).at(-1),
      );
      expect((chart!.series[5]!.data as { value: number }[]).at(-1)?.value).toBe(
        atr(candles).at(-1),
      );
    });
    const chart = charts.instances.at(-1)!;
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
  it('EUR se rechaza, «Añadir EUR/USD (divisa)» lo añade al día con su etiqueta y su calendario 24/5', async () => {
    simulation.markTickerUncovered('EUR');
    const user = userEvent.setup();
    render(<MarketWorkspace />);
    await screen.findByText('Tu lista está vacía.');
    await add('EUR');
    await user.click(await screen.findByRole('button', { name: 'Añadir EUR/USD (divisa)' }));
    const row = await screen.findByRole('button', { name: 'EUR/USD' });
    await waitFor(() =>
      expect(row).toHaveAccessibleDescription(/Divisa · 24\/5 · cartera simulada.*Fiable/),
    );
    const card = await screen.findByRole('region', { name: 'Precio de EUR/USD' });
    expect(within(card).getByRole('heading', { name: 'EUR/USD' })).toBeVisible();
    expect(within(card).getByText(/USD por EUR · Divisa · 24\/5 · cartera simulada/)).toBeVisible();
    expect(
      within(card).getByText(
        /No se esperan datos en fin de semana; sí en los festivos de EE\. UU\./,
      ),
    ).toBeVisible();
    expect(await simulation.api.watchlist.list()).toEqual([
      expect.objectContaining({ ticker: 'EURUSD', assetClass: 'fx' }),
    ]);
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
  it('permite alternar la visibilidad de los paneles secundarios de RSI y ATR', async () => {
    await simulation.api.watchlist.add('AAPL');
    const user = userEvent.setup();
    render(<MarketWorkspace />);
    await screen.findByRole('img', { name: /Velas diarias ajustadas de AAPL/ });
    const rsiBtn = screen.getByRole('button', { name: /Panel RSI 14/ });
    const atrBtn = screen.getByRole('button', { name: /Panel ATR 14/ });
    expect(rsiBtn.getAttribute('aria-pressed')).toBe('true');
    expect(atrBtn.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => {
      const chart = charts.instances.at(-1);
      expect(chart).toBeDefined();
      expect(chart!.series).toHaveLength(6);
    });

    await user.click(rsiBtn);
    expect(rsiBtn.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => {
      const chart = charts.instances.at(-1);
      expect(chart!.series).toHaveLength(5);
    });

    await user.click(atrBtn);
    expect(atrBtn.getAttribute('aria-pressed')).toBe('false');
    await waitFor(() => {
      const chart = charts.instances.at(-1);
      expect(chart!.series).toHaveLength(4);
    });

    await user.click(rsiBtn);
    expect(rsiBtn.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => {
      const chart = charts.instances.at(-1);
      expect(chart!.series).toHaveLength(5);
    });
  });
  it('formatea cotizaciones a 4 decimales y adapta subtítulo y métricas para EUR/USD', async () => {
    render(<MarketWorkspace />);
    await screen.findByText('Tu lista está vacía.');
    await add('EUR/USD');
    await screen.findByRole('img', { name: /Velas diarias ajustadas de EUR\/USD/ });
    expect(screen.getByText('Divisa Forex 24/5')).toBeTruthy();
    expect(screen.getByText('USD por EUR · Divisa · 24/5 · cartera simulada')).toBeTruthy();
    const closeEl = screen.getByText(/\d+,\d{4} EUR\/USD/);
    expect(closeEl).toBeTruthy();
    expect(screen.getByText(/Apertura:/).textContent).toMatch(/Apertura:\s*\d+,\d{4}/);
    expect(screen.getByText(/Cierre:/).textContent).toMatch(/Cierre:\s*\d+,\d{4}/);
    expect(screen.queryByText(/Volumen:/)).toBeNull();
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
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Comprobando…' }).disabled).toBe(
    true,
  );
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

it('la retirada desde el aviso también refresca la lista visible en Mercado', async () => {
  await simulation.api.watchlist.add('EUR');
  await simulation.api.watchlist.add('SPY');
  const uncoveredSummary: DataFreshnessSummary = {
    state: 'current',
    sinceDate: null,
    expectedSessionDate: null,
    missingSessions: 0,
    items: [],
    uncovered: [{ ticker: 'EUR', reason: null, suggestion: 'FXE' }],
    updatedAt: new Date().toISOString(),
  };
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockImplementation(async () => ({
    ...uncoveredSummary,
    uncovered: (await simulation.api.watchlist.list()).some((item) => item.ticker === 'EUR')
      ? uncoveredSummary.uncovered
      : [],
  }));
  render(
    <>
      <ProviderBanner />
      <MarketWorkspace />
    </>,
  );
  await screen.findByRole('button', { name: 'EUR' });
  await userEvent.click(await screen.findByRole('button', { name: 'Quitar EUR de la lista' }));
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'EUR' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'SPY' })).toBeEnabled();
  });
});

it('el gráfico de EUR/USD conserva cinco decimales en las velas y el eje de precio', async () => {
  await simulation.api.watchlist.add('EURUSD');
  render(<MarketWorkspace />);
  await screen.findByRole('region', { name: 'Precio de EUR/USD' });
  await waitFor(() => {
    expect(charts.instances.at(-1)?.addSeries).toHaveBeenCalledWith(
      'candles',
      expect.objectContaining({ priceFormat: { type: 'price', precision: 5, minMove: 0.00001 } }),
    );
  });
});

it('aplica los tokens y trazos de la identidad y conserva las SMA ocultas al cambiar de tema', async () => {
  const applyTheme = (mode: 'light' | 'dark') => {
    for (const [name, token] of Object.entries(base.color[mode]))
      document.documentElement.style.setProperty(`--color-${name}`, token.value);
    for (const group of ['candle', 'series'] as const)
      for (const [name, token] of Object.entries(market.color[group]))
        document.documentElement.style.setProperty(`--${group}-${name}`, token[mode]);
    document.documentElement.style.setProperty(
      '--font-numeric',
      base.typography.family.numeric.value,
    );
  };
  let changeTheme = () => {};
  const removeListener = vi.fn();
  vi.stubGlobal('matchMedia', () => ({
    addEventListener: (_event: string, listener: () => void) => {
      changeTheme = listener;
    },
    removeEventListener: removeListener,
  }));
  const result = await simulation.api.market.getBars({ ticker: 'AAPL' });
  applyTheme('light');
  const { unmount } = render(<PriceChart result={result} loading={false} />);
  try {
    const user = userEvent.setup();
    for (const mode of ['light', 'dark'] as const) {
      if (mode === 'dark') {
        await user.click(screen.getByRole('checkbox', { name: 'SMA 50' }));
        applyTheme(mode);
        act(() => changeTheme());
      }
      expect(createChart).toHaveBeenLastCalledWith(
        expect.any(HTMLElement),
        expect.objectContaining({
          layout: expect.objectContaining({
            background: { type: 'solid', color: base.color[mode].surface.value },
            textColor: base.color[mode].textMuted.value,
            fontFamily: base.typography.family.numeric.value,
          }),
          grid: {
            vertLines: { color: market.color.candle.grid[mode] },
            horzLines: { color: market.color.candle.grid[mode] },
          },
        }),
      );
      const chart = charts.instances.at(-1)!;
      expect(chart.addSeries).toHaveBeenCalledWith(
        'candles',
        expect.objectContaining({
          upColor: base.color[mode].surface.value,
          downColor: market.color.candle.down[mode],
          borderUpColor: market.color.candle.up[mode],
          wickUpColor: market.color.candle.wick[mode],
          wickDownColor: market.color.candle.wick[mode],
        }),
      );
      for (const [index, series] of (['sma20', 'sma50', 'sma200'] as const).entries()) {
        expect(chart.addSeries.mock.calls[index + 1]).toEqual([
          'line',
          expect.objectContaining({
            color: market.color.series[series][mode],
            lineStyle: [0, 2, 1][index],
          }),
        ]);
      }
      for (const indicator of ['rsi', 'atr'] as const)
        expect(chart.addSeries).toHaveBeenCalledWith(
          'line',
          expect.objectContaining({
            color: market.color.series[indicator][mode],
          }),
          expect.any(Number),
        );
      expect(chart.series[2]!.applyOptions).toHaveBeenLastCalledWith({ visible: mode === 'light' });
    }
    expect(charts.instances[0]!.remove).toHaveBeenCalledOnce();
  } finally {
    unmount();
    document.documentElement.removeAttribute('style');
  }
  expect(removeListener).toHaveBeenCalledWith('change', changeTheme);
});

it('si falla el lienzo ofrece las mismas velas ajustadas en una tabla accesible', async () => {
  const historical = await simulation.api.market.getBars({ ticker: 'AAPL' });
  const result = { ...historical, bars: historical.bars.slice(-30) };
  vi.mocked(createChart).mockImplementationOnce(() => {
    throw new Error('Canvas unavailable');
  });
  const user = userEvent.setup();
  render(<PriceChart result={result} loading={false} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Puedes consultar las velas en la tabla');
  await user.click(screen.getByText(/Ver tabla de datos/));
  fireEvent(screen.getByText(/Ver tabla de datos/).closest('details')!, new Event('toggle'));
  const table = await screen.findByRole('table', { name: /AAPL · OHLCV ajustado/ });
  expect(within(table).getAllByRole('row')).toHaveLength(chartData(result.bars).candles.length + 1);
});
