import { expect, test, type Locator, type Page } from '@playwright/test';
import type { DataFreshnessSummary } from '../src/shared/ipc';
import {
  closePhaseApp,
  launchPhaseApp,
  openPage,
  relaunchPhaseApp,
  watchTickers,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * Un activo sin cobertura en Tiingo (el caso real de «EUR») no debe
 * bloquear la app. Todo con el proveedor simulado de TRADIA_E2E, que
 * nace con EUR sin cobertura (TRADIA_E2E_UNCOVERED_TICKERS):
 *  1. añadir EUR → rechazo con la alternativa FXE → añadir FXE;
 *  2. un EUR heredado en la lista → el aviso nombra solo EUR, SPY sigue al
 *     día, el régimen, las predicciones y las señales no se pausan →
 *     «Quitar de la lista» → el aviso desaparece;
 *  3. «Actualizar ahora» con fallo parcial nunca dice «Datos actualizados.»;
 *  4. Ajustes › Conectores explica el estado de Tiingo y el siguiente paso
 *     con la clave rechazada y con EUR sin cobertura.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

let context: PhaseApp | undefined;

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

const freshness = (page: Page): Promise<DataFreshnessSummary> =>
  page.evaluate(() => window.tradia.dataStatus.freshness());

const watchlistTickers = (page: Page): Promise<string[]> =>
  page.evaluate(async () => (await window.tradia.watchlist.list()).map((row) => row.ticker).sort());

/**
 * Un usuario que ya tenía EUR de una versión anterior: se siembra con el
 * proveedor sin lista de «sin cobertura» y se reabre con la lista por
 * defecto (EUR sin cobertura). Un día más de reloj obliga a pedir la vela
 * nueva de EUR, que Tiingo no tiene; SPY sí la recibe.
 */
async function openWithLegacyEur(prefix: string): Promise<PhaseApp> {
  const app = await launchPhaseApp(prefix, { env: { TRADIA_E2E_UNCOVERED_TICKERS: '' } });
  context = app;
  await watchTickers(app.page, ['SPY', 'EUR']);
  await relaunchPhaseApp(app);
  await expect(app.page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible({
    timeout: 30_000,
  });
  await app.page.evaluate((delta) => window.tradia.testing!.advanceMarketClock(delta), DAY_MS);
  await expect
    .poll(async () => (await freshness(app.page)).uncovered.map((asset) => asset.ticker), {
      timeout: 30_000,
    })
    .toEqual(['EUR']);
  return app;
}

const dataBanner = (page: Page): Locator =>
  page.getByRole('region', { name: 'Estado de los datos' });

test.describe('Profesional independiente que organiza varios proyectos', () => {
  test('añadir EUR se rechaza con la alternativa FXE, la lista no cambia y FXE se añade con sus velas', async () => {
    test.setTimeout(180_000);
    context = await launchPhaseApp('tradia-ticker-sin-cobertura');
    const { page } = context;
    await watchTickers(page, ['SPY']);
    await openPage(page, 'Mercado');

    const input = page.getByLabel('Ticker', { exact: true });
    // En minúsculas y con espacios: se normaliza igual que «EUR».
    await input.fill('  eur ');
    await input.press('Enter');
    const alert = page.getByRole('alert').filter({ hasText: 'Tiingo no ofrece datos para EUR' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Puedes añadir EUR/USD');
    await expect(alert).toContainText('cambiar por FXE');
    await expect(alert).toContainText('EUR no está disponible en Tiingo');
    await expect(alert).not.toContainText(/ETF|24\/5|exposición parecida/);
    await expect(alert.getByRole('link', { name: 'Abrir Ajustes › Conectores' })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^(Añadir EUR\/USD|Cambiar por FXE)/ }),
    ).toHaveText(['Añadir EUR/USD (divisa)', 'Cambiar por FXE']);
    expect(await watchlistTickers(page)).toEqual(['SPY']);
    // El rechazo no es una caída: ni aviso de datos ni activos pausados.
    const afterReject = await freshness(page);
    expect(afterReject.state).toBe('current');
    expect(afterReject.uncovered).toEqual([]);
    await expect(dataBanner(page)).toHaveCount(0);

    // Teclado: el siguiente control tras el campo es la alternativa, y Enter la acepta.
    const swap = page.getByRole('button', { name: 'Cambiar por FXE', exact: true });
    await swap.focus();
    await expect(swap).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => watchlistTickers(page), { timeout: 30_000 }).toEqual(['FXE', 'SPY']);
    await expect(page.getByText('FXE se ha añadido a tu lista')).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: 'Tiingo no ofrece datos' })).toHaveCount(
      0,
    );
    await expect
      .poll(
        () =>
          page.evaluate(
            async () => (await window.tradia.market.getBars({ ticker: 'FXE' })).bars.length,
          ),
        { timeout: 60_000 },
      )
      .toBeGreaterThan(250);
    await expect(page.getByRole('button', { name: /^FXE/ }).first()).toBeVisible();
    const final = await freshness(page);
    expect(final.state).toBe('current');
    expect(final.uncovered).toEqual([]);
    await page.screenshot({ path: 'test-results/ticker-sin-cobertura-1-fxe.png' });
  });

  test('un activo de la lista sin cobertura: el aviso nombra solo ese, el resto sigue y «Quitar de la lista» lo retira', async () => {
    test.setTimeout(240_000);
    const { page } = await openWithLegacyEur('tradia-ticker-legado');
    // Inicio: un solo aviso de EUR y «Precios» sigue «Disponible» (SPY está al día).
    await openPage(page, 'Inicio', 'Estado del sistema');
    await expect(
      page.getByRole('heading', { name: 'EUR no está disponible en Tiingo' }),
    ).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Quitar EUR de la lista' })).toHaveCount(1);
    await expect(page.locator('.dashboard-row').filter({ hasText: /^Precios/ })).toContainText(
      'Disponible',
    );
    await openPage(page, 'Mercado');

    const banner = dataBanner(page);
    await expect(
      banner.getByRole('heading', { name: 'EUR no está disponible en Tiingo' }),
    ).toBeVisible();
    await expect(banner).toContainText(
      'Solo EUR queda en pausa. Los demás activos, predicciones y señales siguen al día.',
    );
    await expect(banner).not.toContainText('SPY');
    // Un solo aviso por activo: ni un segundo encabezado ni acciones repetidas en el orden de Tab.
    await expect(
      page.getByRole('heading', { name: 'EUR no está disponible en Tiingo' }),
    ).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Quitar EUR de la lista' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Cambiar por FXE para EUR' })).toHaveCount(1);
    await expect(page.getByRole('group', { name: 'Frescura de datos' })).toHaveCount(0);
    await expect(banner).not.toContainText('Datos actualizados.');
    await expect(banner).not.toContainText('Régimen, predicciones y señales en pausa');
    await expect(banner.getByRole('button', { name: 'Cambiar por FXE para EUR' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'Quitar EUR de la lista' })).toBeVisible();

    // Los datos: SPY al día, un único activo aislado, nada global en pausa.
    const summary = await freshness(page);
    expect(summary.state).toBe('current');
    expect(summary.items).toEqual([]);
    expect(summary.uncovered.map((asset) => asset.ticker)).toEqual(['EUR']);
    expect(summary.uncovered[0]!.suggestion).toBe('FXE');
    const statuses = await page.evaluate(() => window.tradia.dataStatus.get());
    expect(statuses.find((entry) => entry.key === 'ticker:SPY')?.state).toBe('fiable');
    expect(statuses.find((entry) => entry.key === 'ticker:EUR')?.state).toBe('sin-cobertura');
    expect(
      statuses.filter(
        (entry) => /^(ticker|provider|macro):/.test(entry.key) && entry.state === 'desactualizado',
      ),
    ).toEqual([]);

    // Régimen, predicciones y señales no se pausan por EUR.
    await openPage(page, 'IA');
    await expect(page.getByRole('region', { name: 'Régimen del mercado' })).not.toContainText(
      'En pausa:',
    );
    await expect(page.getByRole('region', { name: 'Predicción por activo' })).not.toContainText(
      'No se calculan nuevas probabilidades hasta ponerse al día.',
    );
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const rows = await window.tradia.ai.predictions({ limit: 50 });
            return rows
              .map((row) => row.sessionDate)
              .sort()
              .at(-1);
          }),
        { timeout: 30_000 },
      )
      .toBe(summary.expectedSessionDate);
    const signalRun = await page.evaluate(() => window.tradia.testing!.evaluateSignalsNow());
    expect(JSON.stringify(signalRun)).not.toMatch(/paus|stale|desactualizad/i);

    // Quitar con teclado: Tab desde «Cambiar por FXE» llega a «Quitar de la lista».
    await openPage(page, 'Mercado');
    await banner.getByRole('button', { name: 'Cambiar por FXE para EUR' }).focus();
    await page.keyboard.press('Tab');
    const remove = banner.getByRole('button', { name: 'Quitar EUR de la lista' });
    await expect(remove).toBeFocused();
    await page.screenshot({ path: 'test-results/ticker-sin-cobertura-2-aviso.png' });
    await page.keyboard.press('Enter');
    await expect.poll(() => watchlistTickers(page), { timeout: 30_000 }).toEqual(['SPY']);
    await expect(banner).toHaveCount(0);
    await expect(page.getByText('EUR se ha quitado de tu lista.')).toBeVisible();
    const after = await freshness(page);
    expect(after.state).toBe('current');
    expect(after.uncovered).toEqual([]);
    // El aviso no vuelve con otra pasada del proveedor.
    await page.evaluate(() => window.tradia.market.refreshNow());
    await expect(banner).toHaveCount(0);
  });
});

test.describe('Responsable de equipo que revisa entregas', () => {
  test('«Actualizar ahora» con fallo parcial dice cuántos se actualizaron y nunca «Datos actualizados.»', async () => {
    test.setTimeout(240_000);
    const { page } = await openWithLegacyEur('tradia-ticker-parcial');
    // SPY se queda sin su vela (proveedor caído y un cierre más): estado real «desactualizado».
    await page.evaluate(async (delta) => {
      await window.tradia.testing!.simulateProviderFailure(true);
      await window.tradia.testing!.advanceMarketClock(delta);
    }, DAY_MS);
    await expect.poll(async () => (await freshness(page)).state, { timeout: 30_000 }).toBe('stale');
    const stale = await freshness(page);
    // El proveedor vuelve, pero el resumen se congela en el estado caído:
    // el aviso sigue ahí y su botón lanza una actualización real, que
    // recupera SPY y deja EUR sin datos (fallo parcial).
    await page.evaluate(() => window.tradia.testing!.simulateProviderFailure(false));
    await context!.app.evaluate(({ ipcMain, BrowserWindow }, value) => {
      ipcMain.removeHandler('data-status:freshness');
      ipcMain.handle('data-status:freshness', () => value);
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('data-status:changed', {
          key: 'ticker:SPY',
          state: 'desactualizado',
          lastOkAt: null,
          consecutiveFailures: 1,
          reason: 'fallo simulado del proveedor (network)',
          updatedAt: value.updatedAt,
        });
    }, stale);
    await openPage(page, 'Mercado');
    const banner = dataBanner(page);
    await expect(banner.getByRole('status').first()).toContainText('Datos desactualizados');
    const refresh = banner.getByRole('button', { name: 'Actualizar ahora' });
    await expect(refresh).toBeVisible();
    await refresh.focus();
    await page.keyboard.press('Enter');
    await expect(banner).toContainText('Actualizados 1 de 2 · sin datos: EUR', { timeout: 30_000 });
    await expect(page.getByText('Datos actualizados.')).toHaveCount(0);
    await expect(banner).not.toContainText('Datos actualizados.');
    await page.screenshot({ path: 'test-results/ticker-sin-cobertura-3-parcial.png' });
  });

  test('Ajustes › Conectores: estado y siguiente paso de Tiingo con la clave rechazada y con EUR sin cobertura', async () => {
    test.setTimeout(240_000);
    const { page } = await openWithLegacyEur('tradia-ticker-conectores');
    await openPage(page, 'Ajustes');
    const section = page.getByRole('region', { name: 'Conectores de datos' });
    await section.scrollIntoViewIfNeeded();
    const tiingo = page.getByRole('form', { name: 'Proveedor Tiingo' });
    const fred = page.getByRole('form', { name: 'Proveedor FRED' });
    const test_ = (form: Locator) =>
      form.getByRole('button', { name: /^(Probar conexión|Comprobando…)$/ });

    // Conexión sana, pero EUR sin cobertura: dos problemas distintos.
    await test_(tiingo).click();
    await expect(tiingo).toContainText('Funciona', { timeout: 15_000 });
    await expect(tiingo.getByText('Última comprobación', { exact: true })).toBeVisible();
    const coverage = tiingo.getByRole('heading', { name: 'Cobertura de tu lista en Tiingo' });
    await expect(coverage).toBeVisible();
    await expect(tiingo).toContainText('EUR no está disponible en Tiingo');
    await expect(tiingo).toContainText('Alternativa disponible: FXE.');
    await expect(tiingo).not.toContainText('SPY');
    const toList = tiingo.getByRole('link', {
      name: /Ir a la lista para quitar o cambiar estos activos/,
    });
    await expect(toList).toHaveAttribute('href', '#mercado');
    await expect(fred).toContainText('Sin comprobar');

    // Clave rechazada: el estado, el motivo y el paso concreto; la cobertura sigue aparte.
    await page.evaluate(() =>
      window.tradia.testing!.providers.simulateTest({
        provider: 'tiingo',
        status: 'clave-rechazada',
      }),
    );
    await test_(tiingo).click();
    await expect(tiingo).toContainText('Clave no válida', { timeout: 15_000 });
    await expect(tiingo).toContainText('La clave de Tiingo no es válida');
    await expect(tiingo).toContainText('Cómo arreglarlo');
    await expect(tiingo.getByLabel('Clave de API de Tiingo')).toBeFocused();
    await expect(
      tiingo.getByRole('button', { name: 'Revisar la clave', exact: true }),
    ).toBeVisible();
    await expect(tiingo.getByRole('link', { name: /^Abrir mi cuenta de Tiingo/ })).toHaveAttribute(
      'href',
      'https://www.tiingo.com/account/api/token',
    );
    await expect(tiingo).toContainText('EUR no está disponible en Tiingo');
    await expect(tiingo).toContainText('Alternativa disponible: FXE.');
    // El estado de FRED no se contagia.
    await expect(fred).not.toContainText('Clave no válida');
    await tiingo.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/ticker-sin-cobertura-4-conectores.png' });

    // Teclado: «Revisar la clave» devuelve el foco al campo.
    const review = tiingo.getByRole('button', { name: 'Revisar la clave', exact: true });
    await review.focus();
    await page.keyboard.press('Enter');
    await expect(tiingo.getByLabel('Clave de API de Tiingo')).toBeFocused();

    // Sin EUR en la lista, Conectores deja de nombrarlo.
    await page.evaluate(() => window.tradia.watchlist.remove('EUR'));
    await openPage(page, 'Inicio', 'Estado del sistema');
    await openPage(page, 'Ajustes');
    await expect(tiingo.getByText('Tiingo cubre todos los activos de tu lista.')).toBeVisible();
    await expect(tiingo).not.toContainText('EUR no está disponible en Tiingo');
  });
});

const TECHNICAL_REASON = /no existe|'tiingo'|ticker '|no devolvió datos/;

const coverage = (page: Page): Promise<{ ticker: string; reason: string | null }[]> =>
  page.evaluate(async () =>
    (await window.tradia.watchlist.coverage()).map((entry) => ({
      ticker: entry.ticker,
      reason: (entry as { reason?: string | null }).reason ?? null,
    })),
  );

const REMOVE_EUR = 'Quitar EUR de la lista';
const EUR_HEADING = 'EUR no está disponible en Tiingo';

test.describe('Cierre de los tres fallos del activo sin cobertura', () => {
  test('H1: «Quitar EUR de la lista» con teclado retira el aviso en Mercado e Inicio sin reiniciar', async () => {
    test.setTimeout(300_000);
    const { page } = await openWithLegacyEur('tradia-cierre-quitar');
    await openPage(page, 'Mercado');
    const banner = dataBanner(page);
    await expect(banner.getByRole('heading', { name: EUR_HEADING })).toBeVisible();

    // Teclado: Tab desde «Cambiar por FXE» llega a «Quitar EUR de la lista»; Enter la activa.
    await banner.getByRole('button', { name: 'Cambiar por FXE para EUR' }).focus();
    await page.keyboard.press('Tab');
    await expect(banner.getByRole('button', { name: REMOVE_EUR })).toBeFocused();
    await page.keyboard.press('Enter');

    // Sin reiniciar: el aviso desaparece de Mercado y de Inicio.
    await expect(page.getByText(EUR_HEADING)).toHaveCount(0, { timeout: 10_000 });
    await expect(banner).toHaveCount(0);
    await expect(page.getByText('EUR se ha quitado de tu lista.')).toBeVisible();
    await openPage(page, 'Inicio', 'Estado del sistema');
    await expect(page.getByText(EUR_HEADING)).toHaveCount(0);
    await expect(page.getByRole('button', { name: REMOVE_EUR })).toHaveCount(0);
    await expect(page.locator('.dashboard-row').filter({ hasText: /^Precios/ })).toContainText(
      'Disponible',
    );

    // Datos: ni resumen ni estados guardados nombran ya a EUR.
    expect(await watchlistTickers(page)).toEqual(['SPY']);
    const after = await freshness(page);
    expect(after.uncovered).toEqual([]);
    expect(after.state).toBe('current');
    const statuses = await page.evaluate(() => window.tradia.dataStatus.get());
    expect(statuses.find((entry) => entry.key === 'ticker:EUR')).toBeUndefined();
    expect((await coverage(page)).map((entry) => entry.ticker)).toEqual(['SPY']);
    await page.screenshot({ path: 'test-results/cierre-ticker-1-quitado.png' });

    // Una pasada nueva del proveedor y un reinicio tampoco lo resucitan.
    await page.evaluate(() => window.tradia.market.refreshNow());
    await expect(page.getByText(EUR_HEADING)).toHaveCount(0);
    await relaunchPhaseApp(context!);
    const restarted = context!.page;
    await expect(restarted.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible({
      timeout: 30_000,
    });
    await expect
      .poll(async () => (await freshness(restarted)).state, { timeout: 60_000 })
      .toBe('current');
    expect((await freshness(restarted)).uncovered).toEqual([]);
    await expect(restarted.getByText(EUR_HEADING)).toHaveCount(0);
    expect(await watchlistTickers(restarted)).toEqual(['SPY']);
  });

  test('H2: en Inicio y en Mercado hay un único encabezado del aviso de EUR y un único botón «Quitar EUR de la lista»', async () => {
    test.setTimeout(240_000);
    const { page } = await openWithLegacyEur('tradia-cierre-unico');

    for (const [link, heading] of [
      ['Inicio', 'Estado del sistema'],
      ['Mercado', 'Mercado'],
    ] as const) {
      await openPage(page, link, heading);
      await expect(page.getByRole('heading', { name: EUR_HEADING })).toHaveCount(1);
      await expect(page.getByRole('button', { name: REMOVE_EUR })).toHaveCount(1);
      // En el orden de Tab el botón aparece una sola vez: se recorre la página
      // hasta que el foco vuelve a un elemento ya visitado.
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur();
        (window as unknown as { __tabSeen: Set<Element> }).__tabSeen = new Set();
      });
      let stops = 0;
      for (let step = 0; step < 300; step += 1) {
        await page.keyboard.press('Tab');
        const result = await page.evaluate(() => {
          const seen = (window as unknown as { __tabSeen: Set<Element> }).__tabSeen;
          const active = document.activeElement;
          if (!active || active === document.body) return { name: '', repeated: false };
          const repeated = seen.has(active);
          seen.add(active);
          return { name: active.getAttribute('aria-label') ?? '', repeated };
        });
        if (result.repeated) break;
        if (result.name === REMOVE_EUR) stops += 1;
      }
      expect(stops, `paradas de Tab en «${REMOVE_EUR}» en ${link}`).toBe(1);
    }
    await page.screenshot({ path: 'test-results/cierre-ticker-2-unico.png' });
  });

  test('H3: ningún texto visible ni motivo de freshness() y coverage() es técnico, en Inicio, Mercado, IA y Conectores', async () => {
    test.setTimeout(240_000);
    const { page } = await openWithLegacyEur('tradia-cierre-llano');

    const summary = await freshness(page);
    const reasons = [
      ...summary.uncovered.map((asset) => asset.reason),
      ...summary.items.map((item) => item.reason),
      ...(await coverage(page)).map((entry) => entry.reason),
    ].filter((reason): reason is string => typeof reason === 'string');
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of reasons) expect(reason).not.toMatch(TECHNICAL_REASON);
    expect(summary.uncovered[0]!.reason).toMatch(/no tiene datos de EUR/);

    const visibleText = async (): Promise<string> => page.locator('body').innerText();
    for (const [link, heading] of [
      ['Inicio', 'Estado del sistema'],
      ['Mercado', 'Mercado'],
      ['IA', 'IA'],
    ] as const) {
      await openPage(page, link, heading);
      expect(await visibleText(), `texto visible en ${link}`).not.toMatch(TECHNICAL_REASON);
    }

    await openPage(page, 'Ajustes');
    const tiingo = page.getByRole('form', { name: 'Proveedor Tiingo' });
    await tiingo.scrollIntoViewIfNeeded();
    await tiingo.getByRole('button', { name: /^Probar conexión$/ }).click();
    await expect(tiingo).toContainText('Funciona', { timeout: 15_000 });
    await expect(tiingo).toContainText(EUR_HEADING);
    expect(await visibleText(), 'texto visible en Ajustes › Conectores').not.toMatch(
      TECHNICAL_REASON,
    );
    await page.screenshot({ path: 'test-results/cierre-ticker-3-llano.png' });
  });
});
