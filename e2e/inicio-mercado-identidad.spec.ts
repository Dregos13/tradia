import { expect, test } from '@playwright/test';
import { closePhaseApp, launchPhaseApp, openPage } from './phase-6-7.helpers';

for (const colorScheme of ['light', 'dark'] as const) {
  test(`Inicio y Mercado con velas: identidad y distribución · ${colorScheme}`, async () => {
    const context = await launchPhaseApp('tradia-inicio-mercado-identidad');
    const { page } = context;
    try {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: 1440, height: 1000 });
      await openPage(page, 'Inicio', 'Estado del sistema');
      await expect(page.locator('.dashboard')).toHaveCSS('font-family', /^Sora,/);
      await page.screenshot({ path: `test-results/inicio-identidad-${colorScheme}.png` });
      await openPage(page, 'Mercado');
      await page.getByLabel('Ticker', { exact: true }).fill('AAPL');
      await page.getByRole('button', { name: 'Añadir', exact: true }).click();
      const chart = page.getByRole('img', { name: /Velas diarias ajustadas de AAPL/ });
      await expect(chart.locator('canvas').first()).toBeVisible();
      await expect(page.locator('.market-close')).toHaveCSS('font-family', /^"IBM Plex Mono",/);
      for (const [period, stroke] of [
        [20, 'solid'],
        [50, 'dashed'],
        [200, 'dotted'],
      ] as const) {
        expect(
          await page
            .locator(`.market-sma-${period}`)
            .evaluate((label) => getComputedStyle(label, '::after').borderTopStyle),
        ).toBe(stroke);
      }
      // El panel completo debe quedar dentro del área desplazable: la barra
      // fija del shell no debe tapar la tabla ni el panel ATR en la evidencia.
      await page.setViewportSize({ width: 1440, height: 1800 });
      await page.locator('.market-chart-card').screenshot({
        path: `docs/qa/capturas/identidad/despues-mercado-velas-${colorScheme === 'light' ? 'claro' : 'oscuro'}.png`,
      });
      for (const width of [1280, 1024, 700]) {
        await page.setViewportSize({ width, height: 900 });
        await expect
          .poll(() => page.locator('.main').evaluate((el) => el.scrollWidth <= el.clientWidth))
          .toBe(true);
        if (width === 700) {
          // Evita que la base flex horizontal de 580px se convierta en altura.
          const form = page.locator('.market-add');
          await expect(form).toHaveCSS('flex-basis', 'auto');
          expect((await form.boundingBox())!.height).toBeLessThan(180);
        }
      }
      await page.screenshot({ path: `test-results/mercado-compacto-identidad-${colorScheme}.png` });
    } finally {
      await closePhaseApp(context);
    }
  });
}
