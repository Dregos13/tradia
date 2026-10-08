import type { ReactNode } from 'react';
import { NewsFeed } from './news/NewsFeed';
import { useCalendar } from '../hooks/useCalendar';
export { SourcesPage } from './news/SourcesPage';

/** Accessible section shells; full feed, calendar and forms follow in separate tasks. */
function SectionState({
  name,
  loading,
  error,
  reload,
  empty,
  children,
}: {
  name: string;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
  empty: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={name} aria-busy={loading}>
      {error ? (
        <div className="data-empty" role="alert">
          <p>{error}</p>
          <button className="button" onClick={() => void reload()}>
            Reintentar
          </button>
        </div>
      ) : loading ? (
        <p role="status">Cargando {name.toLocaleLowerCase('es-ES')}…</p>
      ) : (
        (children ?? (
          <div className="data-empty" role="status">
            <p>{empty}</p>
          </div>
        ))
      )}
    </section>
  );
}
export function NewsPage() {
  return <NewsFeed />;
}
export function CalendarPage() {
  const data = useCalendar();
  return (
    <SectionState
      name="Calendario económico"
      {...data}
      empty="No hay eventos programados para esta semana."
    >
      {data.events.length ? (
        <p role="status">{data.events.length} eventos disponibles esta semana.</p>
      ) : null}
    </SectionState>
  );
}
