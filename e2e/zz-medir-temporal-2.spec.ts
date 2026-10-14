import { test } from '@playwright/test';
import { closePhaseApp, launchPhaseApp, openPage } from './phase-6-7.helpers';

const out = '/tmp/tradia-medir';
test('medir mercado y editor', async () => {
  test.setTimeout(300_000);
  const ctx = await launchPhaseApp('tradia-medir2');
  const { page } = ctx;
  try {
    for (const [w, h] of [[1280, 800], [1024, 700]]) {
      await page.setViewportSize({ width: w!, height: h! });
      await openPage(page, 'Mercado');
      const input = page.locator('#market-ticker');
      const before = await input.boundingBox();
      await input.fill('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
      await page.getByRole('button', { name: 'Añadir', exact: true }).click();
      await page.locator('#market-list-error').waitFor();
      const after = await input.boundingBox();
      const err = await page.locator('#market-list-error').boundingBox();
      console.log(`mercado@${w}: antes ${JSON.stringify(before)} después ${JSON.stringify(after)} error ${JSON.stringify(err)}`);
      await page.screenshot({ path: `${out}/mercado-error-${w}.png` });
      await input.fill('');
      await openPage(page, 'Estrategias');
      await page.evaluate(() => (location.hash = 'estrategias/nueva'));
      await page.getByRole('heading', { name: 'Nueva estrategia' }).waitFor();
      await page.waitForTimeout(800);
      const m = await page.evaluate(() => {
        const main = document.querySelector('main')!.getBoundingClientRect();
        const top = document.querySelector('header.top, .top')?.getBoundingClientRect();
        const link = Array.from(document.querySelectorAll('a')).find((a) => a.textContent === 'Volver sin guardar')!.getBoundingClientRect();
        const page = document.querySelector('.app-page')!.getBoundingClientRect();
        const h2 = document.querySelector('.strategy-heading h2')!.getBoundingClientRect();
        return { mainTop: main.top, topBottom: top?.bottom, link: [link.top, link.bottom], pageTop: page.top, h2Top: h2.top, scroll: document.querySelector('main')!.scrollTop };
      });
      console.log(`editor@${w}: ${JSON.stringify(m)}`);
      await page.screenshot({ path: `${out}/editor-${w}.png` });
      for (const [link, heading, name] of [['Diario', 'Diario', 'diario'], ['Órdenes', 'Órdenes', 'ordenes'], ['Dinero real', 'Dinero real', 'dinero-real']]) {
        await openPage(page, link!, heading!);
        await page.waitForTimeout(1200);
        await page.screenshot({ path: `${out}/${name}-${w}.png` });
      }
    }
  } finally {
    await closePhaseApp(ctx);
  }
});
