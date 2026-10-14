import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9241');
const page = b.contexts()[0].pages()[0];
const anchors = [null,'inicio-situacion','mercado-lista','fuentes-lista','estrategias-lista','parada','ordenes-paper','ia-regimen','dinero-real-lista','ajustes-proveedores'];
for (const vp of [{width:1280,height:800},{width:1024,height:700}]) {
  await page.setViewportSize(vp); await page.emulateMedia({ colorScheme: 'light' });
  if (await page.locator('.tour-popover').isVisible()) { await page.locator('.tour-close').click(); await page.waitForTimeout(500); }
  await page.getByRole('link', { name: 'Ajustes', exact: true }).click();
  await page.keyboard.press('Escape').catch(()=>{}); await page.waitForTimeout(400); if (!(await page.locator('.tour-popover').isVisible())) await page.getByRole('button', { name: 'Ver el tour de nuevo' }).click();
  for (let s = 1; s <= 10; s++) {
    const dlg = page.getByRole('dialog', { name: new RegExp(`^Paso ${s} de 10\\.`) });
    await dlg.waitFor({ state: 'visible' });
    await page.waitForTimeout(2500);
    const r = await page.evaluate((a) => {
      const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)]; };
      const t = a ? document.querySelector(`[data-tour="${a}"]`) : null;
      const pop = document.querySelector('.tour-popover'); const ps = getComputedStyle(pop);
      return { target: box(t), spot: box(document.querySelector('.tour-spotlight')), pop: box(pop), pad: ps.padding, popScroll: pop.scrollHeight > pop.clientHeight };
    }, anchors[s-1]);
    console.log(vp.width, s, JSON.stringify(r));
    if (s === 1 || s >= 6) await page.screenshot({ path: `docs/qa/capturas/ux-despues-tour-paso-${s}-${vp.width}.png` });
    if (s === 1 && vp.width === 1280) await page.screenshot({ path: 'docs/qa/capturas/ux-despues-tour.png' });
    const next = s < 10 ? dlg.getByRole('button', { name: /^(Siguiente|Empezar)$/ }) : dlg.getByRole('button', { name: /^Terminar$/ });
    await next.first().click();
  }
}
await b.close().catch(()=>{});
