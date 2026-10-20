import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closePhaseApp, launchPhaseApp, openPage, type PhaseApp } from './phase-6-7.helpers';

/**
 * Correcciones de legibilidad, jerarquía y composición de la identidad
 * (IDV-UXP-1, 2, 3, 4 y 6 e IDV-E2E-7 y 8), medidas con la app real:
 * metadatos small de 13 px o más, un único título dominante, la lista de
 * seguimiento de Mercado compacta con el gráfico a la vista, la barra de
 * estado sin recortes a 1100 px y la ayuda de la búsqueda alineada con el campo.
 */

const evidenceDir = resolve('docs/qa/capturas/identidad-correcciones');
const THEMES = ['light', 'dark'] as const;
const THEME_NAME = { light: 'claro', dark: 'oscuro' } as const;

async function smallSizes(page: Page): Promise<{ text: string; size: number }[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('main small')]
      .filter((el) => el.getBoundingClientRect().width > 0 && (el.textContent ?? '').trim())
      .map((el) => ({
        text: (el.textContent ?? '').trim().slice(0, 40),
        size: Number.parseFloat(getComputedStyle(el).fontSize),
      })),
  );
}

async function headingSizes(page: Page): Promise<{ h1: number; h2: number[] }> {
  return page.evaluate(() => {
    const size = (el: Element) => Number.parseFloat(getComputedStyle(el).fontSize);
    return {
      h1: size(document.querySelector('header.top h1')!),
      h2: [...document.querySelectorAll('main h2')]
        .filter((el) => el.getBoundingClientRect().width > 0)
        .map(size),
    };
  });
}

for (const colorScheme of THEMES) {
  test.describe(`identidad: legibilidad y composición · ${THEME_NAME[colorScheme]}`, () => {
    let context: PhaseApp;
    let page: Page;

    test.beforeAll(async () => {
      mkdirSync(evidenceDir, { recursive: true });
      context = await launchPhaseApp('tradia-identidad-legibilidad-');
      page = context.page;
      await page.emulateMedia({ colorScheme });
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    test.afterAll(async () => {
      await closePhaseApp(context);
    });

    test('IDV-UXP-1: los small de Estrategias, Riesgo y Ajustes miden 13 px o más', async () => {
      for (const link of ['Estrategias', 'Riesgo', 'Ajustes']) {
        await openPage(page, link);
        await expect(page.locator('main small').first()).toBeVisible();
        const sizes = await smallSizes(page);
        expect(sizes.length, link).toBeGreaterThan(0);
        for (const item of sizes) {
          expect(item.size, `${link}: «${item.text}»`).toBeGreaterThanOrEqual(13);
        }
      }
    });

    test('IDV-UXP-2: el h1 de la barra es el único título dominante en Inicio, Mercado, Estrategias y Ajustes', async () => {
      for (const [link, heading] of [
        ['Inicio', 'Estado del sistema'],
        ['Mercado', 'Mercado'],
        ['Estrategias', 'Estrategias'],
        ['Ajustes', 'Ajustes'],
      ] as const) {
        await openPage(page, link, heading);
        const { h1, h2 } = await headingSizes(page);
        expect(h2.length, link).toBeGreaterThan(0);
        expect(h1, link).toBe(24);
        for (const size of h2) expect(size, `${link}: h2`).toBeLessThan(h1);
        await page.screenshot({
          path: resolve(evidenceDir, `${link.toLowerCase()}-${THEME_NAME[colorScheme]}.png`),
        });
      }
    });

    test('IDV-UXP-3 e IDV-UXP-6: con 25 activos y SPY, filas compactas, gráfico a la vista y ayuda alineada', async () => {
      await openPage(page, 'Mercado');
      await page.getByRole('button', { name: /Añadir universo inicial/ }).click();
      await expect(page.locator('.market-watch li')).toHaveCount(25, { timeout: 30_000 });
      await page.locator('button.market-asset[aria-label="SPY"]').click();
      await expect(page.locator('.market-chart canvas').first()).toBeVisible({ timeout: 60_000 });
      const reading = await page.evaluate(() => {
        const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
        const rows = [...document.querySelectorAll('.market-watch li')].map(
          (row) => row.getBoundingClientRect().height,
        );
        const chart = box('.market-chart');
        const input = box('.market-search-input');
        const help = box('.market-ticker-help');
        return {
          rows,
          viewport: innerHeight,
          chartTop: chart.top,
          chartVisible: Math.min(chart.bottom, innerHeight) - chart.top,
          input: { left: input.left, bottom: input.bottom },
          help: { left: help.left, top: help.top },
        };
      });
      for (const [index, height] of reading.rows.entries()) {
        expect(height, `fila ${index + 1}`).toBeLessThanOrEqual(56);
      }
      expect(reading.chartTop).toBeLessThan(reading.viewport);
      expect(reading.chartVisible).toBeGreaterThanOrEqual(150);
      // Ayuda bajo el campo y a su izquierda, no a la derecha del botón.
      expect(Math.abs(reading.help.left - reading.input.left)).toBeLessThanOrEqual(1);
      expect(reading.help.top).toBeGreaterThanOrEqual(reading.input.bottom - 1);
      await expect(page.locator('#market-ticker')).toHaveAttribute(
        'aria-describedby',
        /market-ticker-help/,
      );
      await page.screenshot({
        path: resolve(evidenceDir, `mercado-universo-${THEME_NAME[colorScheme]}.png`),
      });
    });

    test('IDV-UXP-4 e IDV-E2E-8: a 1100 × 760 la barra de estado se lee completa y sin solapamientos', async () => {
      await page.setViewportSize({ width: 1100, height: 760 });
      for (const link of ['Inicio', 'Riesgo']) {
        await openPage(page, link, link === 'Inicio' ? 'Estado del sistema' : link);
        const reading = await page.evaluate(() => {
          const bar = document.querySelector('footer.statusbar')!;
          const items = [
            ...bar.querySelectorAll('[role="status"] > *'),
            ...bar.querySelectorAll('.statusbar-time'),
          ].map((el) => {
            const box = el.getBoundingClientRect();
            return {
              text: (el as HTMLElement).innerText.trim(),
              clipped: el.scrollWidth > el.clientWidth + 1,
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
            };
          });
          const barBox = bar.getBoundingClientRect();
          return { items, barRight: barBox.right, barLeft: barBox.left };
        });
        const texts = reading.items.map((item) => item.text).join(' | ');
        expect(texts, link).toContain('En línea');
        expect(texts, link).toContain('Agentes activos');
        for (const item of reading.items) {
          expect(item.clipped, `${link}: «${item.text}» recortado`).toBe(false);
          expect(item.right, `${link}: «${item.text}» fuera de la barra`).toBeLessThanOrEqual(
            reading.barRight + 1,
          );
        }
        for (const [i, a] of reading.items.entries()) {
          for (const b of reading.items.slice(i + 1)) {
            const overlap =
              a.left < b.right - 1 &&
              b.left < a.right - 1 &&
              a.top < b.bottom - 1 &&
              b.top < a.bottom - 1;
            expect(overlap, `${link}: «${a.text}» y «${b.text}» se solapan`).toBe(false);
          }
        }
      }
      // Las etiquetas largas siguen en el árbol accesible aunque se vean las cortas.
      await expect(page.locator('footer.statusbar [title^="Último latido"]')).toBeVisible();
      await expect(page.locator('footer.statusbar .statusbar-label').first()).toHaveText(
        'Última comprobación',
      );
      await page.screenshot({
        path: resolve(evidenceDir, `barra-estado-1100-${THEME_NAME[colorScheme]}.png`),
      });
    });

    test('IDV-E2E-7: a 1120 px la tabla de estrategias no recorta sus últimas columnas', async () => {
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
        };
      });
      expect(reading.clipped).toEqual([]);
      expect(reading.scrolls, 'la tabla cabe sin desplazamiento horizontal').toBe(false);
      await page.screenshot({
        path: resolve(evidenceDir, `estrategias-1120-${THEME_NAME[colorScheme]}.png`),
      });
    });
  });
}
