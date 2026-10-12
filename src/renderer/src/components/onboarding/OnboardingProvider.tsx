import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ONBOARDING_TOUR_VERSION } from '../../../../shared/ipc';
import { GuidedTour } from './GuidedTour';
import { navigateAndFocus, readTourStep, saveTourStep } from './storage';
import { onboardingTokenStylesheet } from './onboardingTokens';
import { TOUR_STEPS } from './tourSteps';
import './onboarding.css';

interface Onboarding {
  open: boolean;
  pausedStep: number | null;
  restart: () => void;
  resume: () => void;
}
const Context = createContext<Onboarding | null>(null);
export const useOnboarding = () => useContext(Context);

export function OnboardingProvider({ children }: { children: ReactNode }) {
  const [step, setStep] = useState<number | null>(null);
  const [pausedStep, setPausedStep] = useState(readTourStep);
  const [requestedStep, setRequestedStep] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const interacted = useRef(false);
  const restartSaved = useRef<Promise<unknown>>(Promise.resolve());
  const trigger = useRef<HTMLElement | null>(null);
  const fromSettings = useRef(false);
  useEffect(() => {
    let active = true;
    void window.tradia.settings
      .get()
      .then((settings) => {
        if (
          !interacted.current &&
          active &&
          (settings.onboardingTourVersion !== ONBOARDING_TOUR_VERSION ||
            !settings.onboardingTourCompletedAt)
        ) {
          setRequestedStep(readTourStep() ?? 1);
        }
      })
      .catch(() => {
        if (active) setMessage('No pudimos cargar el tour. Puedes abrirlo desde Inicio o Ajustes.');
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (requestedStep === null) return;
    const start = () => {
      const blocking = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"], [role="alertdialog"], .risk-shell',
        ),
      ).some(
        (element) =>
          !element.closest('[hidden], [aria-hidden="true"]') &&
          getComputedStyle(element).display !== 'none',
      );
      if (blocking) return;
      saveTourStep(requestedStep);
      setStep(requestedStep);
      setRequestedStep(null);
    };
    const observer = new MutationObserver(start);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role', 'hidden', 'aria-hidden', 'style'],
    });
    start();
    return () => observer.disconnect();
  }, [requestedStep]);
  function restoreFocus(addKeys = false) {
    if (addKeys) {
      navigateAndFocus('ajustes', '#tiingo-key');
      return;
    }
    if (fromSettings.current && !trigger.current?.isConnected) {
      navigateAndFocus('ajustes', '#tour-resume, #tour-restart');
      trigger.current = null;
      fromSettings.current = false;
      return;
    }
    requestAnimationFrame(() => {
      const target = trigger.current?.isConnected
        ? trigger.current
        : document.querySelector<HTMLElement>('.top h1');
      target?.focus();
      trigger.current = null;
    });
  }
  function pause() {
    interacted.current = true;
    if (step === null) return;
    saveTourStep(step);
    setPausedStep(step);
    setMessage(
      `Tour en pausa en el paso ${step} de ${TOUR_STEPS.length}. Retómalo desde Inicio o Ajustes.`,
    );
    setStep(null);
    restoreFocus();
  }
  async function finish(skipped: boolean, addKeys = false) {
    interacted.current = true;
    setStep(null);
    setPausedStep(null);
    saveTourStep(null);
    setMessage(
      skipped
        ? 'Tour omitido. Puedes verlo cuando quieras en Ajustes.'
        : 'Tour completado. Puedes verlo cuando quieras en Ajustes.',
    );
    restoreFocus(addKeys);
    try {
      await restartSaved.current;
      const saved = await window.tradia.settings.set({
        onboardingTourVersion: ONBOARDING_TOUR_VERSION,
      });
      if (
        saved.onboardingTourVersion !== ONBOARDING_TOUR_VERSION ||
        !saved.onboardingTourCompletedAt
      )
        throw new Error('Tour no confirmado');
    } catch {
      setMessage(
        'No pudimos guardar que has visto el tour; puede volver a aparecer la próxima vez.',
      );
    }
  }
  function launch(restart: boolean) {
    interacted.current = true;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    fromSettings.current = Boolean(trigger.current?.closest('[aria-labelledby="tour-help-title"]'));
    setMessage('');
    setRequestedStep(restart ? 1 : (readTourStep() ?? 1));
    // Reiniciar permite reanudar también después de cerrar la app durante una repetición.
    if (restart)
      restartSaved.current = window.tradia.settings
        .set({ onboardingTourVersion: null })
        .catch(() => {
          setMessage(
            'No pudimos guardar el reinicio del tour; puedes volver a abrirlo desde Ajustes.',
          );
        });
  }
  return (
    <Context.Provider
      value={{
        open: step !== null,
        pausedStep,
        restart: () => launch(true),
        resume: () => launch(false),
      }}
    >
      <style>{onboardingTokenStylesheet()}</style>
      {children}
      {createPortal(
        <div className="onboarding-root">
          <p className="sr-only" role="status">
            {message}
          </p>
          {step !== null && (
            <GuidedTour
              step={step}
              onMove={(next) => {
                saveTourStep(next);
                setStep(next);
              }}
              onPause={pause}
              onFinish={(skipped, addKeys) => void finish(skipped, addKeys)}
            />
          )}
        </div>,
        document.body,
      )}
    </Context.Provider>
  );
}
