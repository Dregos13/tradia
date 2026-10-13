import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';
import type { DataFreshnessSummary } from '../src/shared/ipc';
import { closePhaseApp, launchPhaseApp, watchTickers, type PhaseApp } from './phase-6-7.helpers';

let context: PhaseApp | undefined;
test.afterEach(async () => closePhaseApp(context));

/** Renderer contract fixture through real preload IPC. Ingestion coverage has its own E2E suite. */
async function publishCoverage(summary: DataFreshnessSummary) {
  await context!.app.evaluate(({ ipcMain, BrowserWindow }, value) => {
    ipcMain.removeHandler('data-status:freshness');
    ipcMain.handle('data-status:freshness', () => value);
    for (const window of BrowserWindow.getAllWindows())
      window.webContents.send('data-status:changed', {
        key: 'ticker:EUR',
        state: value.uncovered.length ? 'sin-cobertura' : 'fiable',
        lastOkAt: null,
        consecutiveFailures: 0,
        reason: null,
        updatedAt: value.updatedAt,
      });
  }, summary);
}

test('aviso por activo: lectura, ventanas estrechas, teclado, retirada y cambio sin pausa global', async () => {
  context = await launchPhaseApp('tradia-uncovered-banner');
  const { page, app } = context;
  await watchTickers(page, ['SPY', 'EUR']);
  const summary: DataFreshnessSummary = {
    ...(await page.evaluate(() => window.tradia.dataStatus.freshness())),
    state: 'current',
    items: [],
    sinceDate: null,
    uncovered: [{ ticker: 'EUR', reason: 'No está disponible en Tiingo', suggestion: 'FXE' }],
  };
  await publishCoverage(summary);
  const banner = page.getByRole('region', { name: 'Estado de los datos' });
  await expect(
    banner.getByRole('heading', { name: 'EUR no está disponible en Tiingo' }),
  ).toBeVisible();
  await expect(banner).toContainText(
    'Solo EUR queda en pausa. Los demás activos, predicciones y señales siguen al día.',
  );
  await expect(banner).not.toContainText('Régimen, predicciones y señales en pausa');
  await expect(banner).not.toContainText('Datos actualizados.');
  await expect(banner).not.toContainText('fecha del último dato no disponible');

  for (const [width, theme, zoom] of [
    [1280, 'light', 1],
    [760, 'light', 1],
    [640, 'dark', 1],
    [1280, 'dark', 2],
  ] as const) {
    await page.setViewportSize({ width, height: 800 });
    await app.evaluate(
      ({ nativeTheme, BrowserWindow }, settings) => {
        nativeTheme.themeSource = settings.theme;
        BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(settings.zoom);
      },
      { theme, zoom },
    );
    await page.emulateMedia({ colorScheme: theme });
    await expect
      .poll(() => banner.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe(theme === 'dark' ? 'rgb(62, 50, 20)' : 'rgb(245, 234, 194)');
    await expect(banner.getByRole('button', { name: 'Quitar EUR de la lista' })).toBeVisible();
    const metrics = await banner.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const button = element.querySelector('button')!.getBoundingClientRect();
      return {
        width: rect.width,
        scrollWidth: element.scrollWidth,
        buttonWidth: button.width,
        buttonHeight: button.height,
      };
    });
    expect(metrics.scrollWidth).toBeLessThanOrEqual(Math.ceil(metrics.width));
    expect(metrics.buttonHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.buttonWidth).toBeGreaterThanOrEqual(44);
    const capturePath = join(tmpdir(), `tradia-uncovered-${width}-${theme}-${zoom}.png`);
    if (zoom === 2) {
      const remove = banner.getByRole('button', { name: 'Quitar EUR de la lista' });
      await remove.scrollIntoViewIfNeeded();
      await expect(remove).toBeInViewport();
      await page.screenshot({ path: capturePath });
    } else {
      await banner.screenshot({ path: capturePath });
    }
  }
  await app.evaluate(({ nativeTheme, BrowserWindow }) => {
    nativeTheme.themeSource = 'light';
    BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(1);
  });
  await page.setViewportSize({ width: 1280, height: 800 });

  await banner.getByRole('button', { name: 'Cambiar por FXE para EUR' }).focus();
  await page.keyboard.press('Tab');
  await expect(banner.getByRole('button', { name: 'Quitar EUR de la lista' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.tradia.watchlist.list()).map((row) => row.ticker)),
    )
    .toEqual(['SPY']);
  await publishCoverage({ ...summary, uncovered: [] });
  await expect(banner).toHaveCount(0);
  await expect(page.locator('.provider-banners [aria-label="Avisos de datos"]')).toBeFocused();
  await expect(page.getByText('EUR se ha quitado de tu lista.')).toBeVisible();

  await page.evaluate(() => window.tradia.watchlist.add('EUR'));
  await publishCoverage(summary);
  const replace = banner.getByRole('button', { name: 'Cambiar por FXE para EUR' });
  await replace.focus();
  await page.keyboard.press('Space');
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await window.tradia.watchlist.list()).map((row) => row.ticker).sort(),
      ),
    )
    .toEqual(['FXE', 'SPY']);
  await publishCoverage({ ...summary, uncovered: [] });
  await expect(banner).toHaveCount(0);
  await expect(page.locator('.provider-banners [aria-label="Avisos de datos"]')).toBeFocused();
  await expect(page.getByText('EUR se cambió por FXE.')).toBeVisible();
});
