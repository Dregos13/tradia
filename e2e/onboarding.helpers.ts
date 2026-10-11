import { expect } from '@playwright/test';
import type { Locator, Page } from 'playwright';

/**
 * Utilidades del tour guiado para los E2E. Con un perfil vacío el tour
 * arranca solo en cuanto se acepta el aviso de riesgo y su velo vuelve
 * inerte el resto de la ventana: los recorridos que no prueban el tour lo
 * saltan nada más entrar, como haría alguien que ya conoce la app.
 */

export const TOUR_TOTAL_STEPS = 10;

/** Globo del tour: un diálogo modal titulado «Paso n de 10. …». */
export function tourDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: /^Paso \d+ de 10\./ });
}

/** Espera al tour del primer arranque y lo salta con su botón. */
export async function skipGuidedTour(page: Page): Promise<void> {
  const tour = tourDialog(page);
  await expect(tour).toBeVisible({ timeout: 15_000 });
  await tour.getByRole('button', { name: 'Saltar tour', exact: true }).click();
  await expect(tour).toHaveCount(0, { timeout: 5_000 });
}
