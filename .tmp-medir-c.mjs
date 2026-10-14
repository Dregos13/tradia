import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
const shots = process.argv[2] === 'shots';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9241');
const page = browser.contexts()[0].pages()[0];
const accept = page.getByLabel('He leído y acepto');
if (await accept.isVisible().catch(() => false)) {
  await accept.check();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  const tour = page.getByRole('dialog', { name: /^Paso \d+ de 10\./ });
  await tour.waitFor({ state: 'visible' });
  await tour.getByRole('button', { name: 'Saltar tour', exact: true }).click();
}
const routes = [['riesgo','Riesgo'],['diario','Diario'],['ordenes','Órdenes'],['real-vs-backtest','Real vs backtest'],['dinero-real','Dinero real'],['ajustes','Ajustes']];
const out = [];
for (const theme of ['light','dark']) for (const vp of [{width:1280,height:800},{width:1024,height:700}]) {
  await page.setViewportSize(vp); await page.emulateMedia({ colorScheme: theme });
  for (const [route,label] of routes) {
    await page.getByRole('link', { name: label, exact: true }).click();
    await page.waitForTimeout(1200);
    await page.locator('.main').evaluate((e) => (e.scrollTop = 0));
    const g = await page.evaluate(() => {
      const main = document.querySelector('.main');
      const mr = main.getBoundingClientRect();
      const over = [];
      for (const el of main.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        let p = el.parentElement, clipped = false;
        while (p && p !== main) { const s = getComputedStyle(p); if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { clipped = true; break; } p = p.parentElement; }
        if (!clipped && r.right > mr.right - parseFloat(getComputedStyle(main).paddingRight) + 1) over.push((el.className||el.tagName)+'').slice(0,60);
      }
      // gaps & overlaps among visible children of every stack under .app-page
      const root = main.querySelector('.app-page > *');
      const gaps = [], overlaps = [];
      const walk = (parent, depth) => {
        const kids = [...parent.children].filter((k) => { const r = k.getBoundingClientRect(); const s = getComputedStyle(k); return r.height > 0 && s.position !== 'absolute' && s.position !== 'fixed'; });
        for (let i = 1; i < kids.length; i++) {
          const a = kids[i-1].getBoundingClientRect(), b = kids[i].getBoundingClientRect();
          const sameRow = b.top < a.bottom - 1 && b.left >= a.right - 1;
          if (!sameRow && b.top < a.bottom - 1 && b.left < a.right - 1 && b.right > a.left + 1) overlaps.push([kids[i-1].className, kids[i].className]);
          if (depth === 0 && !sameRow) gaps.push([(kids[i-1].dataset.layoutBlock||kids[i-1].className||kids[i-1].tagName)+'', (kids[i].dataset.layoutBlock||kids[i].className||kids[i].tagName)+'', Math.round(b.top - a.bottom)]);
        }
        if (depth < 3) kids.forEach((k) => walk(k, depth + 1));
      };
      if (root) walk(root, 0);
      return { sw: main.scrollWidth, cw: main.clientWidth, docSW: document.documentElement.scrollWidth, vw: innerWidth, over: [...new Set(over)].slice(0,10), gaps, overlaps: overlaps.slice(0,10) };
    });
    out.push({ theme, w: vp.width, route, ...g });
    if (shots) {
      const suf = vp.width === 1280 ? (theme === 'light' ? ['', '-1280-light'] : ['-1280-dark']) : [`-1024-${theme}`];
      for (const s of suf) await page.screenshot({ path: `docs/qa/capturas/ux-despues-${route}${s}.png` });
    }
  }
}
writeFileSync('/tmp/tradia-c2/geo.json', JSON.stringify(out, null, 1));
for (const r of out) console.log(r.theme, r.w, r.route, 'sw', r.sw, r.cw, r.docSW, r.vw, 'over', r.over.join('|'), 'ovl', JSON.stringify(r.overlaps), '\n   ', r.gaps.map((g) => `${g[0].slice(0,22)}→${g[1].slice(0,22)}:${g[2]}`).join('  '));
await browser.close().catch(()=>{});
