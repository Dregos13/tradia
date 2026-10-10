import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import type { Signal } from '../src/shared/signals';

const projectRoot = resolve('.');
const DAY_MS = 24 * 60 * 60 * 1000;

async function launchTradia(userData: string, healthUrl: string): Promise<ElectronApplication> {
  return electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      TRADIA_E2E: '1',
      TRADIA_E2E_USER_DATA: userData,
      TRADIA_CONNECTIVITY_URLS: JSON.stringify([healthUrl, healthUrl]),
    },
  });
}

async function acceptRisk(page: Page): Promise<void> {
  await page.getByLabel('He leído y acepto').check();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible();
}

async function captureNotifications(app: ElectronApplication): Promise<void> {
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

async function notificationCalls(app: ElectronApplication) {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __tradiaNotificationCalls?: Array<{ title: string; body: string }>;
    };
    return state.__tradiaNotificationCalls ?? [];
  });
}

test('Profesional independiente: una vela cerrada en segundo plano actualiza señales, panel, diario y avisos', async () => {
  test.setTimeout(240_000);
  const userData = mkdtempSync(join(tmpdir(), 'tradia-signals-e2e-'));
  const connectivityServer: Server = createServer((_request, response) => {
    response.writeHead(204).end();
  });
  await new Promise<void>((resolveListen, reject) => {
    connectivityServer.once('error', reject);
    connectivityServer.listen(0, '127.0.0.1', resolveListen);
  });
  const healthUrl = `http://127.0.0.1:${(connectivityServer.address() as AddressInfo).port}/health`;
  let app: ElectronApplication | null = null;

  try {
    app = await launchTradia(userData, healthUrl);
    const page = await app.firstWindow();
    await acceptRisk(page);
    await captureNotifications(app);

    await page.evaluate(async () => {
      await window.tradia.watchlist.add('SPY');
      await window.tradia.watchlist.add('QQQ');
    });
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.tradia.market.getBars({ ticker: 'SPY' })).bars.length,
        ),
      )
      .toBeGreaterThan(750);

    const strategy = await page.evaluate(async () => {
      const found = (await window.tradia.strategies.list()).find(
        (item) => item.name === 'Reversión RSI/Bollinger',
      );
      if (!found) throw new Error('No se encontró la estrategia semilla Reversión RSI/Bollinger');
      const detail = await window.tradia.strategies.get({ id: found.id });
      if (!detail?.executable) throw new Error('La estrategia semilla no es ejecutable');
      const changed = await window.tradia.strategies.update({
        id: detail.id,
        note: 'Ventana corta para comprobar el motor de señales E2E.',
        parameters: {
          ...detail.parameters,
          rsiPeriod: 2,
          oversold: 50,
          trendPeriod: 2,
          atrPeriod: 2,
        },
      });
      await window.tradia.strategies.setStatus({ id: changed.id, status: 'activa' });
      return changed.id;
    });

    // Cerrar la ventana no detiene la ingesta ni la evaluación del motor.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
    await expect
      .poll(() =>
        app!.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false,
        ),
      )
      .toBe(false);

    let emitted: Signal[] = [];
    let previousDate = (
      await page.evaluate(() => window.tradia.market.getBars({ ticker: 'SPY' }))
    ).bars.at(-1)?.date;
    for (let day = 0; day < 120; day += 1) {
      await page.evaluate(
        (delta) => window.tradia.testing!.advanceMarketClock(delta),
        DAY_MS + 8 * 60 * 60 * 1000,
      );
      const currentDate = (
        await page.evaluate(() => window.tradia.market.getBars({ ticker: 'SPY' }))
      ).bars.at(-1)?.date;
      if (currentDate !== previousDate) {
        previousDate = currentDate;
        emitted = await page.evaluate(() => window.tradia.signals.list({ limit: 20 }));
        if (emitted.length > 0) break;
      }
    }
    expect(
      emitted.length,
      'el cierre de una nueva vela debe emitir al menos una señal',
    ).toBeGreaterThan(0);
    expect(
      emitted.every((signal) => signal.strategies.some((vote) => vote.strategyId === strategy)),
    ).toBe(true);
    expect(emitted[0]).toMatchObject({
      dataUsed: { source: 'simulated', barCount: expect.any(Number) },
      strategies: [{ version: 2, reason: expect.any(String) }],
    });
    // Las ventas no llevan protección propia: se vetan con motivo legible.
    // Las compras llevan stop y objetivo (targetR de la ficha), así que su
    // decisión depende de la cautela y los límites del instante simulado.
    if (emitted[0]!.target === null) {
      expect(emitted[0]).toMatchObject({
        decision: {
          status: 'vetada',
          reasons: expect.arrayContaining([expect.objectContaining({ code: 'RR_TOO_LOW' })]),
        },
      });
    } else {
      expect(['aprobada', 'reducida', 'vetada']).toContain(emitted[0]!.decision.status);
    }

    // La ruta de veto se comprueba también con una entrada directa válida,
    // para que el aviso no dependa de que el paseo aleatorio genere otra.
    const veto = await page.evaluate(() =>
      window.tradia.risk.submitSignal({
        ticker: 'SPY',
        direction: 'largo',
        entry: 100,
        stop: 95,
        target: null,
        confidence: 0.7,
        origin: 'e2e',
      }),
    );
    expect(veto.status).toBe('vetada');

    // Una curva que rebasa drawdown genera el aviso de límite en la siguiente vela.
    await page.evaluate(() =>
      window.tradia.testing!.risk.seedPortfolio({
        equity: 85_000,
        equityHistory: [{ at: '2020-01-02T00:00:00.000Z', equity: 100_000 }],
      }),
    );
    expect(
      (await page.evaluate(() => window.tradia.risk.getPortfolio())).drawdownPct,
    ).toBeGreaterThan(10);
    const limitStart = previousDate;
    for (let day = 0; day < 28; day += 1) {
      const seen = await notificationCalls(app);
      if (seen.some((n) => /Límites? alcanzados?/i.test(n.title))) break;
      await page.evaluate(
        (delta) => window.tradia.testing!.advanceMarketClock(delta),
        DAY_MS + 12 * 60 * 60 * 1000,
      );
    }
    await expect
      .poll(async () =>
        (await notificationCalls(app!)).some((n) => /Límites? alcanzados?/i.test(n.title)),
      )
      .toBe(true);
    expect(limitStart).toBeTruthy();

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.show());
    const visiblePage = await app.firstWindow();
    await expect(visiblePage.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible();
    await visiblePage.getByRole('link', { name: 'Inicio', exact: true }).click();
    await expect(visiblePage.getByText(/Confianza \d/).first()).toBeVisible();
    await visiblePage.getByRole('link', { name: 'Diario', exact: true }).click();
    await expect(visiblePage.getByRole('heading', { name: 'Diario', level: 2 })).toBeVisible();
    await expect(
      visiblePage.getByRole('row').filter({ hasText: emitted[0]!.ticker }).first(),
    ).toBeVisible();

    const calls = await notificationCalls(app);
    // La estrategia emite compras protegidas (aprobadas/reducidas) o vetos:
    // el aviso cubre cualquiera de los dos desenlaces.
    expect(
      calls.some((notification) => /Señal (vetada|aprobada)/i.test(notification.title)),
    ).toBe(true);
    expect(calls.some((notification) => /Límites? alcanzados?/i.test(notification.title))).toBe(
      true,
    );
    const journal = await visiblePage.evaluate(
      (ticker) => window.tradia.journal.list({ ticker, limit: 1000 }),
      emitted[0]!.ticker,
    );
    expect
      .soft(
        journal.entries.some(
          (entry) => entry.type === 'senal' && entry.signalId === emitted[0]!.id,
        ),
        `la señal no aparece enlazada en el diario; entradas: ${JSON.stringify(journal.entries.map(({ type, signalId, result }) => ({ type, signalId, result })))}`,
      )
      .toBe(true);
    await visiblePage.screenshot({ path: 'test-results/signals-dashboard.png' });
  } finally {
    if (app) await app.close();
    await new Promise<void>((resolveClose, reject) =>
      connectivityServer.close((error) => (error ? reject(error) : resolveClose())),
    );
    rmSync(userData, { recursive: true, force: true });
  }
});
