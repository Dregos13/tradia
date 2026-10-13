import { expect, test, type Page } from '@playwright/test';
import type { DataFreshnessSummary } from '../src/shared/ipc';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
  PINNED_MARKET_NOW,
  relaunchPhaseApp,
  watchTickers,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * Datos desactualizados (docs/qa/datos-desactualizados.md y la sección 4
 * de docs/diseno-tour-guiado.md). El reloj de mercado arranca el martes
 * 2026-10-06 tras el cierre; con el proveedor simulado caído se adelanta
 * un día, así que falta la vela del miércoles 7. La app debe enseñar un
 * único «Datos desactualizados desde el 6 oct 2026», no calcular régimen,
 * predicciones ni señales sobre la vela vieja, y ponerse al día sola al
 * volver el proveedor, al reconectar y al arrancar.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_TITLE = 'Datos desactualizados desde el 6 oct 2026';

let context: PhaseApp | undefined;

test.beforeEach(async () => {
  context = await launchPhaseApp('tradia-stale-e2e');
});

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

const freshness = (page: Page): Promise<DataFreshnessSummary> =>
  page.evaluate(() => window.tradia.dataStatus.freshness());

const lastBar = (page: Page, ticker: string) =>
  page.evaluate(
    async (symbol) => (await window.tradia.market.getBars({ ticker: symbol })).bars.at(-1)?.date,
    ticker,
  );

/** Pone una estrategia semilla en paper sin filtro de régimen sobre SPY. */
async function paperStrategy(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const strategy = (await window.tradia.strategies.list()).find(
      (item) => item.name === 'Reversión RSI/Bollinger',
    );
    if (!strategy) throw new Error('Falta la estrategia semilla Reversión RSI/Bollinger');
    const detail = await window.tradia.strategies.get({ id: strategy.id });
    if (!detail?.executable) throw new Error('La estrategia semilla no es ejecutable');
    await window.tradia.strategies.update({
      id: detail.id,
      note: 'E2E de datos desactualizados: sin filtro de régimen.',
      worksIn: [],
      failsIn: [],
      parameters: detail.parameters,
    });
    await window.tradia.strategies.setStatus({ id: detail.id, status: 'activa' });
    return detail.id;
  });
}

/** Proveedor caído y un cierre más: la vela del 7-oct no llega. */
async function makeStale(page: Page): Promise<void> {
  await page.evaluate(async (day) => {
    await window.tradia.testing!.simulateProviderFailure(true);
    await window.tradia.testing!.advanceMarketClock(day);
  }, DAY_MS);
  await expect
    .poll(async () => {
      const summary = await freshness(page);
      return `${summary.state} ${summary.sinceDate} ${summary.expectedSessionDate}`;
    })
    .toBe('stale 2026-10-06 2026-10-07');
}

test.describe('Profesional independiente que organiza varios proyectos', () => {
  test('un único «Datos desactualizados desde …» en cada pantalla, con régimen, predicciones y señales en pausa', async () => {
    test.setTimeout(240_000);
    const { page } = context!;
    await watchTickers(page, ['SPY', 'AAPL']);
    await expect.poll(async () => (await freshness(page)).state).toBe('current');
    const strategyId = await paperStrategy(page);
    const signalsBefore = await page.evaluate(
      async () => (await window.tradia.signals.list({ limit: 200 })).length,
    );
    const predictionSessions = async () =>
      page.evaluate(async () =>
        [
          ...new Set(
            (await window.tradia.ai.predictions({ limit: 50 })).map((row) => row.sessionDate),
          ),
        ].sort(),
      );
    const latestPredictionBefore = (await predictionSessions()).at(-1);
    expect(latestPredictionBefore).toBe('2026-10-06');

    await makeStale(page);
    const summary = await freshness(page);
    expect(summary.missingSessions).toBe(1);
    expect(summary.items.map((item) => item.key)).toEqual(
      expect.arrayContaining(['ticker:SPY', 'ticker:AAPL']),
    );

    // Una sola franja global y el mismo texto en el chip de cada pantalla.
    for (const [link, heading] of [
      ['Inicio', 'Estado del sistema'],
      ['Mercado', 'Mercado'],
      ['IA', 'IA'],
    ] as const) {
      await openPage(page, link, heading);
      const banner = page.getByRole('region', { name: 'Estado de los datos' });
      await expect(banner).toHaveCount(1);
      await expect(banner.getByRole('status').first()).toContainText(STALE_TITLE);
      // Texto contrastado con el motor: sin vela al día no se evalúan señales, no se crean
      // predicciones y no se recalcula el régimen (lo ya calculado se conserva).
      await expect(banner).toContainText(
        'no se calculan régimen, predicciones ni señales nuevas para esos activos',
      );
      await expect(banner.getByRole('button', { name: 'Actualizar ahora' })).toBeVisible();
      await expect(banner.getByRole('link', { name: 'Probar conexión' })).toHaveAttribute(
        'href',
        '#ajustes?provider=tiingo&focus=test',
      );
      // Ninguna franja por proveedor contradice a la única.
      await expect(page.getByRole('region', { name: 'Datos del mercado' })).toHaveCount(0);
      const inline = page.getByRole('group', { name: 'Frescura de datos' });
      for (const chip of await inline.all()) await expect(chip).toContainText(STALE_TITLE);
    }

    // IA: ni régimen ni probabilidades caducadas presentadas como vigentes.
    await expect(page.getByRole('region', { name: 'Régimen del mercado' })).toContainText(
      'En pausa:',
    );
    await expect(page.getByRole('region', { name: 'Predicción por activo' })).toContainText(
      'No se calculan nuevas probabilidades hasta ponerse al día.',
    );
    await expect(page.getByRole('region', { name: 'Estrategias por régimen' })).toContainText(
      'un régimen caducado no habilita ni desactiva estrategias',
    );
    const overview = await page.evaluate(() => window.tradia.ai.regimeOverview());
    expect(overview).toMatchObject({ stale: true, expectedSessionDate: '2026-10-07' });
    expect(overview.market?.sessionDate).toBe('2026-10-06');
    const globalTitle = page
      .getByRole('region', { name: 'Estado de los datos' })
      .getByRole('status')
      .first()
      .locator('strong');
    await expect(globalTitle).toHaveText(STALE_TITLE);
    const sharedTitle = (await globalTitle.innerText()).trim();
    for (const name of ['Régimen del mercado', 'Predicción por activo']) {
      const panel = page.getByRole('region', { name });
      await expect(panel.getByRole('status')).toHaveText(sharedTitle);
      await expect(panel).toContainText('Calculado con el cierre del 6 oct 2026');
      await expect(panel).not.toContainText(/\b\d{4}-\d{2}-\d{2}\b/);
    }
    await expect(globalTitle).not.toContainText(/\b\d{4}-\d{2}-\d{2}\b/);
    await capturePhaseScreenshot(page, 'continuacion-datos-desactualizados-ia.png');

    // «Por qué ocurre»: una fila por entrada, con su último dato y su motivo.
    const banner = page.getByRole('region', { name: 'Estado de los datos' });
    await banner.getByText('Por qué ocurre').click();
    const details = banner.getByRole('listitem');
    await expect(details.filter({ hasText: /^SPY · último dato 6 oct 2026 · / })).toHaveCount(1);
    await expect(details.filter({ hasText: /^AAPL · último dato 6 oct 2026 · / })).toHaveCount(1);
    await capturePhaseScreenshot(page, 'continuacion-datos-desactualizados-detalles.png', banner);

    // Señales: la vela vieja no se evalúa ni llega a Riesgo.
    const run = await page.evaluate(() => window.tradia.testing!.evaluateSignalsNow());
    expect(run).toMatchObject({ tickers: 0, emitted: 0 });
    const staleState = await page.evaluate(
      async (id) => (await window.tradia.signals.strategies()).find((row) => row.strategyId === id),
      strategyId,
    );
    expect(staleState?.lastBarDate ?? null).not.toBe('2026-10-06');
    expect(
      await page.evaluate(async () => (await window.tradia.signals.list({ limit: 200 })).length),
    ).toBe(signalsBefore);
    expect((await predictionSessions()).at(-1)).toBe('2026-10-06');

    // «Actualizar ahora» con el proveedor aún caído explica el motivo real.
    await banner.getByRole('button', { name: 'Actualizar ahora' }).click();
    await expect(
      banner
        .getByRole('status')
        .filter({ hasText: /^(Actualizados \d+ de \d+ · sin datos: |No se pudo actualizar: )/ })
        .first(),
    ).toBeVisible({ timeout: 15_000 });
    await expect(banner.getByRole('button', { name: 'Actualizar ahora' })).toBeEnabled();
    await capturePhaseScreenshot(page, 'continuacion-datos-desactualizados-reintento.png', banner);

    // Vuelve el proveedor: se pone al día, la franja desaparece y todo se recalcula.
    await page.evaluate(() => window.tradia.testing!.simulateProviderFailure(false));
    await expect(page.getByRole('region', { name: 'Estado de los datos' })).toHaveCount(0, {
      timeout: 30_000,
    });
    await expect(page.getByRole('status').filter({ hasText: /^Datos al día\.$/ })).toHaveCount(1);
    expect(await lastBar(page, 'SPY')).toBe('2026-10-07');
    await expect.poll(async () => (await freshness(page)).state).toBe('current');
    await expect.poll(async () => (await predictionSessions()).at(-1)).toBe('2026-10-07');
    await expect
      .poll(async () => (await page.evaluate(() => window.tradia.ai.regimeOverview())).stale)
      .toBe(false);
    await expect
      .poll(async () =>
        page.evaluate(
          async (id) =>
            (await window.tradia.signals.strategies()).find((row) => row.strategyId === id)
              ?.lastBarDate ?? null,
          strategyId,
        ),
      )
      .toBe('2026-10-07');
    await expect(page.getByRole('region', { name: 'Régimen del mercado' })).not.toContainText(
      'En pausa:',
    );
    await capturePhaseScreenshot(page, 'continuacion-datos-al-dia-ia.png');
  });
});

test.describe('Responsable de equipo que revisa entregas', () => {
  test('se pone al día sola al reconectar y al arrancar días después', async () => {
    test.setTimeout(240_000);
    const { page } = context!;
    await watchTickers(page, ['SPY']);
    expect(await lastBar(page, 'SPY')).toBe('2026-10-06');

    // Sin red pasa un cierre: no se descarga nada; al volver, se pone al día.
    await page.evaluate(async (day) => {
      await window.tradia.testing!.simulateOffline(true);
      await window.tradia.testing!.advanceMarketClock(day);
    }, DAY_MS);
    await expect(page.getByText('Sin conexión', { exact: false }).first()).toBeVisible();
    expect(await lastBar(page, 'SPY')).toBe('2026-10-06');
    await openPage(page, 'IA');
    await expect(page.locator('.ai-page')).not.toContainText('sin una instantánea disponible');
    await expect(page.locator('.ai-page')).not.toContainText('Al día');
    await expect(page.getByRole('region', { name: 'Régimen del mercado' })).toContainText(
      'En pausa:',
    );
    // Sin red, el resumen conserva current sin una fecha de inicio verificada:
    // el cierre local no debe convertirse en «desactualizados desde».
    await expect(
      page
        .locator('.ai-page > .data-freshness-container [role="status"]')
        .filter({ hasText: /^Sin conexión · datos del 6 oct 2026/ }),
    ).toBeVisible();
    for (const name of ['Régimen del mercado', 'Predicción por activo']) {
      const panel = page.getByRole('region', { name });
      await expect(panel.getByRole('status')).toHaveText(
        'Sin conexión · datos del 6 oct 2026. No se pudo comprobar si hay datos más recientes.',
      );
      await expect(panel).toContainText('Calculado con el cierre del 6 oct 2026');
    }
    await expect(page.locator('.ai-page')).not.toContainText('fecha del último dato no disponible');
    expect(await page.locator('.ai-page').innerText()).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    await capturePhaseScreenshot(page, 'continuacion-datos-sin-red.png');
    await page.evaluate(() => window.tradia.testing!.simulateOffline(false));
    await expect.poll(() => lastBar(page, 'SPY'), { timeout: 30_000 }).toBe('2026-10-07');
    await expect.poll(async () => (await freshness(page)).state).toBe('current');
    await expect
      .poll(async () => (await page.evaluate(() => window.tradia.ai.regimeOverview())).stale)
      .toBe(false);

    // El mismo perfil se abre el viernes 9 tras el cierre: se pone al día al arrancar.
    const friday = new Date(Date.parse(PINNED_MARKET_NOW) + 3 * DAY_MS).toISOString();
    await relaunchPhaseApp(context!, { env: { TRADIA_E2E_MARKET_NOW: friday } });
    const next = context!.page;
    await expect(next.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible({
      timeout: 30_000,
    });
    await expect.poll(() => lastBar(next, 'SPY'), { timeout: 60_000 }).toBe('2026-10-09');
    await expect
      .poll(async () => {
        const summary = await freshness(next);
        return `${summary.state} ${summary.expectedSessionDate}`;
      })
      .toBe('current 2026-10-09');
    await expect(next.getByRole('region', { name: 'Estado de los datos' })).toHaveCount(0);
    await expect
      .poll(async () =>
        next.evaluate(async () => {
          const overview = await window.tradia.ai.regimeOverview();
          return `${overview.stale} ${overview.market?.sessionDate}`;
        }),
      )
      .toBe('false 2026-10-09');
    await openPage(next, 'Mercado');
    await expect(next.getByRole('group', { name: 'Frescura de datos' })).toHaveCount(0);
    await capturePhaseScreenshot(next, 'continuacion-datos-puesta-al-dia-arranque.png');
  });
});
