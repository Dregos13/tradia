import { useBacktestHistory } from '../../hooks/useBacktest';
import { number, date } from '../strategies/model';
export function BacktestHistory({ strategyId, version }: { strategyId: number; version: number }) {
  const state = useBacktestHistory(strategyId, version);
  return (
    <section className="strategy-section">
      <h3>Historial de backtests · v{version}</h3>
      {state.loading ? (
        <p role="status">Cargando historial…</p>
      ) : state.error ? (
        <p role="alert">
          {state.error} <button onClick={() => void state.reload()}>Reintentar historial</button>
        </p>
      ) : !state.items.length ? (
        <p>Aún no hay backtests guardados para esta versión.</p>
      ) : (
        <ul>
          {state.items.map((run) => (
            <li key={run.id}>
              <a href={`#estrategias/${strategyId}/backtest/${run.id}`}>
                Informe #{run.id} · {date(run.createdAt)}
              </a>{' '}
              · {run.kind === 'prueba-final' ? 'Prueba final' : 'Entrenamiento y validación'} ·{' '}
              {number(run.totalReturn == null ? null : run.totalReturn * 100, ' %')} ·{' '}
              {run.dataSource === 'real' ? 'Datos reales' : 'Datos simulados'}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
