import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { KILL_SWITCH_CAUSE_MESSAGES, type KillSwitchState } from '../../../../shared/risk';
import './risk.css';

export function stopSummary(state: KillSwitchState) {
  const cause =
    state.cause === 'manual'
      ? 'Parada manual'
      : state.cause
        ? KILL_SWITCH_CAUSE_MESSAGES[state.cause]
        : 'Parada activa';
  const time = state.activatedAt
    ? new Date(state.activatedAt).toLocaleString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
      })
    : 'Hora no disponible';
  return `${cause} · ${time} · Activada por ${state.actor === 'usuario' ? 'Tú' : 'Sistema'}`;
}

export function KillSwitchControl({
  state,
  onChange,
  summary,
}: {
  state?: KillSwitchState;
  summary?: ReactNode;
  onChange: (state: KillSwitchState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState<'stop' | 'resume' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const busy = useRef(false);
  const requestResume = () => {
    trigger.current = document.activeElement as HTMLElement;
    setError(null);
    setOpen(true);
  };
  useEffect(() => {
    if (!open) return;
    cancel.current?.focus();
    const app = document.querySelector<HTMLElement>('.app');
    const wasInert = app?.inert;
    if (app) app.inert = true;
    return () => {
      if (app) app.inert = wasInert ?? false;
      const target = trigger.current?.isConnected ? trigger.current : stopButton.current;
      target?.focus();
      if (document.activeElement !== target) window.setTimeout(() => target?.focus(), 0);
    };
  }, [open]);
  useEffect(() => {
    if (state && !state.active) setOpen(false);
  }, [state]);
  const act = async (resume: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setPending(resume ? 'resume' : 'stop');
    setError(null);
    try {
      const next = resume
        ? await window.tradia.risk.resumeKillSwitch({ confirm: true })
        : await window.tradia.risk.activateKillSwitch();
      onChange(next);
      if (resume) setOpen(false);
    } catch {
      setError(
        resume
          ? 'No se pudo reanudar. La parada sigue activa. Inténtalo de nuevo.'
          : 'No se pudo activar la parada. Inténtalo de nuevo.',
      );
    } finally {
      busy.current = false;
      setPending(null);
    }
  };
  return (
    <>
      <button
        ref={stopButton}
        className={`risk-stop${state?.active ? ' is-active' : ''}${pending === 'resume' ? ' is-resuming' : ''}`}
        aria-pressed={state?.active ?? false}
        aria-busy={pending !== null}
        disabled={pending !== null}
        onClick={() => (state?.active ? requestResume() : void act(false))}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 2h10l5 5v10l-5 5H7l-5-5V7Z" />
          <path d="M9 9h6v6H9Z" />
        </svg>
        {pending === 'resume'
          ? 'Reanudando…'
          : pending === 'stop'
            ? 'Activando parada…'
            : state?.active
              ? 'Parada activa'
              : 'Parada'}
      </button>
      {state?.active &&
        createPortal(
          <div className="risk-stop-banner" role="alert">
            <strong>Parada activa: {stopSummary(state)}</strong>
            {state.detail && <span>{state.detail}</span>}
            {summary}
            <div className="risk-actions">
              <a href="#riesgo">Ver en Riesgo</a>
              <button className="button" disabled={pending !== null} onClick={requestResume}>
                Reanudar
              </button>
            </div>
          </div>,
          document.getElementById('risk-global-banner') ?? document.body,
        )}
      {error && !open && (
        <p className="risk-error" role="alert">
          {error}
        </p>
      )}
      {open &&
        state &&
        createPortal(
          <div className="risk-modal-backdrop">
            <div
              className="risk-resume-dialog"
              ref={dialog}
              role="dialog"
              aria-modal="true"
              aria-labelledby="risk-resume-title"
              aria-describedby="risk-resume-description"
              onKeyDown={(event) => {
                if (event.key === 'Escape' && !busy.current) {
                  event.preventDefault();
                  setOpen(false);
                }
                if (event.key === 'Tab') {
                  const buttons =
                    dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
                  if (!buttons?.length) {
                    event.preventDefault();
                    return;
                  }
                  const first = buttons[0];
                  const last = buttons[buttons.length - 1];
                  if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last?.focus();
                  }
                  if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first?.focus();
                  }
                }
              }}
            >
              <h2 id="risk-resume-title">Confirmar reanudación</h2>
              <p id="risk-resume-description">
                Volverán a admitirse señales y órdenes. La causa de la parada seguirá en el
                registro.
              </p>
              <p className="risk-stop-summary">{stopSummary(state)}</p>
              {error && (
                <p className="risk-error" role="alert">
                  {error}
                </p>
              )}
              <div className="risk-actions">
                <button
                  ref={cancel}
                  className="button"
                  disabled={pending !== null}
                  onClick={() => setOpen(false)}
                >
                  Mantener parada
                </button>
                <button
                  className="button primary"
                  disabled={pending !== null}
                  aria-busy={pending === 'resume'}
                  onClick={() => void act(true)}
                >
                  {pending === 'resume' ? 'Reanudando…' : 'Confirmar y reanudar'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
