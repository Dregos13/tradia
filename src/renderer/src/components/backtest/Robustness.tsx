import type { BacktestReport, MonteCarloDto, SensitivityDto } from '../../../../shared/backtest';
import { number } from '../strategies/model';
import { ReportTable } from './ReportTable';
export const pct = (value: number | null | undefined) =>
  number(value == null ? null : value * 100, ' %');
export function Robustness({ report: r }: { report: BacktestReport }) {
  return (
    <>
      <section className="strategy-section">
        <h3>Ventanas walk-forward</h3>
        {r.walkForward?.windows.length ? (
          <ReportTable
            caption={`Objetivo: ${r.walkForward.objective} · IS: entrenamiento · OOS: fuera de muestra`}
            headers={[
              'Ventana',
              'Entrenamiento',
              'Fuera de muestra',
              'Métrica IS',
              'Métrica OOS',
              'Parámetros',
            ]}
            rows={r.walkForward.windows.map((w) => [
              w.index + 1,
              `${w.train.startDate} → ${w.train.endDate}`,
              `${w.test.startDate} → ${w.test.endDate}`,
              number(w.inSampleMetric),
              number(w.outOfSampleMetric),
              Object.entries(w.params)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', '),
            ])}
          />
        ) : (
          <p>Sin datos de walk-forward. Este análisis no está disponible en la ejecución.</p>
        )}
      </section>
      <Sensitivity data={r.sensitivity} />
      <MonteCarlo data={r.monteCarlo} />
    </>
  );
}
function Sensitivity({ data: d }: { data: SensitivityDto | null }) {
  const values = d?.cells.flat().filter((v): v is number => v !== null) ?? [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (
    <section className="strategy-section">
      <h3>Sensibilidad de parámetros</h3>
      {d ? (
        <>
          <p>
            {d.metric} · horizontal: {d.xParam} · vertical: {d.yParam}. El borde marca los
            parámetros base.
          </p>
          <div
            className="backtest-heat-scroll"
            tabIndex={0}
            role="region"
            aria-label="Mapa de sensibilidad"
          >
            <div
              className="backtest-heat"
              style={{ gridTemplateColumns: `repeat(${d.xValues.length}, minmax(64px, 1fr))` }}
            >
              {d.cells.flatMap((row, y) =>
                row.map((v, x) => {
                  const band =
                    v === null || max === min
                      ? 'mid'
                      : v < min + (max - min) / 3
                        ? 'low'
                        : v > min + (2 * (max - min)) / 3
                          ? 'high'
                          : 'mid';
                  return (
                    <div
                      key={`${y}-${x}`}
                      tabIndex={0}
                      className={`heat-${band} ${d.baseCell.x === x && d.baseCell.y === y ? 'heat-selected' : ''}`}
                      aria-label={`${d.xParam} ${d.xValues[x]}, ${d.yParam} ${d.yValues[y]}, ${d.metric} ${number(v)}${d.baseCell.x === x && d.baseCell.y === y ? ', parámetros base' : ''}`}
                    >
                      {number(v)}
                    </div>
                  );
                }),
              )}
            </div>
          </div>
          <details>
            <summary>Ver tabla alternativa de sensibilidad</summary>
            <ReportTable
              caption={`Sensibilidad · ${d.metric}`}
              headers={[d.xParam, d.yParam, d.metric, 'Selección']}
              rows={d.cells.flatMap((row, y) =>
                row.map((v, x) => [
                  d.xValues[x],
                  d.yValues[y],
                  number(v),
                  d.baseCell.x === x && d.baseCell.y === y ? 'Base' : '',
                ]),
              )}
            />
          </details>
        </>
      ) : (
        <p>Sin datos de sensibilidad. Se necesitan dos parámetros con rangos evaluados.</p>
      )}
    </section>
  );
}
function MonteCarlo({ data: d }: { data: MonteCarloDto | null }) {
  const samples = d?.distribution ?? [];
  const values = samples.map((s) => s.maxDrawdown);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const bins = Array.from({ length: 12 }, (_, i) => ({
    from: min + ((max - min) * i) / 12,
    to: min + ((max - min) * (i + 1)) / 12,
    count: 0,
  }));
  values.forEach((v) => {
    bins[max === min ? 0 : Math.min(11, Math.floor(((v - min) / (max - min)) * 12))]!.count++;
  });
  const height = Math.max(1, ...bins.map((b) => b.count));
  return (
    <section className="strategy-section">
      <h3>Dispersión Monte Carlo</h3>
      {d ? (
        <>
          <p>
            {number(d.simulations)} simulaciones ·{' '}
            {d.method === 'permutation'
              ? 'Permutación del orden de operaciones'
              : 'Remuestreo con reemplazo'}{' '}
            · semilla {d.seed}
          </p>
          {samples.length ? (
            <>
              <div
                className="backtest-histogram"
                role="img"
                aria-label={`Histograma de drawdown: ${samples.length} muestras, entre ${pct(min)} y ${pct(max)}`}
              >
                {bins.map((b, i) => (
                  <div key={i} style={{ height: `${(b.count / height) * 100}%` }} />
                ))}
              </div>
              <details>
                <summary>Ver frecuencias del histograma de drawdown</summary>
                <ReportTable
                  caption="Distribución de drawdown"
                  headers={['Desde', 'Hasta', 'Simulaciones']}
                  rows={bins.map((b) => [pct(b.from), pct(b.to), b.count])}
                />
              </details>
            </>
          ) : (
            <p>Sin muestras para el histograma.</p>
          )}
          <ReportTable
            caption="Percentiles de Monte Carlo"
            headers={['Métrica', 'P5', 'P50', 'P95']}
            rows={[
              [
                'Rentabilidad',
                pct(d.returnPercentiles.p5),
                pct(d.returnPercentiles.p50),
                pct(d.returnPercentiles.p95),
              ],
              [
                'Drawdown',
                pct(d.drawdownPercentiles.p5),
                pct(d.drawdownPercentiles.p50),
                pct(d.drawdownPercentiles.p95),
              ],
            ]}
          />
          <p>
            Drawdown expresado como magnitud de caída. Las permutaciones pueden conservar la
            rentabilidad final; su orden cambia las caídas intermedias.
          </p>
        </>
      ) : (
        <p>Sin datos de Monte Carlo para esta ejecución.</p>
      )}
    </section>
  );
}
