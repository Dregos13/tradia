import { useCallback, useEffect, useState } from 'react';

import type { ForwardSummary } from '../../../../shared/lab';
import { ForwardBoard } from '../lab/ForwardBoard';
import { signedPct, tone } from '../lab/format';
import './summary.css';

/**
 * Resumen: lo primero que ves. Cómo van tus estrategias en prueba, cuál
 * es la mejor y qué puedes hacer a continuación. Sin jerga: tres pasos,
 * mirar el mercado, crear y probar, y dar el salto con poco dinero.
 */
export function SummaryPage() {
  const [tests, setTests] = useState<ForwardSummary[]>([]);
  const [strategies, setStrategies] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [forward, library] = await Promise.all([
        window.tradia.forward.list(),
        window.tradia.strategies.list(),
      ]);
      setTests(forward);
      setStrategies(library.length);
    } catch (cause) {
      setError((cause as Error)?.message ?? 'No se pudo cargar el resumen.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const live = tests.filter((t) => t.test.status === 'activa');
  const started = tests.filter((t) => t.sessions > 0);
  const best = [...started].sort((a, b) => b.returnPct - a.returnPct)[0] ?? null;
  const total = started.reduce((sum, t) => sum + (t.equity - t.test.initialCash), 0);
  const fresh = !loading && tests.length === 0;

  return (
    <div className="summary-page" data-layout-page="resumen">
      {fresh ? (
        <section className="summary-start" aria-labelledby="summary-start-title">
          <h2 id="summary-start-title">Empieza en tres pasos</h2>
          <ol>
            <li>
              <strong>Mira el mercado</strong>
              <p>
                EUR/USD, yen, libra y oro con sus sesiones de Tokio, Londres y Nueva York, y los
                patrones que han aparecido en las velas.
              </p>
              <a className="button" href="#mesa">
                Ir al mercado
              </a>
            </li>
            <li>
              <strong>Crea y prueba una estrategia</strong>
              <p>
                Escribe la idea con tus palabras; la IA la convierte en reglas y la pruebas con el
                histórico antes de arriesgar nada.
              </p>
              <a className="button primary" href="#laboratorio">
                Crear estrategia
              </a>
            </li>
            <li>
              <strong>Déjala correr con dinero ficticio</strong>
              <p>
                Si te convence, la lanzas en prueba en vivo y aquí verás cada día cuánto lleva
                ganado o perdido.
              </p>
            </li>
          </ol>
        </section>
      ) : (
        <dl className="summary-stats" aria-label="Tus números">
          <div>
            <dt>En prueba ahora</dt>
            <dd>{loading ? '…' : live.length}</dd>
            <p>{strategies === 1 ? '1 estrategia creada' : `${strategies} estrategias creadas`}</p>
          </div>
          <div>
            <dt>Resultado conjunto</dt>
            <dd data-tone={tone(total)}>
              {loading
                ? '…'
                : new Intl.NumberFormat('es-ES', {
                    style: 'currency',
                    currency: 'USD',
                    maximumFractionDigits: 0,
                    signDisplay: 'exceptZero',
                    useGrouping: 'always' as unknown as boolean,
                  }).format(total)}
            </dd>
            <p>dinero ficticio, desde que empezaron</p>
          </div>
          <div>
            <dt>Tu mejor estrategia</dt>
            <dd data-tone={best ? tone(best.returnPct) : 'flat'}>
              {best ? signedPct(best.returnPct) : '—'}
            </dd>
            <p>{best ? best.test.strategyName : 'Aún sin sesiones cerradas'}</p>
          </div>
        </dl>
      )}

      {!fresh && (
        <ForwardBoard rows={tests} loading={loading} error={error} onRetry={() => void load()} />
      )}

      {!fresh && (
        <nav className="summary-next" aria-label="Qué hacer ahora">
          <a href="#mesa">
            <strong>Mirar el mercado</strong>
            <span>Sesiones, velas y patrones de hoy</span>
          </a>
          <a href="#laboratorio">
            <strong>Crear otra estrategia</strong>
            <span>Con IA, a partir de una idea o un patrón</span>
          </a>
          <a href="#dinero-real">
            <strong>Dinero real</strong>
            <span>Cuando una estrategia lo merezca, empezando con poco</span>
          </a>
        </nav>
      )}
    </div>
  );
}
