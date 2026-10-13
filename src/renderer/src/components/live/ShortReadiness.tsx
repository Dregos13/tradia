import { useId } from 'react';
import {
  LIVE_SHORT_REQUIREMENTS,
  type LiveChecklist,
  type LiveDeclareRequest,
} from '../../../../shared/live';
import { DeclarationForm } from './DeclarationForm';
import { LiveIcon, RequirementStatus, timestamp } from './presentation';

export function shortLimitsBlockReason(
  checklist: LiveChecklist | undefined,
  loading: boolean,
  error: string,
  offline: boolean,
) {
  if (loading) return 'Comprobando los requisitos del corto…';
  if (error)
    return 'No se pudieron comprobar los requisitos del corto. Los límites permanecen bloqueados.';
  if (offline) return 'Sin conexión · los límites del corto permanecen bloqueados.';
  return checklist?.short?.allComplete
    ? undefined
    : (checklist?.short?.blockReason ??
        'Completa los requisitos del corto antes de fijar límites mayores que 0.');
}

export function ShortReadiness({
  checklist,
  loading,
  disabled,
  blocked,
  savedShort,
  onDeclare,
  onReload,
}: {
  checklist?: LiveChecklist;
  loading: boolean;
  disabled: boolean;
  blocked: boolean;
  savedShort: boolean;
  onDeclare: (request: LiveDeclareRequest) => Promise<boolean>;
  onReload: () => void;
}) {
  const id = useId();
  const paperEvidence = checklist?.short?.items.find(
    (item) => item.requirement === 'paper-cortos',
  )?.evidence;
  // Reorder the three supplied evidence segments; no progress is inferred locally.
  const segments = paperEvidence?.split(' · ');
  const orderedPaperEvidence =
    segments?.length === 3 &&
    segments[0]?.includes('cortos cerrados') &&
    segments[1]?.includes('semanas')
      ? [segments[1], segments[0], segments[2]].join(' · ')
      : paperEvidence;
  return (
    <section
      className="live-sheet live-short-readiness"
      aria-labelledby={`${id}-title`}
      aria-busy={loading}
    >
      <h3 id={`${id}-title`}>Preparación del corto con dinero real</h3>
      <p>
        El corto nace desactivado: sus tres límites están a 0. La revisión general no sustituye la
        revisión específica del corto.
      </p>
      <p className={`live-mode-status${!blocked ? ' live-mode-ready' : ''}`}>
        <LiveIcon kind={blocked ? 'lock' : 'cumplido'} />
        {loading
          ? 'Comprobando los requisitos del corto…'
          : blocked
            ? 'Corto real bloqueado'
            : 'Ya puedes fijar límites del corto mayores que 0.'}
      </p>
      {savedShort && blocked && (
        <p className="live-warning">
          Tus límites del corto siguen guardados, pero las nuevas entradas en corto real están
          bloqueadas. Cumple de nuevo los requisitos y confirma otra vez la frase antes de operar.
        </p>
      )}
      {loading ? (
        <div className="live-skeleton" aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <div key={row} />
          ))}
        </div>
      ) : (
        <ul className="live-checklist">
          <li className="live-checklist-row">
            <div>
              <RequirementStatus state="revisar" />
              <p className="live-origin">
                <LiveIcon kind="lock" />
                Cuenta de Alpaca
              </p>
            </div>
            <div>
              <h4>Cuenta Alpaca preparada para ventas en corto</h4>
              <p>
                Activa en Alpaca la cuenta live con margen y el corto, con al menos 2.000,00 USD de
                capital, aunque la app use menos. El estado de margen, permiso de corto y capital no
                está disponible en esta pantalla; revísalo en Alpaca.
              </p>
              <a className="live-link" href="#ajustes?seccion=broker-live">
                Revisar conexión live
              </a>
            </div>
          </li>
          {LIVE_SHORT_REQUIREMENTS.map((requirement) => {
            const item = checklist?.short?.items.find((row) => row.requirement === requirement);
            const manual = requirement === 'revision-legal-corto';
            return (
              <li className="live-checklist-row" key={requirement}>
                <div>
                  <RequirementStatus state={item?.state ?? 'revisar'} />
                  <p className="live-origin">
                    {!manual && <LiveIcon kind="lock" />}
                    {manual ? 'Declaración del usuario' : 'Verificación automática'}
                  </p>
                </div>
                <div>
                  <h4>
                    {manual
                      ? 'Revisión legal y fiscal específica del corto'
                      : 'Cortos en paper durante al menos 4 semanas y 5 operaciones cerradas'}
                  </h4>
                  <p>
                    {(manual ? item?.evidence : orderedPaperEvidence) ??
                      (manual
                        ? 'Todavía no has guardado la declaración específica del corto.'
                        : 'No se pudo verificar la evidencia de cortos en paper.')}
                  </p>
                  {item?.markedAt && (
                    <p className="live-meta">
                      {manual ? 'Declaración guardada el ' : 'Evaluado el '}
                      <time dateTime={item.markedAt}>{timestamp(item.markedAt)}</time>.
                    </p>
                  )}
                  {manual && item ? (
                    <DeclarationForm
                      key={`${item.state}-${item.markedAt}-${item.declarationDetail}`}
                      item={item}
                      requirement="revision-legal-corto"
                      disabled={disabled}
                      onDeclare={onDeclare}
                    />
                  ) : (
                    !manual && (
                      <a className="live-link" href="#ordenes?modo=paper">
                        Ver órdenes paper
                      </a>
                    )
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <button className="button" type="button" disabled={disabled && loading} onClick={onReload}>
        Reintentar comprobación
      </button>
    </section>
  );
}
