import type { ReactNode } from 'react';
import { useNews } from '../hooks/useNews';
import { useCalendar } from '../hooks/useCalendar';
import { useSources } from '../hooks/useSources';

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
  const data = useNews();
  return (
    <SectionState
      name="Feed de noticias"
      {...data}
      empty="No hay noticias disponibles. Añade una fuente para recibir titulares."
    >
      {data.items.length ? <p role="status">{data.items.length} titulares disponibles.</p> : null}
    </SectionState>
  );
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
export function SourcesPage() {
  const data = useSources();
  return (
    <SectionState
      name="Fuentes de noticias"
      {...data}
      empty="Todavía no has añadido fuentes de noticias."
    >
      {data.sources.length ? (
        <p role="status">{data.sources.length} fuentes configuradas.</p>
      ) : null}
    </SectionState>
  );
}
