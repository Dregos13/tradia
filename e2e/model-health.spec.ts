import { expect, test } from '@playwright/test';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
  recordedNotifications,
  recordNotifications,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * Fase 6 · detección de degradación y reentrenamiento controlado. El
 * drift se inyecta con el gancho determinista `ai:simulate-drift`: una
 * racha corta solo deja el sujeto en observación; la sostenida lo
 * degrada, avisa y propone un reentrenamiento trimestral (que la app
 * nunca ejecuta sola).
 */

let context: PhaseApp | undefined;

test.beforeEach(async () => {
  context = await launchPhaseApp('tradia-model-health-e2e');
  await recordNotifications(context.app);
});

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

test.describe('Profesional independiente que organiza varios proyectos', () => {
  test('el drift de datos sostenido degrada el modelo, avisa y propone un reentrenamiento', async () => {
    test.setTimeout(180_000);
    const { app, page } = context!;

    // Racha aislada: 5 de 20 sesiones → en observación, sin propuesta ni aviso.
    const short = await page.evaluate(() =>
      window.tradia.testing!.ai.simulateDrift({ kind: 'datos', streak: 5 }),
    );
    const shortModel = short.subjects.find((row) => row.subject === 'modelo')!;
    expect(shortModel.state).toBe('observacion');
    expect(shortModel.reason).toContain('5 de 20 sesiones');
    expect(short.proposals).toHaveLength(0);
    expect(
      (await recordedNotifications(app)).filter((n) => n.title.includes('degradado')),
    ).toHaveLength(0);

    // Drift sostenido durante 20 sesiones → degradada.
    const sustained = await page.evaluate(() =>
      window.tradia.testing!.ai.simulateDrift({ kind: 'datos' }),
    );
    const model = sustained.subjects.find((row) => row.subject === 'modelo')!;
    expect(model.state).toBe('degradada');
    expect(model.dataDrift?.driftedFeatures).toBeGreaterThanOrEqual(2);
    expect(sustained.proposals).toEqual([
      expect.objectContaining({ status: 'pendiente', modelCardId: model.subjectId }),
    ]);
    await expect
      .poll(async () => (await recordedNotifications(app)).map((n) => n.title), {
        timeout: 15_000,
      })
      .toContain('Modelo degradado por drift sostenido');
    const card = await page.evaluate(() => window.tradia.ai.modelCard());
    expect(card?.eligible).toBe(false);
    const journal = await page.evaluate(() => window.tradia.journal.list({ limit: 50 }));
    expect(journal.entries.some((entry) => /queda degradado/.test(entry.reason))).toBe(true);

    // Inicio avisa de la degradación.
    await openPage(page, 'Inicio', 'Estado del sistema');
    const notice = page.getByRole('region', { name: 'Avisos de IA y dinero real' });
    await expect(notice.getByRole('heading', { name: 'Degradación detectada' })).toBeVisible();
    await expect(notice).toContainText(model.name);

    // Salud de modelos: fila degradada, detalle y propuesta.
    await openPage(page, 'Salud de modelos');
    const table = page.getByRole('region', { name: 'Salud de modelos y estrategias' });
    const row = table.getByRole('row').filter({ hasText: model.name }).first();
    await expect(row).toContainText('Degradada');
    await row.getByRole('button', { name: `Ver detalle de ${model.name}` }).click();
    await expect(table).toContainText('Drift sostenido. No se debe a una sola racha perdedora.');
    await expect(table).toContainText('Sobre el umbral');
    const proposal = page.getByRole('article', { name: /^Propuesta \d{4}-Q[1-4]$/ });
    await expect(proposal).toHaveCount(1);
    await expect(proposal).toContainText('pendiente');
    await expect(proposal).toContainText('La nueva versión no se activa sola.');
    await capturePhaseScreenshot(
      page,
      'fase-6-7-salud-modelo-degradado.png',
      page.getByRole('heading', { name: 'Revisión de modelos y estrategias' }),
    );

    await proposal.getByRole('button', { name: 'Aprobar y abrir instrucciones' }).click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('heading', { name: 'Confirmar aprobación del reentrenamiento' }),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Confirmar aprobación' }).click();
    const instructions = page.getByRole('heading', {
      name: 'Pasos del reentrenamiento fuera de la app',
    });
    await expect(instructions).toBeVisible();
    await expect(page.locator('.health-instructions')).toContainText('ml');
    const after = await page.evaluate(() => window.tradia.ai.retrainProposals());
    expect(after[0]?.status).toBe('aprobada');
    // Aprobar no reentrena: el modelo sigue siendo la misma versión, no apto.
    expect((await page.evaluate(() => window.tradia.ai.modelCard()))?.version).toBe(card?.version);
    await capturePhaseScreenshot(page, 'fase-6-7-salud-instrucciones-reentreno.png', instructions);
  });
});

test.describe('Responsable de equipo que revisa entregas', () => {
  test('una estrategia solo se degrada tras dos revisiones mensuales seguidas y sale de la IA', async () => {
    test.setTimeout(180_000);
    const { app, page } = context!;
    const strategy = await page.evaluate(async () => {
      const found = (await window.tradia.strategies.list()).find(
        (item) => item.name === 'Reversión RSI/Bollinger',
      );
      if (!found) throw new Error('Falta la estrategia semilla Reversión RSI/Bollinger');
      return found;
    });

    // Una revisión mensual mala: observación, nunca degradación.
    const first = await page.evaluate(
      (subjectId) =>
        window.tradia.testing!.ai.simulateDrift({ kind: 'rendimiento', subjectId, streak: 1 }),
      strategy.id,
    );
    const firstRow = first.subjects.find(
      (row) => row.subject === 'estrategia' && row.subjectId === strategy.id,
    )!;
    expect(firstRow.state).toBe('observacion');
    expect(first.proposals).toHaveLength(0);
    expect(
      (await page.evaluate((id) => window.tradia.strategies.get({ id }), strategy.id))?.status,
    ).not.toBe('degradada');

    // Segunda revisión consecutiva: degradada, aviso y propuesta.
    const second = await page.evaluate(
      (subjectId) =>
        window.tradia.testing!.ai.simulateDrift({ kind: 'rendimiento', subjectId, streak: 2 }),
      strategy.id,
    );
    const row = second.subjects.find(
      (candidate) => candidate.subject === 'estrategia' && candidate.subjectId === strategy.id,
    )!;
    expect(row.state).toBe('degradada');
    expect(second.proposals).toEqual([
      expect.objectContaining({ status: 'pendiente', strategyId: strategy.id }),
    ]);
    expect(
      (await page.evaluate((id) => window.tradia.strategies.get({ id }), strategy.id))?.status,
    ).toBe('degradada');
    await expect
      .poll(async () => (await recordedNotifications(app)).map((n) => n.title), {
        timeout: 15_000,
      })
      .toContain(`Estrategia degradada · ${strategy.name}`);

    // La página «IA» la muestra degradada (no vota).
    await openPage(page, 'IA');
    await expect(
      page
        .getByRole('region', { name: 'Estrategias según el régimen' })
        .getByRole('row')
        .filter({ hasText: strategy.name }),
    ).toContainText('Degradada');

    // Posponer exige fecha futura y motivo; Escape cierra sin decidir.
    await openPage(page, 'Salud de modelos');
    const health = page.getByRole('region', { name: 'Salud de modelos y estrategias' });
    await expect(health.getByRole('row').filter({ hasText: strategy.name })).toContainText(
      'Degradada',
    );
    const proposal = page.getByRole('article', { name: /^Propuesta / });
    await proposal.getByRole('button', { name: 'Posponer' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Confirmar aplazamiento' }).click();
    await expect(dialog.getByRole('alert')).toHaveText(
      'Indica una fecha futura y el motivo para posponer.',
    );
    await capturePhaseScreenshot(page, 'fase-6-7-salud-posponer-validacion.png');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await page.evaluate(() => window.tradia.ai.retrainProposals()))[0]?.status).toBe(
      'pendiente',
    );
    await capturePhaseScreenshot(
      page,
      'fase-6-7-salud-estrategia-degradada.png',
      page.getByRole('heading', { name: 'Revisión de modelos y estrategias' }),
    );
  });
});
