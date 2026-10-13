import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';
import { skipGuidedTour } from './onboarding.helpers';

const classicStrategies = [
  'Cruce de medias',
  'Reversión RSI/Bollinger',
  'Ruptura de rangos',
  'Momentum entre activos',
];

async function acceptRisk(page: Page) {
  await page.getByLabel('He leído y acepto').check();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await skipGuidedTour(page);
}

async function expectNoHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.main').evaluate((main) => main.scrollWidth <= main.clientWidth)).toBe(
    true,
  );
}

test('biblioteca, versiones, backtest completo, sobreajuste, prueba final y crisis', async () => {
  test.setTimeout(300_000);
  const userData = mkdtempSync(join(tmpdir(), 'tradia-strategies-backtest-'));
  const app = await electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: resolve('.'),
    env: { ...process.env, TRADIA_E2E: '1', TRADIA_E2E_USER_DATA: userData },
  });

  try {
    const page = await app.firstWindow();
    await acceptRisk(page);
    await page.getByRole('link', { name: 'Estrategias', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Biblioteca de estrategias' })).toBeVisible();

    for (const name of classicStrategies)
      await expect(page.getByRole('link', { name, exact: true })).toBeVisible();
    await expect.soft
      .poll(
        async () =>
          page.evaluate(async (names) => {
            const [strategies, runs] = await Promise.all([
              window.tradia.strategies.list(),
              window.tradia.backtest.list({ limit: 100 }),
            ]);
            return names.filter((name) => {
              const strategy = strategies.find((item) => item.name === name);
              return !strategy || !runs.some((run) => run.strategyId === strategy.id);
            });
          }, classicStrategies),
        { timeout: 60_000 },
      )
      .toEqual([]);
    for (const name of classicStrategies) {
      const row = page
        .getByRole('row')
        .filter({ has: page.getByRole('link', { name, exact: true }) });
      await expect.soft(row).not.toContainText('Sin datos');
    }

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: resolve('docs/qa/capturas/fase-2-biblioteca-1440.png') });
    await page.setViewportSize({ width: 700, height: 900 });
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: resolve('docs/qa/capturas/fase-2-biblioteca-700.png') });

    let overfitRunId: number | null = null;
    for (const name of classicStrategies) {
      await page.getByRole('link', { name, exact: true }).click();
      for (const heading of [
        'Hipótesis',
        'Reglas reproducibles',
        'Mercados y periodos',
        'Régimen de mercado',
        'Costes asumidos',
        'Registro de cambios',
      ])
        await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      for (const label of [
        'Entrada',
        'Salida',
        'Stop',
        'Objetivo',
        'Entrenamiento',
        'Fuera de muestra',
      ])
        await expect(page.getByText(label, { exact: true }).first()).toBeVisible();

      const history = page.getByRole('heading', { name: /Historial de backtests · v1/ });
      await expect.soft(history.locator('..').getByRole('link').first()).toBeVisible({
        timeout: 2_000,
      });
      const stress = page.getByRole('region', { name: 'Comportamiento en crisis' });
      await expect(stress).toHaveAttribute('aria-busy', 'false');
      if (await stress.getByText('Aún no hay pruebas de estrés guardadas').isVisible()) {
        await stress
          .getByRole('button', { name: 'Ejecutar pruebas de estrés', exact: true })
          .click();
        await expect(stress.getByRole('status')).toHaveText('Pruebas de estrés guardadas.', {
          timeout: 60_000,
        });
      }
      for (const year of ['2008', '2020', '2022']) {
        const crisis = stress.getByRole('article', { name: year, exact: true });
        await expect(crisis).toBeVisible();
        await expect(crisis.getByText('Datos simulados', { exact: true })).toBeVisible();
        await expect(crisis.locator('dt')).toContainText([
          'Rentabilidad',
          'Drawdown máximo',
          'Operaciones',
        ]);
        await expect(crisis.getByRole('img')).toHaveAccessibleName(
          new RegExp(`Capital en ${year}`),
        );
      }
      await expectNoHorizontalOverflow(page);
      if (name === 'Cruce de medias') {
        await stress.scrollIntoViewIfNeeded();
        await page.screenshot({ path: resolve('docs/qa/capturas/fase-2-crisis-700.png') });
      }

      const overfit = await page.evaluate(async () => {
        const summaries = await window.tradia.backtest.list({ limit: 100 });
        const reports = await Promise.all(
          summaries.map(async ({ id }) => window.tradia.backtest.get(id)),
        );
        return reports.find((report) =>
          report?.warnings.some((warning) => warning.message.includes('Posible sobreajuste')),
        )?.id;
      });
      if (overfitRunId === null && overfit !== undefined) overfitRunId = overfit;
      await page.getByRole('link', { name: 'Volver a la biblioteca', exact: true }).click();
    }

    await page.getByRole('link', { name: 'Nueva estrategia', exact: true }).click();
    for (const [label, value] of Object.entries({
      Nombre: 'Hipótesis de prueba fase 2',
      'Hipótesis económica':
        'La persistencia de tendencias puede capturar movimientos prolongados.',
      Entrada: 'cruza_arriba(sma(rapida), sma(lenta))',
      Salida: 'cruza_abajo(sma(rapida), sma(lenta))',
      Stop: '2%',
      Objetivo: '6%',
      'Mercados (separados por comas)': 'SPY',
      'Régimen favorable y limitaciones': 'Tendencial; falla en rangos laterales.',
    }))
      await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByLabel('Entrenamiento · desde', { exact: true }).fill('2015-01-01');
    await page.getByLabel('Entrenamiento · hasta', { exact: true }).fill('2020-12-31');
    await page.getByLabel('Fuera de muestra · desde', { exact: true }).fill('2021-01-01');
    await page.getByLabel('Fuera de muestra · hasta', { exact: true }).fill('2024-12-31');
    await expectNoHorizontalOverflow(page);
    await page.getByLabel('Parámetros (objeto JSON de números)').fill('{"rapida":20,"lenta":50}');
    await page.getByLabel('Entrenamiento · desde').fill('2015-01-01');
    await page.getByLabel('Entrenamiento · hasta').fill('2020-12-31');
    await page.getByLabel('Fuera de muestra · desde').fill('2021-01-01');
    await page.getByLabel('Fuera de muestra · hasta').fill('2024-12-31');
    await expect(page.getByRole('status').filter({ hasText: 'Reglas válidas' })).toBeVisible();
    await page.screenshot({ path: 'test-results/editor-reglas-700.png' });
    await page.getByRole('button', { name: 'Crear estrategia', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Hipótesis de prueba fase 2', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('status', { name: 'Reglas ejecutables' })).toContainText(
      'Reglas listas para ejecutar',
    );
    const ownStress = page.getByRole('region', { name: 'Comportamiento en crisis' });
    await expect(ownStress).toHaveAttribute('aria-busy', 'false');
    await ownStress
      .getByRole('button', { name: 'Ejecutar pruebas de estrés', exact: true })
      .click();
    await expect(ownStress.getByRole('status')).toHaveText('Pruebas de estrés guardadas.', {
      timeout: 60_000,
    });
    await page.getByLabel('Simulaciones Monte Carlo').fill('100');
    await page.getByRole('button', { name: 'Lanzar backtest', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Informe de backtest', exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    const ownRunId = await page.evaluate(() => Number(location.hash.split('/').at(-1)));
    await page.getByRole('link', { name: 'Volver a la ficha · v1', exact: true }).click();
    const ownHistory = page
      .getByRole('heading', { name: 'Historial de backtests · v1', exact: true })
      .locator('..');
    await expect(
      ownHistory.getByRole('link', { name: new RegExp(`^Informe #${ownRunId} ·`) }),
    ).toBeVisible();
    await ownHistory.getByRole('link', { name: new RegExp(`^Informe #${ownRunId} ·`) }).click();
    await expect(
      page.getByRole('heading', { name: 'Informe de backtest', exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Volver a la ficha · v1', exact: true }).click();
    await page.getByRole('link', { name: 'Editar', exact: true }).click();
    await page.getByLabel('Nombre', { exact: true }).fill('Hipótesis de prueba fase 2 revisada');
    await page
      .getByLabel('Nota del cambio', { exact: true })
      .fill('Aclaro las reglas y el alcance de la hipótesis.');
    await page.getByRole('button', { name: 'Guardar nueva versión', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Hipótesis de prueba fase 2 revisada', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Aclaro las reglas y el alcance de la hipótesis.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'v2', exact: true })).toBeVisible();
    await page.getByLabel('Versión', { exact: true }).selectOption('1');
    await expect(
      page.getByRole('heading', { name: 'Hipótesis de prueba fase 2', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Versión histórica · solo lectura')).toBeVisible();
    await page.getByLabel('Versión', { exact: true }).selectOption('2');
    await page.getByRole('link', { name: 'Volver a la biblioteca', exact: true }).click();

    await page.getByRole('link', { name: 'Reversión RSI/Bollinger', exact: true }).click();
    await page.getByLabel('Desde', { exact: true }).fill('2015-01-01');
    await page.getByLabel('Hasta', { exact: true }).fill('2024-12-31');
    await page.getByLabel('Comisión (%)').fill('0.07');
    await page.getByLabel('Comisión mínima (USD)').fill('1.5');
    await page.getByLabel('Slippage (pb)').fill('6');
    await page.getByLabel('Spread (pb)').fill('3');
    await expect(page.getByRole('button', { name: 'Lanzar backtest', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Lanzar backtest', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Informe de backtest', exact: true }),
    ).toBeVisible({
      timeout: 60_000,
    });
    for (const heading of [
      'Curva de capital',
      'Ventanas walk-forward',
      'Sensibilidad de parámetros',
      'Dispersión Monte Carlo',
      'Operaciones',
    ])
      await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.getByLabel('Ocho métricas del backtest').locator('dt')).toHaveCount(8);
    await expect(page.getByRole('img', { name: /Curva de capital/ })).toBeVisible();
    await expect(
      page
        .getByRole('heading', { name: 'Ventanas walk-forward', exact: true })
        .locator('..')
        .getByRole('table'),
    ).toBeVisible();
    await expect(page.getByRole('region', { name: 'Mapa de sensibilidad' })).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Mapa de sensibilidad' }).locator('.backtest-heat > div'),
    ).not.toHaveCount(0);
    await expect(page.getByRole('img', { name: /Histograma de drawdown/ })).toBeVisible();
    await expect(page.getByRole('table').filter({ hasText: 'Operaciones cerradas' })).toBeVisible();
    await expect(page.getByLabel('Aviso de riesgo')).toContainText(
      'No es asesoramiento financiero',
    );
    await expect(page.getByText('Datos simulados', { exact: true })).toBeVisible();
    await expect(page.getByText(/Comisión 0,07 %/)).toBeVisible();
    await expect(page.getByText(/mínimo 1,5 USD/)).toBeVisible();
    await expect(page.getByText(/slippage 6 pb/)).toBeVisible();
    await expect(page.getByText(/spread 3 pb/)).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: resolve('docs/qa/capturas/fase-2-informe-700.png') });

    if (overfitRunId === null) {
      const current = await page.evaluate(async () => {
        const summaries = await window.tradia.backtest.list({ limit: 100 });
        const reports = await Promise.all(
          summaries.map(async ({ id }) => window.tradia.backtest.get(id)),
        );
        return reports.find((report) =>
          report?.warnings.some((warning) => warning.message.includes('Posible sobreajuste')),
        )?.id;
      });
      if (current !== undefined) overfitRunId = current;
    }
    expect(
      overfitRunId,
      'el caso simulado preparado debe generar un aviso de sobreajuste',
    ).not.toBeNull();
    if (overfitRunId === null)
      throw new Error('No se encontró un backtest simulado con aviso de sobreajuste.');
    const currentRunId = await page.evaluate(() => Number(location.hash.split('/').at(-1)));
    if (overfitRunId !== currentRunId) {
      await page.getByRole('link', { name: 'Volver a la ficha · v1', exact: true }).click();
      await page.getByRole('link', { name: 'Volver a la biblioteca', exact: true }).click();
      const owner = await page.evaluate(async (runId) => {
        const run = (await window.tradia.backtest.list({ limit: 100 })).find(
          (summary) => summary.id === runId,
        );
        const strategies = await window.tradia.strategies.list();
        return strategies.find((strategy) => strategy.id === run?.strategyId)?.name ?? null;
      }, overfitRunId);
      expect(owner).not.toBeNull();
      await page.getByRole('link', { name: owner!, exact: true }).click();
      await page.getByRole('link', { name: new RegExp(`^Informe #${overfitRunId} ·`) }).click();
    }
    await expect(page.getByText('Posible sobreajuste', { exact: true })).toBeVisible();

    if (!page.url().includes(`/backtest/${currentRunId}`)) {
      await page.getByRole('link', { name: 'Volver a la ficha · v1', exact: true }).click();
      await page.getByRole('link', { name: 'Volver a la biblioteca', exact: true }).click();
      await page.getByRole('link', { name: 'Reversión RSI/Bollinger', exact: true }).click();
      await page.getByRole('link', { name: new RegExp(`^Informe #${currentRunId} ·`) }).click();
      await expect(
        page.getByRole('heading', { name: 'Informe de backtest', exact: true }),
      ).toBeVisible();
      await page.getByRole('link', { name: 'Volver a la ficha · v1', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Ejecutar prueba final', exact: true }).click();
    await expect(page.getByText('Confirmar prueba final bloqueada', { exact: true })).toBeVisible();
    await page.screenshot({ path: resolve('docs/qa/capturas/fase-2-prueba-final-700.png') });
    await page
      .getByRole('button', { name: 'Confirmar y ejecutar prueba final', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Informe de backtest', exact: true }),
    ).toBeVisible({
      timeout: 60_000,
    });
    await expect(
      page.getByText('Prueba final · ejecutada y bloqueada', { exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Volver a la ficha · v1', exact: true }).click();
    await expect(page.getByRole('link', { name: 'Ver prueba final', exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Ejecutar prueba final', exact: true }),
    ).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('reglas antiguas: motivo previo, acciones bloqueadas y corrección por teclado', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'tradia-rule-editor-'));
  const app = await electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: resolve('.'),
    env: { ...process.env, TRADIA_E2E: '1', TRADIA_E2E_USER_DATA: userData },
  });
  try {
    const page = await app.firstWindow();
    await acceptRisk(page);
    await page.getByRole('link', { name: 'Estrategias', exact: true }).click();
    // Ficha heredada: las nuevas altas por interfaz ya impiden guardar texto libre.
    const id = await page.evaluate(async () => {
      const legacy = await window.tradia.strategies.create({
        name: 'Reglas heredadas',
        hypothesis: 'Tendencia persistente',
        rules: {
          entry: 'Comprar al cruce',
          exit: 'cruza_abajo(sma(rapida), sma(lenta))',
          stop: '2%',
          target: '6%',
        },
        parameters: { rapida: 20, lenta: 50 },
        markets: ['SPY'],
        regime: 'Tendencial',
      });
      location.hash = `estrategias/${legacy.id}`;
      return legacy.id;
    });
    const ipcError = await page.evaluate(async (strategyId) => {
      try {
        await window.tradia.backtest.run({ strategyId });
        return '';
      } catch (cause) {
        return cause instanceof Error ? cause.message : String(cause);
      }
    }, id);
    expect(ipcError).toContain('reglas-invalidas');
    const notice = page.getByRole('status', { name: 'Reglas no ejecutables' });
    await expect(notice).toContainText(/Estas reglas no se pueden ejecutar:.*Entrada, caracteres/);
    for (const name of ['Lanzar backtest', 'Ejecutar pruebas de estrés', 'Ejecutar comparación']) {
      const button = page.getByRole('button', { name, exact: true });
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await button.focus();
      await expect(button).toBeFocused();
      await button.press('Enter');
    }
    expect(
      await page.evaluate(async (strategyId) => window.tradia.backtest.list({ strategyId }), id),
    ).toEqual([]);
    await notice.getByRole('link', { name: 'Editar reglas' }).focus();
    await page.keyboard.press('Enter');
    const entry = page.getByLabel('Entrada', { exact: true });
    await expect(entry).toHaveAttribute('aria-invalid', 'true');
    await expect(entry).toHaveAccessibleDescription(/caracteres 1–7/);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page
      .locator('#strategy-section-2')
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: 'test-results/editor-reglas-error-1440.png' });
    const examples = page.getByRole('button', { name: 'Insertar cruce de medias', exact: true });
    await examples.focus();
    await page.keyboard.press('Enter');
    await expect(entry).toBeFocused();
    await expect(entry).toHaveValue('cruza_arriba(sma(rapida), sma(lenta))');
    await expect(entry).toHaveAttribute('aria-invalid', 'false');
    expect(await entry.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(37);
    await page.getByRole('button', { name: 'Revisar parámetros', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Parámetros (objeto JSON de números)')).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Editar estrategia' })).toBeVisible();
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page
        .locator('#strategy-section-2')
        .evaluate((element) => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: `test-results/editor-reglas-${theme}-1440.png` });
      await page.setViewportSize({ width: 700, height: 900 });
      await expectNoHorizontalOverflow(page);
      await page
        .locator('#strategy-section-2')
        .evaluate((element) => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: `test-results/editor-reglas-${theme}-700.png` });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page
      .getByLabel('Nota del cambio')
      .fill('Sustituyo el texto antiguo por reglas ejecutables.');
    await page.getByRole('button', { name: 'Guardar nueva versión' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status', { name: 'Reglas ejecutables' })).toContainText(
      'Reglas listas para ejecutar',
    );
    await expect(
      page.getByRole('button', { name: 'Lanzar backtest', exact: true }),
    ).toHaveAttribute('aria-disabled', 'false');
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('estrategia propia con corto: validación por campo, backtest y operación en historial', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'tradia-short-rules-'));
  const app = await electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: resolve('.'),
    env: { ...process.env, TRADIA_E2E: '1', TRADIA_E2E_USER_DATA: userData },
  });
  try {
    const page = await app.firstWindow();
    await acceptRisk(page);
    await page.getByRole('link', { name: 'Estrategias', exact: true }).click();
    await page.getByRole('link', { name: 'Nueva estrategia', exact: true }).click();
    for (const [label, value] of Object.entries({
      Nombre: 'Cruce bajista propio',
      'Hipótesis económica': 'Un cruce bajista puede capturar tendencias descendentes.',
      Entrada: '0 > 1',
      Salida: 'cruza_abajo(sma(rapida), sma(lenta))',
      Stop: '2%',
      Objetivo: '6%',
      'Mercados (separados por comas)': 'SPY',
      'Régimen favorable y limitaciones': 'Tendencias; puede fallar en rangos laterales.',
      'Parámetros (objeto JSON de números)': '{"rapida":20,"lenta":50}',
      'Entrenamiento · desde': '2015-01-01',
      'Entrenamiento · hasta': '2020-12-31',
      'Fuera de muestra · desde': '2021-01-01',
      'Fuera de muestra · hasta': '2024-12-31',
    }))
      await page.getByLabel(label, { exact: true }).fill(value);
    const entry = page.getByLabel('Entrada en corto', { exact: true });
    const exit = page.getByLabel('Salida del corto', { exact: true });
    await expect(entry).not.toHaveAttribute('required', '');
    await page.getByRole('button', { name: 'Insertar cruce de medias en corto' }).focus();
    await page.keyboard.press('Enter');
    await expect(entry).toBeFocused();
    await expect(entry).toHaveValue('cruza_abajo(sma(rapida), sma(lenta))');
    await expect(exit).toHaveAttribute('aria-invalid', 'true');
    await expect(exit).toHaveAccessibleDescription(/van en pareja.*caracteres 1–1/);
    await page.getByRole('button', { name: 'Insertar salida del corto por cruce' }).focus();
    await page.keyboard.press('Enter');
    await expect(exit).toBeFocused();
    await expect(exit).toHaveAttribute('aria-invalid', 'false');
    await entry.fill('cierre > desconocido');
    await expect(entry).toHaveAttribute('aria-invalid', 'true');
    await expect(entry).toHaveAccessibleDescription(/desconocido.*caracteres 10–20/);
    await expect(page.locator('#strategy-rule-entryShort-result')).toHaveAttribute(
      'aria-live',
      'polite',
    );
    await page.getByRole('button', { name: 'Insertar cruce de medias en corto' }).click();
    await expect(entry).toHaveAttribute('aria-invalid', 'false');
    for (const theme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 700, height: 900 });
      await entry.locator('..').evaluate((element) => element.scrollIntoView({ block: 'center' }));
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: `test-results/editor-cortos-${theme}-700.png` });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.getByRole('button', { name: 'Crear estrategia', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Cruce bajista propio', exact: true }),
    ).toBeVisible();
    await expect(page.getByText('Opera en: largo y corto.', { exact: true })).toBeVisible();
    await expect(page.getByText(/Corto con dinero real desactivado/)).toBeVisible();
    await page.getByLabel('Simulaciones Monte Carlo').fill('100');
    await page.getByRole('button', { name: 'Lanzar backtest', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Informe de backtest', exact: true }),
    ).toBeVisible({ timeout: 60_000 });
    const runId = await page.evaluate(() => Number(location.hash.split('/').at(-1)));
    const sides = await page.evaluate(async (id) => {
      const report = await window.tradia.backtest.get(id);
      return report?.trades.map((trade) => trade.side) ?? [];
    }, runId);
    expect(sides.length).toBeGreaterThan(0);
    expect(sides.every((side) => side === 'corto')).toBe(true);
    const operations = page.getByRole('table', { name: /Operaciones cerradas/ });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await expect(operations.getByRole('columnheader', { name: 'Lado', exact: true })).toBeVisible();
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(operations.locator('td[data-label="Lado"]').first()).toHaveText('Corto');
    await expect(operations.locator('td[data-label="Lado"]').first()).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await operations.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'test-results/informe-cortos-700.png' });
    await page.getByRole('link', { name: 'Volver a la ficha · v1', exact: true }).click();
    const history = page
      .getByRole('heading', { name: 'Historial de backtests · v1', exact: true })
      .locator('..');
    await history.getByRole('link', { name: new RegExp(`^Informe #${runId} ·`) }).click();
    await expect(
      page
        .getByRole('table', { name: /Operaciones cerradas/ })
        .locator('td[data-label="Lado"]')
        .first(),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Volver a la ficha · v1', exact: true }).click();
    await page.getByRole('link', { name: 'Editar', exact: true }).click();
    await expect(entry).toHaveValue('cruza_abajo(sma(rapida), sma(lenta))');
    await expect(exit).toHaveValue('cruza_arriba(sma(rapida), sma(lenta))');
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
