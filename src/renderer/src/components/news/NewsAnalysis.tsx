import { useCallback } from 'react';
import { useIpcList } from '../../hooks/useIpcList';
import { date } from '../ai/presentation';

const sentiments = {
  positivo: ['favorable', 'Favorable'],
  negativo: ['unfavorable', 'Desfavorable'],
  neutro: ['neutral', 'Neutral'],
  mixto: ['mixed', 'Mixto'],
} as const;
const subscribe = (reload: () => void) =>
  window.tradia.ai.onChanged((event) => {
    if (event.kind === 'noticias') reload();
  });

export function NewsAnalysis({ id, offline }: { id: number; offline: boolean }) {
  const read = useCallback(() => window.tradia.ai.newsAnalysis({ newsItemId: id }), [id]);
  const data = useIpcList(read, subscribe, 'No se pudo analizar este titular.', true);
  return (
    <section className="news-analysis" aria-label="Análisis automático" aria-busy={data.loading}>
      <h4>Análisis automático</h4>
      {data.loading && (
        <div className="news-analysis-skeleton" role="status">
          Analizando titular confirmado…
          <div />
          <div />
        </div>
      )}
      {data.error ? (
        <div role="alert">
          <p>{data.error} El titular y su fuente siguen disponibles.</p>
          <button className="button" onClick={() => void data.reload()}>
            Reintentar análisis
          </button>
        </div>
      ) : (
        !data.loading &&
        !data.items.length && (
          <p role="status">
            {offline ? 'Pendiente de conexión' : 'Sin análisis disponible para este titular.'}
          </p>
        )
      )}
      {!data.error &&
        data.items.map((analysis) => {
          const [kind, label] = sentiments[analysis.sentiment];
          return (
            <div key={analysis.id} className="news-analysis-asset">
              <span className={`news-badge news-sentiment-${kind}`}>
                {analysis.ticker} · Sentimiento {label}
              </span>
              <p className="news-summary">
                <strong>Resumen automático:</strong> {analysis.summary}
              </p>
              <p className="news-muted">
                Método:{' '}
                {analysis.analyzer === 'llm'
                  ? `LLM · ${analysis.model ?? 'modelo no informado'}`
                  : analysis.analyzer === 'suscripcion'
                    ? 'Suscripción (Claude Code)'
                    : 'Análisis local'}{' '}
                · Analizado: <time dateTime={analysis.analyzedAt}>{date(analysis.analyzedAt)}</time>
              </p>
            </div>
          );
        })}
      <p className="news-muted">
        Puede ajustar la confianza de una señal existente. No crea señales y Riesgo conserva el
        veto.
      </p>
    </section>
  );
}
