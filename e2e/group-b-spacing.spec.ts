import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { skipGuidedTour } from './onboarding.helpers';

async function checkLayout(page: Page) {
  expect(
    await page.locator('main').evaluate((main) => main.scrollWidth - main.clientWidth),
  ).toBeLessThanOrEqual(0);
  const gaps = await page.locator('[data-layout-page]').evaluateAll((roots) =>
    roots.flatMap((root) => {
      const blocks = Array.from(root.querySelectorAll<HTMLElement>(':scope > [data-layout-block]'))
        .map((block) => block.getBoundingClientRect())
        .filter((box) => box.width && box.height);
      return blocks.slice(1).map((box, index) => box.top - blocks[index]!.bottom);
    }),
  );
  for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(24);
}

for (const width of [1280, 1024]) {
  test(`grupo B: ritmo y editor sin desbordamiento a ${width}`, async () => {
    const userData = mkdtempSync(join(tmpdir(), 'tradia-group-b-'));
    const app = await electron.launch({
      args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
      cwd: resolve('.'),
      env: { ...process.env, TRADIA_E2E: '1', TRADIA_E2E_USER_DATA: userData },
    });
    try {
      const page = await app.firstWindow();
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 700 });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.getByLabel('He leído y acepto').check();
      await page.getByRole('button', { name: 'Continuar', exact: true }).click();
      await skipGuidedTour(page);
      for (const [route, name] of [
        ['noticias', 'Noticias'],
        ['calendario', 'Calendario'],
        ['fuentes', 'Fuentes'],
        ['estrategias', 'Estrategias'],
      ]) {
        await page.getByRole('link', { name, exact: true }).click();
        const root = page.locator(`[data-layout-page="${route}"]`).last();
        await expect(root).toBeVisible();
        await expect(root).not.toHaveAttribute('aria-busy', 'true');
        if (route === 'estrategias') await expect(page.getByRole('table')).toBeVisible();
        if (route === 'noticias') {
          await expect(page.getByTestId('news-item').first()).toBeVisible();
          const cardGaps = await page.locator('.news-day-cards').evaluateAll((groups) =>
            groups.flatMap((group) => {
              const cards = Array.from(group.children).map((card) => card.getBoundingClientRect());
              return cards.slice(1).map((box, index) => box.top - cards[index]!.bottom);
            }),
          );
          for (const gap of cardGaps) expect(gap).toBe(16);
        }
        await checkLayout(page);
        await page.locator('main').evaluate((main) => main.scrollTo({ top: 0 }));
        await page.screenshot({
          path: `docs/qa/capturas/ux-despues-${route}${width === 1024 ? '-1024' : ''}.png`,
        });
      }
      await page.getByRole('link', { name: 'Nueva estrategia', exact: true }).click();
      await page
        .getByLabel('Entrada', { exact: true })
        .fill('cruza_arriba(sma(rapida), sma(lenta))');
      await checkLayout(page);
      await page
        .locator('#strategy-section-2')
        .evaluate((element) => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({
        path: `docs/qa/capturas/ux-despues-estrategias-editor-${width}.png`,
      });
      await page.getByRole('link', { name: 'Estrategias', exact: true }).click();
      await page.getByRole('link', { name: 'Cruce de medias', exact: true }).click();
      const launcher = page
        .getByRole('heading', { name: 'Lanzar backtest', exact: true })
        .locator('..');
      await expect(launcher).toBeVisible();
      await checkLayout(page);
      await launcher.evaluate((element) => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({
        path: `docs/qa/capturas/ux-despues-backtest${width === 1024 ? '-1024' : ''}.png`,
      });
      await expect(page.getByLabel('Desde', { exact: true })).toBeVisible();
    } finally {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    }
  });
}
