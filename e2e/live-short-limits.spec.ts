import { expect, test } from '@playwright/test';
import { liveConfirmationPhrase, type LiveLimits } from '../src/shared/live';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
} from './phase-6-7.helpers';

const limits: LiveLimits = {
  capitalUsd: 500,
  orderUsd: 100,
  dailyLossUsd: 10,
  openPositions: 1,
  shortOrderUsd: 100,
  shortExposureUsd: 200,
  shortPositions: 1,
};

test('Ajustes valida los techos del corto, confirma su frase y la ficha muestra el permiso', async () => {
  test.setTimeout(180_000);
  const context = await launchPhaseApp('tradia-short-limits');
  try {
    const { page } = context;
    const strategy = await page.evaluate(async () => {
      await window.tradia.testing!.live.useSimulatedBroker({ enabled: true });
      await window.tradia.testing!.live.seedProgress({
        paperMonths: 4,
        paperTrades: 34,
        deviationPct: -4,
        finalTestDone: true,
        alertsTested: true,
        paperShortTrades: 5,
        paperShortWeeks: 5,
      });
      await window.tradia.live.testKillSwitch();
      await window.tradia.live.declare({ requirement: 'claves-sin-retirada', confirmed: true });
      await window.tradia.live.declare({
        requirement: 'plan-contingencia',
        confirmed: true,
        detail: 'Plan E2E: parada y cierre manual desde Alpaca si no hay conexión.',
      });
      await window.tradia.live.declare({ requirement: 'revision-legal', confirmed: true });
      await window.tradia.live.declare({ requirement: 'revision-legal-corto', confirmed: true });
      return window.tradia.strategies.create({
        name: 'Corto con límites confirmados',
        hypothesis: 'Cruce de medias bajista',
        rules: {
          entry: 'cruza_arriba(sma(20), sma(50))',
          exit: 'cruza_abajo(sma(20), sma(50))',
          entryShort: 'cruza_abajo(sma(20), sma(50))',
          exitShort: 'cruza_arriba(sma(20), sma(50))',
          stop: '2%',
          target: 'ninguno',
        },
        parameters: {},
        markets: ['SPY'],
        regime: 'Tendencial',
      });
    });
    await page.evaluate((id) => {
      window.location.hash = `estrategias/${id}`;
    }, strategy.id);
    await expect(page.getByText(/Corto con dinero real desactivado/)).toBeVisible();
    await openPage(page, 'Ajustes');
    await page.getByLabel('Clave de API live').fill('AKE2ELIVE0001');
    await page.getByLabel('Secreto de API live').fill('e2e-live-secret-0001');
    await page.getByRole('button', { name: 'Verificar y guardar claves live' }).click();
    await expect(
      page.getByText('Cuenta live verificada. Conectar las claves no activa dinero real.'),
    ).toBeVisible();
    const accountRow = page.getByRole('listitem').filter({
      has: page.getByRole('heading', { name: 'Cuenta Alpaca preparada para ventas en corto' }),
    });
    await expect(accountRow.getByText('Cumplido', { exact: true })).toBeVisible();
    await expect(accountRow.getByText('Verificación automática')).toBeVisible();
    const capital = accountRow.getByText(
      'Cuenta live con margen · corto habilitado · capital 100.250,55 USD, mínimo 2.000,00 USD.',
    );
    await expect(capital).toBeVisible();
    await expect(capital).toHaveCSS('font-variant-numeric', 'tabular-nums');
    const fields = [
      ['Capital total en real', limits.capitalUsd],
      ['Máximo por orden', limits.orderUsd],
      ['Pérdida diaria máxima', limits.dailyLossUsd],
      ['Posiciones abiertas simultáneas', limits.openPositions],
    ] as const;
    for (const [label, value] of fields)
      await page.getByLabel(label, { exact: true }).fill(String(value));
    await page.getByRole('button', { name: 'Guardar límites' }).click();
    const confirm = page.getByRole('button', { name: 'Confirmar límites y activar dinero real' });
    await expect(confirm).toBeEnabled();
    const shortOrder = page.getByLabel('Máximo por orden en corto', { exact: true });
    await shortOrder.fill('');
    await expect(shortOrder).toHaveAttribute('aria-invalid', 'true');
    await expect(confirm).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Guardar límites' })).toBeDisabled();
    await shortOrder.fill('0');
    await expect(confirm).toBeEnabled();
    for (const [label, value] of [
      ['Máximo por orden en corto', limits.shortOrderUsd],
      ['Exposición corta total máxima', limits.shortExposureUsd],
      ['Posiciones cortas simultáneas', limits.shortPositions],
    ] as const) {
      const input = page.getByLabel(label, { exact: true });
      await expect(input).toHaveValue('0');
      await input.fill(String(value + 1));
      await expect(input).toHaveAttribute('aria-invalid', 'true');
      await expect(input).toHaveAccessibleDescription(/Tu límite supera el techo/);
      const errorId = (await input.getAttribute('aria-describedby'))!.split(' ').at(-1)!;
      await expect(page.locator(`[id="${errorId}"]`)).toHaveAttribute('role', 'alert');
      await expect(page.getByRole('button', { name: 'Guardar límites' })).toBeDisabled();
      await input.fill(String(value));
    }
    await capturePhaseScreenshot(
      page,
      'corto-real-ajustes-limites.png',
      page.getByLabel('Máximo por orden en corto', { exact: true }),
    );
    await page.getByRole('button', { name: 'Guardar límites' }).click();
    await expect(page.getByText(liveConfirmationPhrase(limits), { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar límites y activar dinero real' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Confirmar activación de dinero real' });
    await expect(dialog.getByRole('button', { name: 'Cancelar y seguir en paper' })).toBeFocused();
    await dialog
      .getByLabel('Escribe exactamente esta frase para confirmar')
      .fill(liveConfirmationPhrase(limits));
    await dialog.getByRole('button', { name: 'Activar dinero real con estos límites' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText('Límites confirmados por escrito.')).toBeVisible();
    await page.evaluate((id) => {
      window.location.hash = `estrategias/${id}`;
    }, strategy.id);
    const status = page.getByText(/Corto con dinero real permitido por los límites confirmados/);
    await capturePhaseScreenshot(page, 'corto-real-ficha-permitido.png', status.locator('..'));
    await expect(status).toContainText(
      '100,00 USD por orden, 200,00 USD de exposición total y 1 posición en corto',
    );
    await expect(
      page.getByText(/con dinero real solo se ejecutan las entradas en largo/),
    ).toHaveCount(0);
  } finally {
    await closePhaseApp(context);
  }
});

for (const account of [
  { equityUsd: 1999.99, shortingEnabled: true, capital: '1.999,99 USD' },
  { equityUsd: 2500, shortingEnabled: false, capital: '2.500,00 USD' },
]) {
  test(`cuenta Alpaca pendiente (${account.capital}, corto ${account.shortingEnabled}) bloquea hasta una nueva verificación`, async () => {
    const context = await launchPhaseApp('tradia-short-account');
    try {
      const { page } = context;
      await openPage(page, 'Ajustes');
      const accountRow = page.getByRole('listitem').filter({
        has: page.getByRole('heading', { name: 'Cuenta Alpaca preparada para ventas en corto' }),
      });
      const shortInputs = [
        page.getByLabel('Máximo por orden en corto', { exact: true }),
        page.getByLabel('Exposición corta total máxima', { exact: true }),
        page.getByLabel('Posiciones cortas simultáneas', { exact: true }),
      ];
      await expect(accountRow.getByText('Revisar', { exact: true })).toBeVisible();
      await expect(
        accountRow.getByText('Capital leído: no disponible · mínimo 2.000,00 USD.'),
      ).toBeVisible();
      for (const input of shortInputs) {
        await expect(input).toHaveAttribute('readonly', '');
        await expect(input).toHaveAttribute('aria-disabled', 'true');
      }
      await page.evaluate(async (fixture) => {
        await window.tradia.testing!.live.useSimulatedBroker({
          enabled: true,
          account: { equityUsd: fixture.equityUsd, shortingEnabled: fixture.shortingEnabled },
        });
        await window.tradia.testing!.live.seedProgress({
          paperMonths: 4,
          paperTrades: 34,
          deviationPct: -4,
          finalTestDone: true,
          killSwitchTested: true,
          alertsTested: true,
          paperShortTrades: 5,
          paperShortWeeks: 5,
        });
        for (const requirement of [
          'claves-sin-retirada',
          'plan-contingencia',
          'revision-legal',
          'revision-legal-corto',
        ] as const)
          await window.tradia.live.declare({ requirement, confirmed: true });
        await window.tradia.live.connect({
          apiKeyId: 'AKE2ELIVE0001',
          apiSecret: 'e2e-live-secret-0001',
        });
      }, account);
      await accountRow.getByRole('button', { name: 'Revisar conexión live' }).click();
      await expect(accountRow.getByText('Pendiente', { exact: true })).toBeVisible();
      await expect(
        accountRow.getByText(`Capital leído: ${account.capital} · mínimo 2.000,00 USD.`),
      ).toBeVisible();
      for (const input of shortInputs) {
        await expect(input).toHaveAttribute('readonly', '');
        await expect(input).toHaveAttribute('aria-disabled', 'true');
        await expect(input).toHaveAccessibleDescription(
          /La cuenta live de Alpaca debe tener margen, el corto habilitado y al menos 2\.000,00 USD de capital/,
        );
        await input.focus();
        await page.keyboard.type('1');
        await expect(input).toHaveValue('0');
      }
      await page.evaluate(async () => {
        await window.tradia.testing!.live.useSimulatedBroker({ enabled: true });
        await window.tradia.live.connect({
          apiKeyId: 'AKE2ELIVE0001',
          apiSecret: 'e2e-live-secret-0001',
        });
      });
      await accountRow.getByRole('button', { name: 'Revisar conexión live' }).click();
      await expect(accountRow.getByText('Cumplido', { exact: true })).toBeVisible();
      for (const input of shortInputs) {
        await expect(input).not.toHaveAttribute('readonly');
        await expect(input).not.toHaveAttribute('aria-disabled');
      }
    } finally {
      await closePhaseApp(context);
    }
  });
}

test('los requisitos del corto bloquean edición, conservan límites y abren órdenes paper', async () => {
  const context = await launchPhaseApp('tradia-short-readiness');
  try {
    const { page } = context;
    // El control de cuenta del corto exige una cuenta live conectada:
    // lista del largo cumplida y conexión contra el broker live falso
    // (su cuenta acredita margen, corto habilitado y capital ≥ 2.000).
    await page.evaluate(async () => {
      await window.tradia.testing!.live.useSimulatedBroker({ enabled: true });
      await window.tradia.testing!.live.seedProgress({
        paperMonths: 4,
        paperTrades: 34,
        deviationPct: -4,
        finalTestDone: true,
        killSwitchTested: true,
        alertsTested: true,
      });
      for (const requirement of [
        'claves-sin-retirada',
        'plan-contingencia',
        'revision-legal',
      ] as const) {
        await window.tradia.live.declare({ requirement, confirmed: true });
      }
      await window.tradia.live.connect({
        apiKeyId: 'AKE2ELIVE0001',
        apiSecret: 'e2e-live-secret-0001',
      });
    });
    await openPage(page, 'Ajustes');
    const readiness = page.getByRole('region', { name: 'Preparación del corto con dinero real' });
    const order = page.getByLabel('Máximo por orden en corto', { exact: true });
    await expect(order).toHaveAttribute('readonly', '');
    await expect(order).toHaveAttribute('aria-disabled', 'true');
    await order.focus();
    await expect(order).toBeFocused();
    await page.keyboard.type('100');
    await expect(order).toHaveValue('0');
    await page.getByLabel('Capital total en real', { exact: true }).fill('500');
    await page.getByLabel('Máximo por orden', { exact: true }).fill('100');
    await page.getByLabel('Pérdida diaria máxima', { exact: true }).fill('10');
    await page.getByLabel('Posiciones abiertas simultáneas', { exact: true }).fill('1');
    await page.getByRole('button', { name: 'Guardar límites', exact: true }).click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Límites guardados · todavía debes confirmarlos por escrito.' }),
    ).toBeVisible();
    await readiness.getByRole('checkbox', { name: /CNMV\/MiFID II.*IRPF/ }).check();
    await readiness.getByRole('button', { name: 'Guardar declaración', exact: true }).click();
    await expect(order).toHaveAttribute('readonly', '');
    await page.evaluate(() =>
      window.tradia.testing!.live.seedProgress({ paperShortTrades: 5, paperShortWeeks: 5 }),
    );
    await readiness.getByRole('button', { name: 'Reintentar comprobación' }).click();
    await expect(order).not.toHaveAttribute('readonly');
    await order.fill('100');
    await page.getByLabel('Exposición corta total máxima').fill('200');
    await page.getByLabel('Posiciones cortas simultáneas').fill('1');
    await page.getByRole('button', { name: 'Guardar límites', exact: true }).click();
    await expect(page.getByText(liveConfirmationPhrase(limits), { exact: true })).toBeVisible();
    await readiness.getByRole('checkbox', { name: /CNMV\/MiFID II.*IRPF/ }).uncheck();
    await readiness.getByRole('button', { name: 'Guardar retirada de declaración' }).click();
    await expect(order).toHaveValue('100');
    await expect(order).toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: 'Guardar límites', exact: true })).toBeDisabled();
    await expect(readiness.getByText(/Tus límites del corto siguen guardados/)).toBeVisible();
    await page.getByLabel('Capital total en real', { exact: true }).fill('400');
    const reset = page.getByRole('button', { name: 'Poner el corto a 0', exact: true });
    await reset.focus();
    await expect(reset).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(order).toBeFocused();
    for (const label of [
      'Máximo por orden en corto',
      'Exposición corta total máxima',
      'Posiciones cortas simultáneas',
    ]) {
      const input = page.getByLabel(label, { exact: true });
      await expect(input).toHaveValue('0');
      await expect(input).toHaveAttribute('readonly', '');
      await expect(input).toHaveAttribute('aria-disabled', 'true');
      await expect(input).toHaveAccessibleDescription(/declaración|requisitos/i);
      await input.focus();
      await page.keyboard.type('1');
      await expect(input).toHaveValue('0');
    }
    const save = page.getByRole('button', { name: 'Guardar límites', exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Límites guardados · todavía debes confirmarlos por escrito.' }),
    ).toBeVisible();
    expect((await page.evaluate(() => window.tradia.live.checklist())).limits.limits).toEqual({
      ...limits,
      capitalUsd: 400,
      shortOrderUsd: 0,
      shortExposureUsd: 0,
      shortPositions: 0,
    });
    for (const [width, theme] of [
      [1440, 'light'],
      [700, 'dark'],
    ] as const) {
      await page.setViewportSize({ width, height: 1000 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await readiness.scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await readiness.screenshot({ path: `/tmp/tradia-short-${width}-${theme}.png` });
    }
    await readiness.getByRole('link', { name: 'Ver órdenes paper' }).click();
    await expect(page.getByRole('combobox', { name: 'Modo' })).toHaveValue('paper');
  } finally {
    await closePhaseApp(context);
  }
});
