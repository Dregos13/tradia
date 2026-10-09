import { useEffect, useRef, useState } from 'react';
import { createChart, LineSeries, LineStyle, ColorType } from 'lightweight-charts';
import type { BacktestReport } from '../../../../shared/backtest';
import { number } from '../strategies/model';
import { ReportTable } from './ReportTable';
export function EquityChart({ report: r }: { report: BacktestReport }) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  const [theme, setTheme] = useState(0);
  const [table, setTable] = useState(false);
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => setTheme((x) => x + 1);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!container.current || !r.equityCurve.length) return;
    const style = getComputedStyle(container.current);
    const color = (key: string) => style.getPropertyValue(`--${key}`).trim();
    let chart: ReturnType<typeof createChart> | undefined;
    try {
      chart = createChart(container.current, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: color('color-surface') },
          textColor: color('color-textMuted'),
        },
        grid: {
          vertLines: { color: color('chart-grid') },
          horzLines: { color: color('chart-grid') },
        },
        localization: { locale: 'es-ES' },
      });
      chart
        .addSeries(LineSeries, { color: color('chart-equity'), title: 'Estrategia' })
        .setData(r.equityCurve.map((p) => ({ time: p.date, value: p.equity })));
      if (r.benchmark?.curve.length)
        chart
          .addSeries(LineSeries, {
            color: color('chart-benchmark'),
            lineStyle: LineStyle.Dashed,
            title: r.benchmark.ticker,
          })
          .setData(r.benchmark.curve.map((p) => ({ time: p.date, value: p.equity })));
      chart.timeScale().fitContent();
      setError(false);
    } catch {
      chart?.remove();
      chart = undefined;
      setError(true);
    }
    return () => chart?.remove();
  }, [r, theme]);
  return (
    <section className="strategy-section">
      <h3>Curva de capital</h3>
      {r.equityCurve.length ? (
        <>
          <p>
            Capital inicial: {number(r.config.initialCash, ' USD')} · Capital final:{' '}
            {number(r.equityCurve.at(-1)?.equity, ' USD')} · {r.equityCurve[0]?.date} →{' '}
            {r.equityCurve.at(-1)?.date}
          </p>
          <div
            ref={container}
            className="backtest-chart"
            role="img"
            aria-label={`Curva de capital, de ${number(r.equityCurve[0]?.equity)} a ${number(r.equityCurve.at(-1)?.equity)} USD`}
          />
          <p>
            Estrategia: línea continua
            {r.benchmark && ` · Comprar y mantener ${r.benchmark.ticker}: línea discontinua`}
          </p>
          {error && <p role="alert">No pudimos dibujar la curva. Consulta la tabla de capital.</p>}
          <details onToggle={(e) => setTable(e.currentTarget.open)}>
            <summary>Ver tabla de capital</summary>
            {table && (
              <ReportTable
                caption="Capital diario · USD"
                headers={['Fecha', 'Capital', 'Efectivo', 'Posiciones']}
                rows={r.equityCurve.map((p) => [
                  p.date,
                  number(p.equity),
                  number(p.cash),
                  p.positions,
                ])}
              />
            )}
          </details>
        </>
      ) : (
        <p>Sin datos de capital para esta ejecución.</p>
      )}
      <p>
        Gráficos con{' '}
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">
          TradingView Lightweight Charts™
        </a>
        .
      </p>
    </section>
  );
}
