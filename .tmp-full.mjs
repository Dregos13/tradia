import { chromium } from 'playwright';
const b = await chromium.connectOverCDP('http://127.0.0.1:9241');
const page = b.contexts()[0].pages()[0];
await page.emulateMedia({ colorScheme: 'light' });
for (const w of [1280, 1024]) {
  await page.setViewportSize({ width: w, height: w === 1280 ? 800 : 700 });
  for (const [r,l] of [['riesgo','Riesgo'],['diario','Diario'],['ordenes','Órdenes'],['real-vs-backtest','Real vs backtest'],['dinero-real','Dinero real'],['ajustes','Ajustes']]) {
    await page.getByRole('link', { name: l, exact: true }).click(); await page.waitForTimeout(1000);
    await page.locator('.app-page').screenshot({ path: `docs/qa/capturas/ux-despues-${r}-completa-${w}.png` });
  }
}
await b.close().catch(()=>{});
