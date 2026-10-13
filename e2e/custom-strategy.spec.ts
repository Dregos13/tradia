import { expect, test } from '@playwright/test';
import type { Page } from 'playwright';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
  watchTickers,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * Estrategia propia de punta a punta, como la crearía alguien que escribe
 * sus reglas: error en vivo, corrección, backtest y estrés desde la
 * ficha, informe en el historial y, ya en paper, su señal en el panel de
 * Inicio. Todo con los ganchos deterministas de TRADIA_E2E (mercado
 * simulado, reloj anclado y sin red).
 */

const NAME = 'Cruce rápido propio E2E';
const DAY_MS = 24 * 60 * 60 * 1000;

let context: PhaseApp | undefined;

test.beforeEach(async () => {
  context = await launchPhaseApp('tradia-custom-strategy-e2e');
});

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

async function fillNewStrategy(page: Page) {
  await openPage(page, 'Estrategias');
  await page.getByRole('link', { name: 'Nueva estrategia', exact: true }).click();
  for (const [label, value] of Object.entries({
    Nombre: NAME,
    'Hipótesis económica': 'Las medias cortas recogen impulsos de pocos días en índices líquidos.',
    Entrada: 'cruza_arriba(sma(rapida), sma(lentx))',
    Salida: 'cruza_abajo(sma(rapida), sma(lenta))',
    Stop: '5%',
    Objetivo: 'ninguno',
    'Mercados (separados por comas)': 'SPY',
    'Régimen favorable y limitaciones': 'Tendencial; falla en rangos laterales.',
    'Parámetros (objeto JSON de números)': '{"rapida":2,"lenta":3}',
    'Entrenamiento · desde': '2015-01-01',
    'Entrenamiento · hasta': '2020-12-31',
    'Fuera de muestra · desde': '2021-01-01',
    'Fuera de muestra · hasta': '2024-12-31',
  }))
    await page.getByLabel(label, { exact: true }).fill(value);
}

test.describe('Profesional independiente que organiza varios proyectos', () => {
  test('crea una propia, corrige el error en vivo, lanza backtest y estrés y ve su señal en paper', async () => {
    test.setTimeout(300_000);
    const { page } = context!;
    await watchTickers(page, ['SPY']);
    await fillNewStrategy(page);

    // Error en vivo: el campo lo marca y lo describe sin esperar a guardar.
    const entry = page.getByLabel('Entrada', { exact: true });
    await expect(entry).toHaveAttribute('aria-invalid', 'true');
    await expect(entry).toHaveAccessibleDescription(/lentx/);
    // Guardar con el error no crea nada: el resumen lo anuncia y el foco va al campo.
    const create = page.getByRole('button', { name: 'Crear estrategia', exact: true });
    await expect(create).toHaveAttribute('aria-disabled', 'true');
    await create.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert').filter({ hasText: /Hay 1 error/ })).toBeVisible();
    await expect(entry).toBeFocused();
    await capturePhaseScreenshot(page, 'reglas-propias-error-en-vivo.png', entry.locator('..'));
    expect(
      (await page.evaluate(() => window.tradia.strategies.list())).some((s) => s.name === NAME),
    ).toBe(false);

    // Corrección por teclado: el error desaparece y las reglas se validan.
    await entry.fill('cruza_arriba(sma(rapida), sma(lenta))');
    await expect(entry).toHaveAttribute('aria-invalid', 'false');
    await expect(page.getByRole('status').filter({ hasText: 'Reglas válidas' })).toBeVisible();
    await page.getByRole('button', { name: 'Crear estrategia', exact: true }).click();
    await expect(page.getByRole('heading', { name: NAME, exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Reglas ejecutables' })).toContainText(
      'Reglas listas para ejecutar',
    );

    // Estrés desde la ficha: las tres crisis quedan guardadas.
    const stress = page.getByRole('region', { name: 'Comportamiento en crisis' });
    await expect(stress).toHaveAttribute('aria-busy', 'false');
    await stress.getByRole('button', { name: 'Ejecutar pruebas de estrés', exact: true }).click();
    await expect(stress.getByRole('status')).toHaveText('Pruebas de estrés guardadas.', {
      timeout: 60_000,
    });
    for (const year of ['2008', '2020', '2022'])
      await expect(stress.getByRole('article', { name: year, exact: true })).toBeVisible();
    await capturePhaseScreenshot(page, 'reglas-propias-estres.png', stress);

    // Backtest desde la ficha: informe completo y enlazado en el historial.
    await page.getByLabel('Simulaciones Monte Carlo').fill('100');
    await page.getByRole('button', { name: 'Lanzar backtest', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Informe de backtest', exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel('Ocho métricas del backtest').locator('dt')).toHaveCount(8);
    const runId = await page.evaluate(() => Number(location.hash.split('/').at(-1)));
    expect(runId).toBeGreaterThan(0);
    const trades = await page.evaluate(
      async (id) => (await window.tradia.backtest.get(id))?.trades.length ?? 0,
      runId,
    );
    expect(trades, 'el cruce 2/3 debe operar sobre el simulado').toBeGreaterThan(0);
    await capturePhaseScreenshot(page, 'reglas-propias-informe.png');
    await page.getByRole('link', { name: 'Volver a la ficha · v1', exact: true }).click();
    const history = page
      .getByRole('heading', { name: 'Historial de backtests · v1', exact: true })
      .locator('..');
    const report = history.getByRole('link', { name: new RegExp(`^Informe #${runId} ·`) });
    await expect(report).toBeVisible();
    await capturePhaseScreenshot(page, 'reglas-propias-historial.png', history);

    // Paso a paper desde la ficha (estado que emite como las clásicas).
    await page.getByLabel('Nuevo estado').selectOption({ label: 'Paper' });
    await page.getByRole('button', { name: 'Cambiar estado', exact: true }).click();
    // F1 (docs/qa/e2e-reglas-noticias.md): la ficha confirma el cambio y el
    // foco vuelve al selector en lugar de caer en body.
    await expect(page.getByRole('status').filter({ hasText: 'Estado actualizado' })).toBeVisible();
    await expect(page.getByLabel('Nuevo estado')).toBeFocused();
    await expect(page.getByText('● Paper', { exact: true })).toBeVisible();
    await expect(page.getByText('Investigación → Paper', { exact: true })).toBeVisible();
    const strategyId = await page.evaluate(
      async (name) => (await window.tradia.strategies.list()).find((s) => s.name === name)!.id,
      NAME,
    );
    expect(
      (await page.evaluate((id) => window.tradia.strategies.get({ id }), strategyId))?.status,
    ).toBe('paper');

    // Cierres de vela simulados hasta que la propia vote una señal.
    // Se espera una entrada (largo): la que lleva el stop del 5 % de la ficha.
    let signalTicker: string | null = null;
    let signalStop: number | null = null;
    for (let day = 0; day < 120 && !signalTicker; day += 1) {
      await page.evaluate(
        (delta) => window.tradia.testing!.advanceMarketClock(delta),
        DAY_MS + 8 * 60 * 60 * 1000,
      );
      const signals = await page.evaluate(() => window.tradia.signals.list({ limit: 50 }));
      const own = signals.find(
        (signal) =>
          signal.direction === 'largo' &&
          signal.strategies.some((vote) => vote.strategyId === strategyId),
      );
      signalTicker = own?.ticker ?? null;
      signalStop = own?.stop ?? null;
    }
    expect(signalTicker, 'la propia en paper debe emitir al cierre de vela').not.toBeNull();
    expect(signalStop, 'la entrada propia lleva el stop de su ficha').not.toBeNull();

    await openPage(page, 'Inicio', 'Estado del sistema');
    const panel = page.getByRole('region', { name: 'Señales vivas' });
    const own = panel
      .getByRole('listitem')
      .filter({ hasText: `${NAME} · v1` })
      .filter({ hasText: 'cruza_arriba(sma(rapida), sma(lenta))' })
      .first();
    await expect(own).toBeVisible({ timeout: 30_000 });
    await expect(own).toContainText(signalTicker!);
    await expect(own.getByRole('progressbar')).toBeVisible();
    await capturePhaseScreenshot(page, 'reglas-propias-senal-panel.png', panel);
  });
});

test.describe('Responsable de equipo que revisa entregas', () => {
  test('una propia con reglas no ejecutables dice el motivo y bloquea backtest y estrés', async () => {
    const { page } = context!;
    await openPage(page, 'Estrategias');
    // Ficha heredada con texto libre: la interfaz ya no deja guardarla así.
    const id = await page.evaluate(async () => {
      const legacy = await window.tradia.strategies.create({
        name: 'Propia heredada sin reglas',
        hypothesis: 'Tendencia persistente',
        rules: {
          entry: 'Comprar cuando suba mucho',
          exit: 'cruza_abajo(sma(rapida), sma(lenta))',
          stop: '5%',
          target: 'ninguno',
        },
        parameters: { rapida: 2, lenta: 3 },
        markets: ['SPY'],
        regime: 'Tendencial',
      });
      location.hash = `estrategias/${legacy.id}`;
      return legacy.id;
    });
    const notice = page.getByRole('status', { name: 'Reglas no ejecutables' });
    await expect(notice).toContainText(/Estas reglas no se pueden ejecutar:.*Entrada, caracteres/);
    for (const name of ['Lanzar backtest', 'Ejecutar pruebas de estrés']) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await button.focus();
      await page.keyboard.press('Enter');
    }
    await capturePhaseScreenshot(page, 'reglas-propias-no-ejecutables.png', notice);
    expect(
      await page.evaluate(async (strategyId) => window.tradia.backtest.list({ strategyId }), id),
    ).toEqual([]);
    const rejected = await page.evaluate(async (strategyId) => {
      try {
        await window.tradia.backtest.run({ strategyId });
        return '';
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    }, id);
    expect(rejected).toContain('[reglas-invalidas]');
  });
});
