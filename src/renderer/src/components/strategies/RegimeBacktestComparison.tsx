import { useCallback, useEffect, useState } from 'react';
import type { Strategy } from '../../../../shared/strategy';
import type { RegimeComparisonSide } from '../../../../shared/ai';
import { useIpcList } from '../../hooks/useIpcList';
import { ReportTable } from '../backtest/ReportTable';
import { number } from './model';

const comparisonMetrics: [keyof Omit<RegimeComparisonSide, 'runId'>, string, string][] = [
  ['totalReturnPct', 'Rentabilidad', '%'],
  ['maxDrawdownPct', 'Drawdown máximo', '%'],
  ['sharpe', 'Sharpe', ''],
  ['trades', 'Operaciones', ''],
  ['winRatePct', 'Tasa de acierto', '%'],
];
export function RegimeBacktestComparison({
  strategy,
  readOnly,
}: {
  strategy: Strategy;
  readOnly: boolean;
}) {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let active = true;
    let updated = false;
    const off = window.tradia.connectivity.onChanged((state) => {
      updated = true;
      setOffline(state.status !== 'online');
    });
    void window.tradia.connectivity
      .getState()
      .then((state) => {
        if (active && !updated) setOffline(state.status !== 'online');
      })
      .catch(() => {
        if (active && !updated) setOffline(true);
      });
    return () => {
      active = false;
      off();
    };
  }, []);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const request = { strategyId: strategy.id, version: strategy.version };
  const read = useCallback(async () => {
    const comparison = await window.tradia.backtest.regimeComparison({
      strategyId: strategy.id,
      version: strategy.version,
    });
    if (!comparison) return [];
    const [without, withFilter] = await Promise.all([
      comparison.withoutFilter.runId === null
        ? null
        : window.tradia.backtest.get(comparison.withoutFilter.runId),
      comparison.withFilter.runId === null
        ? null
        : window.tradia.backtest.get(comparison.withFilter.runId),
    ]);
    const sameMarkets = (a: string[], b: string[]) =>
      JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
    const validReport = (report: NonNullable<typeof without>) =>
      report.strategyId === strategy.id &&
      report.version === strategy.version &&
      report.config.desde === comparison.period.desde &&
      (report.config.ejecutadoHasta ?? report.config.hasta) === comparison.period.hasta &&
      sameMarkets(report.config.markets, comparison.markets);
    const costsMatch =
      without &&
      withFilter &&
      (['commissionPct', 'commissionMin', 'slippageBps', 'spreadBps'] as const).every(
        (key) => without.costs[key] === withFilter.costs[key],
      );
    return [
      {
        comparison,
        costs: costsMatch ? without.costs : null,
        valid:
          comparison.comparable &&
          comparison.strategyId === strategy.id &&
          comparison.version === strategy.version &&
          (comparison.withoutFilter.runId === null || without !== null) &&
          (comparison.withFilter.runId === null || withFilter !== null) &&
          (!without || validReport(without)) &&
          (!withFilter || validReport(withFilter)) &&
          (!(without && withFilter) ||
            (!!costsMatch &&
              without.dataSource === withFilter.dataSource &&
              without.providerId === withFilter.providerId &&
              without.config.initialCash === withFilter.config.initialCash &&
              without.config.riskPerTrade === withFilter.config.riskPerTrade &&
              without.config.maxPositions === withFilter.config.maxPositions &&
              JSON.stringify(Object.entries(without.config.parameters).sort()) ===
                JSON.stringify(Object.entries(withFilter.config.parameters).sort()))),
      },
    ];
  }, [strategy.id, strategy.version]);
  const result = useIpcList(read, undefined, 'No se pudo cargar la comparación');
  const data = result.items[0];
  return (
    <section
      className="strategy-section"
      aria-labelledby="regime-comparison"
      aria-busy={result.loading || running}
    >
      <h3 id="regime-comparison">Efecto del filtro de régimen</h3>
      {offline && <p role="status">Sin conexión · se conserva la última comparación guardada.</p>}
      {result.loading && <p role="status">Cargando comparación…</p>}
      {result.error && (
        <p role="alert">
          {result.error}{' '}
          <button onClick={() => void result.reload()}>Reintentar comparación</button>
        </p>
      )}
      {runError && <p role="alert">{runError}</p>}
      {data ? (
        data.valid ? (
          <>
            <p>
              {data.costs
                ? 'Mismos datos, periodo y costes'
                : 'Periodo común · costes pendientes de verificar'}{' '}
              · {data.comparison.period.desde} – {data.comparison.period.hasta}
            </p>
            <p>
              Universo: {data.comparison.markets.join(', ')} · v{data.comparison.version}
            </p>
            {data.costs ? (
              <p>
                Comisión {number(data.costs.commissionPct, '%')} · mínimo{' '}
                {number(data.costs.commissionMin, ' USD')} · slippage{' '}
                {number(data.costs.slippageBps, ' pb')} · spread{' '}
                {number(data.costs.spreadBps, ' pb')}
              </p>
            ) : (
              <p>Costes ejecutados no disponibles: faltan los informes vinculados.</p>
            )}
            <p>Desplázate horizontalmente para ver todas las columnas</p>
            <div
              className="strategy-comparison-scroll"
              tabIndex={0}
              role="region"
              aria-label="Resultados con y sin filtro de régimen"
            >
              <ReportTable
                caption="Comparación con y sin filtro de régimen"
                headers={['Métrica', 'Sin filtro', 'Con filtro', 'Diferencia']}
                rows={comparisonMetrics.map(([key, label, unit]) => {
                  const before = data.comparison.withoutFilter[key];
                  const after = data.comparison.withFilter[key];
                  const delta = before == null || after == null ? null : after - before;
                  return [
                    label,
                    number(before, unit),
                    number(after, unit),
                    delta == null
                      ? 'Sin datos'
                      : `${delta >= 0 ? '+' : ''}${number(delta, unit === '%' ? ' pp' : key === 'trades' ? ' operaciones' : '')}`,
                  ];
                })}
              />
            </div>
            <p>
              Esta comparación muestra el efecto del filtro; no demuestra que vaya a mejorar
              resultados futuros.
            </p>
            <p>
              Guardada:{' '}
              <time dateTime={data.comparison.createdAt}>
                {new Date(data.comparison.createdAt).toLocaleString('es-ES')}
              </time>
            </p>
          </>
        ) : (
          <p role="alert">Comparación no válida · los dos backtests no usan la misma base.</p>
        )
      ) : (
        !result.loading &&
        !result.error && <p>Todavía no hay un backtest emparejado con y sin filtro de régimen</p>
      )}
      {!data &&
        !result.loading &&
        !result.error &&
        (!readOnly && strategy.executable ? (
          <button
            disabled={running || offline}
            onClick={async () => {
              setRunning(true);
              setRunError('');
              try {
                await window.tradia.backtest.runRegimeComparison(request);
                await result.reload();
              } catch {
                setRunError('No se pudo ejecutar la comparación. Inténtalo de nuevo.');
              } finally {
                setRunning(false);
              }
            }}
          >
            {running ? 'Ejecutando comparación…' : 'Ejecutar comparación'}
          </button>
        ) : (
          <p>
            {readOnly
              ? 'No puedes ejecutar comparaciones desde una versión histórica.'
              : 'Esta estrategia no tiene implementación ejecutable.'}
          </p>
        ))}
    </section>
  );
}
