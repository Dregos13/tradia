import { useEffect, useRef, useState } from 'react';
import { NEWS_PRIORITIES, RELIABILITY_LEVELS, type NewsItem } from '../../../../shared/ipc';
import { useNews } from '../../hooks/useNews';
import { useSystemState } from '../../hooks/useSystemState';
import './news.css';

const priorities = {
  maxima: 'Prioridad máxima',
  media: 'Prioridad media',
  activo: 'Por activo',
  baja: 'Baja',
};
const reliability = { oficial: 'Oficial', agencia: 'Agencia', prensa: 'Prensa', redes: 'Redes' };
const date = new Intl.DateTimeFormat('es-ES', { dateStyle: 'full' });
const time = new Intl.DateTimeFormat('es-ES', {
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});

function NewsHeadline({
  item,
  selectAsset,
}: {
  item: NewsItem;
  selectAsset: (ticker: string) => void;
}) {
  const onlySocial =
    item.sources.length > 0 && item.sources.every((source) => source.reliability === 'redes');
  const confirmed = item.confirmed && !onlySocial;
  const safeUrl = item.url && /^https?:\/\//i.test(item.url) ? item.url : null;
  return (
    <article className="news-card" data-testid="news-item">
      <div className="news-meta">
        <div className="news-badges">
          <span className={`news-badge news-priority-${item.priority}`}>
            {priorities[item.priority]}
          </span>
          {item.sources.map((source) => (
            <span key={source.id} className={`news-badge news-reliability-${source.reliability}`}>
              {reliability[source.reliability]} · {source.name}
            </span>
          ))}
          <span className={`news-badge news-${confirmed ? 'confirmed' : 'unconfirmed'}`}>
            {confirmed ? '✓ Confirmada' : '⚠ Sin confirmar'}
          </span>
          {item.sources.length > 1 && <span className="news-muted">Fuentes agrupadas</span>}
        </div>
        <time dateTime={item.publishedAt}>{time.format(new Date(item.publishedAt))}</time>
      </div>
      <h3>
        {safeUrl ? (
          <a href={safeUrl} target="_blank" rel="noopener noreferrer">
            {item.title}
            <span aria-hidden="true"> ↗</span>
            <span className="sr-only"> (abre en el navegador externo)</span>
          </a>
        ) : (
          item.title
        )}
      </h3>
      {onlySocial && (
        <p className="news-rumor" role="note">
          Noticia procedente únicamente de redes sociales. No confirmada por agencias oficiales ni
          habilitada para señales automáticas.
        </p>
      )}
      {item.summary && <p className="news-summary">{item.summary}</p>}
      <div className="news-assets">
        <span>Activos relacionados:</span>
        {item.assets.length ? (
          item.assets.map((ticker) => (
            <button
              className="button news-asset"
              key={ticker}
              onClick={() => selectAsset(ticker)}
              aria-label={`Filtrar por ${ticker}`}
            >
              {ticker}
            </button>
          ))
        ) : (
          <span>Sin activos identificados</span>
        )}
      </div>
    </article>
  );
}

export function NewsFeed() {
  const data = useNews();
  const { connectivity } = useSystemState();
  const [visible, setVisible] = useState<NewsItem[]>([]);
  const [priority, setPriority] = useState('');
  const [trust, setTrust] = useState('');
  const [asset, setAsset] = useState('');
  const [search, setSearch] = useState('');
  const root = useRef<HTMLElement>(null);
  const initialized = useRef(false);
  useEffect(() => {
    if (data.loading || data.error) return;
    const scroller = root.current?.closest('.main');
    if (!initialized.current || !scroller || scroller.scrollTop < 40) {
      setVisible(data.items);
      initialized.current = true;
    }
  }, [data.items, data.loading, data.error]);
  const pending = data.items.filter((item) => !visible.some((old) => old.id === item.id)).length;
  const changed =
    initialized.current && !data.loading && JSON.stringify(data.items) !== JSON.stringify(visible);
  const assets = [...new Set([...visible, ...data.items].flatMap((item) => item.assets))].sort();
  const filtered = visible
    .filter(
      (item) =>
        (!priority || item.priority === priority) &&
        (!trust || item.sources.some((source) => source.reliability === trust)) &&
        (!asset || item.assets.includes(asset)) &&
        (!search ||
          `${item.title} ${item.summary ?? ''}`
            .toLocaleLowerCase('es')
            .includes(search.toLocaleLowerCase('es'))),
    )
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const days = new Map<string, NewsItem[]>();
  for (const item of filtered) {
    const day = date.format(new Date(item.publishedAt));
    days.set(day, [...(days.get(day) ?? []), item]);
  }
  const reset = () => {
    setPriority('');
    setTrust('');
    setAsset('');
    setSearch('');
  };
  return (
    <section
      ref={root}
      className="news-feed"
      aria-label="Feed de noticias"
      aria-busy={data.loading}
    >
      {connectivity?.status === 'offline' && (
        <p className="news-offline" role="status">
          Sin conexión a internet. La lectura automática de fuentes está pausada; se muestran las
          noticias guardadas en el histórico local.
        </p>
      )}
      <div className="news-filters">
        <label>
          Prioridad
          <select value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="">Todas las prioridades</option>
            {NEWS_PRIORITIES.map((key) => (
              <option key={key} value={key}>
                {priorities[key]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Fiabilidad
          <select value={trust} onChange={(event) => setTrust(event.target.value)}>
            <option value="">Toda fiabilidad</option>
            {RELIABILITY_LEVELS.map((key) => (
              <option key={key} value={key}>
                {reliability[key]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Activo
          <select value={asset} onChange={(event) => setAsset(event.target.value)}>
            <option value="">Todos los activos</option>
            {assets.map((ticker) => (
              <option key={ticker}>{ticker}</option>
            ))}
          </select>
        </label>
        <label>
          Buscar noticias
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
      </div>
      <p role="status">
        {data.loading ? 'Cargando noticias…' : `${visible.length} titulares disponibles.`}
      </p>
      {changed && (
        <button
          className="button primary"
          onClick={() => {
            setVisible(data.items);
            root.current?.closest('.main')?.scrollTo({ top: 0 });
          }}
        >
          ↑ {pending ? `${pending} titulares nuevos recibidos` : 'Titulares actualizados'} · Clic
          para ver
        </button>
      )}
      {data.error && (
        <div role="alert">
          <p>{data.error}</p>
          <button className="button" onClick={() => void data.reload()}>
            Reintentar
          </button>
        </div>
      )}
      {!data.loading && !data.error && !filtered.length && (
        <div className="data-empty" role="status">
          <p>
            {visible.length
              ? 'No hay noticias que coincidan con los filtros aplicados. Prueba a restablecer los filtros de prioridad o fiabilidad.'
              : 'No hay noticias disponibles. Añade una fuente para recibir titulares.'}
          </p>
          {visible.length ? (
            <button className="button" onClick={reset}>
              Restablecer filtros
            </button>
          ) : (
            <a href="#fuentes">Añadir una fuente</a>
          )}
        </div>
      )}
      {Array.from(days, ([day, items]) => (
        <section key={day} aria-label={day}>
          <h2 className="news-day">{day}</h2>
          {items.map((item) => (
            <NewsHeadline key={item.id} item={item} selectAsset={setAsset} />
          ))}
        </section>
      ))}
    </section>
  );
}
