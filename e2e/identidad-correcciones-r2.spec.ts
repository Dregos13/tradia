import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closePhaseApp, launchPhaseApp, openPage, type PhaseApp } from './phase-6-7.helpers';

/**
 * Regresión de los hallazgos IDV-E2E-2, 5, 7 y 8 medidos con la app real
 * (los demás los cubren fx-paper-portfolio, mejoras-mercado-ajustes,
 * news-sentiment y stale-data, sin cambiar sus textos, roles ni selectores).
 */

const evidenceDir = resolve('docs/qa/capturas/identidad-correcciones-r2');
const THEMES = ['light', 'dark'] as const;
const THEME_NAME = { light: 'claro', dark: 'oscuro' } as const;

for (const colorScheme of THEMES) {
  test.describe(`identidad: correcciones E2E, ronda 2 · ${THEME_NAME[colorScheme]}`, () => {
    let context: PhaseApp;
    let page: Page;

    test.beforeAll(async () => {
      mkdirSync(evidenceDir, { recursive: true });
      context = await launchPhaseApp('tradia-identidad-r2-');
      page = context.page;
      await page.emulateMedia({ colorScheme });
    });

    test.afterAll(async () => {
      await closePhaseApp(context);
    });

    for (const [width, height] of [
      [1280, 800],
      [1024, 700],
    ] as const) {
      test(`IDV-E2E-2: a ${width}×${height} la conciliación de Órdenes conserva caja, borde y espaciado`, async () => {
        await page.setViewportSize({ width, height });
        await openPage(page, 'Órdenes');
        const reading = await page.evaluate(() => {
          const reconcile = document.querySelector<HTMLElement>('.orders-reconcile')!;
          const style = getComputedStyle(reconcile);
          return {
            border: [
              style.borderTopWidth,
              style.borderRightWidth,
              style.borderBottomWidth,
              style.borderLeftWidth,
            ],
            padding: style.paddingTop,
            shadow: style.boxShadow,
            width: reconcile.getBoundingClientRect().width,
            stack: document.querySelector('.orders-filters')!.getBoundingClientRect().width,
          };
        });
        expect(reading.border).toEqual(['1px', '1px', '1px', '1px']);
        expect(reading.padding).toBe('24px');
        // Composición por carriles: caja de 1 px, nunca tarjeta con sombra.
        expect(reading.shadow).toBe('none');
        expect(Math.abs(reading.width - reading.stack)).toBeLessThanOrEqual(1);
        await page.screenshot({
          path: resolve(evidenceDir, `ordenes-${width}-${THEME_NAME[colorScheme]}.png`),
        });
      });
    }

    test('IDV-E2E-5: Ajustes ofrece los dos radios de «Análisis de noticias» y cambian el motor', async () => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await openPage(page, 'Ajustes');
      const section = page.getByRole('region', { name: 'Análisis de noticias', exact: true });
      const radios = section.getByRole('radio');
      await expect(radios).toHaveCount(2);
      const subscription = section.getByRole('radio', { name: /^Suscripción \(/ });
      const local = section.getByRole('radio', { name: 'Analizador local' });
      await local.check();
      await expect(local).toBeChecked();
      await expect(section.getByLabel('Motor de análisis de noticias')).toHaveValue('local');
      await subscription.check();
      await expect(subscription).toBeChecked();
      await expect(section.getByLabel('Motor de análisis de noticias')).not.toHaveValue('local');
      await expect(section.getByLabel(/Clave de API/)).toHaveCount(0);
      await section.screenshot({
        path: resolve(evidenceDir, `ajustes-radios-${THEME_NAME[colorScheme]}.png`),
      });
    });

    test('IDV-E2E-7: a 1120 px las columnas de Estrategias se leen enteras', async () => {
      await page.setViewportSize({ width: 1120, height: 688 });
      await openPage(page, 'Estrategias');
      const table = page.locator('.strategy-library-table').first();
      await expect(table).toBeVisible();
      const reading = await table.evaluate((el) => {
        const wrap = el.closest('[tabindex], .table-wrap, [role="region"]') ?? el.parentElement!;
        const cells = [...el.querySelectorAll('th, td')].filter(
          (cell) => cell.getBoundingClientRect().width > 0,
        );
        return {
          scrolls: wrap.scrollWidth > wrap.clientWidth + 1,
          clipped: cells
            .filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
            .map((cell) => (cell.textContent ?? '').trim().slice(0, 30)),
          lastRight: Math.max(...cells.map((cell) => cell.getBoundingClientRect().right)),
          wrapRight: wrap.getBoundingClientRect().right,
        };
      });
      expect(reading.clipped).toEqual([]);
      expect(reading.scrolls).toBe(false);
      expect(reading.lastRight).toBeLessThanOrEqual(reading.wrapRight + 1);
      await page.screenshot({
        path: resolve(evidenceDir, `estrategias-1120-${THEME_NAME[colorScheme]}.png`),
      });
    });

    test('IDV-E2E-8: a 1120 px la barra de estado muestra «En línea» y «Agentes activos» enteros', async () => {
      await page.setViewportSize({ width: 1120, height: 688 });
      for (const link of ['Inicio', 'Mercado', 'Riesgo']) {
        await openPage(page, link, link === 'Inicio' ? 'Estado del sistema' : link);
        const status = page.locator('footer.statusbar [role="status"]');
        await expect(status).toContainText('En línea');
        await expect(status).toContainText('Agentes activos');
        const clipped = await page.evaluate(() =>
          [...document.querySelectorAll('footer.statusbar *')]
            .filter((el) => el.getBoundingClientRect().width > 1)
            .filter((el) => el.scrollWidth > el.clientWidth + 1)
            .map((el) => (el as HTMLElement).innerText.trim()),
        );
        expect(clipped, `${link}: textos recortados`).toEqual([]);
      }
      await openPage(page, 'Inicio', 'Estado del sistema');
      await page.screenshot({
        path: resolve(evidenceDir, `barra-estado-1120-${THEME_NAME[colorScheme]}.png`),
      });
    });
  });
}
