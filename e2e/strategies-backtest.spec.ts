import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { _electron as electron } from 'playwright';

const classicStrategies = [
  'Cruce de medias',
  'Reversión RSI/Bollinger',
  'Ruptura de rangos',
  'Momentum entre activos',
];

async function acceptRisk(page: Page) {
  await page.getByLabel('He leído y acepto').check();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
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
        'Régimen',
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
      Entrada: 'Entrar al cierre de una ruptura confirmada.',
      Salida: 'Salir cuando el cierre pierda la tendencia.',
      Stop: 'Cerrar si la pérdida alcanza el dos por ciento.',
      Objetivo: 'Cerrar al duplicar el riesgo inicial.',
      'Mercados (separados por comas)': 'SPY',
      'Régimen favorable y limitaciones': 'Tendencial; falla en rangos laterales.',
    }))
      await page.getByLabel(label, { exact: true }).fill(value);
    await page.getByLabel('Entrenamiento · desde', { exact: true }).fill('2015-01-01');
    await page.getByLabel('Entrenamiento · hasta', { exact: true }).fill('2020-12-31');
    await page.getByLabel('Fuera de muestra · desde', { exact: true }).fill('2021-01-01');
    await page.getByLabel('Fuera de muestra · hasta', { exact: true }).fill('2024-12-31');
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: resolve('docs/qa/capturas/fase-2-formulario-700.png') });
    await page.getByRole('button', { name: 'Crear estrategia', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Hipótesis de prueba fase 2', exact: true }),
    ).toBeVisible();
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
