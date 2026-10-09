import { useReconciliation } from '../../hooks/useOrders';
import type { ReconcileDiscrepancy } from '../../../../shared/broker';
import './orders.css';
function Difference({ value }: { value: ReconcileDiscrepancy }) {
  return (
    <p>
      <strong>{value.ticker ?? 'Activo no disponible'}</strong>: Tradia registra{' '}
      {value.appValue ?? 'sin dato'}; broker paper, {value.brokerValue ?? 'sin dato'}.{' '}
      <span>{value.detail}</span>
    </p>
  );
}
/** Mount once in the application shell; owns its IPC subscription. */
export function ReconcileBanner() {
  const state = useReconciliation();
  const [first, ...rest] = state.openDiscrepancies;
  return (
    <>
      {!first && !state.loading && state.lastRun?.result === 'ok' && (
        <span className="orders-resolved" role="status">
          Descuadre resuelto. Conciliación completa. Sin diferencias.
        </span>
      )}
      {first && (
        <section className="orders-banner" role="alert" aria-label="Descuadre con el broker">
          <div>
            <strong>
              <span aria-hidden="true">⚠ </span>Descuadre con el broker
            </strong>
            <Difference value={first} />
            {rest.length > 0 && (
              <details>
                <summary>+{rest.length} diferencias</summary>
                {rest.map((value) => (
                  <Difference key={value.id} value={value} />
                ))}
              </details>
            )}
            {state.error && <p>{state.error}</p>}
          </div>
          <div className="orders-actions">
            <a href="#ordenes">Ver en Órdenes</a>
            <button className="button" disabled={state.running} onClick={() => void state.run()}>
              {state.running ? 'Conciliando…' : 'Conciliar ahora'}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
