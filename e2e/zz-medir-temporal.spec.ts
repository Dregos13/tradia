import { test } from '@playwright/test';
import { closePhaseApp, launchPhaseApp, openPage } from './phase-6-7.helpers';

const out = '/tmp/tradia-medir';
test('medir', async () => {
  test.setTimeout(300_000);
  const ctx = await launchPhaseApp('tradia-medir');
  const { page } = ctx;
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    const shots = async (name: string, h = 800) => {
      const total = await page.evaluate(() => document.querySelector('main')!.scrollHeight);
      for (let y = 0, i = 0; y < total && i < 12; y += h - 100, i++) {
        await page.evaluate((y) => document.querySelector('main')!.scrollTo(0, y), y);
        await page.waitForTimeout(150);
        await page.screenshot({ path: `${out}/${name}-${i}.png` });
      }
      await page.evaluate(() => document.querySelector('main')!.scrollTo(0, 0));
    };
    for (const [link, heading, name] of (process.env.PAGES ?? 'Ajustes|Ajustes|ajustes').split(',').map((s) => s.split('|'))) {
      await openPage(page, link!, heading!);
      await page.waitForTimeout(1500);
      if (process.env.HASH) await page.evaluate((h) => (location.hash = h), process.env.HASH);
      await page.waitForTimeout(800);
      const dump = await page.evaluate(() => {
        const main = document.querySelector('main')!;
        const top = main.getBoundingClientRect().top - main.scrollTop;
        const rows: string[] = [];
        const walk = (el: Element, depth: number) => {
          if (depth > Number(6)) return;
          for (const c of Array.from(el.children)) {
            const r = c.getBoundingClientRect();
            if (!r.height || c.tagName === 'STYLE') continue;
            const cs = getComputedStyle(c);
            rows.push(`${'  '.repeat(depth)}${c.tagName.toLowerCase()}.${(c.className || '').toString().replace(/ /g, '.')}${c.getAttribute('aria-label') ? `[${c.getAttribute('aria-label')}]` : ''} y=${Math.round(r.top - top)} h=${Math.round(r.height)} x=${Math.round(r.left)} w=${Math.round(r.width)} pad=${cs.padding} mar=${cs.margin} «${(c.textContent || '').trim().slice(0, 40)}»`);
            walk(c, depth + 1);
          }
        };
        walk(main, 0);
        return rows.join('\n');
      });
      require('node:fs').writeFileSync(`${out}/${name}.txt`, dump);
      await shots(name);
    }
  } finally {
    await closePhaseApp(ctx);
  }
});
