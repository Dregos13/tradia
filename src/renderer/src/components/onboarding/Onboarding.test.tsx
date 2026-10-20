// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../../App';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { ONBOARDING_TOUR_VERSION } from '../../../../shared/ipc';
import { RISK_DISCLAIMER_VERSION } from '../../../../shared/riskDisclaimer';
import { OnboardingProvider } from './OnboardingProvider';
import { TourHelp } from './TourHelp';
import { GuidedTour } from './GuidedTour';
import { TOUR_STEPS } from './tourSteps';
import { readTourStep } from './storage';
import { onboardingTokenStylesheet } from './onboardingTokens';

let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(async () => {
  window.location.hash = '';
  localStorage.clear();
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  await simulation.api.settings.set({ disclaimerAcceptedVersion: RISK_DISCLAIMER_VERSION });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
// Margen para el primer render de <App /> cuando la suite completa corre en paralelo.
const TOUR_TIMEOUT = 3000;
const heading = async (step: number) => {
  const dialog = await screen.findByRole('dialog', {}, { timeout: TOUR_TIMEOUT });
  const title = within(dialog).getByRole('heading');
  expect(title).toHaveAccessibleName(`Paso ${step} de 10. ${TOUR_STEPS[step - 1]!.title}`);
  return title;
};
const headingFocused = (step: number) =>
  waitFor(async () => expect(await heading(step)).toHaveFocus(), { timeout: TOUR_TIMEOUT });

it('recorre las diez rutas solo con teclado, anuncia cada paso y guarda la finalización', async () => {
  vi.spyOn(simulation.api.secrets, 'hasKey').mockResolvedValue(true);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    top: 100,
    right: 300,
    bottom: 160,
    width: 200,
    height: 60,
    x: 100,
    y: 100,
    toJSON: () => ({}),
  });
  const user = userEvent.setup();
  const stop = vi.spyOn(simulation.api.risk, 'activateKillSwitch');
  const activate = vi.spyOn(simulation.api.live, 'activate');
  const { unmount } = render(<App />);
  await headingFocused(1);
  expect(within(screen.getByRole('dialog')).getByRole('status')).toHaveTextContent(
    `Paso 1 de 10. ${TOUR_STEPS[0]!.title}. ${TOUR_STEPS[0]!.text}`,
  );
  const root = document.querySelector('.app')!.closest('[inert]');
  expect(root).not.toBeNull();
  const first = screen.getByRole('button', { name: 'Cerrar el tour y retomarlo más tarde' });
  await user.tab();
  await waitFor(() => expect(first).toHaveFocus());
  await user.tab({ shift: true });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Empezar' })).toHaveFocus());
  await user.tab();
  await waitFor(() => expect(first).toHaveFocus());
  await user.tab();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Saltar tour' })).toHaveFocus());
  await user.tab();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Empezar' })).toHaveFocus());
  await user.keyboard('{Enter}');
  await headingFocused(2);
  await user.keyboard('{ArrowLeft}');
  await headingFocused(1);
  for (let step = 2; step <= 10; step++) {
    await user.keyboard('{ArrowRight}');
    await headingFocused(step);
    expect(screen.getByRole('dialog')).toHaveAccessibleDescription(TOUR_STEPS[step - 1]!.text);
    const announcement = within(screen.getByRole('dialog')).getByRole('status');
    expect(announcement).toHaveAttribute('aria-live', 'polite');
    expect(announcement).toHaveAttribute('aria-atomic', 'true');
    expect(announcement).toHaveTextContent(
      `Paso ${step} de 10. ${TOUR_STEPS[step - 1]!.title}. ${TOUR_STEPS[step - 1]!.text}`,
    );
    await waitFor(() => expect(window.location.hash).toBe(`#${TOUR_STEPS[step - 1]!.route}`));
    await waitFor(() =>
      expect(
        document.querySelector(`[data-tour="${TOUR_STEPS[step - 1]!.anchor}"]`),
      ).toBeInTheDocument(),
    );
    if ([2, 4, 9, 10].includes(step)) {
      // UXP-03: el ancla es la cabecera del bloque, no el bloque entero.
      const anchor = document.querySelector(`[data-tour="${TOUR_STEPS[step - 1]!.anchor}"]`)!;
      expect(anchor.querySelector('h2, h3')).not.toBeNull();
      expect(anchor.querySelector('table, ul, form, section, fieldset')).toBeNull();
    }
    await waitFor(() => expect(document.querySelector('.tour-spotlight')).toBeInTheDocument());
    expect(readTourStep()).toBe(step);
  }
  await user.tab();
  await user.tab();
  await user.tab();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Terminar' })).toHaveFocus());
  await user.keyboard('{Enter}');
  await waitFor(async () =>
    expect((await simulation.api.settings.get()).onboardingTourVersion).toBe(
      ONBOARDING_TOUR_VERSION,
    ),
  );
  expect((await simulation.api.settings.get()).onboardingTourCompletedAt).toBeTruthy();
  expect(readTourStep()).toBeNull();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(root).not.toHaveAttribute('inert');
  await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
  expect(stop).not.toHaveBeenCalled();
  expect(activate).not.toHaveBeenCalled();
  unmount();
  render(<App />);
  await screen.findByRole('button', { name: 'Ver el tour de nuevo' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
}, 10000);

it('Esc pausa en el paso actual, retoma desde Inicio y desde un nuevo arranque', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<App />);
  await heading(1);
  await user.keyboard('{ArrowRight}');
  await heading(2);
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(readTourStep()).toBe(2);
  expect((await simulation.api.settings.get()).onboardingTourCompletedAt).toBeNull();
  expect(
    screen.getByText('Tour en pausa en el paso 2 de 10. Retómalo desde Inicio o Ajustes.'),
  ).toHaveAttribute('role', 'status');
  await user.click(screen.getByRole('button', { name: 'Retomar el tour (paso 2 de 10)' }));
  await headingFocused(2);
  await user.keyboard('{Escape}');
  unmount();
  render(<App />);
  await headingFocused(2);
});

it('saltar no vuelve a ofrecerlo y Ajustes lo reinicia aunque ya esté visto', async () => {
  const user = userEvent.setup();
  const { unmount } = render(<App />);
  await heading(1);
  await user.click(screen.getByRole('button', { name: 'Saltar tour' }));
  await waitFor(async () =>
    expect((await simulation.api.settings.get()).onboardingTourCompletedAt).toBeTruthy(),
  );
  expect(readTourStep()).toBeNull();
  unmount();
  render(<App />);
  await screen.findByRole('navigation');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await user.click(within(screen.getByRole('navigation')).getByRole('link', { name: 'Ajustes' }));
  const restart = await screen.findByRole('button', { name: 'Ver el tour de nuevo' });
  await user.click(restart);
  await headingFocused(1);
  await user.keyboard('{Escape}');
  await waitFor(() => expect(restart).toHaveFocus());
  expect(
    screen.getByRole('button', { name: 'Retomar el tour (paso 1 de 10)' }),
  ).toBeInTheDocument();
});

it('espera a que se cierre otro diálogo antes de abrirse', async () => {
  const { rerender } = render(
    <OnboardingProvider>
      <div role="alertdialog">Confirmación pendiente</div>
      <TourHelp />
    </OnboardingProvider>,
  );
  await act(async () => {});
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  rerender(
    <OnboardingProvider>
      <TourHelp />
    </OnboardingProvider>,
  );
  await headingFocused(1);
});

it('ofrece una versión nueva y reanuda un paso guardado válido', async () => {
  await simulation.api.settings.set({ onboardingTourVersion: 'anterior' });
  localStorage.setItem('tradia.tour.step', '3');
  render(<App />);
  await headingFocused(3);
});

it('ignora un paso guardado inválido y mantiene el tour usable si falla el guardado', async () => {
  localStorage.setItem('tradia.tour.step', '100');
  const user = userEvent.setup();
  render(<App />);
  await heading(1);
  vi.spyOn(simulation.api.settings, 'set').mockRejectedValue(new Error('IPC'));
  await user.click(screen.getByRole('button', { name: 'Saltar tour' }));
  expect(
    await screen.findByText(
      'No pudimos guardar que has visto el tour; puede volver a aparecer la próxima vez.',
    ),
  ).toHaveAttribute('role', 'status');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('centra el paso tras 1,5 s cuando el ancla y su respaldo no están disponibles', async () => {
  const pause = vi.fn();
  const next = vi.fn();
  render(<GuidedTour step={3} onPause={pause} onMove={next} onFinish={vi.fn()} />);
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveAttribute('aria-busy', 'true');
  expect(document.querySelector('.tour-spotlight')).not.toBeInTheDocument();
  await waitFor(() => expect(dialog).toHaveAttribute('aria-busy', 'false'), { timeout: 2200 });
  expect(dialog.style.left).toBe('');
  const user = userEvent.setup();
  await user.keyboard('{ArrowRight}');
  expect(next).toHaveBeenCalledWith(4);
  await user.keyboard('{Escape}');
  expect(pause).toHaveBeenCalledOnce();
});

it('Terminar y añadir claves enfoca el campo de Tiingo sin guardar secretos', async () => {
  localStorage.setItem('tradia.tour.step', '10');
  const saveKey = vi.spyOn(simulation.api.secrets, 'setKey');
  const user = userEvent.setup();
  render(<App />);
  await heading(10);
  await user.click(screen.getByRole('button', { name: 'Terminar y añadir claves' }));
  await waitFor(() => expect(screen.getByLabelText('Clave de API de Tiingo')).toHaveFocus());
  expect(saveKey).not.toHaveBeenCalled();
});

it('genera CSS válido desde los tokens con ambos temas y el halo', () => {
  const style = document.createElement('style');
  style.textContent = onboardingTokenStylesheet();
  document.head.append(style);
  expect(style.sheet?.cssRules.length).toBe(3);
  expect(style.textContent).toContain('--onboarding-halo:#FFFFFF');
  expect(style.textContent).toContain('--onboarding-halo:#10161C');
  style.remove();
});

it('vuelve a la ayuda de Ajustes al pausar después de navegar a otra pantalla', async () => {
  await simulation.api.settings.set({ onboardingTourVersion: ONBOARDING_TOUR_VERSION });
  window.location.hash = '#ajustes';
  const user = userEvent.setup();
  render(<App />);
  await user.click(await screen.findByRole('button', { name: 'Ver el tour de nuevo' }));
  await heading(1);
  await user.keyboard('{ArrowRight}');
  await heading(2);
  await waitFor(() =>
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Estado del sistema'),
  );
  await user.keyboard('{Escape}');
  expect(window.location.hash).toBe('#ajustes');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Retomar el tour (paso 2 de 10)' })).toHaveFocus(),
  );
});

it('no espera a un diálogo oculto para abrir el tour', async () => {
  render(
    <OnboardingProvider>
      <div role="dialog" hidden>
        Diálogo cerrado
      </div>
    </OnboardingProvider>,
  );
  await headingFocused(1);
});
