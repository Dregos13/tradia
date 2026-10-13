import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { STRATEGY_NAME_MAX_LENGTH } from '../src/shared/strategy';
import { skipGuidedTour } from './onboarding.helpers';

test('nombre sin truncar, recuperación al corregir y columnas estables con 120 caracteres', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'tradia-name-columns-'));
  const app = await electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: resolve('.'),
    env: { ...process.env, TRADIA_E2E: '1', TRADIA_E2E_USER_DATA: userData },
  });
  const fullName = 'Beta · Reversión RSI para la consultora Pérez & Asociados — '.padEnd(
    STRATEGY_NAME_MAX_LENGTH + 14,
    'x',
  );
  const validName = fullName.slice(0, STRATEGY_NAME_MAX_LENGTH);
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByLabel('He leído y acepto').check();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await skipGuidedTour(page);
    await page.getByRole('link', { name: 'Estrategias', exact: true }).click();
    await page.getByRole('link', { name: 'Nueva estrategia', exact: true }).click();
    for (const [label, value] of Object.entries({
      Nombre: fullName,
      'Hipótesis económica': 'Persistencia de tendencias',
      Entrada: 'cruza_arriba(sma(20), sma(50))',
      Salida: 'cruza_abajo(sma(20), sma(50))',
      Stop: '5%',
      Objetivo: 'ninguno',
      'Mercados (separados por comas)': 'QQQ',
      'Régimen favorable y limitaciones': 'Tendencial',
    }))
      await page.getByLabel(label, { exact: true }).fill(value);
    const name = page.getByLabel('Nombre', { exact: true });
    await expect(name).toHaveValue(fullName);
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toHaveAccessibleDescription(
      'Sobran 14 caracteres: acorta el nombre para poder guardar. 134/120',
    );
    const create = page.getByRole('button', { name: 'Crear estrategia', exact: true });
    await expect(create).toBeDisabled();
    // aria-disabled conserva el foco: Enter debe explicar el bloqueo sin guardar.
    await create.focus();
    await page.keyboard.press('Enter');
    await expect(name).toBeFocused();
    await expect(
      page.getByRole('heading', { name: 'Nueva estrategia', exact: true }),
    ).toBeVisible();
    await name.fill(validName);
    await expect(name).toHaveAccessibleDescription(
      'Has llegado al máximo de 120 caracteres. 120/120',
    );
    await expect(create).toBeEnabled();
    await create.click();
    await expect(page.getByRole('heading', { name: validName, exact: true })).toBeVisible();
    await page.getByLabel('Desde', { exact: true }).fill('2015-01-01');
    await page.getByLabel('Hasta', { exact: true }).fill('2024-12-31');
    await page.getByLabel('Simulaciones Monte Carlo').fill('100');
    await page.getByRole('button', { name: 'Lanzar backtest', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Informe de backtest', exact: true }),
    ).toBeVisible({
      timeout: 60000,
    });
    await page.getByRole('link', { name: 'Volver a la ficha · v1', exact: true }).click();
    await page.getByRole('link', { name: 'Volver a la biblioteca', exact: true }).click();
    const table = page.getByRole('table');
    const link = table.getByRole('link', { name: validName, exact: true });
    await expect(link).toHaveAttribute('title', validName);
    await link.focus();
    await expect(link).toBeFocused();
    const row = table
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name: validName, exact: true }) });
    // Medimos líneas reales, incluidos cabeceras, cifras, fecha y «Sin datos».
    await expect(row.getByRole('cell').nth(2)).not.toHaveText('Sin datos');
    await expect(table.getByRole('cell', { name: 'Sin datos', exact: true }).first()).toBeVisible();
    const fixedText = table.locator('thead th:not(:first-child), tbody td');
    for (const cell of await fixedText.all()) {
      const lines = await cell.evaluate((element) => {
        const text = element.firstChild!;
        const range = document.createRange();
        range.selectNodeContents(text);
        return new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size;
      });
      expect(lines).toBe(1);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await table.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/strategy-name-columns-1440.png' });
    await page.setViewportSize({ width: 700, height: 1000 });
    await expect(link).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(await table.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'test-results/strategy-name-columns-700.png' });
    await link.click();
    await page.getByRole('link', { name: 'Editar', exact: true }).click();
    await expect(name).toHaveValue(validName);
    await name.fill(`${validName}x`);
    const update = page.getByRole('button', { name: 'Guardar nueva versión', exact: true });
    await expect(update).toBeDisabled();
    await update.focus();
    await page.keyboard.press('Enter');
    await expect(name).toBeFocused();
    await expect(name).toHaveAccessibleDescription(
      'Sobran 1 carácter: acorta el nombre para poder guardar. 121/120',
    );
    await name.fill(validName);
    await page.getByLabel('Nota del cambio').fill('Conservo el nombre completo de la estrategia');
    await update.click();
    await expect(page.getByRole('heading', { name: validName, exact: true })).toBeVisible();
    await expect(page.getByLabel('Versión', { exact: true })).toHaveValue('2');
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
