import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  LIVE_SCALING_MIN_TRADES,
  LIVE_SCALING_MIN_WEEKS,
  type LiveScalingStatus,
} from '../../../../shared/live';
import { LiveIcon, liveTokens, timestamp } from './presentation';
import { LiveNavigation } from './LiveNavigation';
import './checklist.css';
import './live.css';

export function ScalingStatus({ onOpenEvidence }: { onOpenEvidence?: () => void } = {}) {
  const id = useId();
  const [status, setStatus] = useState<LiveScalingStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const next = await window.tradia.live.scaling();
      if (version === generation.current) setStatus(next);
    } catch {
      if (version === generation.current)
        setError('No se pudo cargar la evidencia de escalado. Reintenta para verificarla.');
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const unsubscribe = window.tradia.live.onChanged(() => void reload());
    void reload();
    window.addEventListener('focus', reload);
    return () => {
      generation.current++;
      unsubscribe();
      window.removeEventListener('focus', reload);
    };
  }, [reload]);
  const labels = {
    bloqueado: 'Escalado bloqueado',
    'en-evidencia': 'Evidencia en curso',
    elegible: 'Elegible para evaluación en fase 8',
  };
  const percent = (value: number | null) =>
    value === null
      ? 'Sin muestra suficiente'
      : `${value.toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`;
  return (
    <section
      className="live-surface live-sheet live-scaling"
      aria-labelledby={`${id}-title`}
      aria-busy={loading}
    >
      <style>{liveTokens()}</style>
      <header className="live-panel-head">
        <h3 id={`${id}-title`}>Estado del escalado</h3>
        <span className="live-meta">Los techos no pueden aumentarse en esta fase</span>
      </header>
      {loading && <p role="status">Cargando evidencia de escalado…</p>}
      {error && <p role="alert">{error}</p>}
      {status && (
        <>
          <p className={`live-badge live-scaling-${status.state}`}>
            <LiveIcon kind="lock" />
            {labels[status.state]}
          </p>
          <p>{status.reason}</p>
          <dl className="live-result-facts">
            <div>
              <dt>Tiempo en real</dt>
              <dd>
                {status.liveWeeks} de {LIVE_SCALING_MIN_WEEKS} semanas
              </dd>
            </div>
            <div>
              <dt>Operaciones reales conciliadas</dt>
              <dd>
                {status.liveTrades} de {LIVE_SCALING_MIN_TRADES}
              </dd>
            </div>
            <div>
              <dt>Semanas dentro del margen</dt>
              <dd>{status.weeksInMargin}</dd>
            </div>
            <div>
              <dt>Desviación frente al backtest</dt>
              <dd>{percent(status.deviationPct)}</dd>
            </div>
            <div>
              <dt>Drawdown real</dt>
              <dd>{percent(status.drawdownPct)}</dd>
            </div>
          </dl>
          {status.liveTrades === 0 && (
            <p>Todavía no hay operaciones reales conciliadas para evaluar el escalado.</p>
          )}
          <p className="live-meta">
            Evaluado: <time dateTime={status.evaluatedAt}>{timestamp(status.evaluatedAt)}</time>
          </p>
        </>
      )}
      <p>
        Esta fase limita el capital a los techos confirmados. Tradia no aumenta límites
        automáticamente.
      </p>
      <div className="live-actions">
        <LiveNavigation label="Ver evidencia" href="#diario" onOpen={onOpenEvidence} />
        {error && (
          <button className="button" onClick={() => void reload()}>
            Reintentar evidencia
          </button>
        )}
      </div>
    </section>
  );
}
