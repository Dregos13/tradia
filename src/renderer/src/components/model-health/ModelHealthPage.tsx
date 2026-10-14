import { useState } from 'react';
import type { RetrainAction, RetrainProposal } from '../../../../shared/ai';
import { useModelHealth } from '../../hooks/useModelHealth';
import { aiTokens, Badge, date } from '../ai/presentation';
import tokens from '../../design/ai.tokens.json';
import { HealthTable, healthStates } from './HealthTable';
import { RetrainDialog } from './RetrainDialog';
import { RetrainProposals } from './RetrainProposals';
import '../ai/ai.css';
import './model-health.css';
export function ModelHealthPage() {
  const state = useModelHealth();
  const [decision, setDecision] = useState<{
    proposal: RetrainProposal;
    action: RetrainAction;
  } | null>(null);
  return (
    <div data-layout-page="salud-modelos" className="ai-page health-page" aria-busy={state.loading}>
      <style>
        {aiTokens()}
        {`.health-page{--ai-table-min:${tokens.size.healthTableMin}}.health-dialog{--health-dialog-max:${tokens.size.dialogMax}}`}
      </style>
      <header className="ai-top" data-layout-block="cabecera">
        <div>
          <h2>Salud de modelos</h2>
          <p>Drift de datos, resultados y estrategias. Tradia nunca reentrena automáticamente.</p>
        </div>
        <div>
          {state.overview?.evaluatedAt && (
            <p>
              Revisado{' '}
              <time dateTime={state.overview.evaluatedAt}>{date(state.overview.evaluatedAt)}</time>
            </p>
          )}
          <button
            className="button"
            disabled={state.loading || state.offline || state.busy}
            onClick={() => void state.reload()}
          >
            Revisar ahora
          </button>
        </div>
      </header>
      <p className="ai-notice" data-layout-block="aviso">
        Una racha mala aislada no degrada una estrategia. La degradación requiere evidencia
        sostenida y una muestra suficiente.
      </p>
      {state.offline && (
        <div className="ai-warning" role="status">
          <p>
            Sin conexión · la revisión queda pausada. Últimos resultados{' '}
            {state.overview?.evaluatedAt
              ? `de ${date(state.overview.evaluatedAt)}`
              : 'no disponibles'}
            .
          </p>
          <button className="button" onClick={() => void state.reconnect()}>
            Reintentar conexión
          </button>
        </div>
      )}
      {state.error && !decision && (
        <div className="ai-error" role="alert">
          <p>{state.error}</p>
          {state.overview && <p>Se conserva la última revisión; consulta su fecha.</p>}
          <button
            className="button"
            disabled={state.loading || state.offline}
            onClick={() => void state.reconnect()}
          >
            Reintentar
          </button>
        </div>
      )}
      {state.loading && <p role="status">Calculando salud con las últimas revisiones…</p>}
      {state.overview && (
        <>
          <section
            data-layout-block="resumen"
            className="health-summary"
            aria-label="Resumen de salud"
          >
            {Object.entries(healthStates).map(([key, value]) => (
              <div key={key}>
                <Badge kind={`health-${value.kind}`}>{value.label}</Badge>
                <strong className="ai-numeric">
                  {state.overview!.counts[key as keyof typeof healthStates]}
                </strong>
              </div>
            ))}
          </section>
          <p className="health-visually-hidden" role="status">
            Revisión de salud completada. {state.overview.counts.degradada} sujetos requieren
            atención.
          </p>
        </>
      )}
      {(!state.loading || state.overview) && (
        <>
          <HealthTable rows={state.overview?.subjects ?? []} />
          <RetrainProposals
            proposals={state.overview?.proposals ?? []}
            disabled={state.offline || state.busy || state.loading || !!state.error}
            onDecide={(proposal, action) => setDecision({ proposal, action })}
          />
        </>
      )}
      {state.instructions && (
        <section
          className="ai-section"
          data-layout-block="seccion"
          aria-labelledby="retrain-instructions"
        >
          <h3 id="retrain-instructions">Pasos del reentrenamiento fuera de la app</h3>
          <p role="status">
            Propuesta aprobada. Ejecuta el pipeline externo y verifica la nueva ficha antes de usar
            el modelo.
          </p>
          <pre className="health-instructions">{state.instructions}</pre>
        </section>
      )}
      {decision && (
        <RetrainDialog
          {...decision}
          busy={state.busy}
          offline={state.offline}
          error={state.error}
          onCancel={() => setDecision(null)}
          onConfirm={async (request) => {
            if (await state.resolve(request)) setDecision(null);
          }}
        />
      )}
    </div>
  );
}
