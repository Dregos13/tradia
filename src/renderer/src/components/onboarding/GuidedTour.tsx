import { useEffect, useRef, type KeyboardEvent } from 'react';
import { TOUR_STEPS } from './tourSteps';
import { useTourAnchor } from './useTourAnchor';

interface Props {
  step: number;
  onMove: (step: number) => void;
  onPause: () => void;
  onFinish: (skipped: boolean, addKeys?: boolean) => void;
}
export function GuidedTour({ step, onMove, onPause, onFinish }: Props) {
  const current = TOUR_STEPS[step - 1]!;
  const dialog = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  const { rect, loading, position } = useTourAnchor(step, dialog);
  useEffect(() => {
    title.current?.focus();
  }, [step]);
  useEffect(() => {
    const siblings = Array.from(document.body.children).filter(
      (element): element is HTMLElement =>
        element instanceof HTMLElement && !element.classList.contains('onboarding-root'),
    );
    const previous = siblings.map((element) => element.hasAttribute('inert'));
    siblings.forEach((element) => element.setAttribute('inert', ''));
    const keepFocus = (event: FocusEvent) => {
      if (dialog.current && event.target instanceof Node && !dialog.current.contains(event.target))
        title.current?.focus();
    };
    document.addEventListener('focusin', keepFocus);
    return () => {
      siblings.forEach((element, index) => {
        if (!previous[index]) element.removeAttribute('inert');
      });
      document.removeEventListener('focusin', keepFocus);
    };
  }, []);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onPause();
      return;
    }
    const textInput =
      event.target instanceof HTMLElement &&
      event.target.matches('input, textarea, select, [contenteditable="true"]');
    if (!textInput && (event.key === 'ArrowRight' || event.key === 'ArrowLeft')) {
      event.preventDefault();
      if (event.key === 'ArrowRight' && step < TOUR_STEPS.length) onMove(step + 1);
      if (event.key === 'ArrowLeft' && step > 1) onMove(step - 1);
    }
    if (event.key !== 'Tab') return;
    const buttons = Array.from(
      dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
    );
    const first = buttons[0];
    const last = buttons.at(-1);
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === title.current)
    ) {
      event.preventDefault();
      last?.focus();
    } else if (
      !event.shiftKey &&
      (document.activeElement === last || document.activeElement === title.current)
    ) {
      event.preventDefault();
      first?.focus();
    }
  }
  const final = step === TOUR_STEPS.length;
  return (
    <>
      <div className={`tour-veil${rect ? ' has-spotlight' : ''}`} aria-hidden="true" />
      {rect && <div className="tour-spotlight" aria-hidden="true" style={rect} />}
      <div
        ref={dialog}
        className="tour-popover"
        style={position}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-description"
        aria-busy={loading}
        onKeyDown={onKeyDown}
      >
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {`Paso ${step} de ${TOUR_STEPS.length}. ${current.title}. ${current.text}`}
        </p>
        <div className="tour-header">
          <span className="tour-label" aria-hidden="true">
            Paso {step} de {TOUR_STEPS.length}
          </span>
          <button
            className="tour-close"
            aria-label="Cerrar el tour y retomarlo más tarde"
            onClick={onPause}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <h2 key={step} id="tour-title" ref={title} tabIndex={-1}>
          <span className="sr-only">{`Paso ${step} de ${TOUR_STEPS.length}. `}</span>{' '}
          {current.title}
        </h2>
        <p id="tour-description">{current.text}</p>
        <div className="tour-progress" aria-hidden="true">
          {TOUR_STEPS.map((_, index) => (
            <span key={index} className={index < step ? 'is-done' : undefined} />
          ))}
        </div>
        <div className="tour-actions">
          {!final && (
            <button className="tour-skip" onClick={() => onFinish(true)}>
              Saltar tour
            </button>
          )}
          {step > 1 && (
            <button className="button" onClick={() => onMove(step - 1)}>
              Atrás
            </button>
          )}
          {final ? (
            <>
              <button className="button" onClick={() => onFinish(false)}>
                Terminar
              </button>
              <button className="button primary" onClick={() => onFinish(false, true)}>
                Terminar y añadir claves
              </button>
            </>
          ) : (
            <button className="button primary" onClick={() => onMove(step + 1)}>
              {step === 1 ? 'Empezar' : 'Siguiente'}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
