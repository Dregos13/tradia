import { expect, test } from '@playwright/test';
import { closePhaseApp, launchPhaseApp, openPage } from './phase-6-7.helpers';

for (const colorScheme of ['light', 'dark'] as const) {
  test(`identidad de estrategias, riesgo, órdenes y dinero real · ${colorScheme}`, async () => {
    const context = await launchPhaseApp('tradia-identidad-dominio');
    const { page } = context;
    try {
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: 1440, height: 1000 });
      for (const name of ['Estrategias', 'Riesgo', 'Órdenes', 'Dinero real']) {
        await openPage(page, name);
        await expect(page.locator('main')).toBeVisible();
        await expect(page.locator('main')).toHaveCSS('font-family', /^Sora,/);
        await page.screenshot({ path: `test-results/identidad-${name}-${colorScheme}.png` });
        await page.setViewportSize({ width: 700, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.setViewportSize({ width: 1440, height: 1000 });
      }
      await expect(
        page.getByRole('button', { name: 'Activar dinero real', exact: true }),
      ).toBeDisabled();
      const activate = page.getByRole('button', { name: 'Activar dinero real', exact: true });
      const inactive = await activate.evaluate((node) => {
        const probe = document.createElement('span');
        probe.style.background = 'var(--color-surfaceStrong)';
        probe.style.color = 'var(--color-textMuted)';
        document.body.append(probe);
        const expected = getComputedStyle(probe);
        const colors = { background: expected.backgroundColor, color: expected.color };
        probe.remove();
        return { ...colors, opacity: getComputedStyle(node).opacity };
      });
      await activate.hover();
      await expect(activate).toHaveCSS('background-color', inactive.background);
      await expect(activate).toHaveCSS('color', inactive.color);
      await expect(activate).toHaveCSS('border-top-style', 'dashed');
      expect(inactive.opacity).toBe('1');
      await page.evaluate(() =>
        window.tradia.risk.submitSignal({
          ticker: 'AAPL',
          direction: 'largo',
          entry: 100,
          stop: 95,
          target: 105,
          confidence: 0.7,
          origin: 'e2e',
        }),
      );
      await openPage(page, 'Diario');
      const exportButton = page.getByRole('button', { name: /Exportar CSV/ });
      await expect(exportButton).toBeEnabled();
      const inverse = await exportButton.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--color-inverse)';
        document.body.append(probe);
        const color = getComputedStyle(probe).color;
        probe.remove();
        return color;
      });
      await expect(exportButton).toHaveCSS('color', inverse);
      await openPage(page, 'Estrategias');
      await page.getByRole('link', { name: 'Nueva estrategia', exact: true }).click();
      const create = page.getByRole('button', { name: 'Crear estrategia', exact: true });
      await expect(create).toBeDisabled();
      const disabled = await create.evaluate((node) => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, color: style.color };
      });
      await create.hover();
      await expect(create).toHaveCSS('background-color', disabled.background);
      await expect(create).toHaveCSS('color', disabled.color);
      await expect(create).toHaveCSS('border-top-style', 'dashed');
      const surface = await create.evaluate(() => {
        const probe = document.createElement('span');
        probe.style.background = 'var(--color-surfaceStrong)';
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      });
      expect(disabled.background).toBe(surface);
      // Un formulario inválido mantiene el botón enfocable para explicar el error.
      await page.getByLabel('Entrada', { exact: true }).fill('cruza_arriba(sma(20), sma(50))');
      await page.getByLabel('Nombre', { exact: true }).fill('x'.repeat(121));
      await expect(create).toHaveJSProperty('disabled', false);
      await expect(create).toHaveAttribute('aria-disabled', 'true');
      await create.hover();
      await expect(create).toHaveCSS('background-color', surface);
      await expect(create).toHaveCSS('color', disabled.color);
    } finally {
      await closePhaseApp(context);
    }
  });
}
