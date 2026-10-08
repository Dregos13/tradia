import { useEffect, useState } from 'react';
import type { CalendarEvent, ImpactLevel } from '../../../../shared/ipc';
import { useCalendar } from '../../hooks/useCalendar';
import './calendar.css';

const impacts: Record<ImpactLevel, string> = { alto: 'Alto', medio: 'Medio', bajo: 'Bajo' };
const bars = { alto: '■■■', medio: '■■□', bajo: '■□□' };
const dayLabel = new Intl.DateTimeFormat('es-ES', { dateStyle: 'full' });
const clock = new Intl.DateTimeFormat('es-ES', {
  hour: '2-digit',
  minute: '2-digit',
  timeZoneName: 'short',
});
function monday(date: Date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  value.setDate(value.getDate() - ((value.getDay() + 6) % 7));
  return value;
}
function addDays(date: Date, days: number) {
  const value = new Date(date);
  value.setDate(value.getDate() + days);
  return value;
}
function EventRow({ event, now, next }: { event: CalendarEvent; now: number; next: boolean }) {
  const past = new Date(event.dateUtc).getTime() <= now;
  return (
    <article
      data-testid="calendar-event"
      className={`calendar-row${past ? ' calendar-past' : ''}${next ? ' calendar-next' : ''}`}
    >
      <time dateTime={event.dateUtc}>{clock.format(new Date(event.dateUtc))}</time>
      <div className="calendar-badges">
        <span
          className={`calendar-badge calendar-impact-${event.impact}`}
          data-testid={event.impact === 'alto' ? 'event-impact-high' : undefined}
        >
          <span aria-hidden="true">{bars[event.impact]} </span>Impacto{' '}
          {impacts[event.impact].toLowerCase()}
        </span>
        {event.kind === 'resultados' && (
          <span className="calendar-badge calendar-earnings" data-testid="earnings-event">
            Resultados · {event.asset}
          </span>
        )}
      </div>
      <div>
        <h3>{event.title}</h3>
        <p>
          {event.country ?? 'Global'} ·{' '}
          {event.origin === 'simulado' ? 'Datos simulados' : event.origin}
        </p>
      </div>
      <div>
        {past ? (
          'Finalizado'
        ) : next ? (
          <strong data-testid="event-upcoming">
            Próximo en {Math.max(1, Math.ceil((new Date(event.dateUtc).getTime() - now) / 60000))}{' '}
            min
          </strong>
        ) : (
          'Programado'
        )}
      </div>
    </article>
  );
}
export function CalendarPage() {
  const [week, setWeek] = useState(() => monday(new Date()));
  const [now, setNow] = useState(() => Date.now());
  const [impact, setImpact] = useState('');
  const [key, setKey] = useState<boolean | null>(null);
  const [keyError, setKeyError] = useState(false);
  const end = addDays(week, 7);
  const data = useCalendar({
    desde: addDays(week, -1).toISOString().slice(0, 10),
    hasta: end.toISOString().slice(0, 10),
  });
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    const check = () => {
      void window.tradia.secrets
        .hasKey('finnhub')
        .then((value) => {
          if (active) {
            setKey(value);
            setKeyError(false);
          }
        })
        .catch(() => {
          if (active) setKeyError(true);
        });
    };
    check();
    window.addEventListener('focus', check);
    return () => {
      active = false;
      window.removeEventListener('focus', check);
    };
  }, []);
  const events = data.events
    .filter((event) => {
      const date = new Date(event.dateUtc).getTime();
      return (
        date >= week.getTime() &&
        date < end.getTime() &&
        (!impact ||
          (impact === 'resultados' ? event.kind === 'resultados' : event.impact === impact))
      );
    })
    .sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
  const next = events.find((event) => new Date(event.dateUtc).getTime() > now)?.id;
  return (
    <section className="calendar-page" aria-label="Calendario económico" aria-busy={data.loading}>
      <div className="headline">
        <h2>Calendario económico y de resultados</h2>
        <p>
          Hora local: {Intl.DateTimeFormat().resolvedOptions().timeZone} ·{' '}
          {clock.format(new Date(now))}
        </p>
      </div>
      <div className="calendar-toolbar">
        <nav aria-label="Navegación semanal" data-testid="calendar-week-nav">
          <button className="button" onClick={() => setWeek(addDays(week, -7))}>
            ‹ Semana anterior
          </button>
          <button className="button" onClick={() => setWeek(monday(new Date()))}>
            Esta semana
          </button>
          <button className="button" onClick={() => setWeek(addDays(week, 7))}>
            Semana siguiente ›
          </button>
        </nav>
        <p aria-live="polite">
          {dayLabel.format(week)} — {dayLabel.format(addDays(week, 6))}
        </p>
        <label>
          Filtrar por impacto
          <select
            data-testid="filter-impact"
            value={impact}
            onChange={(e) => setImpact(e.target.value)}
          >
            <option value="">Todos los impactos</option>
            {Object.entries(impacts).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
            <option value="resultados">Resultados de activos seguidos</option>
          </select>
        </label>
      </div>
      {key === false && (
        <p className="calendar-notice" role="note">
          Para ver los resultados trimestrales y estimaciones de BPA de tus activos, introduce una
          clave gratuita de Finnhub en <a href="#ajustes">Ajustes</a>.
        </p>
      )}
      {keyError && (
        <p role="alert">
          No se pudo comprobar la clave de Finnhub. Vuelve a abrir Calendario o a enfocar la ventana
          para reintentar.
        </p>
      )}
      {data.error ? (
        <div className="data-empty" role="alert">
          <p>{data.error}</p>
          <button className="button" onClick={() => void data.reload()}>
            Reintentar
          </button>
        </div>
      ) : data.loading ? (
        <p role="status">Cargando calendario económico…</p>
      ) : !events.length ? (
        <div className="data-empty" role="status">
          <p>
            {impact
              ? 'No hay eventos que coincidan con este filtro.'
              : 'No hay eventos programados para esta semana.'}
          </p>
          {impact && (
            <button className="button" onClick={() => setImpact('')}>
              Restablecer filtros
            </button>
          )}
        </div>
      ) : (
        <div className="calendar-days">
          {Array.from({ length: 7 }, (_, index) => {
            const day = addDays(week, index);
            const tomorrow = addDays(day, 1);
            const rows = events.filter(
              (event) => new Date(event.dateUtc) >= day && new Date(event.dateUtc) < tomorrow,
            );
            return rows.length ? (
              <section
                className="calendar-day"
                key={day.toISOString()}
                aria-label={dayLabel.format(day)}
              >
                <h3 className="calendar-day-title">
                  {dayLabel.format(day)}
                  {new Date(now).toDateString() === day.toDateString() && <span> · Hoy</span>}
                </h3>
                {rows.map((event) => (
                  <EventRow key={event.id} event={event} now={now} next={event.id === next} />
                ))}
              </section>
            ) : null;
          })}
        </div>
      )}
    </section>
  );
}
