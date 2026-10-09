import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

const projectRoot = resolve('.');

async function launchTradia(userData: string, extraEnv: Record<string, string> = {}) {
  return electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      TRADIA_E2E: '1',
      TRADIA_E2E_USER_DATA: userData,
      ...extraEnv,
    },
  });
}

async function acceptRisk(page: Page) {
  const continueButton = page.getByRole('button', { name: 'Continuar' });
  await expect(page.getByRole('heading', { name: 'Antes de empezar' })).toBeVisible();
  await expect(continueButton).toBeDisabled();
  await page.getByLabel('He leído y acepto').check();
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible();
}

function containsValueInJsonFiles(directory: string, value: string): string[] {
  const matches: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...containsValueInJsonFiles(path, value));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      if (readFileSync(path).includes(value)) matches.push(path);
    }
  }
  return matches;
}

test.describe('Tradia Electron', () => {
  let app: ElectronApplication;
  let userData: string;
  let appClosed: boolean;
  let connectivityServer: Server;

  test.beforeEach(async () => {
    userData = mkdtempSync(join(tmpdir(), 'tradia-e2e-'));
    appClosed = false;
    connectivityServer = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolveListen, reject) => {
      connectivityServer.once('error', reject);
      connectivityServer.listen(0, '127.0.0.1', resolveListen);
    });
    const { port } = connectivityServer.address() as AddressInfo;
    const endpoint = `http://127.0.0.1:${port}/health`;
    app = await launchTradia(userData, {
      TRADIA_CONNECTIVITY_URLS: JSON.stringify([endpoint, endpoint]),
    });
  });

  test.afterEach(async () => {
    if (!appClosed) await app.close();
    await new Promise<void>((resolveClose, reject) => {
      connectivityServer.close((error) => (error ? reject(error) : resolveClose()));
    });
    if (userData) rmSync(userData, { recursive: true, force: true });
  });

  test('requiere aceptar el aviso en instalación limpia y lo recuerda al reiniciar', async () => {
    let page = await app.firstWindow();
    await acceptRisk(page);

    await app.close();
    appClosed = true;
    app = await launchTradia(userData);
    appClosed = false;
    page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Antes de empezar' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Ajustes' }).click();
    await page.getByRole('button', { name: /Ver aviso de riesgo/ }).click();
    await expect(page.getByRole('heading', { name: 'Aviso de riesgo' })).toBeVisible();
  });

  test('Ajustes envía notificaciones habilitadas y bloquea las desactivadas', async () => {
    const page = await app.firstWindow();
    await acceptRisk(page);

    await app.evaluate(({ Notification }) => {
      const state = globalThis as typeof globalThis & {
        __tradiaNotificationCalls?: Array<{ title: string; body: string }>;
      };
      state.__tradiaNotificationCalls = [];
      Object.defineProperty(Notification, 'isSupported', {
        configurable: true,
        value: () => true,
      });
      Notification.prototype.show = function (this: Notification) {
        state.__tradiaNotificationCalls?.push({ title: this.title, body: this.body });
      };
    });

    await page.getByRole('link', { name: 'Ajustes' }).click();
    await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
    await page.getByLabel('Nivel de la notificación de prueba').selectOption('info');
    await page
      .getByRole('region', { name: 'Notificaciones' })
      .getByRole('button', { name: 'Enviar prueba', exact: true })
      .click();
    await expect(page.getByRole('status').filter({ hasText: 'Prueba enviada' })).toBeVisible();
    await expect
      .poll(() =>
        app.evaluate(() => {
          const state = globalThis as typeof globalThis & {
            __tradiaNotificationCalls?: Array<{ title: string; body: string }>;
          };
          return state.__tradiaNotificationCalls?.length ?? 0;
        }),
      )
      .toBe(1);

    const alertSwitch = page.getByRole('switch', { name: 'Notificaciones: Alerta' });
    await expect(alertSwitch).toBeEnabled();
    await alertSwitch.click();
    await expect(alertSwitch).not.toBeChecked();
    await page.getByLabel('Nivel de la notificación de prueba').selectOption('alerta');
    const send = page
      .getByRole('region', { name: 'Notificaciones' })
      .getByRole('button', { name: 'Enviar prueba', exact: true });
    await expect(send).toBeDisabled();
    await expect
      .poll(() =>
        app.evaluate(() => {
          const state = globalThis as typeof globalThis & {
            __tradiaNotificationCalls?: Array<{ title: string; body: string }>;
          };
          return state.__tradiaNotificationCalls?.length ?? 0;
        }),
      )
      .toBe(1);
  });

  test('cerrar la ventana mantiene vivo el latido y la pausa lo detiene', async () => {
    const page = await app.firstWindow();
    await acceptRisk(page);
    await expect
      .poll(() =>
        page.evaluate(() => window.tradia.agents.getState()).then((s) => s.lastHeartbeatAt),
      )
      .not.toBeNull();

    const beforeClose = await page.evaluate(() => window.tradia.agents.getState());
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.close();
    });
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false),
      )
      .toBe(false);
    await page.waitForTimeout(750);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.show();
    });
    const reopened = await app.firstWindow();
    const afterClose = await reopened.evaluate(() => window.tradia.agents.getState());
    expect(afterClose.lastHeartbeatAt).not.toBe(beforeClose.lastHeartbeatAt);

    await reopened.evaluate(() => window.tradia.agents.pause());
    const pausedAt = await reopened.evaluate(() => window.tradia.agents.getState());
    expect(pausedAt.paused).toBe(true);
    await reopened.waitForTimeout(750);
    await expect
      .poll(() => reopened.evaluate(() => window.tradia.agents.getState()))
      .toMatchObject({ paused: true, lastHeartbeatAt: pausedAt.lastHeartbeatAt });
  });

  test('la simulación sin conexión pausa decisiones y las reanuda al volver', async () => {
    const page = await app.firstWindow();
    await acceptRisk(page);

    await page.evaluate(() => window.tradia.testing?.simulateOffline(true));
    await expect(page.getByText('Sin conexión').first()).toBeVisible();
    await expect(page.getByText(/decisiones.*pausa/i)).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.tradia.agents.getState()))
      .toMatchObject({ paused: true, pauseReason: 'sin-conexion' });

    await page.evaluate(() => window.tradia.testing?.simulateOffline(false));
    await expect(page.getByText('Sin conexión').first()).toHaveCount(0);
    await expect(page.getByText('En línea').first()).toBeVisible();
    await expect
      .poll(() => page.evaluate(() => window.tradia.agents.getState()))
      .toMatchObject({ paused: false, pauseReason: null });
  });

  test('guarda claves cifradas y no deja el secreto en JSON ni en SQLite', async () => {
    const page = await app.firstWindow();
    await acceptRisk(page);
    await page.getByRole('link', { name: 'Ajustes' }).click();
    await page.getByLabel('Proveedor', { exact: true }).fill('Proveedor de prueba');
    await page.getByLabel('Clave nueva').fill('tradia-e2e-secret-not-a-real-key-49281');
    await page.getByRole('button', { name: 'Guardar clave', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Guardada (cifrada)' })).toBeVisible();

    const secret = 'tradia-e2e-secret-not-a-real-key-49281';
    await app.close();
    appClosed = true;

    const jsonMatches = containsValueInJsonFiles(userData, secret);
    expect(jsonMatches).toEqual([]);
    const database = readFileSync(join(userData, 'tradia.db'));
    expect(database.includes(secret)).toBe(false);
  });

  test('mantiene webPreferences seguras', async () => {
    const page = await app.firstWindow();
    await acceptRisk(page);
    expect(await page.evaluate(() => window.tradia.testing?.getContextIsolation())).toBe(true);
    expect(
      await page.evaluate(() => typeof (window as Window & { require?: unknown }).require),
    ).toBe('undefined');
  });
});
