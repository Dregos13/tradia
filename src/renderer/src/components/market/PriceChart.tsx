import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  LineStyle,
  createChart,
  type ISeriesApi,
} from 'lightweight-charts';
import { formatFxPair } from '../../../../shared/fx';
import { isFxSymbol } from '../../../../shared/fxTrading';
import type { MarketBarsResult, DataStatusEntry } from '../../../../shared/ipc';
import {
  chartData,
  formatPrice,
  priceFormat,
  rangeStart,
  volumeFormat,
  type AdjustedCandle,
} from './chartData';
import { HistoricalProgress, MarketStatus } from './MarketStatus';
import { FX_CALENDAR_HELP, fxLabel } from '../assetPresentation';

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
  const [showRsi, setShowRsi] = useState(true);
  const [showAtr, setShowAtr] = useState(true);
  const [hover, setHover] = useState<AdjustedCandle | null>(null);
  const [chartError, setChartError] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const [theme, setTheme] = useState(0);

  const isForex = isFxSymbol(result.ticker);
  const displayTicker = isForex ? formatFxPair(result.ticker) : result.ticker;

  const data = useMemo(() => chartData(result.bars), [result.bars]);
  const last = data.candles.at(-1);
  const prev = data.candles.length >= 2 ? data.candles.at(-2) : null;
  const changeDiff = last && prev ? last.close - prev.close : null;
  const changePct = last && prev && prev.close > 0 ? (changeDiff! / prev.close) * 100 : null;

  const first = last ? rangeStart(last.time, years) : null;
  const selected = hover ?? last;

  const rsiByDate = useMemo(() => new Map(data.rsi.map((p) => [p.time, p.value])), [data.rsi]);
  const atrByDate = useMemo(() => new Map(data.atr.map((p) => [p.time, p.value])), [data.atr]);
  const selectedRsi = selected ? rsiByDate.get(selected.time) : undefined;
  const selectedAtr = selected ? atrByDate.get(selected.time) : undefined;

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
          background: { type: ColorType.Solid, color: color('color-surface') || '#17233A' },
          textColor: color('color-textMuted') || '#94A3B8',
          fontFamily: style.getPropertyValue('--font-numeric').trim() || 'monospace',
          attributionLogo: true,
        },
        grid: {
          vertLines: { color: color('candle-grid') || 'rgba(148, 163, 184, 0.15)' },
          horzLines: { color: color('candle-grid') || 'rgba(148, 163, 184, 0.15)' },
        },
        crosshair: {
          vertLine: { color: color('candle-crosshair') || '#94A3B8' },
          horzLine: { color: color('candle-crosshair') || '#94A3B8' },
        },
        localization: { locale: 'es-ES' },
        timeScale: { timeVisible: false, lockVisibleTimeRangeOnResize: true },
      });
      const candles = chart.addSeries(CandlestickSeries, {
        upColor: color('color-surface') || '#17233A',
        downColor: color('candle-down') || '#DC2626',
        borderUpColor: color('candle-up') || '#16A873',
        borderDownColor: color('candle-down') || '#DC2626',
        wickUpColor: color('candle-wick') || '#94A3B8',
        wickDownColor: color('candle-wick') || '#94A3B8',
        lastValueVisible: true,
        priceFormat: {
          type: 'price',
          precision: isFxSymbol(result.ticker) ? 5 : 2,
          minMove: isFxSymbol(result.ticker) ? 0.00001 : 0.01,
        },
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
      let paneIdx = 1;
      if (showRsi) {
        const rsiPane = paneIdx++;
        const rsi = chart.addSeries(
          LineSeries,
          {
            color: color('series-rsi') || color('series-sma20') || '#0284C7',
            lineWidth: 2,
            title: 'RSI 14',
            priceLineVisible: false,
          },
          rsiPane,
        );
        rsi.setData(data.rsi);
        [30, 70].forEach((price) =>
          rsi.createPriceLine({
            price,
            color: color('color-textMuted') || '#94A3B8',
            lineStyle: LineStyle.Dashed,
            lineWidth: 1,
            axisLabelVisible: true,
            title: String(price),
          }),
        );
      }
      if (showAtr) {
        const atrPane = paneIdx++;
        const atr = chart.addSeries(
          LineSeries,
          {
            color: color('series-atr') || color('series-sma200') || '#D97706',
            lineWidth: 2,
            title: isForex ? 'ATR 14 · Divisa' : 'ATR 14 · USD',
            priceLineVisible: false,
          },
          atrPane,
        );
        atr.setData(data.atr);
      }
      const activePanes = (showRsi ? 1 : 0) + (showAtr ? 1 : 0);
      if (activePanes === 2) {
        chart.panes()[0]?.setStretchFactor(3);
        chart.panes()[1]?.setStretchFactor(1);
        chart.panes()[2]?.setStretchFactor(1);
      } else if (activePanes === 1) {
        chart.panes()[0]?.setStretchFactor(3);
        chart.panes()[1]?.setStretchFactor(1);
      } else {
        chart.panes()[0]?.setStretchFactor(1);
      }
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
  }, [data, years, theme, showRsi, showAtr, isForex]);

  useEffect(() => {
    averages.current.forEach((series, index) => series.applyOptions({ visible: visible[index] }));
  }, [visible, data, years, theme, showRsi, showAtr]);

  const diffStr =
    changeDiff !== null ? `${changeDiff >= 0 ? '+' : ''}${formatPrice(changeDiff, isForex)}` : null;
  const pctStr =
    changePct !== null ? `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)} %` : null;
  const changeLabel =
    diffStr && pctStr ? (isForex ? `${diffStr} (${pctStr})` : `${diffStr} USD (${pctStr})`) : null;

  return (
    <section
      className={`market-chart-card${status?.state === 'no-fiable' ? ' data-unreliable' : ''}`}
      aria-label={`Precio de ${displayTicker}`}
    >
      <header className="market-chart-heading">
        <div className="ticker-main-group">
          <div className="market-chart-title-row">
            <h3>{displayTicker}</h3>
            <span className={`asset-class-pill ${isForex ? 'forex' : 'stock'}`}>
              {isForex ? 'Divisa Forex 24/5' : 'Acción / ETF'}
            </span>
          </div>
          <p className="market-chart-sub">
            {isForex
              ? `${displayTicker} · Tipo de cambio Forex 24/5 · Operativa en cartera simulada interna`
              : 'USD · Precios ajustados por splits y dividendos'}
          </p>
          {isForex && (
            <>
              <p className="market-chart-sub">
                USD por {result.ticker.slice(0, 3)} · {fxLabel(result.ticker)}
              </p>
              <p className="market-fx-calendar">{FX_CALENDAR_HELP}</p>
            </>
          )}
          <p className="market-chart-meta">
            Fuente: {result.source ?? 'Pendiente'} · Última vela:{' '}
            {last?.time ?? 'Sin velas ajustadas'}
          </p>
          {last && (
            <div className="quote-display">
              <strong className="market-close">
                {formatPrice(last.close, isForex)} {isForex ? displayTicker : 'USD'}
              </strong>
              {changeLabel && (
                <span
                  className={`quote-change ${changeDiff! >= 0 ? 'bull' : 'bear'}`}
                  aria-label={`Variación: ${changeLabel}`}
                >
                  {changeLabel}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="market-chart-controls">
          <MarketStatus status={status} simulated={result.source === 'simulated'} />
          <div role="group" aria-label="Rango del gráfico" className="market-ranges">
            {[1, 3, 5].map((value) => (
              <button
                className={`button range-btn${years === value ? ' active' : ''}`}
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
          <div className="chart-toolbar">
            <div className="toolbar-group">
              <span className="toolbar-label">Medias móviles:</span>
              {[20, 50, 200].map((period, index) => (
                <label className={`market-sma-${period} sma-label sma-${period}`} key={period}>
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
            </div>
            <div className="toolbar-group">
              <span className="toolbar-label">Paneles secundarios:</span>
              <button
                type="button"
                className={`toggle-chip${showRsi ? ' active' : ''}`}
                aria-pressed={showRsi}
                onClick={() => setShowRsi((prev) => !prev)}
              >
                <span>{showRsi ? '✓' : '+'}</span> Panel RSI 14
              </button>
              <button
                type="button"
                className={`toggle-chip${showAtr ? ' active' : ''}`}
                aria-pressed={showAtr}
                onClick={() => setShowAtr((prev) => !prev)}
              >
                <span>{showAtr ? '✓' : '+'}</span> Panel ATR 14
              </button>
            </div>
            <span className="candle-legend">
              Vela alcista: cuerpo vacío · Bajista: cuerpo sólido
            </span>
          </div>

          <div
            ref={container}
            className="market-chart"
            role="img"
            aria-label={`Velas diarias ajustadas de ${displayTicker}, rango ${years} años, SMA 20, 50 y 200${showRsi ? ', panel RSI 14' : ''}${showAtr ? ', panel ATR 14' : ''}`}
          />
          {chartError && (
            <p className="market-error" role="alert">
              No pudimos dibujar el gráfico. Puedes consultar las velas en la tabla de datos.
            </p>
          )}
          {selected && (
            <div className="market-ohlcv ohlcv-bar" aria-live="polite">
              <span className="ohlcv-date">{selected.time}</span>
              <span className={`ohlcv-pill ${selected.close >= selected.open ? 'bull' : 'bear'}`}>
                {selected.close >= selected.open ? 'Alcista' : 'Bajista'}
              </span>
              <span>
                Apertura: <span className="ohlcv-val">{formatPrice(selected.open, isForex)}</span>
              </span>
              <span>
                Máximo: <span className="ohlcv-val">{formatPrice(selected.high, isForex)}</span>
              </span>
              <span>
                Mínimo: <span className="ohlcv-val">{formatPrice(selected.low, isForex)}</span>
              </span>
              <span>
                Cierre: <span className="ohlcv-val">{formatPrice(selected.close, isForex)}</span>
              </span>
              {!isForex && (
                <span>
                  Volumen: <span className="ohlcv-val">{volumeFormat.format(selected.volume)}</span>
                </span>
              )}
              {isForex && selected.volume > 0 && (
                <span>
                  Volumen:{' '}
                  <span className="ohlcv-val">{volumeFormat.format(selected.volume)} ticks</span>
                </span>
              )}
              {(selectedRsi !== undefined || selectedAtr !== undefined) && (
                <span className="ohlcv-indicators">
                  {selectedRsi !== undefined && (
                    <>
                      RSI 14: <span className="ohlcv-val">{priceFormat.format(selectedRsi)}</span>
                    </>
                  )}
                  {selectedRsi !== undefined && selectedAtr !== undefined && ' · '}
                  {selectedAtr !== undefined && (
                    <>
                      ATR 14:{' '}
                      <span className="ohlcv-val">
                        {formatPrice(selectedAtr, isForex)}
                        {!isForex ? ' USD' : ''}
                      </span>
                    </>
                  )}
                </span>
              )}
            </div>
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
                    {displayTicker} · OHLCV ajustado · {years} años
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
                        <td className={bar.close >= bar.open ? 'cell-bull' : 'cell-bear'}>
                          {bar.close >= bar.open ? 'Alcista' : 'Bajista'}
                        </td>
                        <td>{formatPrice(bar.open, isForex)}</td>
                        <td>{formatPrice(bar.high, isForex)}</td>
                        <td>{formatPrice(bar.low, isForex)}</td>
                        <td>{formatPrice(bar.close, isForex)}</td>
                        <td>
                          {isForex
                            ? bar.volume > 0
                              ? `${volumeFormat.format(bar.volume)} ticks`
                              : '—'
                            : volumeFormat.format(bar.volume)}
                        </td>
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
