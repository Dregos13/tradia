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
      // El reloj de mercado arranca el martes 2026-10-06 tras el cierre y la
      // actualización diaria (18:00 ET): los saltos de 24 h del bloque de
      // fallos cruzan los cierres de miércoles, jueves y viernes, y el avance
      // final de 72 h cae tras el cierre del lunes. Sin el anclaje, esos
      // saltos dependen de la fecha real y pueden caer en fin de semana o
      // festivo, donde la ingesta ni siquiera intenta refrescar. La variable
      // de entorno permite inyectar otra semana equivalente para comprobar
      // que el resultado no depende del calendario real.
      TRADIA_E2E_MARKET_NOW: process.env.TRADIA_E2E_MARKET_NOW ?? '2026-10-06T22:00:00.000Z',
      TRADIA_CONNECTIVITY_URLS: JSON.stringify([endpoint, endpoint]),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByLabel('He leído y acepto').check();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await page.getByRole('link', { name: 'Mercado', exact: true }).click();
    await expect(page.getByText('Tu lista está vacía.')).toBeVisible();
    const tickerInput = page.getByLabel('Ticker', { exact: true });
    await tickerInput.fill('NASDAQ-TOO-LONG');
    await tickerInput.press('Enter');
    await expect(page.getByRole('alert')).toHaveText(
      'Introduce un ticker de 1 a 12 caracteres: letras, números, punto o guion.',
    );
    await expect(tickerInput).toHaveValue('NASDAQ-TOO-LONG');
    await tickerInput.fill('AAPL');
    await tickerInput.press('Enter');
    const chart = page.getByRole('img', { name: /Velas diarias ajustadas de AAPL/ });
    await expect(chart).toBeVisible({ timeout: 20000 });
    await expect(chart.locator('canvas').first()).toBeVisible();
    await expect(page.locator('.market-chart-card').getByText('◇ Datos simulados')).toBeVisible();
    for (const period of [20, 50, 200]) {
      await expect(
        page.getByRole('checkbox', { name: `SMA ${period}`, exact: true }),
      ).toBeVisible();
    }
    await expect(page.getByText(/RSI 14: [\d]/)).toBeVisible();
    await expect(page.getByText(/ATR 14: [\d]/)).toBeVisible();
    const originalBars = await page.evaluate(() =>
      window.tradia.market.getBars({ ticker: 'AAPL' }),
    );
    expect(originalBars.bars.length).toBeGreaterThan(750);
    expect(
      Date.parse(originalBars.bars.at(-1)!.date) - Date.parse(originalBars.bars[0]!.date),
    ).toBeGreaterThan(1000 * 24 * 60 * 60 * 1000);
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
    const navigation = page.getByRole('navigation');
    expect(await navigation.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true,
    );
    const settingsLink = navigation.getByRole('link', { name: 'Ajustes', exact: true });
    const journalLink = navigation.getByRole('link', { name: 'Diario', exact: true });
    const strategiesLink = navigation.getByRole('link', { name: 'Estrategias', exact: true });
    const riskLink = navigation.getByRole('link', { name: 'Riesgo', exact: true });
    await strategiesLink.focus();
    await expect(strategiesLink).toBeFocused();
    // La fase 4 inserta Diario entre Riesgo y Ajustes.
    await page.keyboard.press('Tab');
    await expect(riskLink).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(journalLink).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(settingsLink).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(journalLink).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(riskLink).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(strategiesLink).toBeFocused();
    await page.getByText(/Ver tabla de datos/).click();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.getByText(/Ver tabla de datos/).click();
    await app.evaluate(({ Notification }) => {
      const state = globalThis as typeof globalThis & {
        __tradiaNotificationCalls?: Array<{ title: string; body: string }>;
      };
      state.__tradiaNotificationCalls = [];
      Object.defineProperty(Notification, 'isSupported', {
        configurable: true,
        value: () => true,
      });
      Notification.prototype.show = function (this: Notification) {
        state.__tradiaNotificationCalls?.push({ title: this.title, body: this.body });
      };
    });
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
    const providerBanner = page.getByRole('alert', { name: /Estado de Proveedor simulado/ });
    await expect(providerBanner).toBeVisible();
    await expect(providerBanner.getByRole('button', { name: 'Reintentar' })).toBeVisible();
    await expect(page.locator('.market-chart-card')).toHaveClass(/data-unreliable/);
    await expect
      .poll(() =>
        app.evaluate(() => {
          const state = globalThis as typeof globalThis & {
            __tradiaNotificationCalls?: Array<{ title: string; body: string }>;
          };
          return state.__tradiaNotificationCalls?.some((notification) =>
            /no fiable/i.test(notification.title),
          );
        }),
      )
      .toBe(true);
    await page.screenshot({ path: 'test-results/provider-failure-narrow.png' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: 'test-results/provider-failure-dark.png' });
    await providerBanner.getByRole('button', { name: 'Reintentar' }).click();
    await expect(page.locator('.provider-banners').getByRole('status')).toContainText(
      'Actualización solicitada',
    );
    await page.evaluate(() => window.tradia.testing!.simulateProviderFailure(false));
    await expect(providerBanner).toHaveCount(0);
    await expect(page.locator('.market-chart-card')).not.toHaveClass(/data-unreliable/);
    const recoveredBars = await page.evaluate(() =>
      window.tradia.market.getBars({ ticker: 'AAPL' }),
    );
    const recoveredLastDate = recoveredBars.bars.at(-1)!.date;
    await page.evaluate(() => window.tradia.testing!.advanceMarketClock(3 * 24 * 60 * 60 * 1000));
    await expect
      .poll(async () => {
        const result = await page.evaluate(() => window.tradia.market.getBars({ ticker: 'AAPL' }));
        return result.bars.at(-1)?.date;
      })
      .not.toBe(recoveredLastDate);
    await page.screenshot({ path: 'test-results/market-new-candle.png' });
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
