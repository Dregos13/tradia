import { expect, test, type Page } from '@playwright/test';
import { liveConfirmationPhrase, type LiveLimits } from '../src/shared/live';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
  watchTickers,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * Órdenes con su modo (paper o dinero real) y el Diario de la prueba de
 * humo. La lista de comprobación se completa por IPC (su recorrido por
 * la interfaz está en live-gate.spec.ts) con el broker real simulado; la
 * orden paper se crea desde la pantalla «Órdenes», como lo haría el
 * usuario. Cada orden debe decir de qué cuenta salió, también cuando el
 * modo de la app cambia después.
 */

const LIMITS: LiveLimits = { capitalUsd: 500, orderUsd: 100, dailyLossUsd: 10, openPositions: 1, shortOrderUsd: 0, shortExposureUsd: 0, shortPositions: 0 };

let context: PhaseApp | undefined;

test.beforeEach(async () => {
  context = await launchPhaseApp('tradia-orders-mode-e2e');
});

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

const ordersTable = (page: Page) =>
  page.getByRole('region', { name: 'Órdenes, desplazamiento horizontal' });

const modeFilter = (page: Page) =>
  page.getByRole('region', { name: 'Filtros de órdenes' }).getByLabel('Modo');

async function createPaperLimitOrder(page: Page): Promise<void> {
  await page.evaluate(() =>
    window.tradia.broker.connect({ apiKeyId: 'PKTESTKEY01', apiSecret: 'paper-test-secret-01' }),
  );
  await openPage(page, 'Órdenes');
  await page.getByRole('button', { name: 'Crear orden limitada' }).click();
  await page.getByLabel('Activo').fill('AAPL');
  await page.getByLabel('Cantidad').fill('2');
  await page.getByLabel('Precio límite').fill('1');
  await page.getByRole('button', { name: 'Enviar orden limitada', exact: true }).click();
  await expect(ordersTable(page).getByRole('row').filter({ hasText: 'AAPL' })).toContainText(
    'Enviada',
  );
}

/** Lista completa, límites confirmados, claves live y activación (broker simulado). */
async function activateLiveByIpc(page: Page): Promise<void> {
  await page.evaluate(
    async ({ limits, phrase }) => {
      const live = window.tradia.live;
      await window.tradia.testing!.live.useSimulatedBroker({ enabled: true });
      await window.tradia.testing!.live.seedProgress({
        paperMonths: 4,
        paperTrades: 34,
        deviationPct: -4,
        finalTestDone: true,
        alertsTested: true,
      });
      await live.testKillSwitch();
      await live.declare({ requirement: 'claves-sin-retirada', confirmed: true });
      await live.declare({
        requirement: 'plan-contingencia',
        confirmed: true,
        detail: 'Plan E2E: parada, cierre manual en el panel del broker y aviso por correo.',
      });
      await live.declare({ requirement: 'revision-legal', confirmed: true });
      await live.setLimits(limits);
      await live.connect({ apiKeyId: 'AKE2ELIVE0001', apiSecret: 'e2e-live-secret-0001' });
      const result = await live.activate({ phrase });
      if (!result.activated) throw new Error(`No se activó: ${result.reasons.join(' · ')}`);
    },
    { limits: LIMITS, phrase: liveConfirmationPhrase(LIMITS) },
  );
}

test.describe('Responsable de equipo que revisa entregas', () => {
  test('Órdenes muestra el modo de cada orden y las órdenes reales de la prueba de humo; el Diario las rotula como dinero real', async () => {
    test.setTimeout(240_000);
    const { page } = context!;
    await watchTickers(page, ['SPY']);
    await createPaperLimitOrder(page);

    // Paper: cada orden lleva su insignia, nunca «Modo no disponible».
    const paperRow = ordersTable(page).getByRole('row').filter({ hasText: 'AAPL' });
    await expect(paperRow).toContainText('Paper · sin dinero real');
    await expect(page.getByText('Modo no disponible')).toHaveCount(0);
    await expect(page.getByLabel('Modo sin registrar')).toHaveCount(0);

    await activateLiveByIpc(page);
    const smoke = await page.evaluate(() => window.tradia.live.smokeTest({ confirm: true }));
    expect(smoke).toMatchObject({ state: 'cerrada-conciliada', ticker: 'SPY', discrepancies: 0 });
    const ipcOrders = await page.evaluate(() => window.tradia.orders.list({ mode: 'live' }));
    expect(ipcOrders.filter((order) => order.ticker === 'SPY').length).toBeGreaterThanOrEqual(2);
    expect(ipcOrders.every((order) => order.mode === 'live')).toBe(true);

    // Órdenes con el modo real activo: las reales de la prueba y la paper anterior.
    await openPage(page, 'Órdenes');
    await expect(
      page.getByRole('banner').getByText('Dinero real activo', { exact: true }),
    ).toBeVisible();
    const liveRows = ordersTable(page).getByRole('row').filter({ hasText: 'SPY' });
    await expect(liveRows).toHaveCount(ipcOrders.filter((order) => order.ticker === 'SPY').length);
    for (const row of await liveRows.all()) {
      await expect(row).toContainText('Dinero real');
      await expect(row.getByRole('cell').nth(5)).not.toHaveText('0');
      await expect(row.getByRole('cell').nth(8)).toContainText('Respecto a la referencia');
      await expect(row).not.toContainText('Paper · sin dinero real');
      // El canal de cancelación solo admite paper: una orden real no lo ofrece.
      await expect(row.getByRole('button', { name: /Cancelar orden/ })).toHaveCount(0);
    }
    await expect(paperRow).toContainText('Paper · sin dinero real');
    await expect(page.getByText('Modo no disponible')).toHaveCount(0);
    await capturePhaseScreenshot(page, 'continuacion-ordenes-paper-y-real.png', ordersTable(page));

    // Filtro por modo.
    await modeFilter(page).selectOption({ label: 'Dinero real' });
    await expect(ordersTable(page).getByRole('row').filter({ hasText: 'AAPL' })).toHaveCount(0);
    await expect(liveRows.first()).toBeVisible();
    await capturePhaseScreenshot(page, 'continuacion-ordenes-filtro-dinero-real.png');
    await modeFilter(page).selectOption({ label: 'Paper' });
    await expect(liveRows).toHaveCount(0);
    await expect(paperRow).toBeVisible();
    await expect(paperRow.getByRole('button', { name: /Cancelar orden/ })).toBeVisible();
    await modeFilter(page).selectOption({ label: 'Todos los modos' });
    await expect(liveRows.first()).toBeVisible();

    // Volver a paper no reetiqueta el histórico: cada orden conserva su modo.
    const liveBanner = page.getByRole('complementary', { name: 'Aviso de dinero real' });
    await liveBanner.getByRole('button', { name: 'Volver a paper', exact: true }).click();
    await page
      .getByRole('alertdialog', { name: 'Confirmar vuelta a paper' })
      .getByRole('button', { name: 'Confirmar vuelta a paper' })
      .click();
    await expect(liveBanner).toHaveCount(0);
    await expect(
      page.getByRole('banner').getByText('Señales + paper trading', { exact: true }),
    ).toBeVisible();
    await openPage(page, 'Inicio', 'Estado del sistema');
    await openPage(page, 'Órdenes');
    for (const row of await liveRows.all()) await expect(row).toContainText('Dinero real');
    await expect(paperRow).toContainText('Paper · sin dinero real');

    // Diario: la prueba de humo es una operación con dinero real.
    await openPage(page, 'Diario');
    const smokeEntry = page
      .getByRole('row')
      .filter({ hasText: /Prueba de humo · compra de .* uds de SPY/ })
      .first();
    await expect(smokeEntry).toContainText('Dinero real');
    await expect(smokeEntry).not.toContainText('Operación simulada');
    const journal = await page.evaluate(() => window.tradia.journal.list({ limit: 100 }));
    const smokeEntries = journal.entries.filter((entry) =>
      entry.reason.startsWith('Prueba de humo ·'),
    );
    expect(smokeEntries.length).toBeGreaterThanOrEqual(2);
    expect(smokeEntries.every((entry) => entry.mode === 'live')).toBe(true);
    await capturePhaseScreenshot(page, 'continuacion-diario-prueba-humo-real.png');
  });
});
