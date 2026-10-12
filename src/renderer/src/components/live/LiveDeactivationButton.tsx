import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { LiveState } from '../../../../shared/live';
import { liveTokens } from './presentation';

export function LiveDeactivationButton({
  label = 'Volver a paper',
  disabled = false,
  onDeactivated,
}: {
  label?: string;
  disabled?: boolean;
  onDeactivated: (state: LiveState) => void;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} className="button" disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </button>
      {open && (
        <DeactivationDialog
          onCancel={() => setOpen(false)}
          onConfirm={(state) => {
            setOpen(false);
            onDeactivated(state);
          }}
          restoreFocus={() => trigger.current?.focus()}
        />
      )}
    </>
  );
}

function DeactivationDialog({
  onCancel,
  onConfirm,
  restoreFocus,
}: {
  onCancel: () => void;
  onConfirm: (state: LiveState) => void;
  restoreFocus: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const working = useRef(false);
  const mounted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const restore = useRef(restoreFocus);
  useEffect(() => {
    mounted.current = true;
    const root = document.getElementById('root');
    const previous = root?.inert ?? false;
    if (root) root.inert = true;
    cancel.current?.focus();
    return () => {
      mounted.current = false;
      if (root) root.inert = previous;
      restore.current();
    };
  }, []);
  async function deactivate() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    dialog.current?.focus();
    try {
      const state = await window.tradia.live.deactivate();
      if (mounted.current) onConfirm(state);
    } catch {
      if (mounted.current)
        setError(
          'No se pudo desactivar dinero real. Reintenta o comprueba su estado en el broker.',
        );
    } finally {
      working.current = false;
      if (mounted.current) {
        setBusy(false);
        cancel.current?.focus();
      }
    }
  }
  return createPortal(
    <div className="live-dialog-scope live-backdrop">
      <style>{liveTokens()}</style>
      <div
        ref={dialog}
        tabIndex={-1}
        className="live-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        aria-busy={busy}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            if (!working.current) onCancel();
          }
          if (event.key === 'Tab') {
            const controls =
              dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
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
            } else if (
              !event.shiftKey &&
              (document.activeElement === last || document.activeElement === dialog.current)
            ) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2 id={`${id}-title`}>Confirmar vuelta a paper</h2>
        <p id={`${id}-description`}>
          Se desactiva el dinero real y las nuevas operaciones vuelven a paper. No cierra las
          posiciones abiertas y no sustituye a la parada de emergencia. Revisa las posiciones reales
          en el broker.
        </p>
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">Desactivando dinero real…</p>}
        <div className="live-actions">
          <button ref={cancel} className="button" disabled={busy} onClick={onCancel}>
            Cancelar
          </button>
          <button className="button live-primary" disabled={busy} onClick={() => void deactivate()}>
            Confirmar vuelta a paper
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
