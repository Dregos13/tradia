import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9241');
const page = b.contexts()[0].pages()[0];
const theme = process.argv[2] || 'light'; const save = process.argv[3] === 'save';
await page.emulateMedia({ colorScheme: theme });
for (const w of [1280, 1024]) {
  await page.setViewportSize({ width: w, height: w === 1280 ? 800 : 700 });
  for (const [r,l] of [['riesgo','Riesgo'],['diario','Diario'],['ordenes','Órdenes'],['real-vs-backtest','Real vs backtest'],['dinero-real','Dinero real'],['ajustes','Ajustes']]) {
    await page.getByRole('link', { name: l, exact: true }).click(); await page.waitForTimeout(1000);
    for (let i = 0; i < 2; i++) {
      await page.evaluate((i) => { const m = document.querySelector('.main'); const p = m.querySelector('.app-page'); m.scrollTop = p.offsetTop - 24 + i * (m.clientHeight - 120); }, i);
      await page.waitForTimeout(150);
      await page.screenshot({ path: save ? `docs/qa/capturas/ux-despues-${r}-contenido-${i+1}-${w}-${theme}.png` : `/tmp/tradia-c2/${r}-${w}-${i+1}.png` });
    }
  }
}
await b.close().catch(()=>{});
