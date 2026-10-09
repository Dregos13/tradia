import { useState } from 'react';
import type { StrategySummary } from '../../../../shared/strategy';
import { STRATEGY_STATUSES } from '../../../../shared/strategy';
import { date, number, statusLabels, statusTokens } from './model';
export function StrategyStatus({ status }: { status: StrategySummary['status'] }) {
  return (
    <span className={`strategy-status strategy-${statusTokens[status]}`}>
      ● {statusLabels[status]}
    </span>
  );
}
export function StrategyLibrary({ strategies }: { strategies: StrategySummary[] }) {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('recent');
  const rows = strategies
    .filter((s) => !filter || s.status === filter)
    .sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name)
        : sort === 'status'
          ? a.status.localeCompare(b.status)
          : sort === 'return'
            ? (b.metricsSummary?.totalReturnPct ?? -Infinity) -
              (a.metricsSummary?.totalReturnPct ?? -Infinity)
            : b.updatedAt.localeCompare(a.updatedAt),
    );
  return (
    <>
      <header className="strategy-heading">
        <div>
          <h2>Biblioteca de estrategias</h2>
          <p>Hipótesis versionadas, reglas reproducibles y evidencia.</p>
        </div>
        <a className="strategy-primary" href="#estrategias/nueva">
          Nueva estrategia
        </a>
      </header>
      <div className="strategy-actions">
        <label>
          Estado
          <select aria-label="Estado" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">Todos los estados</option>
            {STRATEGY_STATUSES.map((s) => (
              <option key={s} value={s}>
                {statusLabels[s]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Ordenar por
          <select aria-label="Ordenar por" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="recent">Actividad reciente</option>
            <option value="name">Nombre</option>
            <option value="status">Estado</option>
            <option value="return">Rentabilidad</option>
          </select>
        </label>
      </div>
      {!rows.length ? (
        <section className="strategy-section">
          <h3>
            {strategies.length ? 'No hay estrategias con este estado' : 'Aún no hay estrategias'}
          </h3>
          <p>Documenta tu primera hipótesis para comenzar.</p>
          <a href="#estrategias/nueva">Crear estrategia</a>
        </section>
      ) : (
        <table className="strategy-table">
          <caption className="sr-only">Estrategias y métricas del último backtest</caption>
          <thead>
            <tr>
              {[
                'Estrategia',
                'Versión',
                'Estado',
                'Rentabilidad',
                'Drawdown',
                'Sharpe',
                'Operaciones',
                'Actualización',
              ].map((x) => (
                <th key={x} scope="col">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <th scope="row" data-label="Estrategia">
                  <a href={`#estrategias/${s.id}`}>{s.name}</a>
                  <small>
                    {s.regime} · {s.markets.join(', ')}
                  </small>
                </th>
                <td data-label="Versión">v{s.version}</td>
                <td data-label="Estado">
                  <StrategyStatus status={s.status} />
                </td>
                <td data-label="Rentabilidad">{number(s.metricsSummary?.totalReturnPct, '%')}</td>
                <td data-label="Drawdown">{number(s.metricsSummary?.maxDrawdownPct, '%')}</td>
                <td data-label="Sharpe">{number(s.metricsSummary?.sharpe)}</td>
                <td data-label="Operaciones">{number(s.metricsSummary?.trades)}</td>
                <td data-label="Actualización">
                  {date(s.updatedAt)}
                  <small>Procedencia no disponible</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
