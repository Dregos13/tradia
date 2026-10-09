/* global window */
import console from 'node:console';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
const server = await createServer({
  configFile: false,
  root: 'src/renderer',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5195, strictPort: true },
  define: { 'import.meta.env.VITE_TRADIA_SIMULATED': '"true"' },
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch();
  await mkdir('docs/qa/capturas', { recursive: true });
  for (const width of [1440, 700]) {
    const page = await browser.newPage({
      viewport: { width, height: 1000 },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
    });
    await page.goto('http://127.0.0.1:5195');
    await page.getByLabel('He leído y acepto').check();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.evaluate(() => {
      const entry = {
        id: 1,
        type: 'senal',
        createdAt: '2026-10-09T14:00:00Z',
        ticker: 'AAPL',
        strategies: [{ strategyId: 1, name: 'Tendencia SMA', version: 3 }],
        reason: 'Cierre sobre la SMA 50 con volumen relativo de 1,4×.',
        dataUsed: { barCount: 250, source: 'simulated', batchVersion: 3 },
        result: 'aprobada',
        errors: [],
        ruleChecks: [
          {
            code: 'STOP',
            label: 'Stop obligatorio',
            cumplida: true,
            observed: '219,20',
            limit: '220,00',
          },
        ],
        signalId: 1,
      };
      window.tradia.journal.list = async () => ({
        entries: [
          entry,
          {
            ...entry,
            id: 2,
            type: 'veto',
            ticker: 'NVDA',
            result: 'vetada',
            reason: 'Exposición tecnológica supera el límite.',
          },
        ],
        total: 2,
        limit: 20,
        offset: 0,
      });
      window.tradia.journal.get = async () => entry;
    });
    await page.getByRole('link', { name: 'Diario', exact: true }).click();
    await page.getByText('Cierre sobre la SMA 50 con volumen relativo de 1,4×.').waitFor();
    await page.screenshot({ path: `docs/qa/capturas/fase-4-diario-${width}.png` });
    await page.getByRole('button', { name: /Ver detalle de Señal/ }).click();
    await page.getByText('✓ Cumplida · Stop obligatorio').waitFor();
    await page.screenshot({ path: `docs/qa/capturas/fase-4-diario-detalle-${width}.png` });
    console.log(`Diario y detalle verificados a ${width}px`);
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
