import { expect, test } from '@playwright/test';
import { closePhaseApp, launchPhaseApp, openPage } from './phase-6-7.helpers';

async function seedLong(page: import('@playwright/test').Page, shorts: { t: number; w: number }) {
  await page.evaluate(async (s) => {
    await window.tradia.testing!.live.useSimulatedBroker({ enabled: true });
    await window.tradia.testing!.live.seedProgress({
      paperMonths: 4, paperTrades: 34, deviationPct: -4, finalTestDone: true,
      killSwitchTested: true, alertsTested: true, paperShortTrades: s.t, paperShortWeeks: s.w,
    });
    for (const requirement of ['claves-sin-retirada', 'plan-contingencia', 'revision-legal', 'revision-legal-corto'] as const)
      await window.tradia.live.declare({ requirement, confirmed: true });
    await window.tradia.live.connect({ apiKeyId: 'AKE2ELIVE0001', apiSecret: 'e2e-live-secret-0001' });
  }, shorts);
}

test('Profesional: corto a 0 con requisito retirado y límites generales', async () => {
  test.setTimeout(180_000);
  const ctx = await launchPhaseApp('tradia-retest1-pro');
  try {
    const { page } = ctx;
    await seedLong(page, { t: 6, w: 5 });
    await openPage(page, 'Ajustes');
    const readiness = page.getByRole('region', { name: 'Preparación del corto con dinero real' });
    const ev = await readiness.getByText(/cortos cerrados/).first().textContent();
    console.log('EVIDENCIA_PRO:', ev);
    await page.getByLabel('Capital total en real', { exact: true }).fill('500');
    await page.getByLabel('Máximo por orden', { exact: true }).fill('100');
    await page.getByLabel('Pérdida diaria máxima', { exact: true }).fill('10');
    await page.getByLabel('Posiciones abiertas simultáneas', { exact: true }).fill('1');
    await page.getByLabel('Máximo por orden en corto', { exact: true }).fill('100');
    await page.getByLabel('Exposición corta total máxima').fill('200');
    await page.getByLabel('Posiciones cortas simultáneas').fill('1');
    await page.getByRole('button', { name: 'Guardar límites', exact: true }).click();
    await expect(page.getByText(/Límites del corto guardados/)).toBeVisible();
    await readiness.getByRole('checkbox', { name: /CNMV\/MiFID II.*IRPF/ }).uncheck();
    await readiness.getByRole('button', { name: 'Guardar retirada de declaración' }).click();
    const order = page.getByLabel('Máximo por orden en corto', { exact: true });
    await expect(order).toHaveAttribute('readonly', '');
    await page.screenshot({ path: '/tmp/retest1-pro-bloqueado.png', fullPage: true });
    const reset = page.getByRole('button', { name: 'Poner el corto a 0', exact: true });
    await reset.click();
    console.log('FOCO_TRAS_RESET:', await page.evaluate(() => document.activeElement?.tagName + ' ' + (document.activeElement?.textContent ?? '').slice(0, 40)));
    await page.getByLabel('Capital total en real', { exact: true }).fill('450');
    await page.getByRole('button', { name: 'Guardar límites', exact: true }).click();
    await expect(page.getByText('Límites guardados · todavía debes confirmarlos por escrito.').first()).toBeVisible();
    console.log('BACKEND_LIMITS:', JSON.stringify((await page.evaluate(() => window.tradia.live.checklist())).limits.limits));
    await page.screenshot({ path: '/tmp/retest1-pro-corto-cero.png', fullPage: true });
    // Página Dinero real: un único estado de modo
    await page.evaluate(() => { window.location.hash = 'dinero-real'; });
    await page.waitForTimeout(1000);
    console.log('MODE_STATUS_COUNT:', await page.locator('.live-mode-status').count(), 'SHORT_STATUS_COUNT:', await page.locator('.live-short-status').count());
  } finally { await closePhaseApp(ctx); }
});

test('Responsable: evidencia paper-cortos y rechazo [corto-requisitos] limpio', async () => {
  test.setTimeout(180_000);
  const ctx = await launchPhaseApp('tradia-retest1-resp');
  try {
    const { page } = ctx;
    await seedLong(page, { t: 2, w: 1 });
    await openPage(page, 'Ajustes');
    const readiness = page.getByRole('region', { name: 'Preparación del corto con dinero real' });
    console.log('EVIDENCIA_PARCIAL:', await readiness.getByText(/cortos cerrados/).first().textContent());
    await page.evaluate(() => window.tradia.testing!.live.seedProgress({ paperShortTrades: 5, paperShortWeeks: 4 }));
    await readiness.getByRole('button', { name: 'Reintentar comprobación' }).click();
    await expect(readiness.getByText(/4 de 4 semanas/)).toBeVisible();
    console.log('EVIDENCIA_CUMPLIDA:', await readiness.getByText(/cortos cerrados/).first().textContent());
    await page.screenshot({ path: '/tmp/retest1-resp-evidencia.png', fullPage: true });
    const order = page.getByLabel('Máximo por orden en corto', { exact: true });
    await expect(order).not.toHaveAttribute('readonly');
    await page.getByLabel('Capital total en real', { exact: true }).fill('500');
    await page.getByLabel('Máximo por orden', { exact: true }).fill('100');
    await page.getByLabel('Pérdida diaria máxima', { exact: true }).fill('10');
    await page.getByLabel('Posiciones abiertas simultáneas', { exact: true }).fill('1');
    await order.fill('100');
    await page.getByLabel('Exposición corta total máxima').fill('200');
    await page.getByLabel('Posiciones cortas simultáneas').fill('1');
    // El requisito cae en el proceso principal sin que la interfaz se entere (caché)
    await page.evaluate(() => window.tradia.live.declare({ requirement: 'revision-legal-corto', confirmed: false }));
    await page.getByRole('button', { name: 'Guardar límites', exact: true }).click();
    await page.waitForTimeout(1500);
    const alerts = await page.getByRole('alert').allTextContents();
    console.log('ALERTAS:', JSON.stringify(alerts));
    console.log('CAPITAL_DISABLED:', await page.getByLabel('Capital total en real', { exact: true }).isDisabled());
    console.log('RESET_VISIBLE:', await page.getByRole('button', { name: 'Poner el corto a 0' }).isVisible());
    await page.screenshot({ path: '/tmp/retest1-resp-rechazo.png', fullPage: true });
  } finally { await closePhaseApp(ctx); }
});
