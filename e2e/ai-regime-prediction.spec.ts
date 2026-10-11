import { expect, test } from '@playwright/test';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
  watchTickers,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * Fase 6 · régimen de mercado y predicción probabilística en la app real.
 * El régimen se fija con el gancho determinista `ai:simulate-regime`
 * sobre la última sesión guardada; el modelo es el ONNX empaquetado en
 * resources/models con su ficha.
 */

let context: PhaseApp | undefined;

test.beforeEach(async () => {
  context = await launchPhaseApp('tradia-ai-regime-e2e');
});

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

async function pinRegimes(page: PhaseApp['page']) {
  await watchTickers(page, ['SPY', 'AAPL']);
  const sessions = await page.evaluate(async () => {
    const last = async (ticker: string) => {
      const bars = (await window.tradia.market.getBars({ ticker })).bars;
      return bars[bars.length - 1]!.date;
    };
    return { SPY: await last('SPY'), AAPL: await last('AAPL') };
  });
  // Mercado (SPY) en tendencia con volatilidad alta; AAPL lateral y tranquilo.
  await page.evaluate(
    (sessionDate) =>
      window.tradia.testing!.ai.simulateRegime({
        scope: 'mercado',
        ticker: 'SPY',
        direction: 'tendencia',
        volatility: 'volatilidad-alta',
        sessionDate,
      }),
    sessions.SPY,
  );
  await page.evaluate(
    (sessionDate) =>
      window.tradia.testing!.ai.simulateRegime({
        scope: 'activo',
        ticker: 'AAPL',
        direction: 'lateral',
        volatility: 'volatilidad-baja',
        sessionDate,
      }),
    sessions.AAPL,
  );
  return sessions;
}

test.describe('Profesional independiente que organiza varios proyectos', () => {
  test('fija el régimen, ve qué estrategias quedan desactivadas y lee la ficha calibrada del modelo', async () => {
    test.setTimeout(240_000);
    const { page } = context!;
    const sessions = await pinRegimes(page);

    // Contrato por IPC: el régimen fijado manda sobre la habilitación.
    const overview = await page.evaluate(() => window.tradia.ai.regimeOverview());
    expect(overview.market).toMatchObject({
      ticker: 'SPY',
      direction: 'tendencia',
      volatility: 'volatilidad-alta',
      sessionDate: sessions.SPY,
    });
    expect(overview.assets.find((asset) => asset.ticker === 'AAPL')).toMatchObject({
      direction: 'lateral',
      volatility: 'volatilidad-baja',
    });
    const disabled = overview.strategies.find(
      (strategy) =>
        strategy.failsIn.includes('tendencia') || strategy.failsIn.includes('volatilidad-alta'),
    );
    expect(disabled, 'se esperaba una estrategia semilla que falla en tendencia').toBeDefined();
    expect(disabled!.regimeState).toBe('desactivada');
    const enabled = overview.strategies.find(
      (strategy) => strategy.regimeState === 'habilitada' && strategy.worksIn.includes('tendencia'),
    );
    expect(enabled, 'se esperaba una estrategia de tendencia habilitada').toBeDefined();

    const card = await page.evaluate(() => window.tradia.ai.modelCard());
    expect(card, 'la app debe cargar la ficha del modelo empaquetado').not.toBeNull();
    expect(card!.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(card!.horizonDays).toBeGreaterThan(0);
    expect(card!.trainingPeriod.hasta < card!.testPeriod.desde).toBe(true);
    expect(card!.metrics.brierOos).toEqual(expect.any(Number));
    expect(card!.metrics.brierBaseline).toEqual(expect.any(Number));
    expect(card!.calibration.length).toBeGreaterThan(0);
    await expect
      .poll(() => page.evaluate(() => window.tradia.ai.predictions({ limit: 20 })), {
        timeout: 90_000,
      })
      .toEqual(expect.arrayContaining([expect.objectContaining({ ticker: 'SPY' })]));

    // Interfaz: página «IA».
    await openPage(page, 'IA');
    const regime = page.getByRole('region', { name: 'Régimen por activo' });
    await expect(regime.getByRole('row').filter({ hasText: 'AAPL' })).toContainText('Lateral');
    await expect(regime.getByRole('row').filter({ hasText: 'AAPL' })).toContainText(
      'Volatilidad baja',
    );
    await expect(regime.getByRole('row').filter({ hasText: 'SPY' })).toContainText('Tendencia');
    const regimeSection = page.locator('section', {
      has: page.getByRole('heading', { name: 'Régimen del mercado' }),
    });
    await expect(regimeSection).toContainText('Referencia SPY');
    await capturePhaseScreenshot(page, 'fase-6-7-ia-regimen.png');

    const strategies = page.getByRole('region', { name: 'Estrategias según el régimen' });
    const disabledRow = strategies.getByRole('row').filter({ hasText: disabled!.name });
    await expect(disabledRow).toContainText('Desactivada por régimen');
    const enabledRow = strategies.getByRole('row').filter({ hasText: enabled!.name });
    await expect(enabledRow).toContainText('Activa por régimen');
    await capturePhaseScreenshot(
      page,
      'fase-6-7-ia-estrategias-por-regimen.png',
      page.getByRole('heading', { name: 'Estrategias según el régimen' }),
    );

    const predictions = page.getByRole('region', { name: 'Predicciones por activo' });
    await expect(predictions.getByRole('row').filter({ hasText: 'SPY' }).first()).toContainText(
      `Próximas ${card!.horizonDays} sesiones`,
    );
    await expect(
      predictions.getByRole('img', { name: /Probabilidad estimada: subida .* bajada/ }).first(),
    ).toBeVisible();

    const modelCard = page.locator('#ai-model-card');
    await expect(
      modelCard.getByRole('heading', { name: 'Ficha del modelo · dirección y volatilidad' }),
    ).toBeVisible();
    await expect(modelCard.getByText(`v${card!.version}`, { exact: true })).toBeVisible();
    await expect(
      modelCard.getByText(`${card!.horizonDays} sesiones`, { exact: true }),
    ).toBeVisible();
    await expect(modelCard.getByText('Entrenamiento', { exact: true })).toBeVisible();
    await expect(modelCard.getByText('Prueba final intacta', { exact: true })).toBeVisible();
    await expect(modelCard.getByText('Brier del modelo', { exact: true })).toBeVisible();
    await expect(modelCard.getByText('Brier de referencia', { exact: true })).toBeVisible();
    await expect(
      modelCard.getByRole('img', { name: /Calibración fuera de muestra/ }),
    ).toBeVisible();
    // La tabla accesible del diagrama se abre con teclado.
    const chartData = modelCard.getByRole('button', { name: 'Ver datos del gráfico' });
    await chartData.focus();
    await page.keyboard.press('Enter');
    await expect(chartData).toHaveAttribute('aria-expanded', 'true');
    await expect(modelCard.getByRole('region', { name: 'Datos de calibración' })).toBeVisible();
    await capturePhaseScreenshot(page, 'fase-6-7-ia-ficha-modelo.png', modelCard);
  });

  test('la ficha de una estrategia semilla muestra su régimen y compara el backtest con y sin filtro', async () => {
    test.setTimeout(300_000);
    const { page } = context!;
    await pinRegimes(page);
    const overview = await page.evaluate(() => window.tradia.ai.regimeOverview());
    const disabled = overview.strategies.find((strategy) => strategy.regimeState === 'desactivada');
    expect(disabled).toBeDefined();

    await openPage(page, 'IA');
    await page.getByRole('button', { name: `Ver ficha de ${disabled!.name}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Régimen de mercado' })).toBeVisible({
      timeout: 15_000,
    });
    const regimeFacts = page.locator('section', {
      has: page.getByRole('heading', { name: 'Régimen de mercado' }),
    });
    await expect(regimeFacts.getByText('Funciona en', { exact: true })).toBeVisible();
    await expect(regimeFacts.getByText('Falla en', { exact: true })).toBeVisible();
    await expect(regimeFacts).toContainText('Tendencia');

    const comparison = page.locator('section', {
      has: page.getByRole('heading', { name: 'Efecto del filtro de régimen' }),
    });
    await comparison.getByRole('button', { name: 'Ejecutar comparación' }).click();
    const table = comparison.getByRole('region', {
      name: 'Resultados con y sin filtro de régimen',
    });
    await expect(table).toBeVisible({ timeout: 180_000 });
    await expect(table).toContainText('Sin filtro');
    await expect(table).toContainText('Con filtro');
    await expect(comparison).toContainText('Mismos datos, periodo y costes');
    const saved = await page.evaluate(
      (strategyId) => window.tradia.backtest.regimeComparison({ strategyId }),
      disabled!.strategyId,
    );
    expect(saved?.comparable).toBe(true);
    expect(saved?.withFilter.runId).not.toBe(saved?.withoutFilter.runId);
    await capturePhaseScreenshot(page, 'fase-6-7-ficha-estrategia-regimen.png', regimeFacts);
  });
});

test.describe('Responsable de equipo que revisa entregas', () => {
  test('«Predicción por activo» destaca la vigente de cada activo y «Ver ficha del modelo» lleva a la ficha', async () => {
    test.setTimeout(240_000);
    const { page } = context!;
    await watchTickers(page, ['SPY', 'AAPL']);
    // Un cierre más: cada activo tiene una predicción vigente y otras anteriores.
    await page.evaluate(() => window.tradia.testing!.advanceMarketClock(24 * 60 * 60 * 1000));
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const rows = await window.tradia.ai.predictions({ limit: 50 });
            return ['SPY', 'AAPL'].every((ticker) =>
              rows.some((row) => row.ticker === ticker && row.sessionDate === '2026-10-07'),
            );
          }),
        { timeout: 60_000 },
      )
      .toBe(true);
    const card = await page.evaluate(() => window.tradia.ai.modelCard());
    expect(card).not.toBeNull();

    await openPage(page, 'IA');
    const current = page.getByRole('region', { name: 'Predicciones por activo' });
    const body = current.getByRole('row').filter({ has: page.getByRole('rowheader') });
    // Una sola fila por activo, la de su último cierre.
    await expect(body).toHaveCount(2);
    for (const ticker of ['SPY', 'AAPL']) {
      const row = body.filter({ hasText: ticker });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText('Último cierre disponible · Cierre 7 oct 2026');
      await expect(row).not.toContainText('Desactualizada');
    }
    // El histórico queda aparte y plegado.
    const history = page.getByText(/^Histórico de predicciones \(\d+\)$/);
    await expect(history).toBeVisible();
    await expect(page.getByRole('region', { name: 'Histórico de predicciones' })).toBeHidden();
    await history.click();
    const past = page.getByRole('region', { name: 'Histórico de predicciones' });
    await expect(past).toBeVisible();
    await expect(
      past.getByRole('row').filter({ hasText: 'Cierre 6 oct 2026' }).first(),
    ).toBeVisible();
    await expect(past).not.toContainText('Cierre 7 oct 2026');
    await capturePhaseScreenshot(
      page,
      'continuacion-ia-prediccion-vigente.png',
      page.getByRole('heading', { name: 'Predicción por activo' }),
    );

    // Filtro por activo sobre la tabla vigente.
    const filter = page
      .getByRole('region', { name: 'Predicción por activo', exact: true })
      .getByRole('combobox', { name: /^Activo/ });
    await filter.selectOption('AAPL');
    await expect(body).toHaveCount(1);
    await expect(body).toContainText('AAPL');
    await filter.selectOption({ label: 'Todos los activos' });
    await expect(body).toHaveCount(2);

    // «Ver ficha del modelo» se queda en IA y pone el foco en la ficha.
    const link = body
      .filter({ hasText: 'SPY' })
      .getByRole('button', { name: 'Ver ficha del modelo' });
    await link.focus();
    await page.keyboard.press('Enter');
    const modelCard = page.getByRole('region', { name: /^Ficha del modelo/ });
    await expect(modelCard).toBeFocused();
    await expect(modelCard).toBeInViewport();
    expect(await page.evaluate(() => location.hash)).toBe('#ia');
    await expect(page.getByRole('heading', { name: 'IA', exact: true, level: 1 })).toBeVisible();
    await expect(modelCard.getByText(`v${card!.version}`, { exact: true })).toBeVisible();
    await capturePhaseScreenshot(page, 'continuacion-ia-ver-ficha-modelo.png');
  });
});
