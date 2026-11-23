import { expect, test } from '@playwright/test';
import { closePhaseApp, launchPhaseApp, openPage, type PhaseApp } from './phase-6-7.helpers';

/**
 * Divisas y oro con OANDA en «Dinero real», contra el bróker simulado
 * (`fx-broker:use-simulated`: la misma API v20 servida en memoria, sin
 * red). Recorrido de quien empieza: conecta la cuenta de práctica, ve el
 * saldo y hace la orden mínima de prueba; la cuenta real sigue cerrada
 * sin la lista; los techos y la parada de emergencia mandan también por
 * IPC directo. Ninguna orden sale a OANDA.
 */

const TOKEN = '0123456789abcdef0123456789abcdef-fedcba9876543210fedcba9876543210';
const PRACTICE_ACCOUNT = '101-004-1234567-001';
const LIVE_ACCOUNT = '001-004-1234567-001';

let context: PhaseApp | undefined;

test.beforeEach(async () => {
  context = await launchPhaseApp('tradia-fx-oanda-e2e');
  await context.page.evaluate(() =>
    window.tradia.testing!.fxBroker.useSimulated({ enabled: true }),
  );
});

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

test.describe('Quien empieza con poco dinero en divisas', () => {
  test('conecta la práctica, ve el saldo y hace la orden mínima de prueba', async () => {
    test.setTimeout(120_000);
    const { page } = context!;
    await openPage(page, 'Dinero real');
    const panel = page.locator('section.fx-broker');
    await expect(panel.getByRole('heading', { name: 'Divisas y oro con OANDA' })).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Hacer orden de prueba en práctica' }),
    ).toBeDisabled();

    // Una cuenta real en la ranura de práctica se rechaza antes de tocar OANDA.
    await panel.getByLabel('Número de cuenta').fill(LIVE_ACCOUNT);
    await panel.getByLabel('Token de acceso (API)').fill(TOKEN);
    await panel.getByRole('button', { name: 'Conectar cuenta de práctica' }).click();
    await expect(panel.getByRole('alert').first()).toContainText('Esa cuenta es real');

    await panel.getByLabel('Número de cuenta').fill(PRACTICE_ACCOUNT);
    await panel.getByLabel('Token de acceso (API)').fill(TOKEN);
    await panel.getByRole('button', { name: 'Conectar cuenta de práctica' }).click();
    const balance = panel.getByLabel('Saldo de práctica');
    await expect(balance).toContainText('100,00 EUR');
    await expect(balance).toContainText('simulada');

    await panel.getByRole('button', { name: 'Hacer orden de prueba en práctica' }).click();
    const result = panel.getByRole('status', { name: 'Resultado de la orden de prueba' });
    await expect(result).toContainText('Orden de prueba correcta', { timeout: 20_000 });
    await expect(result).toContainText('Cuentas cuadradas con OANDA');
    await expect(panel.getByText('No tienes posiciones abiertas.')).toBeVisible();

    // El token nunca vuelve al renderer.
    const status = await page.evaluate(() => window.tradia.fxBroker.status());
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(status.practice.state).toBe('conectada');
    expect(status.lastReconcile.practice?.ok).toBe(true);
  });

  test('la cuenta real sigue cerrada y los techos y la parada mandan por IPC', async () => {
    test.setTimeout(120_000);
    const { page } = context!;
    await openPage(page, 'Dinero real');
    await expect(
      page.locator('section.fx-broker').getByText(/Se desbloquea cuando completes la lista/),
    ).toBeVisible();

    const live = await page.evaluate(
      ([token, accountId]) =>
        window.tradia.fxBroker.connect({ environment: 'live', token, accountId }),
      [TOKEN, LIVE_ACCOUNT] as const,
    );
    expect(live.live.state).toBe('error');
    expect(live.live.error).toContain('lista de comprobación');
    expect(live.live.hasCredentials).toBe(false);

    await page.evaluate(
      ([token, accountId]) =>
        window.tradia.fxBroker.connect({ environment: 'practice', token, accountId }),
      [TOKEN, PRACTICE_ACCOUNT] as const,
    );

    // Más riesgo que el límite de 1 € por orden: no sale.
    const risky = await page.evaluate(() =>
      window.tradia.fxBroker.placeOrder({
        environment: 'practice',
        instrument: 'EURUSD',
        side: 'buy',
        size: { units: 5000 },
        stopPrice: 1.07,
        targetPrice: 1.12,
      }),
    );
    expect(risky.ok).toBe(false);
    expect(risky.reasons.join(' ')).toContain('tu límite por orden es 1 €');

    // Por euros de riesgo: el proceso principal calcula las unidades.
    const sized = await page.evaluate(() =>
      window.tradia.fxBroker.placeOrder({
        environment: 'practice',
        instrument: 'EURUSD',
        side: 'buy',
        size: { riskEur: 1 },
        stopPrice: 1.08262,
        targetPrice: 1.08862,
      }),
    );
    expect(sized.reasons).toEqual([]);
    expect(sized.ok).toBe(true);
    expect(sized.units).toBeGreaterThan(1);
    expect(sized.riskEur).toBeLessThanOrEqual(1);
    await expect(
      page.locator('section.fx-broker').getByRole('table', { name: 'Posiciones abiertas' }),
    ).toContainText('EUR/USD');

    // La parada de emergencia cierra la posición de OANDA.
    await page.evaluate(() => window.tradia.testing!.risk.simulateCause('manual'));
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.tradia.fxBroker.status())).practice.positions.length,
        {
          timeout: 15_000,
        },
      )
      .toBe(0);
    const blocked = await page.evaluate(() =>
      window.tradia.fxBroker.placeOrder({
        environment: 'practice',
        instrument: 'GBPUSD',
        side: 'buy',
        size: { units: 1 },
        stopPrice: 1.26,
        targetPrice: 1.29,
      }),
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.reasons[0]).toContain('parada de emergencia');
  });
});
