import { expect, test, type Page } from '@playwright/test';
import {
  LIVE_DECLARATION_TEXTS,
  LIVE_REQUIREMENT_TITLES,
  liveConfirmationPhrase,
  type LiveLimits,
} from '../src/shared/live';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
  watchTickers,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * Fase 7 · lista de comprobación, bloqueo del dinero real y prueba de humo
 * con el importe mínimo. El broker real es el adaptador Alpaca Live contra
 * el servidor falso (`live:use-simulated-broker`); la evidencia automática
 * de meses de paper, prueba final y alertas se siembra con
 * `live:seed-progress`. Nada sale a la red.
 */

const LIMITS: LiveLimits = { capitalUsd: 500, orderUsd: 100, dailyLossUsd: 10, openPositions: 1, shortOrderUsd: 0, shortExposureUsd: 0, shortPositions: 0 };
const LIVE_KEY = 'AKE2ELIVE0001';
const LIVE_SECRET = 'e2e-live-secret-0001';

let context: PhaseApp | undefined;

test.beforeEach(async () => {
  context = await launchPhaseApp('tradia-live-gate-e2e');
});

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

const activationPanel = (page: Page) => page.locator('section.live-activation');

async function fillLimits(page: Page, limits: LiveLimits): Promise<void> {
  await page.getByLabel('Capital total en real', { exact: true }).fill(String(limits.capitalUsd));
  await page.getByLabel('Máximo por orden', { exact: true }).fill(String(limits.orderUsd));
  await page.getByLabel('Pérdida diaria máxima', { exact: true }).fill(String(limits.dailyLossUsd));
  await page
    .getByLabel('Posiciones abiertas simultáneas', { exact: true })
    .fill(String(limits.openPositions));
}

test.describe('Responsable de equipo que revisa entregas', () => {
  test('sin la lista completa la activación se rechaza en la interfaz y por IPC directo', async () => {
    test.setTimeout(180_000);
    const { page } = context!;
    await page.evaluate(() => window.tradia.testing!.live.useSimulatedBroker({ enabled: true }));

    // Interfaz: la pantalla muestra cada requisito pendiente y no deja activar.
    await openPage(page, 'Dinero real');
    const checklist = await page.evaluate(() => window.tradia.live.checklist());
    expect(checklist.allComplete).toBe(false);
    const pending = checklist.items.filter((item) => item.state !== 'cumplido');
    expect(pending.length).toBeGreaterThanOrEqual(5);
    await expect(page.getByRole('status').filter({ hasText: 'Dinero real bloqueado' })).toHaveText(
      `Dinero real bloqueado · faltan ${pending.length} de ${checklist.total} requisitos`,
    );
    const panel = activationPanel(page);
    await expect(panel.getByRole('heading', { name: 'No se puede activar todavía' })).toBeVisible();
    for (const item of pending) {
      await expect(panel.getByRole('listitem').filter({ hasText: `${item.title}:` })).toHaveCount(
        1,
      );
      await expect(
        page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: item.title }) }),
      ).toContainText('Pendiente');
    }
    await expect(panel).toContainText('Conecta y verifica las claves live del broker.');
    const activate = panel.getByRole('button', { name: 'Activar dinero real' });
    await expect(activate).toBeDisabled();

    // Un límite por encima del techo fijo se rechaza en el formulario.
    await fillLimits(page, { ...LIMITS, capitalUsd: 5000 });
    await expect(
      page.getByRole('alert').filter({ hasText: 'Tu límite supera el techo' }),
    ).toContainText('1.000,00 USD');
    await expect(page.getByRole('button', { name: 'Guardar límites' })).toBeDisabled();
    await capturePhaseScreenshot(page, 'fase-6-7-dinero-real-bloqueado.png');

    // IPC directo: límites guardados y frase exacta, pero la lista manda.
    await expect(
      page.evaluate(() =>
        window.tradia.live.setLimits({
          capitalUsd: 5000,
          orderUsd: 100,
          dailyLossUsd: 10,
          openPositions: 1, shortOrderUsd: 0, shortExposureUsd: 0, shortPositions: 0
        }),
      ),
    ).rejects.toThrow(/techos fijos/);
    await page.evaluate((limits) => window.tradia.live.setLimits(limits), LIMITS);
    const result = await page.evaluate(
      (phrase) => window.tradia.live.activate({ phrase }),
      liveConfirmationPhrase(LIMITS),
    );
    expect(result.activated).toBe(false);
    expect([...result.pendingRequirements].sort()).toEqual(
      pending.map((item) => item.requirement).sort(),
    );
    expect(result.reasons.length).toBeGreaterThanOrEqual(pending.length);
    expect(result.state.mode).toBe('bloqueado');

    // Tampoco se pueden guardar claves live con la lista incompleta.
    await expect(
      page.evaluate(
        ({ apiKeyId, apiSecret }) => window.tradia.live.connect({ apiKeyId, apiSecret }),
        { apiKeyId: LIVE_KEY, apiSecret: LIVE_SECRET },
      ),
    ).rejects.toThrow(/lista de comprobación del modo real no está completa/);
    const state = await page.evaluate(() => window.tradia.live.state());
    expect(state).toMatchObject({ mode: 'bloqueado', hasCredentials: false, activatedAt: null });

    const journal = await page.evaluate(() => window.tradia.journal.list({ limit: 50 }));
    expect(
      journal.entries.some((entry) =>
        entry.reason.startsWith('Activación de dinero real rechazada'),
      ),
    ).toBe(true);

    // Ajustes: las claves live están bloqueadas y enumeran lo pendiente.
    await openPage(page, 'Ajustes');
    const locked = page.getByRole('region', { name: 'Claves live bloqueadas' });
    await expect(locked).toContainText('Completa la lista antes de conectar las claves live.');
    for (const item of pending)
      await expect(locked).toContainText(LIVE_REQUIREMENT_TITLES[item.requirement]);
    await expect(page.getByLabel('Clave de API live')).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Aviso de dinero real' })).toHaveCount(0);
    await capturePhaseScreenshot(page, 'fase-6-7-ajustes-claves-live-bloqueadas.png', locked);
  });
});

test.describe('Profesional independiente que organiza varios proyectos', () => {
  test('completa la lista, confirma los límites por escrito, activa y pasa la prueba de humo', async () => {
    test.setTimeout(300_000);
    const { page } = context!;
    await watchTickers(page, ['SPY']);
    await page.evaluate(() => window.tradia.testing!.live.useSimulatedBroker({ enabled: true }));
    // Evidencia que solo el tiempo da: meses de paper, prueba final y alertas.
    await page.evaluate(() =>
      window.tradia.testing!.live.seedProgress({
        paperMonths: 4,
        paperTrades: 34,
        deviationPct: -4,
        finalTestDone: true,
        alertsTested: true,
      }),
    );

    await openPage(page, 'Dinero real');
    await page.getByRole('button', { name: 'Reintentar verificación' }).click();
    const row = (title: string) =>
      page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title }) });

    // Parada probada desde la propia lista.
    await row(LIVE_REQUIREMENT_TITLES['parada-probada'])
      .getByRole('button', { name: 'Probar parada' })
      .click();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Parada probada: se activó y se reanudó en paper.' }),
    ).toBeVisible();
    await expect(row(LIVE_REQUIREMENT_TITLES['parada-probada'])).toContainText('Cumplido');

    // Las tres declaraciones por escrito.
    for (const requirement of [
      'claves-sin-retirada',
      'plan-contingencia',
      'revision-legal',
    ] as const) {
      const item = row(LIVE_REQUIREMENT_TITLES[requirement]);
      await item.getByLabel(LIVE_DECLARATION_TEXTS[requirement]).check();
      if (requirement === 'plan-contingencia') {
        await item.getByRole('button', { name: 'Guardar declaración' }).click();
        await expect(item.getByRole('alert')).toHaveText(
          'Documenta el plan o indica su ruta local antes de declararlo.',
        );
        await item.getByRole('button', { name: 'Usar plantilla de contingencia' }).click();
      }
      await expect(item.getByLabel(LIVE_DECLARATION_TEXTS[requirement])).toBeChecked();
      await item.getByRole('button', { name: 'Guardar declaración' }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Declaración guardada con fecha.' }),
      ).toBeVisible();
      await expect(row(LIVE_REQUIREMENT_TITLES[requirement])).toContainText('Cumplido');
      await expect(row(LIVE_REQUIREMENT_TITLES[requirement])).not.toContainText(
        'Sin evidencia guardada.',
      );
    }
    const checklist = await page.evaluate(() => window.tradia.live.checklist());
    expect(checklist.allComplete).toBe(true);

    // Límites por escrito, dentro de los techos.
    await fillLimits(page, LIMITS);
    await page.getByRole('button', { name: 'Guardar límites' }).click();
    await expect(page.getByText(liveConfirmationPhrase(LIMITS), { exact: true })).toBeVisible();
    // Falta la cuenta live: todavía no se puede activar.
    await expect(activationPanel(page)).toContainText(
      'Conecta y verifica las claves live del broker.',
    );
    await expect(
      activationPanel(page).getByRole('button', { name: 'Activar dinero real' }),
    ).toBeDisabled();

    // Claves live (broker simulado) desde Ajustes.
    await openPage(page, 'Ajustes');
    await page.getByLabel('Clave de API live').fill(LIVE_KEY);
    await page.getByLabel('Secreto de API live').fill(LIVE_SECRET);
    await page.getByRole('button', { name: 'Verificar y guardar claves live' }).click();
    await expect(
      page.getByText('Cuenta live verificada. Conectar las claves no activa dinero real.'),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText('Claves live guardadas de forma cifrada')).toBeVisible();

    // Activación con la frase exacta.
    await openPage(page, 'Dinero real');
    // El borrador guardado debe sobrevivir a la navegación a Ajustes.
    await expect(page.getByLabel('Capital total en real', { exact: true })).toHaveValue(
      String(LIMITS.capitalUsd),
    );
    await expect(page.getByLabel('Máximo por orden', { exact: true })).toHaveValue(
      String(LIMITS.orderUsd),
    );
    await expect(page.getByText(liveConfirmationPhrase(LIMITS), { exact: true })).toBeVisible();
    const panel = activationPanel(page);
    await expect(
      panel.getByRole('heading', { name: 'Todos los requisitos están vigentes' }),
    ).toBeVisible();
    await capturePhaseScreenshot(page, 'fase-6-7-dinero-real-lista-completa.png');
    await panel.getByRole('button', { name: 'Activar dinero real' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Confirmar activación de dinero real' });
    await expect(dialog.getByRole('button', { name: 'Cancelar y seguir en paper' })).toBeFocused();
    const confirm = dialog.getByRole('button', { name: 'Activar dinero real con estos límites' });
    const phrase = dialog.getByLabel('Escribe exactamente esta frase para confirmar');
    await phrase.fill(liveConfirmationPhrase(LIMITS).toLowerCase());
    await expect(dialog.getByRole('alert')).toContainText('La frase no coincide');
    await expect(confirm).toBeDisabled();
    await phrase.fill(liveConfirmationPhrase(LIMITS));
    await capturePhaseScreenshot(page, 'fase-6-7-dinero-real-dialogo-activacion.png');
    await confirm.click();
    await expect(dialog).toHaveCount(0);
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Dinero real activado con los límites confirmados.' }),
    ).toBeVisible();
    // La lista también refleja la activación aunque llegue live:changed.
    await expect(page.locator('.live-mode-status')).toHaveText('Dinero real activo');
    await expect(page.getByText(/faltan 0 de 7/)).toHaveCount(0);
    await expect(page.getByText(/Los requisitos cambiaron/)).toHaveCount(0);
    await expect(
      page.getByRole('banner').getByText('Dinero real activo', { exact: true }),
    ).toBeVisible();
    const state = await page.evaluate(() => window.tradia.live.state());
    expect(state).toMatchObject({ mode: 'activo', limits: LIMITS, hasCredentials: true });

    // Franja global visible en cualquier página.
    const banner = page.getByRole('complementary', { name: 'Aviso de dinero real' });
    await expect(banner).toContainText('DINERO REAL');
    await expect(banner).toContainText('Capital 500,00 USD · Orden 100,00 USD');
    await openPage(page, 'IA');
    await expect(banner).toBeVisible();
    await expect(page.getByText('Dinero real activo', { exact: true })).toBeVisible();
    await capturePhaseScreenshot(page, 'fase-6-7-franja-dinero-real.png');

    // Prueba de humo con 1 USD: compra, cierre y conciliación sin descuadres.
    await openPage(page, 'Dinero real');
    const smoke = page.locator('section.live-smoke');
    await smoke.getByRole('button', { name: 'Ejecutar prueba de 1,00 USD' }).click();
    const smokeDialog = page.getByRole('alertdialog', {
      name: 'Confirmar prueba de 1,00 USD reales',
    });
    await expect(smokeDialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await smokeDialog.getByRole('button', { name: 'Confirmar prueba de 1,00 USD' }).click();
    await expect(smoke.getByText('Cerrada y conciliada', { exact: true })).toBeVisible({
      timeout: 60_000,
    });
    await expect(smoke).toContainText('Sin diferencias');
    const steps = smoke.getByRole('list', { name: 'Pasos de la prueba de humo' });
    await expect(steps.getByText('Completado')).toHaveCount(4);
    const smokeResult = (await page.evaluate(() => window.tradia.live.state())).smokeTest!;
    expect(smokeResult).toMatchObject({
      state: 'cerrada-conciliada',
      ticker: 'SPY',
      notionalUsd: 1,
      discrepancies: 0,
      failedStep: null,
    });
    expect(smokeResult.buyExecutedPrice).toEqual(expect.any(Number));
    expect(smokeResult.sellExecutedPrice).toEqual(expect.any(Number));
    expect(smokeResult.slippageBps).toEqual(expect.any(Number));
    expect(smokeResult.steps.every((step) => step.at !== null)).toBe(true);
    await capturePhaseScreenshot(page, 'fase-6-7-prueba-humo-conciliada.png', smoke);
    const facts = smoke.locator('dl.live-result-facts');
    await expect(facts).toContainText('Precio ejecutado compra');
    await expect(facts).toContainText('Slippage');
    await capturePhaseScreenshot(page, 'fase-6-7-prueba-humo-precios.png', facts);

    // Diario: hora, precio pedido (referencia), ejecutado y slippage.
    const journal = await page.evaluate(() => window.tradia.journal.list({ limit: 100 }));
    const buy = journal.entries.find((entry) => entry.reason.startsWith('Prueba de humo · compra'));
    expect(buy?.reason).toMatch(/ejecutada a .* USD \(referencia .* USD, slippage /);
    expect(buy?.dataUsed).toMatchObject({
      precioReferencia: expect.any(Number),
      precioEjecutado: smokeResult.buyExecutedPrice,
      slippageBps: smokeResult.slippageBps,
      ejecutadaEn: expect.any(String),
    });
    expect(
      journal.entries.some(
        (entry) =>
          entry.reason.startsWith('Prueba de humo real completada') &&
          /sin descuadres/.test(entry.reason),
      ),
    ).toBe(true);
    await openPage(page, 'Diario');
    await expect(page.getByText(/Prueba de humo · compra de .* uds de SPY/).first()).toBeVisible();
    await capturePhaseScreenshot(page, 'fase-6-7-diario-prueba-humo.png');

    // Una orden por encima del techo por orden se frena antes del broker.
    // N6: volver a paper desde la pantalla, con cancelación y confirmación accesibles.
    await openPage(page, 'Dinero real');
    const deactivate = page.getByRole('button', {
      name: 'Volver a paper (desactivar dinero real)',
      exact: true,
    });
    await deactivate.click();
    const deactivateDialog = page.getByRole('alertdialog', { name: 'Confirmar vuelta a paper' });
    await expect(deactivateDialog).toContainText(
      'No cierra las posiciones abiertas y no sustituye a la parada de emergencia',
    );
    await capturePhaseScreenshot(page, 'continuacion-volver-paper-dialogo.png', deactivateDialog);
    await page.keyboard.press('Escape');
    await expect(deactivate).toBeFocused();
    await expect(banner).toBeVisible();
    await deactivate.click();
    await deactivateDialog.getByRole('button', { name: 'Confirmar vuelta a paper' }).click();
    await expect(deactivateDialog).toHaveCount(0);
    await expect(banner).toHaveCount(0);
    await expect(page.locator('.live-mode-status')).toContainText('Listo para confirmar');
    const deactivationJournal = await page.evaluate(() =>
      window.tradia.journal.list({ limit: 100 }),
    );
    expect(
      deactivationJournal.entries.some(
        (entry) => entry.reason === 'Modo real desactivado por el usuario; la app vuelve a paper.',
      ),
    ).toBe(true);
    const capped: LiveLimits = { ...LIMITS, orderUsd: 0.5 };
    await page.evaluate(async (limits) => {
      await window.tradia.live.setLimits(limits);
    }, capped);
    const reactivated = await page.evaluate(
      (phrase) => window.tradia.live.activate({ phrase }),
      liveConfirmationPhrase(capped),
    );
    expect(reactivated.activated).toBe(true);
    await openPage(page, 'Dinero real');
    await expect(page.getByRole('list', { name: 'Requisitos de la prueba' })).toContainText(
      'Los límites confirmados deben permitir la prueba de 1,00 USD.',
    );
    await expect(smoke.getByRole('button', { name: 'Ejecutar prueba de 1,00 USD' })).toBeDisabled();
    await expect(
      page.evaluate(() => window.tradia.live.smokeTest({ confirm: true })),
    ).rejects.toThrow(/supera el límite por orden/);
    const after = await page.evaluate(() => window.tradia.live.state());
    // La prueba anterior sigue siendo la última: la orden nunca se envió.
    expect(after.smokeTest?.startedAt).toBe(smokeResult.startedAt);
    const blocked = await page.evaluate(() => window.tradia.journal.list({ limit: 20 }));
    expect(
      blocked.entries.some((entry) =>
        entry.reason.startsWith('Prueba de humo bloqueada antes de llegar al broker'),
      ),
    ).toBe(true);
  });
});
