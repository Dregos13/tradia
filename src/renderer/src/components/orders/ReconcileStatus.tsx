import type { ReconciliationState } from '../../hooks/useOrders';
import { time } from './orderPresentation';
import './orders.css';
export function ReconcileStatus({ state }: { state: ReconciliationState }) {
  const { lastRun, openDiscrepancies, running, loading, error } = state;
  return (
    <section
      className="orders-reconcile"
      aria-label="Conciliación con el broker"
      aria-busy={running || loading}
    >
      <div>
        <strong>Conciliación con el broker</strong>
        <p role="status">
          {running || lastRun?.result === null
            ? 'Conciliando…'
            : loading
              ? 'Cargando conciliación…'
              : openDiscrepancies.length
                ? `⚠ ${openDiscrepancies.length} diferencias`
                : lastRun?.result === 'ok'
                  ? '✓ Sin diferencias'
                  : lastRun?.result === 'error'
                    ? '⚠ No se pudo conciliar'
                    : 'Aún no se ha conciliado'}
        </p>
        {lastRun && (
          <small>
            Última:{' '}
            <time dateTime={lastRun.finishedAt ?? lastRun.startedAt}>
              {time(lastRun.finishedAt ?? lastRun.startedAt)}
            </time>
          </small>
        )}
        {lastRun?.error && <p role="alert">{lastRun.error}</p>}
        {error && (
          <p role="alert">
            {error}{' '}
            <button className="button" onClick={() => void state.reload()}>
              Reintentar conciliación
            </button>
          </p>
        )}
      </div>
      <button
        className="button primary"
        disabled={running || loading}
        onClick={() => void state.run()}
      >
        {running ? 'Conciliando…' : 'Conciliar ahora'}
      </button>
    </section>
  );
}
