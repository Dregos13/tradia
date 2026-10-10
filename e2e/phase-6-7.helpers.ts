import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect } from '@playwright/test';
import {
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
} from 'playwright';

/**
 * Utilidades comunes de los E2E de la fase 6-7 (IA predictiva y dinero
 * real). La app arranca con los ganchos deterministas de TRADIA_E2E, el
 * reloj de mercado anclado a un martes y un servidor local que responde
 * la comprobación de conectividad (y, si la prueba lo pide, feeds RSS):
 * nada depende de la fecha real ni de la red.
 */

const projectRoot = resolve('.');
const evidenceDir = resolve(projectRoot, 'docs/qa/capturas');
export const PINNED_MARKET_NOW = '2026-10-06T22:00:00.000Z';

/** Ruta del servidor local: devuelve true si atendió la petición. */
export type LocalRoute = (request: IncomingMessage, response: ServerResponse) => boolean;

export interface PhaseApp {
  app: ElectronApplication;
  page: Page;
  userData: string;
  server: Server;
  /** URL absoluta de una ruta del servidor local. */
  url(path: string): string;
}

export interface NotificationCall {
  title: string;
  body: string;
}

export async function launchPhaseApp(
  prefix: string,
  options: { route?: LocalRoute } = {},
): Promise<PhaseApp> {
  const userData = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const server = createServer((request, response) => {
    if (options.route?.(request, response)) return;
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/health') {
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = server.address() as AddressInfo;
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;

  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
      cwd: projectRoot,
      env: {
        ...process.env,
        TRADIA_E2E: '1',
        TRADIA_E2E_USER_DATA: userData,
        TRADIA_CONNECTIVITY_URLS: JSON.stringify([url('/health')]),
        // Reloj de mercado anclado: la cautela y las sesiones no dependen
        // del día real en que se ejecute la batería.
        TRADIA_E2E_MARKET_NOW: PINNED_MARKET_NOW,
      },
    });
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'Antes de empezar' })).toBeVisible({
      timeout: 30_000,
    });
    await page.getByLabel('He leído y acepto').check();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible({
      timeout: 30_000,
    });
    return { app, page, userData, server, url };
  } catch (error: unknown) {
    await app?.close().catch(() => undefined);
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    rmSync(userData, { recursive: true, force: true });
    throw error;
  }
}

export async function closePhaseApp(context: PhaseApp | undefined): Promise<void> {
  if (!context) return;
  try {
    await context.app.close();
  } finally {
    await new Promise<void>((resolveClose, reject) =>
      context.server.close((error) => (error ? reject(error) : resolveClose())),
    );
    rmSync(context.userData, { recursive: true, force: true });
  }
}

/** Abre una página desde la navegación lateral y espera el título de la cabecera. */
export async function openPage(page: Page, link: string, heading = link): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Principal' })
    .getByRole('link', { name: link, exact: true })
    .click();
  await expect(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible({
    timeout: 15_000,
  });
}

/** Añade activos al seguimiento y espera a que el mercado simulado guarde velas. */
export async function watchTickers(page: Page, tickers: readonly string[]): Promise<void> {
  await page.evaluate(async (list) => {
    for (const ticker of list) await window.tradia.watchlist.add(ticker);
  }, tickers);
  await expect
    .poll(
      () =>
        page.evaluate(
          async (list) =>
            Math.min(
              ...(await Promise.all(
                list.map(
                  async (ticker) => (await window.tradia.market.getBars({ ticker })).bars.length,
                ),
              )),
            ),
          tickers,
        ),
      { timeout: 90_000 },
    )
    .toBeGreaterThan(250);
}

/** Sustituye las notificaciones nativas por una grabadora en el proceso principal. */
export async function recordNotifications(app: ElectronApplication): Promise<void> {
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
}

export async function recordedNotifications(app: ElectronApplication): Promise<NotificationCall[]> {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __tradiaNotificationCalls?: Array<{ title: string; body: string }>;
    };
    return [...(state.__tradiaNotificationCalls ?? [])];
  });
}

/**
 * Captura de evidencia. Con `target` la sección se desplaza al principio
 * del contenedor desplazable (.main) antes de la captura, para que la
 * pantalla nueva quede visible en la imagen.
 */
export async function capturePhaseScreenshot(
  page: Page,
  filename: string,
  target?: Locator,
): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  // Las tablas anchas arrancan en su primera columna en la evidencia.
  await page.locator('.main').evaluate((element) => {
    element.querySelectorAll<HTMLElement>('[role="region"][tabindex="0"]').forEach((wrap) => {
      wrap.scrollLeft = 0;
    });
  });
  if (target) {
    await target.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  } else {
    await page.locator('.main').evaluate((element) => {
      element.scrollTop = 0;
    });
  }
  await page.screenshot({ path: resolve(evidenceDir, filename) });
}
