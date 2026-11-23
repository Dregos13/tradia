import { expect, test } from '@playwright/test';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * Laboratorio de punta a punta sobre la app Electron: idea en lenguaje
 * natural → reglas validadas (IA simulada en TRADIA_E2E) → backtest real
 * del motor → prueba en vivo persistida en SQLite y visible en el tablero.
 */

let context: PhaseApp | undefined;

test.beforeEach(async () => {
  context = await launchPhaseApp('tradia-laboratorio-e2e');
});

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

test('de una idea a una prueba en vivo', async () => {
  test.setTimeout(240_000);
  const { page } = context!;
  await openPage(page, 'Crear');
  await expect(page.getByText('IA simulada')).toBeVisible();

  await page
    .getByLabel('Tu idea', { exact: true })
    .fill('Seguir la tendencia en el SPY y el QQQ con un cruce de medias');
  await page.getByRole('button', { name: 'Generar estrategia' }).click();
  const draft = page.getByRole('article', { name: /Borrador: Cruce de medias/ });
  await expect(draft).toBeVisible();
  await expect(draft.getByText('cruza_arriba(sma(rapida), sma(lenta))')).toBeVisible();

  await page.getByRole('button', { name: 'Probar con datos históricos' }).click();
  await expect(page.getByRole('heading', { name: /Así le habría ido/ })).toBeVisible({
    timeout: 120_000,
  });
  await capturePhaseScreenshot(page, 'laboratorio-veredicto.png');

  await page.getByRole('button', { name: 'Lanzar prueba en vivo' }).click();
  await expect(page).toHaveURL(/#laboratorio\/prueba\/\d+$/);
  await expect(page.getByRole('heading', { name: 'Cruce de medias', level: 2 })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByText(/v1 congelada/)).toBeVisible();
  await capturePhaseScreenshot(page, 'laboratorio-prueba.png');

  await page.getByRole('link', { name: 'Crear', exact: true }).click();
  const board = page.getByRole('region', { name: 'Pruebas en vivo' });
  await expect(board.getByRole('link', { name: 'Cruce de medias' })).toBeVisible({
    timeout: 60_000,
  });
});

test('abre en Resumen; Mercado sigue divisas y oro y lleva una idea a Crear', async () => {
  test.setTimeout(240_000);
  const { page } = context!;
  await expect(page.getByRole('heading', { name: 'Resumen', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Empieza en tres pasos' })).toBeVisible();
  await openPage(page, 'Mercado');
  for (const city of ['Tokio', 'Londres', 'Nueva York']) {
    await expect(page.getByText(city, { exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Seguir estos activos' }).click();
  const assets = page.getByRole('region', { name: 'Activos' });
  await expect(assets.getByRole('button', { name: /Oro/ })).toBeVisible();
  await assets.getByRole('button', { name: /Oro/ }).click();
  await expect(page.getByRole('img', { name: /Velas diarias de Oro/ })).toBeVisible({
    timeout: 90_000,
  });
  await capturePhaseScreenshot(page, 'mesa-oro.png');
  await page.getByRole('button', { name: 'Escribir mi propia idea sobre Oro' }).click();
  await expect(page.getByRole('heading', { name: 'Crear', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Tu idea', { exact: true })).toHaveValue(
    'Estrategia sobre Oro (GLD): ',
  );
});
