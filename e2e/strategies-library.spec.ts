import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

test('biblioteca, edición versionada y ventana de 700 px', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'tradia-strategies-'));
  const app = await electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: resolve('.'),
    env: { ...process.env, TRADIA_E2E: '1', TRADIA_E2E_USER_DATA: userData },
  });
  try {
    const page = await app.firstWindow();
    await page.getByLabel('He leído y acepto').check();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await page.getByRole('link', { name: 'Estrategias', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Biblioteca de estrategias' })).toBeVisible();
    for (const name of [
      'Cruce de medias',
      'Reversión RSI/Bollinger',
      'Ruptura de rangos',
      'Momentum entre activos',
    ]) {
      await page.getByRole('link', { name, exact: true }).click();
      await expect(page.getByText(/Sin implementación ejecutable/)).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Ejecutar pruebas de estrés', exact: true }),
      ).toBeEnabled();
      await page.getByLabel('Desde', { exact: true }).fill('2015-01-01');
      await page.getByLabel('Hasta', { exact: true }).fill('2024-12-31');
      await page.getByLabel('Simulaciones Monte Carlo').fill('100');
      await page.getByRole('button', { name: 'Lanzar backtest', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Informe de backtest', exact: true }),
      ).toBeVisible({ timeout: 60000 });
      await page.getByRole('link', { name: 'Volver a la ficha · v1' }).click();
      await page.getByRole('link', { name: 'Volver a la biblioteca', exact: true }).click();
    }
    await page.getByRole('link', { name: 'Nueva estrategia' }).click();
    await page.setViewportSize({ width: 700, height: 900 });
    for (const [label, value] of Object.entries({
      Nombre: 'Evidencia E2E',
      'Hipótesis económica': 'Persistencia de tendencias',
      Entrada: 'Cruce alcista',
      Salida: 'Cruce bajista',
      Stop: 'Stop de cinco por ciento',
      Objetivo: 'Salida por señal',
      'Mercados (separados por comas)': 'SPY',
      'Régimen favorable y limitaciones': 'Tendencial',
    }))
      await page.getByLabel(label, { exact: true }).fill(value);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.locator('.main').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: 'test-results/strategy-form-700.png' });
    await page.getByRole('button', { name: 'Crear estrategia', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Evidencia E2E' })).toBeVisible();
    await expect(
      page
        .getByText(
          'Sin implementación ejecutable: el backtest de estrategias propias llegará en la próxima fase',
        )
        .first(),
    ).toBeVisible();
    for (const name of ['Lanzar backtest', 'Ejecutar prueba final', 'Ejecutar pruebas de estrés'])
      await expect(page.getByRole('button', { name, exact: true })).toBeDisabled();
    await page.getByRole('link', { name: 'Editar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Editar estrategia' })).toBeVisible({
      timeout: 5000,
    });
    await page.getByLabel('Nombre', { exact: true }).fill('Evidencia E2E revisada');
    await page.getByRole('button', { name: 'Guardar nueva versión' }).click();
    await expect(page.getByRole('alert')).toContainText('Explica qué cambió');
    await page
      .getByLabel('Nota del cambio', { exact: false })
      .fill('Aclaro el nombre de la hipótesis');
    await page.getByRole('button', { name: 'Guardar nueva versión' }).click();
    await expect(page.getByRole('heading', { name: 'Evidencia E2E revisada' })).toBeVisible();
    await expect(page.getByText('Aclaro el nombre de la hipótesis')).toBeVisible();
    await page.getByLabel('Versión', { exact: true }).selectOption('1');
    await expect(page.getByRole('heading', { name: 'Evidencia E2E', exact: true })).toBeVisible();
    await expect(page.getByText('Versión histórica · solo lectura')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.locator('.main').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: 'test-results/strategy-detail-700.png' });
    await page.getByRole('link', { name: 'Volver a la biblioteca', exact: true }).click();
    await expect(
      page.getByRole('link', { name: 'Evidencia E2E revisada', exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/strategy-library-700.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: 'test-results/strategy-library-wide.png' });
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
