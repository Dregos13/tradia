import { useCallback } from 'react';
import { useIpcList } from '../../hooks/useIpcList';
import type { Strategy } from '../../../../shared/strategy';
import { date } from './model';

export function StrategyHealth({ strategy }: { strategy: Strategy }) {
  const read = useCallback(async () => {
    const overview = await window.tradia.ai.health();
    return overview.subjects.filter(
      (row) => row.subject === 'estrategia' && row.subjectId === strategy.id,
    );
  }, [strategy.id]);
  const subscribe = useCallback(
    (reload: () => void) =>
      window.tradia.ai.onChanged((event) => {
        if (event.kind === 'salud') reload();
      }),
    [],
  );
  const health = useIpcList(read, subscribe, 'No se pudo cargar la salud de la estrategia.', true);
  const row = health.items[0];
  if (strategy.status !== 'degradada' && row?.state !== 'degradada' && !health.error) return null;
  return (
    <section className="strategy-section" aria-labelledby="strategy-health">
      <h3 id="strategy-health">Salud de la estrategia · estado actual</h3>
      {health.loading && (
        <p role="status" aria-busy="true">
          Cargando motivo de degradación…
        </p>
      )}
      {health.error && (
        <p role="alert">
          {health.error} <button onClick={() => void health.reload()}>Reintentar salud</button>
        </p>
      )}
      {(strategy.status === 'degradada' || row?.state === 'degradada') && (
        <>
          <span className="strategy-status strategy-degraded">Degradada</span>
          <p>{row?.reason ?? 'Motivo de degradación pendiente de consulta.'}</p>
          <p>
            Última revisión:{' '}
            {row?.lastReviewedAt ? (
              <time dateTime={row.lastReviewedAt}>{date(row.lastReviewedAt)}</time>
            ) : (
              'Sin fecha de revisión disponible'
            )}
          </p>
        </>
      )}
      <a href="#salud-modelos">Salud de modelos</a>
    </section>
  );
}
