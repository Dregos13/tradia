import { useEffect, useRef } from 'react';
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type SeriesMarker,
  type Time,
} from 'lightweight-charts';

import { sma } from '../../../../shared/indicators';
import type { DetectedPattern, PatternCandle } from '../../../../shared/patterns';

/** Sesiones visibles en el gráfico de la Mesa (~6 meses). */
const VISIBLE = 130;

/**
 * Velas del activo con la media de 50 y los patrones de hoy marcados
 * sobre su vela. El único gráfico grande de la Mesa.
 */
export function MesaChart({
  candles,
  patterns,
  fx,
  label,
}: {
  candles: PatternCandle[];
  patterns: DetectedPattern[];
  fx: boolean;
  label: string;
}) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (!element || candles.length === 0) return;
    const style = getComputedStyle(document.documentElement);
    const color = (token: string) => style.getPropertyValue(`--${token}`).trim();
    const chart = createChart(element, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: color('color-surface') },
        textColor: color('color-textMuted'),
        fontFamily: style.getPropertyValue('--font-numeric').trim() || 'monospace',
        attributionLogo: true,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: color('candle-grid') },
      },
      crosshair: {
        vertLine: { color: color('candle-crosshair') },
        horzLine: { color: color('candle-crosshair') },
      },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, timeVisible: false },
      localization: { locale: 'es-ES' },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: color('color-surface'),
      downColor: color('candle-down'),
      borderUpColor: color('candle-up'),
      borderDownColor: color('candle-down'),
      wickUpColor: color('candle-wick'),
      wickDownColor: color('candle-wick'),
      priceFormat: { type: 'price', precision: fx ? 5 : 2, minMove: fx ? 0.00001 : 0.01 },
    });
    series.setData(
      candles.map((c) => ({
        time: c.date as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    const average = sma(candles, 50);
    chart
      .addSeries(LineSeries, {
        color: color('color-accent'),
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      })
      .setData(
        average.flatMap((value, i) =>
          value === null ? [] : [{ time: candles[i]!.date as Time, value }],
        ),
      );
    const markers: SeriesMarker<Time>[] = patterns.map((p) => ({
      time: p.date as Time,
      position: p.tone === 'bajista' ? 'aboveBar' : 'belowBar',
      shape: p.tone === 'bajista' ? 'arrowDown' : p.tone === 'alcista' ? 'arrowUp' : 'circle',
      color: color(
        p.tone === 'bajista'
          ? 'candle-down'
          : p.tone === 'alcista'
            ? 'candle-up'
            : 'color-textMuted',
      ),
    }));
    createSeriesMarkers(series, markers);
    const from = candles[Math.max(0, candles.length - VISIBLE)]!.date as Time;
    chart.timeScale().setVisibleRange({ from, to: candles[candles.length - 1]!.date as Time });
    return () => chart.remove();
  }, [candles, patterns, fx]);

  return (
    <figure className="mesa-chart">
      <div
        ref={container}
        className="mesa-chart-canvas"
        role="img"
        aria-label={`Velas diarias de ${label} con su media de 50 sesiones${
          patterns.length > 0 ? ` y ${patterns.length} patrones marcados` : ''
        }`}
      />
      <figcaption className="mesa-chart-legend">
        <span className="mesa-key mesa-key-sma">Media de 50 sesiones</span>
        <span>Velas diarias · últimos 6 meses</span>
      </figcaption>
    </figure>
  );
}
