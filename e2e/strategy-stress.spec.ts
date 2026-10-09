import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

test('las cuatro fichas muestran crisis, fuente y capital sin desbordamiento', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'tradia-stress-'));
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
    for (const name of [
      'Cruce de medias',
      'Reversión RSI/Bollinger',
      'Ruptura de rangos',
      'Momentum entre activos',
    ]) {
      await page.getByRole('link', { name, exact: true }).click();
      const section = page.getByRole('region', { name: 'Comportamiento en crisis' });
      await section
        .getByRole('button', { name: 'Ejecutar pruebas de estrés', exact: true })
        .click();
      await expect(section.getByRole('status')).toHaveText('Pruebas de estrés guardadas.', {
        timeout: 60000,
      });
      for (const id of ['2008', '2020', '2022']) {
        const crisis = section.getByRole('article', { name: id, exact: true });
        await expect(crisis.getByText('Datos simulados', { exact: true })).toBeVisible();
        await expect(crisis.locator('dt')).toHaveText([
          'Rentabilidad',
          'Drawdown máximo',
          'Operaciones',
          'Comprar y mantener SPY',
          'Diferencia frente a SPY',
        ]);
        await expect(crisis.locator('dd')).toHaveCount(5);
        await expect(crisis.getByRole('img')).toHaveAccessibleName(new RegExp(`Capital en ${id}`));
      }
      if (name === 'Cruce de medias') {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: 'test-results/strategy-stress-1440.png' });
        await page.setViewportSize({ width: 700, height: 900 });
        await section.evaluate((el) => el.scrollIntoView({ block: 'start' }));
        await page.screenshot({ path: 'test-results/strategy-stress-700.png' });
        expect(await page.locator('.main').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
          true,
        );
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
      await page.getByRole('link', { name: 'Volver a la biblioteca', exact: true }).click();
      await page.getByRole('link', { name, exact: true }).click();
      await expect(
        page.getByRole('region', { name: 'Comportamiento en crisis' }).getByRole('article'),
      ).toHaveCount(3);
      await page.getByRole('link', { name: 'Volver a la biblioteca', exact: true }).click();
    }
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
