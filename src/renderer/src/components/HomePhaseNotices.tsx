import { useModelHealth } from '../hooks/useModelHealth';
import type { useLiveState } from './live/useLiveState';
import { aiTokens, date } from './ai/presentation';
import { LiveIcon, liveTokens } from './live/presentation';
import './ai/ai.css';
import './live/live.css';
import './home-phase-notices.css';

export function HomePhaseNotices({ live }: { live: ReturnType<typeof useLiveState> }) {
  const health = useModelHealth();
  const degraded = health.overview?.subjects.filter((row) => row.state === 'degradada') ?? [];
  const real = live.state?.mode === 'activo' || live.state?.mode === 'suspendido';
  return (
    <section className="ai-page home-phase-notices" aria-label="Avisos de IA y dinero real">
      <style>
        {aiTokens()}
        {liveTokens()}
      </style>
      {real && (
        <div className="live-surface live-warning" role="alert">
          <p>
            <LiveIcon />{' '}
            {live.state?.mode === 'suspendido' ? 'Dinero real suspendido' : 'Dinero real activo'}
            {' · '}Capital real en riesgo.
          </p>
          {live.state?.suspension && <p>{live.state.suspension.detail}</p>}
          <a href="#dinero-real">Revisar límites y lista de comprobación</a>
        </div>
      )}
      {(live.loading || live.error) && (
        <p role="status">
          {live.error || 'Comprobando el modo de operación…'}{' '}
          {live.error && (
            <button className="button" onClick={() => void live.reload()}>
              Reintentar modo
            </button>
          )}
        </p>
      )}
      {health.loading && <p role="status">Comprobando degradación de modelos y estrategias…</p>}
      {health.error && (
        <div className="ai-warning" role="status">
          <p>{health.error}. No se pudo verificar la degradación.</p>
          <a href="#salud-modelos">Revisar salud de modelos</a>
        </div>
      )}
      {health.offline && (
        <p role="status">
          Sin conexión · revisión de salud pausada. <a href="#salud-modelos">Ver última revisión</a>
        </p>
      )}
      {degraded.length > 0 && (
        <div className="ai-error" role="alert">
          <h2>Degradación detectada</h2>
          <ul>
            {degraded.map((row) => (
              <li key={`${row.subject}-${row.subjectId}`}>
                <strong>{row.name}</strong>
                {row.reason && ` · ${row.reason}`}
                {row.lastReviewedAt && (
                  <>
                    {' '}
                    · Revisado <time dateTime={row.lastReviewedAt}>{date(row.lastReviewedAt)}</time>
                  </>
                )}
              </li>
            ))}
          </ul>
          <a href="#salud-modelos">Ver degradación y propuestas de reentrenamiento</a>
        </div>
      )}
    </section>
  );
}
