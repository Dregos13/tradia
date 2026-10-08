import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  type ISeriesApi,
} from 'lightweight-charts';
import type { MarketBarsResult, DataStatusEntry } from '../../../../shared/ipc';
import { chartData, priceFormat, rangeStart, type AdjustedCandle } from './chartData';
import { HistoricalProgress, MarketStatus } from './MarketStatus';

export function PriceChart({
  result,
  status,
  loading,
}: {
  result: MarketBarsResult;
  status?: DataStatusEntry;
  loading: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  const averages = useRef<ISeriesApi<'Line'>[]>([]);
  const [years, setYears] = useState(5);
  const [visible, setVisible] = useState([true, true, true]);
  const [hover, setHover] = useState<AdjustedCandle | null>(null);
  const [chartError, setChartError] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [theme, setTheme] = useState(0);
  const data = useMemo(() => chartData(result.bars), [result.bars]);
  const last = data.candles.at(-1);
  const first = last ? rangeStart(last.time, years) : null;
  const selected = hover ?? last;
  const rsiValue = data.rsi.at(-1)?.value;
  const atrValue = data.atr.at(-1)?.value;
  const visibleRows = data.candles.filter((bar) => !first || bar.time >= first);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const change = () => setTheme((value) => value + 1);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    const element = container.current;
    if (!element || !last || !first) return;
    const style = getComputedStyle(document.documentElement);
    const color = (token: string) => style.getPropertyValue(`--${token}`).trim();
    let chart: ReturnType<typeof createChart> | undefined;
    setChartError(false);
    setHover(null);
    try {
      chart = createChart(element, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: color('color-surface') },
          textColor: color('color-textMuted'),
          fontFamily: style.getPropertyValue('--font-numeric').trim(),
          attributionLogo: true,
        },
        grid: {
          vertLines: { color: color('candle-grid') },
          horzLines: { color: color('candle-grid') },
        },
        crosshair: {
          vertLine: { color: color('candle-crosshair') },
          horzLine: { color: color('candle-crosshair') },
        },
        localization: { locale: 'es-ES' },
        timeScale: { timeVisible: false, lockVisibleTimeRangeOnResize: true },
      });
      const candles = chart.addSeries(CandlestickSeries, {
        upColor: color('color-surface'),
        downColor: color('candle-down'),
        borderUpColor: color('candle-up'),
        borderDownColor: color('candle-down'),
        wickUpColor: color('candle-wick'),
        wickDownColor: color('candle-wick'),
        lastValueVisible: true,
      });
      candles.setData(data.candles);
      averages.current = [20, 50, 200].map((period) =>
        chart!.addSeries(LineSeries, {
          color: color(`series-sma${period}`),
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          title: `SMA ${period}`,
        }),
      );
      [data.sma20, data.sma50, data.sma200].forEach((values, index) =>
        averages.current[index]!.setData(values),
      );
      const rsi = chart.addSeries(
        LineSeries,
        { color: color('series-sma20'), lineWidth: 2, title: 'RSI 14', priceLineVisible: false },
        1,
      );
      rsi.setData(data.rsi);
      [30, 70].forEach((price) =>
        rsi.createPriceLine({
          price,
          color: color('color-textMuted'),
          lineStyle: LineStyle.Dashed,
          lineWidth: 1,
          axisLabelVisible: true,
          title: String(price),
        }),
      );
      const atr = chart.addSeries(
        LineSeries,
        {
          color: color('series-sma200'),
          lineWidth: 2,
          title: 'ATR 14 · USD',
          priceLineVisible: false,
        },
        2,
      );
      atr.setData(data.atr);
      chart.panes()[0]?.setStretchFactor(3);
      chart.panes()[1]?.setStretchFactor(1);
      chart.panes()[2]?.setStretchFactor(1);
      const from = visibleRows[0]?.time;
      if (from) chart.timeScale().setVisibleRange({ from, to: last.time });
      const byDate = new Map(data.candles.map((bar) => [bar.time, bar]));
      chart.subscribeCrosshairMove((event) => {
        const time = event.time;
        const date =
          typeof time === 'string'
            ? time
            : typeof time === 'object'
              ? `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`
              : null;
        setHover(date ? (byDate.get(date) ?? null) : null);
      });
    } catch {
      chart?.remove();
      chart = undefined;
      setChartError(true);
    }
    return () => {
      averages.current = [];
      chart?.remove();
    };
    // Range selection intentionally resets the viewport; indicator visibility does not.
  }, [data, years, theme]);
  useEffect(() => {
    averages.current.forEach((series, index) => series.applyOptions({ visible: visible[index] }));
  }, [visible, data, years, theme]);
  return (
    <section
      className={`market-chart-card${status?.state === 'no-fiable' ? ' data-unreliable' : ''}`}
      aria-label={`Precio de ${result.ticker}`}
    >
      <header className="market-chart-heading">
        <div>
          <h3>{result.ticker}</h3>
          <p>USD · Precios ajustados por splits y dividendos</p>
          <p>
            Fuente: {result.source ?? 'Pendiente'} · Última vela:{' '}
            {last?.time ?? 'Sin velas ajustadas'}
          </p>
          {last && <strong className="market-close">{priceFormat.format(last.close)} USD</strong>}
        </div>
        <div className="market-chart-controls">
          <MarketStatus status={status} simulated={result.source === 'simulated'} />
          <div role="group" aria-label="Rango del gráfico" className="market-ranges">
            {[1, 3, 5].map((value) => (
              <button
                className="button"
                key={value}
                aria-pressed={years === value}
                onClick={() => setYears(value)}
              >
                {value}A
              </button>
            ))}
          </div>
        </div>
      </header>
      <HistoricalProgress ticker={result.ticker} active={status?.state === 'actualizando'} />
      {loading && (
        <p className="market-chart-note" role="status">
          Consultando velas…
        </p>
      )}
      {status?.reason && <p className="market-chart-note">{status.reason}</p>}
      {status?.state === 'no-fiable' && (
        <p className="data-quality-warning" role="alert">
          Datos no fiables. No se usarán para señales hasta confirmarlos.
        </p>
      )}
      {status?.state === 'desactualizado' && (
        <p className="market-chart-note" role="status">
          El histórico está desactualizado; puede faltar el último cierre.
        </p>
      )}
      {result.source === 'simulated' && (
        <p className="market-chart-note">
          Entorno de pruebas. Los valores no representan cotizaciones reales.
        </p>
      )}
      {result.bars.length > data.candles.length && (
        <p className="market-chart-note">
          Hay velas pendientes de ajuste; se mostrarán cuando termine su limpieza.
        </p>
      )}
      {last ? (
        <>
          <fieldset className="market-legend">
            <legend>Medias móviles</legend>
            {[20, 50, 200].map((period, index) => (
              <label className={`market-sma-${period}`} key={period}>
                <input
                  type="checkbox"
                  checked={visible[index]}
                  onChange={(event) =>
                    setVisible((previous) =>
                      previous.map((value, i) => (i === index ? event.target.checked : value)),
                    )
                  }
                />
                SMA {period}
              </label>
            ))}
            <span>Alcista: cuerpo vacío · Bajista: cuerpo sólido</span>
          </fieldset>
          <p className="market-chart-note">
            RSI 14:{' '}
            {rsiValue === undefined ? 'Sin datos suficientes' : priceFormat.format(rsiValue)} ·
            Referencias 30 y 70. ATR 14:{' '}
            {atrValue === undefined
              ? 'Sin datos suficientes'
              : `${priceFormat.format(atrValue)} USD`}
            .
          </p>
          <div
            ref={container}
            className="market-chart"
            role="img"
            aria-label={`Velas diarias ajustadas de ${result.ticker}, rango ${years} años, SMA 20, 50 y 200, paneles RSI 14 y ATR 14`}
          />
          {chartError && (
            <p className="market-error" role="alert">
              No pudimos dibujar el gráfico. Puedes consultar las velas en la tabla de datos.
            </p>
          )}
          {selected && (
            <p className="market-ohlcv">
              {selected.time} · {selected.close >= selected.open ? 'Alcista' : 'Bajista'} · Apertura{' '}
              {priceFormat.format(selected.open)} · Máximo {priceFormat.format(selected.high)} ·
              Mínimo {priceFormat.format(selected.low)} · Cierre{' '}
              {priceFormat.format(selected.close)} · Volumen {priceFormat.format(selected.volume)}
            </p>
          )}
          <details
            className="market-table"
            onToggle={(event) => setTableOpen(event.currentTarget.open)}
          >
            <summary>Ver tabla de datos · {visibleRows.length} velas</summary>
            {tableOpen && (
              <div tabIndex={0} role="region" aria-label="Tabla de velas ajustadas">
                <table>
                  <caption>
                    {result.ticker} · OHLCV ajustado · {years} años
                  </caption>
                  <thead>
                    <tr>
                      {[
                        'Fecha',
                        'Dirección',
                        'Apertura',
                        'Máximo',
                        'Mínimo',
                        'Cierre',
                        'Volumen',
                      ].map((label) => (
                        <th scope="col" key={label}>
                          {label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((bar) => (
                      <tr key={bar.time}>
                        <th scope="row">{bar.time}</th>
                        <td>{bar.close >= bar.open ? 'Alcista' : 'Bajista'}</td>
                        {[bar.open, bar.high, bar.low, bar.close, bar.volume].map(
                          (value, index) => (
                            <td key={index}>{priceFormat.format(value)}</td>
                          ),
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        </>
      ) : (
        <div className="market-list-empty">
          <h3>El histórico todavía no está disponible.</h3>
          <p>Las velas aparecerán cuando termine la descarga y el ajuste.</p>
        </div>
      )}
      <p className="market-attribution">
        Gráficos con{' '}
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          TradingView Lightweight Charts™
        </a>
        .
      </p>
    </section>
  );
}
