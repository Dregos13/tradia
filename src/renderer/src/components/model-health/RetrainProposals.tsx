import type { RetrainAction, RetrainProposal } from '../../../../shared/ai';
import { date } from '../ai/presentation';
export function RetrainProposals({
  proposals,
  disabled,
  onDecide,
}: {
  proposals: RetrainProposal[];
  disabled: boolean;
  onDecide: (proposal: RetrainProposal, action: RetrainAction) => void;
}) {
  return (
    <section
      className="ai-section"
      data-layout-block="seccion"
      aria-labelledby="health-proposals-title"
    >
      <h3 id="health-proposals-title">Propuestas de reentrenamiento</h3>
      <p>Como máximo una propuesta por trimestre natural.</p>
      {!proposals.length && (
        <>
          <p>No hay reentrenamientos propuestos</p>
          <p>Los modelos se mantienen bajo vigilancia.</p>
        </>
      )}
      {proposals.map((proposal) => (
        <article
          className="health-proposal"
          key={proposal.id}
          aria-label={`Propuesta ${proposal.quarter}`}
        >
          <h4>
            Propuesta {proposal.quarter} · {proposal.status}
          </h4>
          <dl className="health-facts">
            <dt>Propuesto el</dt>
            <dd>
              <time dateTime={proposal.createdAt}>{date(proposal.createdAt)}</time>
            </dd>
            <dt>Motivo</dt>
            <dd>{proposal.reason}</dd>
            <dt>Datos que se usarían</dt>
            <dd>{proposal.dataScope ?? 'Pendiente de definir'}</dd>
            <dt>Último reentrenamiento</dt>
            <dd>
              {proposal.lastTrainedAt
                ? date(proposal.lastTrainedAt)
                : 'Sin reentrenamiento registrado'}
            </dd>
            <dt>Próxima fecha permitida</dt>
            <dd>{proposal.nextAllowedAt ? date(proposal.nextAllowedAt) : 'No disponible'}</dd>
            {proposal.postponedUntil && (
              <>
                <dt>Pospuesta hasta</dt>
                <dd>{date(proposal.postponedUntil)}</dd>
              </>
            )}
            {proposal.note && (
              <>
                <dt>Nota registrada</dt>
                <dd>{proposal.note}</dd>
              </>
            )}
          </dl>
          <p>
            Reentrenar no sustituye la validación fuera de muestra. La nueva versión no se activa
            sola.
          </p>
          {proposal.nextAllowedAt && (
            <p>No se propondrá otro reentrenamiento hasta {date(proposal.nextAllowedAt)}.</p>
          )}
          {proposal.status === 'pendiente' && (
            <div className="health-actions">
              <button
                className="button"
                disabled={disabled}
                onClick={() => onDecide(proposal, 'posponer')}
              >
                Posponer
              </button>
              <button
                className="button primary"
                disabled={disabled}
                onClick={() => onDecide(proposal, 'aprobar')}
              >
                Aprobar y abrir instrucciones
              </button>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
