import process from 'node:process';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

// Ejecutar contra npm run dev con REMOTE_DEBUGGING_PORT=9233 y perfil E2E separado.
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.CDP_PORT ?? 9233}`);
const page = browser.contexts()[0].pages()[0];
const results = [];
try {
  const accept = page.getByLabel('He leído y acepto');
  if (await accept.isVisible()) {
    await accept.check();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    const tour = page.getByRole('dialog', { name: /^Paso \d+ de 10\./ });
    await tour.waitFor({ state: 'visible' });
    await tour.getByRole('button', { name: 'Saltar tour', exact: true }).click();
  }
  const routes = [
    ['inicio', 'Inicio', '.dashboard-grid'],
    ['mercado', 'Mercado', '.market-chart-card'],
    ['ia', 'IA', '.ai-section'],
    ['salud-modelos', 'Salud de modelos', '.health-summary'],
    ['macro', 'Macro', '.macro-grid'],
  ];
  for (const viewport of [{ width: 1280, height: 800 }, { width: 1024, height: 700 }]) {
    await page.setViewportSize(viewport);
    for (const [route, label, ready] of routes) {
      await page.getByRole('link', { name: label, exact: true }).click();
      if (route === 'mercado' && (await page.evaluate(() => globalThis.tradia.watchlist.list())).length === 0) {
        await page.getByRole('button', { name: 'Añadir universo inicial · 25', exact: true }).click();
      }
      await page.locator(ready).first().waitFor({ state: 'visible' });
      await page.locator('.main').evaluate((element) => (element.scrollTop = 0));
      await page.evaluate(() => globalThis.document.fonts.ready);
      const geometry = await page.evaluate(() => {
        const main = globalThis.document.querySelector('.main');
        const stacks = ['.app-page', '.dashboard', '.market-data-page', '.ai-page', '.macro-panel'];
        const gaps = [];
        for (const selector of stacks) {
          for (const stack of globalThis.document.querySelectorAll(selector)) {
            const children = [...stack.children].filter((child) => {
              const box = child.getBoundingClientRect();
              return box.width > 1 && box.height > 1 && globalThis.getComputedStyle(child).position !== 'absolute' && child.tagName !== 'STYLE';
            });
            for (let i = 1; i < children.length; i++) {
              gaps.push({ stack: selector, gap: children[i].getBoundingClientRect().top - children[i - 1].getBoundingClientRect().bottom });
            }
          }
        }
        const style = (selector) => {
          const el = globalThis.document.querySelector(selector);
          if (!el) return null;
          const css = globalThis.getComputedStyle(el);
          return { padding: css.padding, rowGap: css.rowGap, columnGap: css.columnGap };
        };
        return { width: main.clientWidth, scrollWidth: main.scrollWidth, gaps, firstSteps: style('.first-steps'), dashboard: style('.dashboard-grid'), workspace: style('.market-workspace'), health: style('.health-summary > div'), macro: style('.macro-panel') };
      });
      assert(geometry.scrollWidth <= geometry.width, `${route}: desbordamiento horizontal`);
      // Los avisos de Inicio son una unidad de componentes a 16 px.
      for (const { stack, gap } of geometry.gaps) {
        assert(gap >= (stack === '.ai-page' && route === 'inicio' ? 15 : 23), `${route} ${stack}: gap ${gap}`);
      }
      const file = viewport.width === 1280 ? `ux-despues-${route}.png` : `ux-despues-${route}-1024.png`;
      await page.screenshot({ path: `docs/qa/capturas/${file}` });
      results.push({ route, viewport, ...geometry });
    }
  }
  writeFileSync('docs/qa/grupo-a-mediciones.json', JSON.stringify(results, null, 2) + '\n');
} finally {
  await browser.close();
}
