/* global window, document, innerWidth */
import console from 'node:console';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

// Isolated renderer simulation: no real delivery, secret storage or restore.
const server = await createServer({
  configFile: false,
  root: 'src/renderer',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5196, strictPort: true },
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
    await page.goto('http://127.0.0.1:5196');
    await page.getByLabel('He leído y acepto').check();
    await page.getByRole('button', { name: 'Continuar' }).click();
    await page.evaluate(() => {
      const api = window.tradia;
      let config = {
        telegram: {
          enabled: true,
          chatId: '-100234918',
          events: ['senal-aprobada', 'senal-vetada', 'limite-alcanzado', 'resumen-diario'],
          hasToken: true,
        },
        email: {
          enabled: false,
          host: 'smtp.example.com',
          port: 587,
          security: 'starttls',
          user: 'alertas@example.com',
          to: '',
          events: ['senal-aprobada', 'resumen-diario'],
          hasPassword: true,
        },
      };
      api.delivery.getConfig = async () => config;
      api.delivery.setConfig = async (value) => {
        config = {
          telegram: { ...value.telegram, hasToken: true },
          email: { ...value.email, hasPassword: true },
        };
        return config;
      };
      api.backup.list = async () =>
        [9, 8, 7].map((day) => ({
          fileName: `tradia-2026-10-${day}.db`,
          sizeBytes: 5033164,
          createdAt: `2026-10-0${day}T02:00:00Z`,
          schemaVersion: 8,
          integrityOk: true,
        }));
    });
    await page.getByRole('link', { name: 'Ajustes', exact: true }).click();
    await page
      .getByRole('region', { name: 'Telegram' })
      .getByText('Guardado', { exact: true })
      .waitFor();
    await page.getByText('3 copias disponibles').waitFor();
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
        [...document.querySelectorAll('.settings-panel')].some(
          (node) => node.scrollWidth > node.clientWidth + 1,
        ),
    );
    if (overflow || errors.length) throw new Error(JSON.stringify({ width, overflow, errors }));
    await page.screenshot({ path: `docs/qa/capturas/fase-4-ajustes-${width}.png`, fullPage: true });
    await page.setViewportSize({ width, height: 1000 });
    const trigger = page.getByRole('button', { name: /Restaurar copia/ }).first();
    await trigger.click();
    const cancel = page.getByRole('button', { name: 'Cancelar', exact: true });
    if (!(await cancel.evaluate((node) => node === document.activeElement)))
      throw new Error('Cancelar no tiene foco inicial');
    await page.screenshot({ path: `docs/qa/capturas/fase-4-ajustes-restaurar-${width}.png` });
    await page.keyboard.press('Escape');
    if (!(await trigger.evaluate((node) => node === document.activeElement)))
      throw new Error('No se devolvió el foco');
    console.log(
      `Ajustes ${width}px: sin desbordamientos ni errores; confirmación y foco verificados.`,
    );
    await page.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
