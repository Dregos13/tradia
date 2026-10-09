import type { ReactNode } from 'react';
import type { Snapshot } from './useDashboard';
export function DashboardBlock({
  id,
  title,
  wide = false,
  snapshot,
  reload,
  action,
  children,
}: {
  id: string;
  title: string;
  wide?: boolean;
  snapshot: Pick<Snapshot<unknown>, 'loading' | 'error'>;
  reload: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      className={`dashboard-block${wide ? ' dashboard-wide' : ''}`}
      aria-labelledby={`dashboard-${id}`}
      aria-busy={snapshot.loading}
    >
      <header>
        <h3 id={`dashboard-${id}`}>{title}</h3>
        {action}
      </header>
      {snapshot.error && (
        <div className="dashboard-error" role="alert">
          <p>No se pudo actualizar este bloque. Se conservan los datos conocidos.</p>
          <button onClick={reload}>Reintentar</button>
        </div>
      )}
      {snapshot.loading ? (
        <div role="status">
          <p>Cargando…</p>
          <div className="dashboard-skeleton" />
          <div className="dashboard-skeleton" />
          <div className="dashboard-skeleton" />
        </div>
      ) : (
        children
      )}
    </section>
  );
}
