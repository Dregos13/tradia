import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  liveConfirmationPhrase,
  livePhraseMatches,
  type LiveLimits,
} from '../../../../shared/live';
import { LIMIT_FIELDS } from './LimitsForm';
import { liveTokens, usd } from './presentation';

export function LiveActivationDialog({
  limits,
  account,
  busy,
  onCancel,
  onConfirm,
}: {
  limits: LiveLimits;
  account: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (phrase: string) => Promise<void>;
}) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [phrase, setPhrase] = useState('');
  const [touched, setTouched] = useState(false);
  const valid = livePhraseMatches(phrase, limits);
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
    <div className="live-dialog-scope live-backdrop">
      <style>{liveTokens()}</style>
      <div
        ref={dialog}
        className="live-dialog"
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-risk`}
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!busy) onCancel();
          }
          if (event.key === 'Tab') {
            const controls = dialog.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), textarea:not(:disabled)',
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
        <h2 id={`${id}-title`}>Confirmar activación de dinero real</h2>
        <div id={`${id}-risk`}>
          <p>Las órdenes usan capital real y pueden generar pérdidas.</p>
          <p>
            Riesgo conserva el veto. Sin conexión, con la parada activa o si deja de cumplirse un
            requisito automático, las órdenes nuevas se suspenden.
          </p>
        </div>
        <p>
          Broker: <strong>Alpaca Live · cuenta {account}</strong>
        </p>
        <dl className="live-confirm-facts">
          {LIMIT_FIELDS.map(({ key, label }) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{key === 'openPositions' ? limits[key] : usd(limits[key])}</dd>
            </div>
          ))}
        </dl>
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (!busy && valid) void onConfirm(phrase);
          }}
        >
          <label htmlFor={`${id}-phrase`}>Escribe exactamente esta frase para confirmar</label>
          <p className="live-phrase" id={`${id}-expected`}>
            {liveConfirmationPhrase(limits)}
          </p>
          <textarea
            id={`${id}-phrase`}
            value={phrase}
            rows={4}
            disabled={busy}
            required
            autoComplete="off"
            spellCheck={false}
            aria-invalid={touched && !valid}
            aria-describedby={`${id}-expected${touched && !valid ? ` ${id}-error` : ''}`}
            onBlur={() => setTouched(true)}
            onChange={(event) => {
              setPhrase(event.target.value);
              setTouched(true);
            }}
          />
          {touched && !valid && (
            <p className="live-field-error" id={`${id}-error`} role="alert">
              La frase no coincide con los límites guardados. Respeta mayúsculas, cifras y acentos.
            </p>
          )}
          {busy && <p role="status">Comprobando requisitos y límites en el proceso principal…</p>}
          <div className="live-actions">
            <button
              ref={cancel}
              className="button"
              type="button"
              disabled={busy}
              onClick={onCancel}
            >
              Cancelar y seguir en paper
            </button>
            <button className="button live-primary" type="submit" disabled={busy || !valid}>
              Activar dinero real con estos límites
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
