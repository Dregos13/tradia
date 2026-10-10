import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

const projectRoot = resolve('.');
const evidenceDir = resolve(projectRoot, 'docs/qa/capturas');
const DAY_MS = 24 * 60 * 60 * 1000;

let app: ElectronApplication;
let page: Page;
let userData: string;
let connectivityServer: Server;

test.beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), 'tradia-paper-e2e-'));
  connectivityServer = createServer((_request, response) => {
    response.writeHead(204).end();
  });
  await new Promise<void>((resolveListen, reject) => {
    connectivityServer.once('error', reject);
    connectivityServer.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = connectivityServer.address() as AddressInfo;
  app = await electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      TRADIA_E2E: '1',
      TRADIA_E2E_USER_DATA: userData,
      TRADIA_CONNECTIVITY_URLS: JSON.stringify([`http://127.0.0.1:${port}/health`]),
      // Reloj de mercado anclado a un martes: sin él la cautela evaluaría la
      // fecha real y un fin de semana vetaría todas las señales (festivo).
      TRADIA_E2E_MARKET_NOW: process.env.TRADIA_E2E_MARKET_NOW ?? '2026-10-06T22:00:00.000Z',
    },
  });
  page = await app.firstWindow();
  await page.getByLabel('He leído y acepto').check();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible();
});

test.afterEach(async () => {
  await app.close();
  await new Promise<void>((resolveClose, reject) =>
    connectivityServer.close((error) => (error ? reject(error) : resolveClose())),
  );
  rmSync(userData, { recursive: true, force: true });
});

async function connectPaper(): Promise<void> {
  await page.getByRole('link', { name: 'Ajustes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
  const settings = page.locator('.broker-settings');
  await expect(settings.getByText('Solo paper · sin dinero real')).toBeVisible();
  const connect = settings.getByRole('button', { name: 'Probar conexión', exact: true });
  await expect(connect).toBeDisabled();
  await page.getByLabel('Clave de API', { exact: true }).fill('PKTESTKEY01');
  await page.getByLabel('Secreto de API', { exact: true }).fill('paper-test-secret-01');
  await expect(connect).toBeEnabled();
  await connect.click();
  await expect(settings.getByText('Cuenta paper conectada', { exact: true })).toBeVisible();
  await expect(settings.getByText('Broker simulado')).toBeVisible();
  await expect(settings.getByText('Clave y secreto guardados de forma cifrada')).toBeVisible();
  await captureEvidence('fase-5-perfil-a-ajustes-paper.png', '.broker-settings');
}

async function captureNotifications(): Promise<void> {
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

async function captureEvidence(name: string, targetSelector?: string): Promise<void> {
  await page.locator('.main').evaluate((element) => {
    element.scrollTop = 0;
    element
      .querySelectorAll<HTMLElement>(
        '.orders-table-wrap, .deviation-table-wrap, .journal-table-scroll',
      )
      .forEach((table) => {
        table.scrollLeft = 0;
      });
  });
  if (targetSelector) {
    await page.locator(targetSelector).evaluate((element) => {
      element.scrollIntoView({ block: 'start' });
    });
  }
  await page.screenshot({ path: resolve(evidenceDir, name) });
}

async function createApprovedStrategySignal() {
  await page.evaluate(async () => {
    await window.tradia.watchlist.add('SPY');
  });
  await expect
    .poll(() =>
      page.evaluate(
        async () => (await window.tradia.market.getBars({ ticker: 'SPY' })).bars.length,
      ),
    )
    .toBeGreaterThan(750);

  const strategyId = await page.evaluate(async () => {
    const strategy = (await window.tradia.strategies.list()).find(
      (item) => item.name === 'Reversión RSI/Bollinger',
    );
    if (!strategy) throw new Error('Falta la estrategia semilla Reversión RSI/Bollinger');
    const detail = await window.tradia.strategies.get({ id: strategy.id });
    if (!detail?.executable) throw new Error('La estrategia semilla no es ejecutable');
    const updated = await window.tradia.strategies.update({
      id: detail.id,
      note: 'Parámetros deterministas para la comprobación E2E de ejecución paper.',
      parameters: {
        ...detail.parameters,
        rsiPeriod: 2,
        oversold: 50,
        trendPeriod: 2,
        atrPeriod: 2,
      },
    });
    await window.tradia.strategies.setStatus({ id: updated.id, status: 'activa' });
    return updated.id;
  });

  let signals: Awaited<ReturnType<typeof window.tradia.signals.list>> = [];
  for (let day = 0; day < 90; day += 1) {
    await page.evaluate(
      (delta) => window.tradia.testing!.advanceMarketClock(delta),
      DAY_MS + 8 * 60 * 60 * 1000,
    );
    signals = await page.evaluate(() => window.tradia.signals.list({ limit: 100 }));
    const approved = signals.find(
      (signal) =>
        signal.strategies.some((vote) => vote.strategyId === strategyId) &&
        (signal.decision.status === 'aprobada' || signal.decision.status === 'reducida'),
    );
    if (approved) return approved;
  }
  throw new Error(
    `No se emitió ninguna señal aprobada/reducida en 90 sesiones; señales encontradas: ${JSON.stringify(
      signals.map((signal) => ({
        ticker: signal.ticker,
        status: signal.decision.status,
        reasons: signal.decision.reasons.map((reason) => reason.code),
        target: signal.target,
      })),
    )}`,
  );
}

test.describe('Profesional independiente que organiza varios proyectos', () => {
  test('conecta una cuenta paper desde Ajustes y conserva visible la insignia Solo paper', async () => {
    await connectPaper();
    await expect(page.locator('.broker-settings')).toContainText('Activado');
    await expect(page.getByLabel('Ejecutar señales aprobadas en paper')).toBeChecked();
  });

  test('una señal aprobada ejecuta la entrada y muestra precios, slippage y protección OCO', async () => {
    test.setTimeout(240_000);
    await connectPaper();
    const signal = await createApprovedStrategySignal();

    await expect
      .poll(async () =>
        page.evaluate(
          async (signalId) =>
            (await window.tradia.orders.list({})).find(
              (candidate) => candidate.signalId === signalId && candidate.leg === 'entrada',
            ) ?? null,
          signal.id,
        ),
      )
      .not.toBeNull();

    const entry = await page.evaluate(
      async (signalId) =>
        (await window.tradia.orders.list({})).find(
          (candidate) => candidate.signalId === signalId && candidate.leg === 'entrada',
        ) ?? null,
      signal.id,
    );
    expect(entry).not.toBeNull();
    expect(entry!.execution).toMatchObject({
      requestedAt: expect.any(String),
      requestedPrice: expect.any(Number),
      executedAt: expect.any(String),
      executedPrice: expect.any(Number),
      slippageBps: expect.any(Number),
    });
    await expect
      .poll(async () =>
        page.evaluate(
          async (signalId) =>
            (await window.tradia.orders.list({})).filter(
              (candidate) => candidate.signalId === signalId && candidate.type === 'oco',
            ),
          signal.id,
        ),
      )
      .toHaveLength(1);

    await page.getByRole('link', { name: 'Órdenes', exact: true }).click();
    const table = page.getByRole('table', { name: 'Órdenes paper y precios de ejecución' });
    await expect(page.getByText(/Solo paper · sin dinero real/)).toBeVisible();
    for (const heading of ['Hora', 'Precio pedido', 'Precio ejecutado', 'Slippage']) {
      await expect(table.getByRole('columnheader', { name: heading, exact: true })).toBeVisible();
    }
    await expect(table).toContainText(signal.ticker);
    await expect(table).toContainText('Protección OCO');
    await captureEvidence('fase-5-perfil-a-orden-ejecutada.png', '.orders-table-wrap');
  });

  test('permite crear una orden limitada pendiente y cancelarla desde Órdenes', async () => {
    await connectPaper();
    await page.getByRole('link', { name: 'Órdenes', exact: true }).click();
    await expect(
      page.locator('#contenido').getByRole('heading', { name: 'Órdenes', exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: 'test-results/paper-trading-limit-order.png' });

    const createLimit = page.getByRole('button', { name: /crear orden limitada/i });
    await expect(createLimit).toBeVisible();
    await createLimit.click();
    await expect(page.getByLabel('Activo')).toBeVisible();
    await page.getByLabel('Activo').fill('AAPL');
    await page.getByLabel('Cantidad').fill('2');
    await page.getByLabel('Precio límite').fill('1');
    await page.getByRole('button', { name: 'Enviar orden limitada', exact: true }).click();

    const pending = page.getByRole('row').filter({ hasText: 'AAPL' });
    // El broker acepta la limitada al instante: queda abierta ('Enviada'),
    // pendiente de ejecutarse y cancelable.
    await expect(pending).toContainText('Enviada');
    await captureEvidence('fase-5-perfil-a-orden-limitada-pendiente.png', '.orders-table-wrap');
    await pending.getByRole('button', { name: /cancelar orden/i }).click();
    await page.getByRole('button', { name: 'Confirmar cancelación', exact: true }).click();
    await expect(pending).toContainText('Cancelada');
    await captureEvidence('fase-5-perfil-a-orden-limitada-cancelada.png', '.orders-table-wrap');
  });

  test('un timeout al enviar la señal no duplica la orden', async () => {
    test.setTimeout(240_000);
    await connectPaper();
    await page.evaluate(() => window.tradia.testing!.broker.failNext({ kind: 'timeout' }));
    const signal = await createApprovedStrategySignal();

    await expect
      .poll(async () =>
        page.evaluate(
          async (signalId) =>
            (await window.tradia.orders.list({})).filter(
              (candidate) => candidate.signalId === signalId && candidate.leg === 'entrada',
            ).length,
          signal.id,
        ),
      )
      .toBe(1);
  });
});

test.describe('Responsable de equipo que revisa entregas', () => {
  test('la conciliación muestra la diferencia, la registra en el Diario y notifica', async () => {
    await connectPaper();
    await captureNotifications();
    await page.evaluate(() =>
      window.tradia.testing!.broker.createDiscrepancy({ kind: 'orden-fantasma' }),
    );
    await page.getByRole('link', { name: 'Órdenes', exact: true }).click();
    await page.getByRole('button', { name: 'Conciliar ahora', exact: true }).click();

    const banner = page.getByRole('alert', { name: 'Descuadre con el broker' });
    await expect(banner).toBeVisible();
    await expect(page.getByText(/Solo paper · sin dinero real/)).toBeVisible();
    const discrepancy = await page.evaluate(
      async () => (await window.tradia.reconcile.status()).openDiscrepancies[0] ?? null,
    );
    expect(discrepancy).not.toBeNull();
    expect(discrepancy!.ticker).toBe('AAPL');
    await expect(banner).toContainText(discrepancy!.detail);
    const journal = await page.evaluate(() => window.tradia.journal.list({ limit: 100 }));
    expect(
      journal.entries.some(
        (entry) =>
          entry.type === 'error' && entry.errors?.some((error) => error === discrepancy!.detail),
      ),
    ).toBe(true);
    await expect
      .poll(() =>
        app.evaluate(() => {
          const state = globalThis as typeof globalThis & {
            __tradiaNotificationCalls?: Array<{ title: string; body: string }>;
          };
          return state.__tradiaNotificationCalls?.some((call) =>
            /descuadre|conciliaci[oó]n/i.test(call.title),
          );
        }),
      )
      .toBe(true);
    await captureEvidence('fase-5-perfil-b-conciliacion-descuadre.png');
    const discrepancyEntry = journal.entries.find(
      (entry) =>
        entry.type === 'error' && entry.errors?.some((error) => error === discrepancy!.detail),
    );
    expect(discrepancyEntry).toBeDefined();
    await page.getByRole('link', { name: 'Diario', exact: true }).click();
    await expect(page.locator('.journal h2')).toHaveText('Diario');
    const detailButton = page.getByRole('button', {
      name: new RegExp(`entrada ${discrepancyEntry!.id}$`),
    });
    await detailButton.click();
    const detail = page.getByRole('dialog', { name: /Detalle del diario/ });
    await expect(detail).toContainText(discrepancy!.detail);
    await captureEvidence('fase-5-perfil-b-diario-descuadre.png');
  });

  test('ocho semanas sembradas generan informes semanales y mensuales con alerta', async () => {
    test.setTimeout(300_000);
    await connectPaper();
    await page.evaluate(async () => {
      for (const ticker of ['SPY', 'QQQ', 'DIA', 'IWM']) {
        await window.tradia.watchlist.add(ticker);
      }
    });
    await expect
      .poll(() =>
        page.evaluate(async () =>
          Math.min(
            ...(await Promise.all(
              ['SPY', 'QQQ', 'DIA', 'IWM'].map(
                async (ticker) => (await window.tradia.market.getBars({ ticker })).bars.length,
              ),
            )),
          ),
        ),
      )
      .toBeGreaterThan(750);
    const backtestIds = await page.evaluate(async () => {
      const strategies = await window.tradia.strategies.list();
      return strategies
        .filter((strategy) =>
          ['Cruce de medias', 'Reversión RSI/Bollinger'].includes(strategy.name),
        )
        .map((strategy) => strategy.id);
    });
    expect(backtestIds).toHaveLength(2);
    for (const strategyId of backtestIds) {
      await page.evaluate(
        (id) =>
          window.tradia.backtest.run({
            strategyId: id,
            desde: '2010-01-01',
            hasta: '2025-12-31',
            universe: ['SPY', 'QQQ', 'DIA', 'IWM'],
            walkForward: false,
            sensitivity: false,
            monteCarlo: false,
          }),
        strategyId,
      );
    }
    const seeded = await page.evaluate(() => window.tradia.testing!.broker.seedWeeks({ weeks: 8 }));
    expect(seeded.orders).toBeGreaterThan(0);
    await page.getByRole('link', { name: 'Real vs backtest', exact: true }).click();
    const report = page.getByRole('table', {
      name: 'Resultados semanales por estrategia y periodo cerrado',
    });
    await expect(report).toBeVisible();
    await expect(report).toContainText('Fuera de margen');
    await expect(page.getByText(/Solo paper · sin dinero real/)).toBeVisible();
    const weeklyData = await page.evaluate(() =>
      window.tradia.deviation.report({ period: 'semanal' }),
    );
    expect(weeklyData.rows).toHaveLength(16);
    expect(
      weeklyData.rows.some((row) => row.expectedReturnPct !== null && row.deviationPp !== null),
    ).toBe(true);
    expect(weeklyData.rows.some((row) => row.outOfMargin)).toBe(true);
    await captureEvidence('fase-5-perfil-b-real-vs-backtest-semanal.png');

    await page.getByRole('button', { name: 'Mensual', exact: true }).click();
    const monthly = page.getByRole('table', {
      name: 'Resultados mensuales por estrategia y periodo cerrado',
    });
    await expect(monthly).toBeVisible();
    await expect(monthly).toContainText('Fuera de margen');
    await expect(page.getByText(/Solo paper · sin dinero real/)).toBeVisible();
    const monthlyData = await page.evaluate(() =>
      window.tradia.deviation.report({ period: 'mensual' }),
    );
    expect(monthlyData.rows.length).toBeGreaterThanOrEqual(4);
    expect(monthlyData.rows.some((row) => row.outOfMargin)).toBe(true);
    await captureEvidence('fase-5-perfil-b-real-vs-backtest-mensual.png');
  });
});
