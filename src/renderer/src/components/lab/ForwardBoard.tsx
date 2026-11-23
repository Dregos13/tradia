import type { ForwardSummary } from '../../../../shared/lab';
import { money, pct, shortDate, signedPct, tone } from './format';

/**
 * Tablero de pruebas en vivo: una fila por estrategia, ordenadas por lo
 * que más importa — cuánto bate (o no) al mercado desde que empezó.
 */
export function ForwardBoard({
  rows,
  loading,
  error,
  onRetry,
}: {
  rows: ForwardSummary[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const sorted = [...rows].sort((a, b) => {
    if (a.test.status !== b.test.status) return a.test.status === 'activa' ? -1 : 1;
    const edge = (r: ForwardSummary) => r.returnPct - (r.benchmarkReturnPct ?? 0);
    return edge(b) - edge(a);
  });
  return (
    <section className="lab-board" aria-labelledby="lab-board-title">
      <header className="lab-board-head">
        <h2 id="lab-board-title">Pruebas en vivo</h2>
        {rows.length > 0 && (
          <p className="lab-board-meta">
            {rows.filter((r) => r.test.status === 'activa').length} activas · dinero ficticio
          </p>
        )}
      </header>
      {error ? (
        <p role="alert" className="lab-error">
          {error}{' '}
          <button type="button" className="lab-link" onClick={onRetry}>
            Reintentar
          </button>
        </p>
      ) : loading && rows.length === 0 ? (
        <p role="status" aria-busy="true" className="lab-muted">
          Calculando las pruebas…
        </p>
      ) : rows.length === 0 ? (
        <p className="lab-empty">
          Todavía no hay ninguna. Genera una estrategia, pruébala con el histórico y lánzala: aquí
          verás cada día cómo le va frente al mercado.
        </p>
      ) : (
        <table className="lab-table">
          <thead>
            <tr>
              <th scope="col">Estrategia</th>
              <th scope="col">Desde</th>
              <th scope="col" className="num">
                Capital
              </th>
              <th scope="col" className="num">
                Resultado
              </th>
              <th scope="col" className="num">
                Mercado
              </th>
              <th scope="col" className="num">
                Peor caída
              </th>
              <th scope="col" className="num">
                Operaciones
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const started = row.sessions > 0;
              return (
                <tr key={row.test.id} data-status={row.test.status}>
                  <th scope="row">
                    <a href={`#laboratorio/prueba/${row.test.id}`}>{row.test.strategyName}</a>
                    <span className="lab-row-sub">
                      {row.test.status === 'detenida'
                        ? 'Detenida'
                        : row.error
                          ? row.error
                          : started
                            ? `${row.sessions} sesiones · ${row.openPositions} abiertas`
                            : 'Esperando su primer cierre'}
                    </span>
                  </th>
                  <td className="mono">{shortDate(row.test.startDate)}</td>
                  <td className="num">{money(row.equity)}</td>
                  <td className="num" data-tone={started ? tone(row.returnPct) : 'flat'}>
                    {started ? signedPct(row.returnPct) : '—'}
                  </td>
                  <td className="num lab-muted">
                    {started ? signedPct(row.benchmarkReturnPct) : '—'}
                  </td>
                  <td className="num">{started ? pct(row.maxDrawdownPct) : '—'}</td>
                  <td className="num">{row.tradeCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
