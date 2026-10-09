import type { DeviationReport, DeviationReportRow } from '../../../../shared/broker';
import { useDeviation } from '../../hooks/useDeviation';
import { DeviationMargins } from './DeviationMargins';
import { DeviationIcon, deviationTokens, number, signed } from './presentation';
import './deviation.css';

function DeviationRow({ row, report }: { row: DeviationReportRow; report: DeviationReport }) {
  const reasons = [];
  if (row.deviationPp !== null && Math.abs(row.deviationPp) > report.marginPp)
    reasons.push(
      `Desviación ${signed(row.deviationPp, 'pp')} supera ±${number(report.marginPp)} pp`,
    );
  if (row.avgSlippageBps !== null && row.avgSlippageBps > report.maxSlippageBps)
    reasons.push(
      `Slippage ${number(row.avgSlippageBps)} pb supera ${number(report.maxSlippageBps)} pb`,
    );
  const partial = row.deviationPp === null || row.expectedReturnPct === null;
  return (
    <tr>
      <th scope="row">{row.strategyName}</th>
      <td>
        <time dateTime={row.desde}>{row.desde}</time> –{' '}
        <time dateTime={row.hasta}>{row.hasta}</time>
      </td>
      <td>{row.trades}</td>
      <td>{signed(row.expectedReturnPct, '%')}</td>
      <td>{signed(row.realReturnPct, '%')}</td>
      <td>{signed(row.deviationPp, 'pp')}</td>
      <td>
        {number(row.realWinRate * 100)} %
        <small>
          Esperada:{' '}
          {row.expectedWinRate === null ? 'No calculado' : `${number(row.expectedWinRate * 100)} %`}
        </small>
      </td>
      <td>{row.avgSlippageBps === null ? 'No calculado' : signed(row.avgSlippageBps, 'pb')}</td>
      <td>
        ±{number(report.marginPp)} pp<small>máx. {number(report.maxSlippageBps)} pb</small>
      </td>
      <td>
        <span
          className={`deviation-status ${row.outOfMargin ? 'deviation-outside' : partial ? '' : 'deviation-within'}`}
        >
          <DeviationIcon kind={row.outOfMargin ? 'outside' : 'within'} />
          {row.outOfMargin ? 'Fuera de margen' : partial ? 'No calculado' : 'Dentro del margen'}
        </span>
        <small>{reasons.join('; ') || (partial ? 'Falta la expectativa del backtest.' : '')}</small>
      </td>
    </tr>
  );
}
export function DeviationPage() {
  const state = useDeviation();
  const report = state.report;
  const alerts = report?.rows.filter((row) => row.outOfMargin) ?? [];
  const strategies = new Set(report?.rows.map((row) => row.strategyId)).size;
  return (
    <div className="deviation-page">
      <style>{deviationTokens()}</style>
      <div className="deviation-top">
        <header>
          <div className="deviation-title">
            <h1>Real vs backtest</h1>
            <span className="deviation-paper">
              <DeviationIcon kind="paper" />
              Solo paper · sin dinero real
            </span>
          </div>
          <p>
            Compara las operaciones ejecutadas en paper con la expectativa del último backtest de
            cada estrategia.
          </p>
        </header>
        <div className="deviation-segments" role="group" aria-label="Periodo del informe">
          {(['semanal', 'mensual'] as const).map((period) => (
            <button
              key={period}
              className="button"
              aria-pressed={state.period === period}
              onClick={() => state.setPeriod(period)}
            >
              {period === 'semanal' ? 'Semanal' : 'Mensual'}
            </button>
          ))}
        </div>
      </div>
      <dl className="deviation-summary">
        <div>
          <dt>Periodo</dt>
          <dd>{state.period === 'semanal' ? 'Semanas cerradas' : 'Meses cerrados'}</dd>
          <small>
            America/New_York · {state.period === 'semanal' ? 'lunes a domingo' : 'meses naturales'}
          </small>
        </div>
        <div>
          <dt>Estrategias</dt>
          <dd>{report ? strategies : '—'}</dd>
        </div>
        <div>
          <dt>Fuera de margen</dt>
          <dd>{report ? alerts.length : '—'}</dd>
        </div>
        <div>
          <dt>Actualizado</dt>
          <dd>
            {report ? (
              <time dateTime={report.generatedAt}>
                {new Date(report.generatedAt).toLocaleString('es-ES', { timeZoneName: 'short' })}
              </time>
            ) : (
              '—'
            )}
          </dd>
        </div>
      </dl>
      <p role="status" aria-live="polite">
        {report && !state.loading
          ? alerts.length
            ? `${alerts.length} periodos fuera de margen: ${[...new Set(alerts.map((row) => row.strategyName))].join(', ')}.`
            : 'Informe calculado. Todas las estrategias dentro del margen.'
          : ''}
      </p>
      {state.error && (
        <div className="deviation-error" role="alert">
          {state.error}{' '}
          <button className="button" onClick={() => void state.reload()}>
            Reintentar informe
          </button>
          {report && (
            <p>Datos conservados del {new Date(report.generatedAt).toLocaleString('es-ES')}.</p>
          )}
        </div>
      )}
      <p className="deviation-scroll-hint">
        Desplázate horizontalmente para ver todas las columnas.
      </p>
      <div
        className="deviation-table-wrap"
        tabIndex={0}
        role="region"
        aria-label="Informe real frente a backtest"
        aria-busy={state.loading}
      >
        <table>
          <caption>
            Resultados {state.period === 'semanal' ? 'semanales' : 'mensuales'} por estrategia y
            periodo cerrado
          </caption>
          <thead>
            <tr>
              {[
                'Estrategia',
                'Periodo',
                'Operaciones',
                'Esperado',
                'Real',
                'Desviación',
                'Tasa de acierto',
                'Slippage medio',
                'Margen',
                'Estado',
              ].map((label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.loading && !report
              ? Array.from({ length: 5 }, (_, index) => (
                  <tr key={index}>
                    <td colSpan={10}>
                      {index === 0 ? (
                        <span role="status">Cargando informe…</span>
                      ) : (
                        <span aria-hidden="true">—</span>
                      )}
                    </td>
                  </tr>
                ))
              : report?.rows.map((row) => (
                  <DeviationRow key={`${row.strategyId}:${row.desde}`} row={row} report={report} />
                ))}
          </tbody>
        </table>
      </div>
      {!state.loading && !state.error && report?.rows.length === 0 && (
        <p className="deviation-empty">
          {state.period === 'semanal'
            ? 'Aún no hay semanas cerradas con operaciones en paper'
            : 'Aún no hay meses cerrados con operaciones en paper'}
        </p>
      )}
      <DeviationMargins onSaved={state.reload} />
    </div>
  );
}
