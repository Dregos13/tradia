import { useEffect, useState } from 'react';

import {
  EXCHANGE_SESSIONS,
  formatDuration,
  sessionState,
  sessionWindows,
} from '../../../../shared/sessions';

const HOUR = 3_600_000;

/** Medianoche local de hoy (ms). */
function localMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const timeFmt = new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' });

/**
 * Las tres sesiones en carriles sobre el día de hoy en tu hora local, con
 * el cursor «Ahora». Se actualiza cada 30 s.
 */
export function SessionsTimeline() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const start = localMidnight(now);
  const end = start + 24 * HOUR;
  const at = (ms: number) => ((Math.min(Math.max(ms, start), end) - start) / (end - start)) * 100;
  const states = EXCHANGE_SESSIONS.map((session) => sessionState(session, now));
  const anyOpen = states.some((s) => s.open);

  return (
    <section className="mesa-sessions" aria-labelledby="mesa-sessions-title">
      <header className="mesa-section-head">
        <h2 id="mesa-sessions-title">Sesiones</h2>
        <p className="mesa-meta">
          Hoy en tu hora · {anyOpen ? 'mercado abierto' : 'todas las bolsas cerradas'}
        </p>
      </header>
      <div className="mesa-lanes">
        <div className="mesa-axis" aria-hidden="true">
          {[0, 6, 12, 18, 24].map((h) => (
            <span key={h} style={{ '--at': (h / 24) * 100 } as React.CSSProperties}>
              {String(h).padStart(2, '0')}:00
            </span>
          ))}
        </div>
        {states.map(({ session, open, nextChange }) => (
          <div className="mesa-lane" key={session.id} data-open={open || undefined}>
            <div className="mesa-lane-label">
              <strong>{session.name}</strong>
              <span>
                {open
                  ? `Cierra en ${formatDuration(nextChange - now)}`
                  : `Abre en ${formatDuration(nextChange - now)}`}
              </span>
            </div>
            <div className="mesa-lane-track" title={session.focus}>
              {sessionWindows(session, start, end).map((w) => (
                <span
                  key={w.start}
                  className="mesa-lane-band"
                  style={{ left: `${at(w.start)}%`, width: `${at(w.end) - at(w.start)}%` }}
                >
                  {timeFmt.format(w.start)}–{timeFmt.format(w.end)}
                </span>
              ))}
            </div>
          </div>
        ))}
        <div
          className="mesa-now"
          style={{ '--at': at(now) } as React.CSSProperties}
          aria-hidden="true"
        >
          <span>Ahora {timeFmt.format(now)}</span>
        </div>
      </div>
    </section>
  );
}
