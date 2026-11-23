import { DataFreshness } from '../DataFreshness';
import { useDataFreshness } from '../../hooks/useDataFreshness';
import { useAi } from '../../hooks/useAi';
import { ModelCard } from './ModelCard';
import { PredictionsTable } from './PredictionsTable';
import { RegimePanel } from './RegimePanel';
import { StrategyRegimeTable } from './StrategyRegimeTable';
import { aiTokens, date } from './presentation';
import './ai.css';
export interface AiPageProps {
  onOpenStrategy?: (id: number) => void;
  onOpenMarketSources?: () => void;
}
export function AiPage({ onOpenStrategy, onOpenMarketSources }: AiPageProps = {}) {
  const state = useAi();
  const { summary } = useDataFreshness();
  const paused =
    !!state.overview?.stale ||
    (!!summary && summary.state !== 'current' && summary.state !== 'no-data');
  const pauseReason =
    summary?.state === 'catching-up' ? 'puesta al día en curso' : 'datos desactualizados';
  const hasData = !!state.overview || state.predictions.length > 0 || !!state.model;
  const modelUnavailable = state.errors.some((error) => error.includes('ficha del modelo'));
  return (
    <div data-layout-page="ia" className="ai-page" aria-busy={state.loading}>
      <style>{aiTokens()}</style>
      <header className="ai-top" data-layout-block="cabecera">
        <div>
          <h2>IA</h2>
          <p>Régimen, probabilidades calibradas y decisiones de estrategia al cierre diario.</p>
        </div>
        <div>
          {state.overview?.computedAt && (
            <p>
              Instantánea calculada{' '}
              <time dateTime={state.overview.computedAt}>{date(state.overview.computedAt)}</time>
            </p>
          )}
          <button
            className="button"
            disabled={state.loading || state.offline}
            onClick={() => void state.reload()}
          >
            Actualizar
          </button>
        </div>
      </header>
      <DataFreshness
        layoutBlock="frescura"
        offline={state.offline}
        snapshotSessionDate={state.overview?.market?.sessionDate}
      />
      <p className="ai-notice" data-layout-block="aviso">
        Son estimaciones, no certezas. Los modelos no crean señales por sí solos y nunca evitan el
        motor de riesgo.
      </p>
      {state.offline && (
        <div className="ai-warning" role="status">
          <p>
            Sin conexión · régimen y predicciones congelados{' '}
            {state.overview?.computedAt
              ? `desde ${date(state.overview.computedAt)}`
              : 'sin una instantánea disponible'}
            . No se evaluarán señales nuevas.
          </p>
          <p>Ficha local · no se pudo comprobar si existe una versión posterior.</p>
          <button className="button" onClick={() => void state.reconnect()}>
            Reintentar conexión
          </button>
        </div>
      )}
      {!!state.errors.length && (
        <div className="ai-error" role="alert">
          <p>
            {hasData ? 'No se pudo actualizar toda la página IA' : 'No se pudo cargar la página IA'}
          </p>
          {state.errors.map((error) => (
            <p key={error}>{error}</p>
          ))}
          <button
            className="button"
            disabled={state.offline}
            onClick={() =>
              void (state.errors.some((error) => error.includes('conexión'))
                ? state.reconnect()
                : state.reload())
            }
          >
            Reintentar
          </button>
          {hasData && <p>Se conserva la última instantánea; consulta las fechas de cada bloque.</p>}
          {onOpenMarketSources && (
            <button className="button" onClick={onOpenMarketSources}>
              Ver estado de fuentes
            </button>
          )}
        </div>
      )}
      {state.loading && <div role="status">Cargando régimen y estimaciones…</div>}
      {state.loading && !hasData ? (
        <div className="ai-skeleton" aria-hidden="true">
          <div />
          <div />
          <div />
        </div>
      ) : (
        <>
          <RegimePanel
            overview={state.overview}
            summary={summary}
            offline={state.offline}
            pauseReason={paused ? pauseReason : undefined}
          />
          {paused ? (
            <section
              className="ai-section"
              data-layout-block="seccion"
              aria-label="Estrategias por régimen"
            >
              <h3>Estrategias por régimen</h3>
              <p>En pausa: un régimen caducado no habilita ni desactiva estrategias.</p>
            </section>
          ) : (
            <StrategyRegimeTable
              strategies={state.overview?.strategies ?? []}
              onOpenStrategy={onOpenStrategy}
            />
          )}
          <PredictionsTable
            predictions={state.predictions}
            model={state.model}
            summary={summary}
            offline={state.offline}
            pauseReason={paused ? pauseReason : undefined}
            modelUnavailable={modelUnavailable}
            expectedSessionDate={state.overview?.expectedSessionDate ?? null}
          />
          <ModelCard model={state.model} unavailable={modelUnavailable} />
          {onOpenMarketSources && !state.overview?.market && (
            <button className="button" onClick={onOpenMarketSources}>
              Revisar fuentes de mercado
            </button>
          )}
        </>
      )}
    </div>
  );
}
