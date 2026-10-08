import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';

test('añade un ticker, recibe histórico simulado con indicadores y confirma quitarlo', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'tradia-chart-'));
  const server = createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app = await electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      TRADIA_E2E: '1',
      TRADIA_E2E_USER_DATA: userData,
      TRADIA_CONNECTIVITY_URLS: JSON.stringify([endpoint, endpoint]),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByLabel('He leído y acepto').check();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await page.getByRole('link', { name: 'Mercado', exact: true }).click();
    await expect(page.getByText('Tu lista está vacía.')).toBeVisible();
    await page.getByLabel('Ticker', { exact: true }).fill('AAPL');
    await page.getByRole('button', { name: 'Añadir', exact: true }).click();
    const chart = page.getByRole('img', { name: /Velas diarias ajustadas de AAPL/ });
    await expect(chart).toBeVisible({ timeout: 20000 });
    await expect(chart.locator('canvas').first()).toBeVisible();
    await expect(page.locator('.market-chart-card').getByText('◇ Datos simulados')).toBeVisible();
    await expect(page.getByText(/RSI 14: [\d]/)).toBeVisible();
    await expect(page.getByText(/ATR 14: [\d]/)).toBeVisible();
    await page.getByRole('button', { name: '1A', exact: true }).click();
    await expect(page.getByRole('button', { name: '1A', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByText(/Ver tabla de datos/).click();
    await expect(page.getByRole('table', { name: /AAPL · OHLCV ajustado/ })).toBeVisible();
    await expect(
      page.getByRole('table', { name: /AAPL · OHLCV ajustado/ }).locator('tbody tr'),
    ).not.toHaveCount(0);
    await page.getByText(/Ver tabla de datos/).click();
    await page.locator('.main').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: 'test-results/market-chart-wide.png' });
    await page
      .locator('.market-chart-card')
      .screenshot({ path: 'test-results/market-chart-detail.png' });
    await page.setViewportSize({ width: 700, height: 900 });
    await page.locator('.main').evaluate((element) => {
      element.scrollTop = 0;
    });
    await page.screenshot({ path: 'test-results/market-chart-narrow.png' });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    for (let failure = 1; failure <= 3; failure++) {
      await page.evaluate(async () => {
        await window.tradia.testing!.simulateProviderFailure(true);
        await window.tradia.testing!.advanceMarketClock(24 * 60 * 60 * 1000);
      });
      await expect
        .poll(() =>
          page.evaluate(
            async () =>
              (await window.tradia.dataStatus.get()).find((entry) => entry.key === 'ticker:AAPL')
                ?.consecutiveFailures ?? 0,
          ),
        )
        .toBeGreaterThanOrEqual(failure);
    }
    const providerBanner = page.getByRole('alert', { name: 'Estado de Proveedor simulado' });
    await expect(providerBanner).toBeVisible();
    await expect(page.locator('.market-chart-card')).toHaveClass(/data-unreliable/);
    await page.screenshot({ path: 'test-results/provider-failure-narrow.png' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: 'test-results/provider-failure-dark.png' });
    await page.evaluate(() => window.tradia.testing!.simulateProviderFailure(false));
    await expect(providerBanner).toHaveCount(0);
    await expect(page.locator('.market-chart-card')).not.toHaveClass(/data-unreliable/);
    await page.getByRole('button', { name: 'Quitar AAPL', exact: true }).click();
    await expect(chart).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar quitar AAPL', exact: true }).click();
    await expect(page.getByText('Tu lista está vacía.')).toBeVisible();
  } finally {
    await app.close();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(userData, { recursive: true, force: true });
  }
});
