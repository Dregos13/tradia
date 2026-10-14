import { useOnboarding } from './OnboardingProvider';
import { TOUR_STEPS } from './tourSteps';

export function TourHelp() {
  const tour = useOnboarding();
  if (!tour) return null;
  return (
    <section
      data-layout-block="ayuda"
      className="settings-section"
      aria-labelledby="tour-help-title"
    >
      <div>
        <h2 id="tour-help-title">Ayuda</h2>
        <p>Conoce las secciones principales de Tradia en 2 minutos.</p>
      </div>
      <div className="settings-panel">
        {tour.pausedStep !== null && (
          <p>
            <button id="tour-resume" className="button" onClick={tour.resume}>
              Retomar el tour (paso {tour.pausedStep} de {TOUR_STEPS.length})
            </button>
          </p>
        )}
        <button id="tour-restart" className="button" onClick={tour.restart}>
          Ver el tour de nuevo
        </button>
      </div>
    </section>
  );
}
