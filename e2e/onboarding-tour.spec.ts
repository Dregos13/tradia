import { expect, test, type Page } from '@playwright/test';
import { TOUR_STEPS } from '../src/renderer/src/components/onboarding/tourSteps';
import { TOUR_TOTAL_STEPS, tourDialog } from './onboarding.helpers';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
  relaunchPhaseApp,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * Tour guiado del primer arranque (docs/diseno-tour-guiado.md). Cada
 * prueba parte de un perfil vacío: el aviso de riesgo va siempre antes,
 * el tour arranca solo después y se puede recorrer solo con teclado,
 * saltar, pausar, retomar (también tras reiniciar) y relanzar desde
 * Ajustes. Los textos se comparan con `TOUR_STEPS`, el mismo arreglo que
 * pinta la interfaz.
 */

let context: PhaseApp | undefined;

test.beforeEach(async () => {
  context = await launchPhaseApp('tradia-tour-e2e', { onboarding: 'manual' });
});

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

const stepTitle = (page: Page) => tourDialog(page).getByRole('heading', { level: 2 });

/** El globo muestra el paso `n` con su título, su texto y el foco en el título. */
async function expectStep(page: Page, step: number): Promise<void> {
  const data = TOUR_STEPS[step - 1]!;
  const dialog = tourDialog(page);
  await expect(dialog).toHaveAccessibleName(`Paso ${step} de ${TOUR_TOTAL_STEPS}. ${data.title}`);
  await expect(dialog).toHaveAccessibleDescription(data.text);
  await expect(stepTitle(page)).toBeFocused();
  if (data.route) await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#${data.route}`);
  // El globo deja de esperar al ancla en 1,5 s como máximo.
  await expect(dialog).toHaveAttribute('aria-busy', 'false', { timeout: 5_000 });
}

/** Acepta el aviso de riesgo solo con teclado. */
async function acceptRiskWithKeyboard(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Antes de empezar' })).toBeVisible({
    timeout: 30_000,
  });
  const accept = page.getByLabel('He leído y acepto');
  const proceed = page.getByRole('button', { name: 'Continuar', exact: true });
  await expect(proceed).toBeDisabled();
  for (let tab = 0; tab < 20; tab++) {
    if (await accept.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press('Tab');
  }
  await expect(accept).toBeFocused();
  await page.keyboard.press('Space');
  await expect(accept).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(proceed).toBeFocused();
  await page.keyboard.press('Enter');
}

async function acceptRisk(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Antes de empezar' })).toBeVisible({
    timeout: 30_000,
  });
  // El tour nunca sustituye ni tapa el aviso de riesgo.
  await expect(tourDialog(page)).toHaveCount(0);
  await page.getByLabel('He leído y acepto').check();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
}

const tourSettings = (page: Page) =>
  page.evaluate(async () => {
    const settings = await window.tradia.settings.get();
    return {
      version: settings.onboardingTourVersion,
      completedAt: settings.onboardingTourCompletedAt,
      step: localStorage.getItem('tradia.tour.step'),
    };
  });

test.describe('Profesional independiente que organiza varios proyectos', () => {
  test('primer arranque: aviso de riesgo, tour de 10 pasos solo con teclado y foco en la clave de Tiingo', async () => {
    test.setTimeout(180_000);
    const { page } = context!;
    await expect(page.getByRole('heading', { name: 'Antes de empezar' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(tourDialog(page)).toHaveCount(0);
    await acceptRiskWithKeyboard(page);

    // Arranca solo en el paso 1 con el foco en el título y el resto inerte.
    await expect(tourDialog(page)).toBeVisible({ timeout: 15_000 });
    await expectStep(page, 1);
    expect(
      await page.evaluate(() =>
        Array.from(document.body.children)
          .filter((element) => !element.classList.contains('onboarding-root'))
          .every((element) => element.hasAttribute('inert')),
      ),
    ).toBe(true);
    await expect(tourDialog(page)).toHaveAttribute('aria-modal', 'true');
    await capturePhaseScreenshot(page, 'continuacion-tour-paso-1.png');

    // Foco atrapado: X → Saltar tour → Empezar → X.
    const dialog = tourDialog(page);
    const close = dialog.getByRole('button', { name: 'Cerrar el tour y retomarlo más tarde' });
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Saltar tour' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Empezar' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.getByRole('button', { name: 'Empezar' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expectStep(page, 2);

    // → y ← con el foco en el globo.
    await page.keyboard.press('ArrowRight');
    await expectStep(page, 3);
    await page.keyboard.press('ArrowLeft');
    await expectStep(page, 2);

    for (let step = 2; step < TOUR_TOTAL_STEPS; step++) {
      if (step % 2 === 0) {
        await page.keyboard.press('ArrowRight');
      } else {
        // Tab desde el título va a la X; Mayús+Tab, al último botón (Siguiente).
        await page.keyboard.press('Shift+Tab');
        await expect(dialog.getByRole('button', { name: 'Siguiente' })).toBeFocused();
        await page.keyboard.press('Enter');
      }
      await expectStep(page, step + 1);
      expect((await tourSettings(page)).step).toBe(String(step + 1));
      if (step + 1 === 6) {
        await capturePhaseScreenshot(page, 'continuacion-tour-paso-6-parada.png');
      }
    }

    // Paso 10: «Terminar y añadir claves» deja el foco en la clave de Tiingo.
    await expect(dialog.getByRole('button', { name: 'Saltar tour' })).toHaveCount(0);
    await capturePhaseScreenshot(page, 'continuacion-tour-paso-10.png');
    await page.keyboard.press('Shift+Tab');
    const finishWithKeys = dialog.getByRole('button', { name: 'Terminar y añadir claves' });
    await expect(finishWithKeys).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(tourDialog(page)).toHaveCount(0);
    await expect(page.getByLabel('Clave de API de Tiingo')).toBeFocused({ timeout: 5_000 });
    await expect(page.getByRole('status').filter({ hasText: 'Tour completado' })).toHaveText(
      'Tour completado. Puedes verlo cuando quieras en Ajustes.',
    );
    await expect
      .poll(async () => (await tourSettings(page)).completedAt)
      .toEqual(expect.any(String));
    expect((await tourSettings(page)).step).toBeNull();

    // El tour enseña, no actúa: ni parada, ni dinero real, ni inertes de más.
    const after = await page.evaluate(async () => ({
      killSwitch: (await window.tradia.risk.getKillSwitch()).active,
      live: (await window.tradia.live.state()).mode,
      inert: Array.from(document.body.children).some((element) => element.hasAttribute('inert')),
    }));
    expect(after).toEqual({ killSwitch: false, live: 'bloqueado', inert: false });
    await page.keyboard.type('clave-que-no-se-guarda');
    await expect(page.getByLabel('Clave de API de Tiingo')).toHaveValue('clave-que-no-se-guarda');
  });

  test('pausa con Esc en el paso 4, retoma desde Inicio y se reabre en ese paso al reiniciar', async () => {
    test.setTimeout(180_000);
    const { page } = context!;
    await acceptRisk(page);
    await expect(tourDialog(page)).toBeVisible({ timeout: 15_000 });
    await tourDialog(page).getByRole('button', { name: 'Empezar' }).click();
    for (let step = 2; step < 4; step++) {
      await expectStep(page, step);
      await tourDialog(page).getByRole('button', { name: 'Siguiente' }).click();
    }
    await expectStep(page, 4);
    await page.keyboard.press('Escape');
    await expect(tourDialog(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Tour en pausa' })).toHaveText(
      'Tour en pausa en el paso 4 de 10. Retómalo desde Inicio o Ajustes.',
    );
    // El foco vuelve al título de la página en la que se queda (Fuentes).
    await expect(page.locator('.top h1')).toBeFocused();
    expect((await tourSettings(page)).step).toBe('4');
    expect((await tourSettings(page)).completedAt).toBeNull();

    // No se reabre solo en la misma sesión; «Primeros pasos» ofrece retomarlo.
    await openPage(page, 'Inicio', 'Estado del sistema');
    const firstSteps = page.getByRole('region', { name: 'Primeros pasos' });
    await expect(firstSteps).toBeVisible();
    await expect(tourDialog(page)).toHaveCount(0);
    await capturePhaseScreenshot(page, 'continuacion-primeros-pasos-retomar.png', firstSteps);
    await firstSteps.getByRole('button', { name: 'Retomar el tour (paso 4 de 10)' }).click();
    await expectStep(page, 4);
    await tourDialog(page).getByRole('button', { name: 'Cerrar el tour y retomarlo más tarde' }).click();
    await expect(tourDialog(page)).toHaveCount(0);

    await openPage(page, 'Ajustes');
    await expect(page.getByRole('button', { name: 'Retomar el tour (paso 4 de 10)' })).toBeVisible();

    // Siguiente arranque del mismo perfil: sin aviso (ya aceptado) y el tour en el paso 4.
    await relaunchPhaseApp(context!);
    const next = context!.page;
    await expect(tourDialog(next)).toBeVisible({ timeout: 30_000 });
    await expect(next.getByRole('heading', { name: 'Antes de empezar' })).toHaveCount(0);
    await expectStep(next, 4);
    await tourDialog(next).getByRole('button', { name: 'Saltar tour' }).click();
    await expect(tourDialog(next)).toHaveCount(0);
  });
});

test.describe('Responsable de equipo que revisa entregas', () => {
  test('salta el tour, no reaparece al reiniciar y se relanza desde Ajustes en el paso 1', async () => {
    test.setTimeout(180_000);
    const { page } = context!;
    await acceptRisk(page);
    await expect(tourDialog(page)).toBeVisible({ timeout: 15_000 });
    await expectStep(page, 1);
    await tourDialog(page).getByRole('button', { name: 'Saltar tour' }).click();
    await expect(tourDialog(page)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'Tour omitido' })).toHaveText(
      'Tour omitido. Puedes verlo cuando quieras en Ajustes.',
    );
    await expect
      .poll(async () => (await tourSettings(page)).completedAt)
      .toEqual(expect.any(String));
    const skipped = await tourSettings(page);
    expect(skipped.version).toEqual(expect.any(String));
    expect(skipped.step).toBeNull();

    // Reinicio: ni aviso de riesgo (ya aceptado) ni tour (ya saltado).
    await relaunchPhaseApp(context!);
    const next = context!.page;
    await expect(next.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(next.getByRole('region', { name: 'Primeros pasos' })).toBeVisible();
    await expect.poll(async () => (await tourSettings(next)).completedAt).toBe(skipped.completedAt);
    await expect(tourDialog(next)).toHaveCount(0);

    // Ajustes › Ayuda › «Ver el tour de nuevo» arranca en el paso 1.
    await openPage(next, 'Ajustes');
    const help = next.getByRole('region', { name: 'Ayuda' });
    const restart = help.getByRole('button', { name: 'Ver el tour de nuevo' });
    await restart.scrollIntoViewIfNeeded();
    await capturePhaseScreenshot(next, 'continuacion-ajustes-ayuda-tour.png', help);
    await restart.click();
    await expectStep(next, 1);
    await tourDialog(next).getByRole('button', { name: 'Empezar' }).click();
    await expectStep(next, 2);
    // «Terminar» desde el último paso: recorre el resto con «Siguiente».
    for (let step = 2; step < TOUR_TOTAL_STEPS; step++) {
      await tourDialog(next).getByRole('button', { name: 'Siguiente' }).click();
      await expectStep(next, step + 1);
    }
    await tourDialog(next).getByRole('button', { name: 'Terminar', exact: true }).click();
    await expect(tourDialog(next)).toHaveCount(0);
    await expect(next.getByRole('status').filter({ hasText: 'Tour completado' })).toBeVisible();
    // Lanzado desde Ajustes, el foco vuelve a su botón.
    await expect(next.getByRole('button', { name: 'Ver el tour de nuevo' })).toBeFocused({
      timeout: 5_000,
    });
    const relaunched = await tourSettings(next);
    expect(relaunched.completedAt).toEqual(expect.any(String));
    expect(relaunched.completedAt! >= skipped.completedAt!).toBe(true);
    expect(relaunched.step).toBeNull();
  });
});
