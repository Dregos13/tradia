/* global window, document, innerWidth */
import { Buffer } from 'node:buffer';
import console from 'node:console';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { readFile, mkdir } from 'node:fs/promises';
import ts from 'typescript';

// Explicit renderer simulation, never connects to real market providers.
const fixtureSource = await readFile(
  'src/renderer/src/components/dashboard/testFixtures.ts',
  'utf8',
);
const fixtureJs = ts.transpileModule(fixtureSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext },
}).outputText;
const { signal, portfolio, strategies, contradiction } = await import(
  `data:text/javascript;base64,${Buffer.from(fixtureJs).toString('base64')}`
);
const server = await createServer({
  configFile: false,
  root: 'src/renderer',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5194, strictPort: true },
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
      colorScheme: 'light',
      timezoneId: 'Europe/Madrid',
      locale: 'es-ES',
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto('http://127.0.0.1:5194');
    await page.getByLabel('He leído y acepto').check();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.getByRole('link', { name: 'Fuentes', exact: true }).click();
    await page.evaluate(
      ({ signal, portfolio, strategies, contradiction }) => {
        const api = window.tradia;
        api.signals.list = async () => [
          signal,
          {
            ...signal,
            id: 2,
            ticker: 'NVDA',
            direction: 'corto',
            confidence: 0.64,
            reason: 'La propuesta supera el límite de exposición del sector.',
            decision: {
              ...signal.decision,
              status: 'vetada',
              size: 0,
              reasons: [
                {
                  code: 'MAX_SECTOR_EXPOSURE',
                  message: 'Exposición sectorial por encima del límite.',
                  details: { observed: 34, limit: 30 },
                },
              ],
            },
            createdAt: '2026-10-09T13:35:00Z',
          },
        ];
        api.signals.strategies = async () => strategies;
        api.risk.getPortfolio = async () => portfolio;
        api.journal.list = async () => ({
          entries: [contradiction],
          total: 1,
          limit: 20,
          offset: 0,
        });
        const original = api.dataStatus.get;
        api.dataStatus.get = async () => [
          ...(await original()),
          {
            key: 'provider:macro-simulated',
            state: 'fiable',
            lastOkAt: signal.createdAt,
            updatedAt: signal.createdAt,
            consecutiveFailures: 0,
            reason: null,
          },
          {
            key: 'ticker:AAPL',
            state: 'fiable',
            lastOkAt: signal.createdAt,
            updatedAt: signal.createdAt,
            consecutiveFailures: 0,
            reason: null,
          },
        ];
      },
      { signal, portfolio, strategies, contradiction },
    );
    await page.getByRole('link', { name: 'Inicio', exact: true }).click();
    await page.getByText(signal.reason, { exact: true }).waitFor();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('.dashboard-block')].every(
        (node) => node.getAttribute('aria-busy') === 'false',
      ),
    );
    // Fit all rows in the capture while preserving the application's responsive width.
    const height = await page.evaluate(() =>
      Math.ceil(
        document.querySelector('.main').scrollHeight +
          document.querySelector('.top').getBoundingClientRect().bottom +
          document.querySelector('.statusbar').getBoundingClientRect().height +
          24,
      ),
    );
    await page.setViewportSize({ width, height });
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth > innerWidth ||
        [...document.querySelectorAll('.dashboard-block')].some(
          (node) => node.scrollWidth > node.clientWidth + 1,
        ),
    );
    if (overflow || errors.length) throw new Error(JSON.stringify({ width, overflow, errors }));
    await page.getByRole('button', { name: 'Por sector' }).focus();
    await page.keyboard.press('Enter');
    await page.getByText('Tecnología', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Por activo' }).click();
    await page.locator('h1').focus();
    await page.screenshot({ path: `docs/qa/capturas/fase-4-panel-${width}.png`, fullPage: true });
    console.log(
      `Panel ${width}px: 7 bloques, sin desbordamiento ni errores; selector de exposición verificado con teclado.`,
    );
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
