import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

test('lanzador, informe, prueba final y ancho de 700 px', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'tradia-backtest-'));
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
    await page.getByRole('link', { name: 'Reversión RSI/Bollinger', exact: true }).click();
    await page.setViewportSize({ width: 700, height: 900 });
    await page.getByLabel('Desde', { exact: true }).fill('2015-01-01');
    await page.getByLabel('Hasta', { exact: true }).fill('2024-12-31');
    await page.getByLabel('Comisión (%)').fill('0.07');
    await page.getByLabel('Slippage (pb)').fill('6');
    await page.getByLabel('Spread (pb)').fill('3');
    await expect(page.getByRole('button', { name: 'Lanzar backtest', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole('button', { name: 'Lanzar backtest', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Informe de backtest', exact: true }),
    ).toBeVisible({ timeout: 60000 });
    for (const name of [
      'Curva de capital',
      'Ventanas walk-forward',
      'Sensibilidad de parámetros',
      'Dispersión Monte Carlo',
      'Operaciones',
    ])
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(page.getByLabel('Ocho métricas del backtest').locator('dt')).toHaveCount(8);
    await expect(page.getByLabel('Aviso de riesgo')).toContainText(
      'No es asesoramiento financiero',
    );
    await expect(page.getByText('Datos simulados', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await page.locator('.main').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
    await page
      .getByRole('heading', { name: 'Curva de capital', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/backtest-equity-700.png' });
    await page
      .getByRole('heading', { name: 'Sensibilidad de parámetros', exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/backtest-robustness-700.png' });
    await page.locator('.main').evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({ path: 'test-results/backtest-report-700.png' });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: 'test-results/backtest-report-1440.png' });
    await page.getByRole('link', { name: 'Volver a la ficha · v1' }).click();
    await page.getByRole('button', { name: 'Ejecutar prueba final', exact: true }).click();
    await expect(page.getByText('Confirmar prueba final bloqueada', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar y ejecutar prueba final' }).click();
    await expect(
      page.getByRole('heading', { name: 'Informe de backtest', exact: true }),
    ).toBeVisible({ timeout: 60000 });
    await expect(
      page.getByText('Prueba final · ejecutada y bloqueada', { exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Volver a la ficha · v1' }).click();
    await expect(page.getByRole('link', { name: 'Ver prueba final', exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Ejecutar prueba final', exact: true }),
    ).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
