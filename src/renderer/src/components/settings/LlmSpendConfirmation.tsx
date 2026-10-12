import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import './broker-settings.css';

export function LlmSpendConfirmation({
  budget,
  cap,
  accept,
  close,
}: {
  budget: number;
  cap: number;
  accept: () => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const safe = useRef<HTMLButtonElement>(null);
  const amount = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(
    budget,
  );
  useEffect(() => {
    safe.current?.focus();
    const app = document.querySelector<HTMLElement>('.app');
    const previous = app?.inert;
    if (app) app.inert = true;
    return () => {
      if (app) app.inert = previous ?? false;
    };
  }, []);
  return createPortal(
    <div className="broker-modal-backdrop">
      <div
        ref={dialog}
        className="broker-disconnect-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="llm-spend-title"
        aria-describedby="llm-spend-help"
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
          if (event.key === 'Tab') {
            const buttons = dialog.current?.querySelectorAll<HTMLButtonElement>('button');
            const first = buttons?.[0];
            const last = buttons?.[1];
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
        <h2 id="llm-spend-title">Confirmar gasto del LLM</h2>
        <p>
          Máximo diario: {cap} titulares · Tope mensual: {amount}
        </p>
        <p id="llm-spend-help">
          Este límite controla el uso de Tradia, pero no sustituye las alertas de facturación de
          Anthropic.
        </p>
        <div className="settings-actions">
          <button ref={safe} className="button" onClick={close}>
            Seguir con análisis local
          </button>
          <button className="button primary" onClick={accept}>
            Aceptar tope de {amount} al mes
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
