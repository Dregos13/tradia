import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

const macroSeries = [
  { id: 'DFF', className: 'dff' },
  { id: 'CPIAUCSL', className: 'cpi' },
  { id: 'DGS2', className: 'yield2y' },
  { id: 'DGS10', className: 'yield10y' },
  { id: 'T10Y2Y', className: 'spread' },
  { id: 'VIXCLS', className: 'vix' },
] as const;

async function withApp(run: (app: ElectronApplication, page: Page) => Promise<void>) {
  const userData = mkdtempSync(join(tmpdir(), 'tradia-macro-'));
  const server = createServer((_request, response) => {
    response.writeHead(204);
    response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const app = await electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: resolve('.'),
    env: {
      ...process.env,
      TRADIA_E2E: '1',
      TRADIA_E2E_USER_DATA: userData,
      TRADIA_CONNECTIVITY_URLS: JSON.stringify([endpoint, endpoint]),
    },
  });
  try {
    const page = await app.firstWindow();
    await page.getByLabel('He leído y acepto').check();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await run(app, page);
  } finally {
    await app.close();
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(userData, { recursive: true, force: true });
  }
}

test('el panel macro E2E presenta las series simuladas sin exigir una clave real de FRED', async () => {
  await withApp(async (_app, page) => {
    await page.getByRole('link', { name: 'Macro', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Contexto macro' })).toBeVisible();
    await expect
      .poll(async () => {
        return (
          (await page.locator('.macro-card').count()) +
          (await page.getByText('Conecta tus fuentes de datos.').count())
        );
      })
      .toBeGreaterThan(0);
    await page.screenshot({ path: 'test-results/macro-context-no-key.png' });
    await expect(page.locator('.macro-card')).toHaveCount(6);
  });
});

test('el panel macro muestra valor, fecha y frescura de los seis indicadores', async () => {
  await withApp(async (_app, page) => {
    await page.evaluate(() =>
      window.tradia.secrets.setKey('fred', 'test-only-placeholder-never-used'),
    );
    await page.getByRole('link', { name: 'Macro', exact: true }).click();
    const cards = page.locator('.macro-card');
    await expect(cards).toHaveCount(6, { timeout: 20_000 });
    for (const { id, className } of macroSeries) {
      const card = page.locator(`.macro-series-${className}`);
      await expect(card.locator('.macro-code')).toHaveText(id);
      await expect(card.locator('.macro-value')).not.toHaveText('Sin dato');
      await expect(card.locator('time[datetime]')).toHaveCount(1);
      await expect(card.locator('.macro-badge').first()).toContainText(
        /Fiable|Actualizando|Desactualizado|No fiable/,
      );
    }
    await page.screenshot({ path: 'test-results/macro-context.png' });
    await expect(page.getByText(/Datos simulados · Entorno de pruebas/)).toBeVisible();
  });
});
