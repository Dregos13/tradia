import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RetrainAction, RetrainProposal, RetrainResolveRequest } from '../../../../shared/ai';
import dialogTokens from '../../design/dashboard.tokens.json';
import tokens from '../../design/ai.tokens.json';
import { aiTokens } from '../ai/presentation';
export function RetrainDialog({
  proposal,
  action,
  busy,
  offline,
  error,
  onCancel,
  onConfirm,
}: {
  proposal: RetrainProposal;
  action: RetrainAction;
  busy: boolean;
  offline: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: (request: RetrainResolveRequest) => Promise<void>;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const [until, setUntil] = useState('');
  const [note, setNote] = useState('');
  const [validation, setValidation] = useState('');
  const title = useId();
  const description = useId();
  const today = new Date();
  const todayDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const root = document.getElementById('root');
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;
    cancel.current?.focus();
    return () => {
      if (root) root.inert = wasInert;
      trigger?.focus();
    };
  }, []);
  useEffect(() => {
    if (busy) dialog.current?.focus();
  }, [busy]);
  return createPortal(
    <div className="ai-page health-backdrop">
      <style>
        {aiTokens()}
        {`.health-dialog{--health-dialog-max:${tokens.size.dialogMax}}.health-backdrop{--health-overlay:${dialogTokens.color.overlay.light}}@media(prefers-color-scheme:dark){.health-backdrop{--health-overlay:${dialogTokens.color.overlay.dark}}}`}
      </style>
      <div
        className="health-dialog"
        ref={dialog}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        aria-describedby={description}
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!busy) onCancel();
          }
          if (event.key === 'Tab') {
            const controls = dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled)',
            );
            if (!controls?.length) {
              event.preventDefault();
              return;
            }
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === dialog.current)
            ) {
              event.preventDefault();
              last?.focus();
            }
            if (
              !event.shiftKey &&
              (document.activeElement === last || document.activeElement === dialog.current)
            ) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2 id={title}>
          {action === 'aprobar'
            ? 'Confirmar aprobación del reentrenamiento'
            : 'Confirmar aplazamiento'}
        </h2>
        <p id={description}>{proposal.reason}</p>
        <p>
          Reentrenar no sustituye la validación fuera de muestra. La nueva versión no se activa
          sola. El pipeline se ejecuta fuera de la app.
        </p>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || offline) return;
            if (
              action === 'posponer' &&
              (!/^\d{4}-\d{2}-\d{2}$/.test(until) || until <= todayDate || !note.trim())
            ) {
              setValidation('Indica una fecha futura y el motivo para posponer.');
              return;
            }
            setValidation('');
            void onConfirm({
              id: proposal.id,
              action,
              ...(action === 'posponer' ? { postponeUntil: until, note: note.trim() } : {}),
            });
          }}
        >
          {action === 'posponer' && (
            <fieldset disabled={busy}>
              <legend>Fecha y motivo</legend>
              <label>
                Posponer hasta
                <input
                  type="date"
                  value={until}
                  min={todayDate}
                  required
                  aria-invalid={!!validation}
                  onChange={(event) => setUntil(event.target.value)}
                />
              </label>
              <label>
                Motivo
                <textarea
                  required
                  maxLength={2000}
                  value={note}
                  aria-invalid={!!validation}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
            </fieldset>
          )}
          {(validation || error) && (
            <p className="ai-error" role="alert">
              {validation || error}
            </p>
          )}
          {offline && <p role="status">Sin conexión. Recupera la conexión antes de confirmar.</p>}
          {busy && <p role="status">Guardando decisión…</p>}
          <div className="health-actions">
            <button
              ref={cancel}
              type="button"
              className="button"
              disabled={busy}
              onClick={onCancel}
            >
              Cancelar
            </button>
            <button type="submit" className="button primary" disabled={busy || offline}>
              {action === 'aprobar' ? 'Confirmar aprobación' : 'Confirmar aplazamiento'}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
