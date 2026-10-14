import { TOUR_STEPS } from './tourSteps';

const STEP_KEY = 'tradia.tour.step';
export const FIRST_STEPS_HIDDEN_KEY = 'tradia.firstSteps.hidden';

export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // El tour sigue funcionando aunque el almacenamiento local esté deshabilitado.
  }
}
export function readTourStep(): number | null {
  const stored = readStorage(STEP_KEY);
  const step = stored === null ? NaN : Number(stored);
  return Number.isInteger(step) && step >= 1 && step <= TOUR_STEPS.length ? step : null;
}
export function saveTourStep(step: number | null) {
  writeStorage(STEP_KEY, step === null ? null : String(step));
}

/** Espera al montaje por hash y al foco de App, sin introducir otra ruta. */
export function navigateAndFocus(route: string, selector: string) {
  window.location.hash = route;
  const observer = new MutationObserver(find);
  function find() {
    const target = document.querySelector<HTMLElement>(selector);
    if (!target || target.matches(':disabled')) return;
    observer.disconnect();
    window.clearTimeout(timer);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        let parent = target.parentElement;
        while (parent) {
          if (parent instanceof HTMLDetailsElement) parent.open = true;
          parent = parent.parentElement;
        }
        target.scrollIntoView?.({ block: 'center', behavior: 'auto' });
        target.focus();
      }),
    );
  }
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled'],
  });
  const timer = window.setTimeout(() => observer.disconnect(), 1500);
  find();
}
