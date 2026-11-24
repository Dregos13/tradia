import { useEffect, useRef, useState } from 'react';
import {
  CandlestickSeries,
  ColorType,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';

import { sma } from '../../../../shared/indicators';
import type { DetectedPattern, PatternCandle } from '../../../../shared/patterns';
import { EXCHANGE_SESSIONS, sessionWindows } from '../../../../shared/sessions';

/** Velas visibles al abrir: ~6 meses en diario, ~5 días en horas. */
const VISIBLE_DAILY = 130;
const VISIBLE_HOURLY = 120;

const isHourly = (candles: PatternCandle[]) => candles[0]?.date.includes('T') ?? false;
const toTime = (date: string): Time =>
  date.includes('T') ? ((Date.parse(date) / 1000) as UTCTimestamp) : (date as Time);

interface Lane {
  id: string;
  bands: { left: number; width: number }[];
}

/**
 * Velas del activo con la media de 50 y los patrones de la última vela.
 * En 1 hora, tres carriles finos arriba marcan cuándo están abiertas
 * Tokio, Londres y Nueva York: el único gráfico grande del Mercado.
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
  const [lanes, setLanes] = useState<Lane[]>([]);
  const hourly = isHourly(candles);

  useEffect(() => {
    const element = container.current;
    if (!element || candles.length === 0) return;
    const style = getComputedStyle(document.documentElement);
    const color = (token: string) => style.getPropertyValue(`--${token}`).trim();
    const chart: IChartApi = createChart(element, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: color('color-surface') },
        textColor: color('color-textMuted'),
        fontFamily: style.getPropertyValue('--font-numeric').trim() || 'monospace',
        attributionLogo: true,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: color('candle-grid') } },
      crosshair: {
        vertLine: { color: color('candle-crosshair') },
        horzLine: { color: color('candle-crosshair') },
      },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: hourly, secondsVisible: false },
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
        time: toTime(c.date),
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
          value === null ? [] : [{ time: toTime(candles[i]!.date), value }],
        ),
      );
    const markers: SeriesMarker<Time>[] = patterns.map((p) => ({
      time: toTime(p.date),
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
    const visible = hourly ? VISIBLE_HOURLY : VISIBLE_DAILY;
    chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, candles.length - visible),
      to: candles.length + 2,
    });

    // Carriles de sesión (solo en horas): cada ventana se convierte en
    // posición x interpolando entre velas, porque Nueva York abre a :30.
    const stamps = hourly ? candles.map((c) => Date.parse(c.date)) : [];
    const logicalOf = (ms: number): number => {
      const last = stamps.length - 1;
      if (ms <= stamps[0]!) return 0;
      if (ms >= stamps[last]!) return last + (ms - stamps[last]!) / 3_600_000;
      let lo = 0;
      let hi = last;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (stamps[mid]! <= ms) lo = mid;
        else hi = mid;
      }
      return lo + (ms - stamps[lo]!) / Math.max(1, stamps[hi]! - stamps[lo]!);
    };
    // logicalToCoordinate solo admite índices enteros: se interpola entre
    // las dos velas vecinas para las horas que caen dentro de una vela.
    const coordOf = (logical: number): number | null => {
      const ts = chart.timeScale();
      const base = Math.floor(logical);
      const a = ts.logicalToCoordinate(base as never);
      const b = ts.logicalToCoordinate((base + 1) as never);
      if (a === null || b === null) return null;
      return a + (b - a) * (logical - base);
    };
    const updateLanes = () => {
      if (!hourly || stamps.length < 2) {
        setLanes([]);
        return;
      }
      const range = chart.timeScale().getVisibleLogicalRange();
      if (!range) return;
      const fromIdx = Math.max(0, Math.floor(range.from));
      const toIdx = Math.min(stamps.length - 1, Math.ceil(range.to));
      const fromMs = stamps[fromIdx]! - 3_600_000;
      const toMs = stamps[toIdx]! + 3_600_000;
      const width = chart.timeScale().width();
      setLanes(
        EXCHANGE_SESSIONS.map((session) => ({
          id: session.id,
          bands: sessionWindows(session, fromMs, toMs).flatMap((w) => {
            const x1 = coordOf(logicalOf(w.start));
            const x2 = coordOf(logicalOf(w.end));
            if (x1 === null || x2 === null) return [];
            const left = Math.max(0, x1);
            const right = Math.min(width, x2);
            return right > left ? [{ left, width: right - left }] : [];
          }),
        })),
      );
    };
    // El gráfico se coloca de forma asíncrona (autoSize): los carriles se
    // recalculan al cambiar el rango, el tamaño del eje y tras pintar.
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateLanes);
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
    chart.timeScale().subscribeSizeChange(schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      chart.remove();
    };
  }, [candles, patterns, fx, hourly]);

  return (
    <figure className="mesa-chart">
      <div className="mesa-chart-frame">
        <div
          ref={container}
          className="mesa-chart-canvas"
          role="img"
          aria-label={`Velas ${hourly ? 'de 1 hora' : 'diarias'} de ${label} con su media de 50${
            patterns.length > 0 ? ` y ${patterns.length} patrones marcados` : ''
          }`}
        />
        {lanes.length > 0 && (
          <div className="mesa-chart-lanes" aria-hidden="true">
            {lanes.map((lane) => (
              <div key={lane.id} className="mesa-chart-lane" data-session={lane.id}>
                {lane.bands.map((band, index) => (
                  <span key={index} style={{ left: band.left, width: band.width }} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
      <figcaption className="mesa-chart-legend">
        <span className="mesa-key mesa-key-sma">Media de 50 velas</span>
        {hourly ? (
          <>
            <span className="mesa-key-session" data-session="tokio">
              Tokio
            </span>
            <span className="mesa-key-session" data-session="londres">
              Londres
            </span>
            <span className="mesa-key-session" data-session="nueva-york">
              Nueva York
            </span>
          </>
        ) : (
          <span>Velas diarias · últimos 6 meses</span>
        )}
      </figcaption>
    </figure>
  );
}
