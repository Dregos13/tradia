import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { liveTokens } from './presentation';

export function SmokeConfirmation({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const trigger = document.activeElement as HTMLElement | null;
    const root = document.getElementById('root');
    const previous = root?.inert ?? false;
    if (root) root.inert = true;
    safe.current?.focus();
    return () => {
      if (root) root.inert = previous;
      trigger?.focus();
    };
  }, []);
  return createPortal(
    <div className="live-dialog-scope live-backdrop">
      <style>{liveTokens()}</style>
      <div
        ref={dialog}
        className="live-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
          if (event.key === 'Tab') {
            const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button');
            const first = buttons?.[0];
            const last = buttons?.[buttons.length - 1];
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
        <h2 id={`${id}-title`}>Confirmar prueba de 1,00 USD reales</h2>
        <p id={`${id}-description`}>
          Esta prueba compra una fracción de SPY, la vende y concilia el resultado. Usa dinero real.
          Puede generar pérdidas y costes.
        </p>
        <div className="live-actions">
          <button ref={safe} className="button" onClick={onCancel}>
            Cancelar
          </button>
          <button className="button live-primary" onClick={onConfirm}>
            Confirmar prueba de 1,00 USD
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
