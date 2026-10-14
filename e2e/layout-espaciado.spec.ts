import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { TOUR_STEPS } from '../src/renderer/src/components/onboarding/tourSteps';
import { TOUR_TOTAL_STEPS, tourDialog } from './onboarding.helpers';
import {
  closePhaseApp,
  launchPhaseApp,
  openPage,
  watchTickers,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * Contrato de ritmo de página (docs/diseno-espaciado.md, «Contrato que
 * medirá el E2E»). En las 15 secciones de la navegación, a 1280 × 800 y a
 * 1024 × 700, se comprueba que `main#contenido` no se desborda en
 * horizontal, que los bloques hermanos visibles de primer nivel de cada
 * página no se solapan, que entre bloques apilados hay al menos 24 px
 * (tolerancia ±1 px) y que el primer bloque arranca a 32 px (1280) o
 * 24 px (1024) del borde de `main`. La marca de la barra lateral y de
 * «Antes de empezar» debe verse y llamarse «Tradia» en claro y oscuro. El
 * tour se mide en su propia superficie: el foco acaba sobre el ancla
 * `data-tour` de cada paso, no sobre el respaldo. Además (UXE-01…04): en los
 * pasos 8 y 9 el globo no tapa el ancla y el foco del 9 no pasa de 400 px,
 * la barra de estado ocupa una línea de 48 px con «Último latido» a la vista
 * y el selector «Prioridad» de Noticias muestra su texto entero. Y (UXP-01 y
 * UXP-10): a 1280 × 800 caben las 15 entradas del menú lateral; a 1024 × 700
 * la lista desplaza dentro de la barra con un indicio inferior mientras queda
 * algo oculto, y «Ajustes» se alcanza con rueda y con Tab. Casillas (con su
 * etiqueta), selectores y enlaces en línea alcanzan el área mínima.
 */

const GAP_MIN = 24;
const TOLERANCE = 1;
const evidenceDir = resolve('docs/qa/capturas/e2e-espaciado');

const VIEWPORTS = [
  { width: 1280, height: 800, inline: 32 },
  { width: 1024, height: 700, inline: 24 },
] as const;

/** Las 15 entradas de la navegación lateral, en su orden, con su título h1. */
const ROUTES = [
  { route: 'inicio', link: 'Inicio', heading: 'Estado del sistema' },
  { route: 'mercado', link: 'Mercado', heading: 'Mercado' },
  { route: 'ia', link: 'IA', heading: 'IA' },
  { route: 'salud-modelos', link: 'Salud de modelos', heading: 'Salud de modelos' },
  { route: 'macro', link: 'Macro', heading: 'Contexto macro' },
  { route: 'noticias', link: 'Noticias', heading: 'Noticias' },
  { route: 'calendario', link: 'Calendario', heading: 'Calendario' },
  { route: 'fuentes', link: 'Fuentes', heading: 'Fuentes' },
  { route: 'estrategias', link: 'Estrategias', heading: 'Estrategias' },
  { route: 'riesgo', link: 'Riesgo', heading: 'Riesgo' },
  { route: 'diario', link: 'Diario', heading: 'Diario' },
  { route: 'ordenes', link: 'Órdenes', heading: 'Órdenes' },
  { route: 'real-vs-backtest', link: 'Real vs backtest', heading: 'Real vs backtest' },
  { route: 'dinero-real', link: 'Dinero real', heading: 'Dinero real' },
  { route: 'ajustes', link: 'Ajustes', heading: 'Ajustes' },
] as const;

interface Box {
  name: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface LayoutGroup {
  parent: string;
  blocks: Box[];
}

interface LayoutReading {
  overflow: number;
  mainLeft: number;
  firstBlockLeft: number | null;
  groups: LayoutGroup[];
}

/**
 * Lee la geometría de la página desde el renderer. Cada bloque
 * `data-layout-block` visible se agrupa con sus hermanos de la misma
 * superficie: su antecesor `data-layout-page` o `data-layout-block` más
 * cercano (sin aplanar anidados). Los hijos directos de `.app-page` forman
 * además el grupo de primer nivel de la pantalla, tengan o no atributo.
 */
function readLayout(page: Page): Promise<LayoutReading> {
  return page.evaluate(() => {
    const main = document.querySelector<HTMLElement>('main#contenido');
    if (!main) throw new Error('No hay main#contenido en la página');
    const isVisible = (element: Element): boolean => {
      if (element.closest('[hidden]')) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    const describe = (element: Element): string => {
      const own =
        element.getAttribute('data-layout-block') ??
        element.getAttribute('data-layout-page') ??
        element.getAttribute('aria-label') ??
        element.id ??
        element.className;
      return `${element.tagName.toLowerCase()}[${String(own).trim().split(/\s+/).join('.')}]`;
    };
    const toBox = (element: Element) => {
      const box = element.getBoundingClientRect();
      return {
        name: describe(element),
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
      };
    };
    const groups = new Map<Element, { parent: string; blocks: ReturnType<typeof toBox>[] }>();
    const add = (parent: Element, element: Element) => {
      const group = groups.get(parent) ?? { parent: describe(parent), blocks: [] };
      group.blocks.push(toBox(element));
      groups.set(parent, group);
    };
    for (const surface of Array.from(main.querySelectorAll<HTMLElement>('.app-page'))) {
      for (const child of Array.from(surface.children)) {
        if (child.tagName === 'STYLE' || !isVisible(child)) continue;
        add(surface, child);
      }
    }
    for (const block of Array.from(main.querySelectorAll<HTMLElement>('[data-layout-block]'))) {
      if (!isVisible(block)) continue;
      const parent = block.parentElement?.closest('[data-layout-page],[data-layout-block]');
      if (!parent) continue;
      // Bajo `.app-page`, los hijos directos ya forman su grupo; los bloques
      // más profundos sin superficie propia se comparan con sus hermanos DOM.
      if (parent.classList.contains('app-page')) {
        if (block.parentElement !== parent) add(block.parentElement!, block);
        continue;
      }
      add(parent, block);
    }
    const surface = main.querySelector<HTMLElement>('.app-page');
    const first = surface
      ? Array.from(surface.children).find((child) => child.tagName !== 'STYLE' && isVisible(child))
      : undefined;
    return {
      overflow: main.scrollWidth - main.clientWidth,
      mainLeft: main.getBoundingClientRect().left,
      firstBlockLeft: first ? first.getBoundingClientRect().left : null,
      groups: Array.from(groups.values()),
    };
  });
}

/** Dos cajas se solapan si comparten más de la tolerancia en ambos ejes. */
function overlaps(a: Box, b: Box): boolean {
  const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return x > TOLERANCE && y > TOLERANCE;
}

/** Comparten fila si sus rangos verticales se cruzan. */
function sameRow(a: Box, b: Box): boolean {
  return a.top < b.bottom - TOLERANCE && b.top < a.bottom - TOLERANCE;
}

interface LayoutProblem {
  kind: 'solape' | 'separacion';
  parent: string;
  a: string;
  b: string;
  value: number;
}

/** Devuelve los solapes y las separaciones por debajo del mínimo. */
function auditGroups(groups: LayoutGroup[]): LayoutProblem[] {
  const problems: LayoutProblem[] = [];
  for (const { parent, blocks } of groups) {
    const sorted = [...blocks].sort((a, b) => a.top - b.top || a.left - b.left);
    sorted.forEach((block, index) => {
      for (const other of sorted.slice(index + 1)) {
        if (overlaps(block, other)) {
          problems.push({
            kind: 'solape',
            parent,
            a: block.name,
            b: other.name,
            value: Math.min(block.bottom, other.bottom) - Math.max(block.top, other.top),
          });
        }
      }
      // Separación respecto al bloque más bajo de los que quedan por encima
      // sin compartir fila: siguiente.top - anterior.bottom.
      const above = sorted
        .slice(0, index)
        .filter((previous) => !sameRow(previous, block))
        .sort((a, b) => b.bottom - a.bottom)[0];
      if (above) {
        const gap = block.top - above.bottom;
        if (gap < GAP_MIN - TOLERANCE) {
          problems.push({
            kind: 'separacion',
            parent,
            a: above.name,
            b: block.name,
            value: Math.round(gap * 100) / 100,
          });
        }
      }
    });
  }
  return problems;
}

function formatProblems(route: string, width: number, problems: LayoutProblem[]): string {
  return problems
    .map(
      (problem) =>
        `${route}@${width}: ${problem.kind} en ${problem.parent} entre ${problem.a} y ${problem.b} (${problem.value} px)`,
    )
    .join('\n');
}

/** Espera a que la página haya terminado sus cargas asíncronas. */
async function waitForSettled(page: Page, route: string): Promise<void> {
  const root = page.locator(`[data-layout-page="${route}"]`).last();
  await expect(root).toBeVisible({ timeout: 15_000 });
  await expect(root).not.toHaveAttribute('aria-busy', 'true', { timeout: 15_000 });
  await expect(page.locator('main#contenido [aria-busy="true"]')).toHaveCount(0, {
    timeout: 15_000,
  });
}

async function capture(page: Page, name: string): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  await page.locator('main#contenido').evaluate((main) => main.scrollTo({ top: 0 }));
  await page.screenshot({ path: resolve(evidenceDir, `${name}.png`) });
}

/** La marca visible: `role="img"` llamado «Tradia» con su símbolo cargado y su nombre. */
async function expectBrand(page: Page, scope: ReturnType<Page['locator']>): Promise<void> {
  const brand = scope.getByRole('img', { name: 'Tradia', exact: true });
  await expect(brand).toBeVisible();
  await expect(brand).toHaveAccessibleName('Tradia');
  await expect(brand.getByText('Tradia', { exact: true })).toBeVisible();
  const mark = brand.locator('img.brand-mark');
  await expect(mark).toBeVisible();
  await expect
    .poll(() => mark.evaluate((image) => (image as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  const size = await mark.boundingBox();
  expect(size?.width ?? 0).toBeGreaterThanOrEqual(24);
  expect(size?.height ?? 0).toBeGreaterThanOrEqual(24);
}

/**
 * UXE-03: la barra de estado ocupa una sola línea de 48 px y «Último latido»
 * sigue a la vista, con su etiqueta completa en el title.
 */
async function readStatusBar(page: Page, width: number): Promise<string[]> {
  const problems: string[] = [];
  const bar = page.locator('footer.statusbar');
  const box = await bar.boundingBox();
  if (!box || Math.abs(box.height - 48) > TOLERANCE) {
    problems.push(`barra de estado@${width}: mide ${box?.height ?? 0} px de alto, esperado 48 px`);
  }
  const heartbeat = bar.locator('[title^="Último latido"]');
  if (!(await heartbeat.isVisible())) {
    problems.push(`barra de estado@${width}: «Último latido» no se ve`);
  } else {
    const item = await heartbeat.boundingBox();
    if (!item || !box || item.x + item.width > box.x + box.width + TOLERANCE) {
      problems.push(`barra de estado@${width}: «Último latido» se sale de la barra`);
    }
  }
  return problems;
}

/**
 * UXE-04: el selector «Prioridad» de Noticias muestra «Todas las prioridades»
 * entero y no desborda la barra de filtros.
 */
async function readPriorityFilter(page: Page, width: number): Promise<string[]> {
  const priority = page
    .locator('.news-filters label')
    .filter({ hasText: /^Prioridad/ })
    .locator('select');
  const reading = await priority.evaluate((element) => {
    const select = element as HTMLSelectElement;
    const style = getComputedStyle(select);
    const context = document.createElement('canvas').getContext('2d')!;
    context.font = style.font;
    const text = select.selectedOptions[0]?.textContent ?? '';
    // Texto + relleno + flecha nativa (16 px) + borde.
    const needed =
      context.measureText(text).width +
      parseFloat(style.paddingLeft) +
      parseFloat(style.paddingRight) +
      16 +
      2;
    const bar = select.closest('.news-filters')!;
    const box = select.getBoundingClientRect();
    const barBox = bar.getBoundingClientRect();
    return {
      text,
      width: box.width,
      needed: Math.ceil(needed),
      inside: box.left >= barBox.left - 1 && box.right <= barBox.right + 1,
      overflow: bar.scrollWidth - bar.clientWidth,
    };
  });
  const problems: string[] = [];
  if (reading.text !== 'Todas las prioridades') {
    problems.push(`noticias@${width}: el selector «Prioridad» muestra «${reading.text}»`);
  }
  if (reading.width < reading.needed) {
    problems.push(
      `noticias@${width}: el selector «Prioridad» mide ${reading.width} px y su texto necesita ${reading.needed} px`,
    );
  }
  if (!reading.inside || reading.overflow > 0) {
    problems.push(`noticias@${width}: el selector «Prioridad» desborda la barra de filtros`);
  }
  return problems;
}

type Rect = { x: number; y: number; width: number; height: number };

/** Píxeles de solape entre el globo y el ancla en cada eje (0 si no se tocan). */
function overlapOf(a: Rect, b: Rect): number {
  const x = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const y = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return x > TOLERANCE && y > TOLERANCE ? Math.round(Math.min(x, y)) : 0;
}

let context: PhaseApp | undefined;

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

for (const viewport of VIEWPORTS) {
  test(`las 15 secciones respiran a ${viewport.width}×${viewport.height}: sin desbordamiento, sin solapes y ≥ ${GAP_MIN} px entre bloques`, async () => {
    test.setTimeout(240_000);
    context = await launchPhaseApp('tradia-layout-e2e');
    const { page } = context;
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.emulateMedia({ colorScheme: 'light' });
    await expectBrand(page, page.locator('aside.side'));
    // Con un activo en seguimiento, Mercado muestra lista, gráfico y tabla (UX-08).
    await watchTickers(page, ['SPY']);

    const failures: string[] = [];
    for (const { route, link, heading } of ROUTES) {
      await openPage(page, link, heading);
      await waitForSettled(page, route);
      const reading = await readLayout(page);
      await capture(page, `${route}-${viewport.width}`);

      if (reading.overflow > 0) {
        failures.push(`${route}@${viewport.width}: main se desborda ${reading.overflow} px`);
      }
      if (reading.firstBlockLeft === null) {
        failures.push(`${route}@${viewport.width}: no hay ningún bloque visible en .app-page`);
      } else {
        const inline = reading.firstBlockLeft - reading.mainLeft;
        if (Math.abs(inline - viewport.inline) > TOLERANCE) {
          failures.push(
            `${route}@${viewport.width}: margen de página ${inline} px, esperado ${viewport.inline} px`,
          );
        }
      }
      expect(
        reading.groups.length,
        `${route}@${viewport.width}: sin bloques medibles`,
      ).toBeGreaterThan(0);
      const problems = auditGroups(reading.groups);
      if (problems.length) failures.push(formatProblems(route, viewport.width, problems));
      if (route === 'inicio') failures.push(...(await readStatusBar(page, viewport.width)));
      if (route === 'noticias') failures.push(...(await readPriorityFilter(page, viewport.width)));
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`la marca Tradia se ve en «Antes de empezar» y en la barra lateral (tema ${colorScheme === 'light' ? 'claro' : 'oscuro'})`, async () => {
    context = await launchPhaseApp('tradia-brand-e2e', { onboarding: 'manual' });
    const { page } = context;
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme });
    await expect(page.getByRole('heading', { name: 'Antes de empezar' })).toBeVisible({
      timeout: 30_000,
    });
    await expectBrand(page, page.locator('[data-layout-page="aviso-riesgo"]'));
    mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({
      path: resolve(evidenceDir, `marca-antes-de-empezar-${colorScheme}.png`),
    });

    await page.getByLabel('He leído y acepto').check();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
    const tour = tourDialog(page);
    await expect(tour).toBeVisible({ timeout: 15_000 });
    await tour.getByRole('button', { name: 'Saltar tour', exact: true }).click();
    await expect(tour).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible({
      timeout: 30_000,
    });
    await expectBrand(page, page.locator('aside.side'));
    await page.screenshot({ path: resolve(evidenceDir, `marca-barra-lateral-${colorScheme}.png`) });
  });
}

/**
 * UXE-01 y UXE-02: el foco enmarca un elemento acotado (≤ 400 px de alto) y
 * el globo, ya quieto, no se solapa con el ancla.
 */
async function readTourFocus(
  page: Page,
  step: number,
  anchor: string,
  width: number,
): Promise<string[]> {
  const target = page.locator(`[data-tour="${anchor}"]`).first();
  const dialog = tourDialog(page);
  let last = '';
  await expect
    .poll(
      async () => {
        const first = [await target.boundingBox(), await dialog.boundingBox()];
        await page.waitForTimeout(150);
        const box = await target.boundingBox();
        const globe = await dialog.boundingBox();
        const spot = await page.locator('.tour-spotlight').boundingBox();
        if (!box || !globe || !spot) return 'sin medir';
        const still = JSON.stringify(first) === JSON.stringify([box, globe]);
        last = `ancla ${Math.round(box.height)} px, foco ${Math.round(spot.height)} px, solape ${overlapOf(globe, box)} px`;
        return still && overlapOf(globe, box) === 0 ? 'ok' : last;
      },
      { timeout: 8_000 },
    )
    .toBe('ok')
    .catch(() => undefined);
  const problems: string[] = [];
  const box = await target.boundingBox();
  const globe = await dialog.boundingBox();
  const spot = await page.locator('.tour-spotlight').boundingBox();
  if (!box || !globe || !spot) return [`paso ${step}@${width}: no se pudo medir el foco`];
  if (anchor === 'dinero-real-lista' && spot.height > 400) {
    problems.push(`paso ${step}@${width}: el foco mide ${Math.round(spot.height)} px de alto`);
  }
  const overlap = overlapOf(globe, box);
  if (overlap) {
    problems.push(`paso ${step}@${width}: el globo tapa el ancla ${anchor} (${last})`);
  }
  return problems;
}

test('el tour ilumina el ancla data-tour de cada paso, también en Mercado, IA y Dinero real', async () => {
  test.setTimeout(240_000);
  context = await launchPhaseApp('tradia-tour-layout-e2e', { onboarding: 'manual' });
  const { page } = context;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.getByRole('heading', { name: 'Antes de empezar' })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByLabel('He leído y acepto').check();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  const dialog = tourDialog(page);
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Empezar', exact: true }).click();

  const failures: string[] = [];
  for (let step = 2; step <= TOUR_TOTAL_STEPS; step++) {
    const data = TOUR_STEPS[step - 1]!;
    await expect(dialog).toHaveAccessibleName(`Paso ${step} de ${TOUR_TOTAL_STEPS}. ${data.title}`);
    if (data.route) {
      await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#${data.route}`);
    }
    await expect(dialog).toHaveAttribute('aria-busy', 'false', { timeout: 5_000 });
    // La superficie del tour: 24 px de relleno y dentro de la ventana.
    const padding = await dialog.evaluate((element) => getComputedStyle(element).paddingTop);
    const box = await dialog.boundingBox();
    if (padding !== '24px') failures.push(`paso ${step}: relleno del globo ${padding}`);
    if (!box || box.x < 0 || box.y < 0 || box.x + box.width > 1280 || box.y + box.height > 800) {
      failures.push(`paso ${step}: el globo se sale de la ventana (${JSON.stringify(box)})`);
    }
    if (data.anchor) {
      const anchor = page.locator(`[data-tour="${data.anchor}"]`).first();
      await expect(anchor).toBeVisible({ timeout: 15_000 });
      // El respaldo puede verse un instante; el foco debe acabar en el ancla.
      await expect
        .poll(
          async () => {
            const target = await anchor.boundingBox();
            const spot = await page.locator('.tour-spotlight').boundingBox();
            if (!target || !spot) return 'sin foco';
            const slack = 8 + TOLERANCE;
            const fits =
              spot.x >= Math.max(0, target.x - slack) - TOLERANCE &&
              spot.y >= Math.max(0, target.y - slack) - TOLERANCE &&
              spot.width <= target.width + 2 * slack &&
              spot.height <= target.height + 2 * slack;
            return fits ? 'ancla' : `respaldo ${Math.round(spot.width)}×${Math.round(spot.height)}`;
          },
          { timeout: 5_000 },
        )
        .toBe('ancla');
    }
    if (data.anchor === 'dinero-real-lista' || data.anchor === 'ia-regimen') {
      failures.push(...(await readTourFocus(page, step, data.anchor, 1280)));
    }
    mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({ path: resolve(evidenceDir, `tour-paso-${step}.png`) });
    if (data.anchor === 'ia-regimen') {
      // UXE-02 también a 1024 × 700: se vuelve a entrar en el paso para que
      // el tour desplace y coloque el globo con la ventana pequeña.
      await page.setViewportSize({ width: 1024, height: 700 });
      await dialog.getByRole('button', { name: 'Atrás', exact: true }).click();
      await expect(dialog).toHaveAccessibleName(new RegExp(`^Paso ${step - 1} de`));
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await expect(dialog).toHaveAccessibleName(new RegExp(`^Paso ${step} de`));
      await expect(dialog).toHaveAttribute('aria-busy', 'false', { timeout: 5_000 });
      failures.push(...(await readTourFocus(page, step, data.anchor, 1024)));
      await page.screenshot({ path: resolve(evidenceDir, `tour-paso-${step}-1024.png`) });
      await page.setViewportSize({ width: 1280, height: 800 });
    }
    if (step < TOUR_TOTAL_STEPS) {
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
    }
  }
  expect(failures, failures.join('\n')).toEqual([]);
  await dialog.getByRole('button', { name: 'Terminar', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 5_000 });
});

interface NavReading {
  overflow: number;
  hint: boolean;
  hintOpacity: number;
  hidden: string[];
}

/** Entradas del menú lateral que no se ven enteras dentro de la lista, e indicio. */
function readNav(page: Page): Promise<NavReading> {
  return page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('nav[aria-label="Principal"]')!;
    const side = nav.closest<HTMLElement>('aside.side')!;
    const box = nav.getBoundingClientRect();
    const hidden = Array.from(nav.querySelectorAll('a'))
      .filter((link) => {
        const item = link.getBoundingClientRect();
        return item.top < box.top - 1 || item.bottom > box.bottom + 1;
      })
      .map((link) => link.textContent ?? '');
    return {
      overflow: nav.scrollHeight - nav.clientHeight,
      hint: side.hasAttribute('data-more-below'),
      hintOpacity: Number(getComputedStyle(side, '::after').opacity),
      hidden,
    };
  });
}

test('el menú lateral: 15 entradas a la vista a 1280×800 y, a 1024×700, desplazamiento con indicio, rueda y Tab', async () => {
  context = await launchPhaseApp('tradia-nav-e2e');
  const { page } = context;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible({
    timeout: 30_000,
  });
  const nav = page.getByRole('navigation', { name: 'Principal' });
  await expect(nav.getByRole('link')).toHaveCount(ROUTES.length);

  // 1280 × 800: todas a la vista, sin desplazar y sin indicio.
  await expect.poll(() => readNav(page)).toMatchObject({ overflow: 0, hint: false, hidden: [] });
  for (const { link } of ROUTES) {
    await expect(nav.getByRole('link', { name: link, exact: true })).toBeInViewport({ ratio: 1 });
  }
  mkdirSync(evidenceDir, { recursive: true });
  await page.screenshot({ path: resolve(evidenceDir, 'barra-lateral-1280.png') });

  // 1024 × 700: la lista desplaza dentro de la barra y avisa de que hay más.
  await page.setViewportSize({ width: 1024, height: 700 });
  await expect.poll(async () => (await readNav(page)).hint).toBe(true);
  const narrow = await readNav(page);
  expect(narrow.overflow).toBeGreaterThan(0);
  expect(narrow.hidden).toContain('Ajustes');
  await expect.poll(async () => (await readNav(page)).hintOpacity).toBe(1);
  // La marca no se desplaza con la lista.
  await expect(page.locator('aside.side').getByRole('img', { name: 'Tradia' })).toBeInViewport({
    ratio: 1,
  });
  await page.screenshot({ path: resolve(evidenceDir, 'barra-lateral-1024-indicio.png') });

  // Con rueda: al llegar al final, «Ajustes» se ve y el indicio desaparece.
  await nav.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(async () => (await readNav(page)).hint).toBe(false);
  expect((await readNav(page)).hidden).not.toContain('Ajustes');
  await expect.poll(async () => (await readNav(page)).hintOpacity).toBe(0);
  await expect(nav.getByRole('link', { name: 'Ajustes', exact: true })).toBeInViewport({
    ratio: 1,
  });
  await page.screenshot({ path: resolve(evidenceDir, 'barra-lateral-1024-final.png') });

  // Con Tab: desde «Inicio», arriba del todo, hasta «Ajustes».
  await nav.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect.poll(async () => (await readNav(page)).hint).toBe(true);
  await nav.getByRole('link', { name: 'Inicio', exact: true }).focus();
  for (let index = 1; index < ROUTES.length; index++) {
    await page.keyboard.press('Tab');
    const { link } = ROUTES[index]!;
    const focused = nav.getByRole('link', { name: link, exact: true });
    await expect(focused).toBeFocused();
    // Cada entrada enfocada queda entera dentro de la lista visible.
    await expect.poll(async () => (await readNav(page)).hidden).not.toContain(link);
  }
  await expect.poll(async () => (await readNav(page)).hint).toBe(false);
});

interface TargetReading {
  name: string;
  width: number;
  height: number;
  /** El punto a 1 px de cada borde vertical cae dentro del propio control. */
  hitEdges: boolean;
  /** Casilla visible, si el objetivo es una etiqueta con casilla. */
  box: { width: number; height: number } | null;
}

/** Mide el área clicable de los controles que casan con `selector` en `main`. */
async function readTargets(page: Page, selector: string): Promise<TargetReading[]> {
  const targets = page.locator(`main#contenido ${selector}`);
  const count = await targets.count();
  const readings: TargetReading[] = [];
  for (let index = 0; index < count; index++) {
    const target = targets.nth(index);
    if (!(await target.isVisible())) continue;
    await target.scrollIntoViewIfNeeded();
    readings.push(
      await target.evaluate((element) => {
        // Un enlace en línea puede partirse en varias líneas: se mide el primer fragmento.
        const rect = element.getClientRects()[0] ?? element.getBoundingClientRect();
        const x = rect.left + Math.min(rect.width / 2, 8);
        const hits = [rect.top + 1, rect.bottom - 1].map((y) => {
          const hit = document.elementFromPoint(x, y);
          return Boolean(hit && (hit === element || element.contains(hit)));
        });
        const input = element.querySelector('input[type="checkbox"], input[type="radio"]');
        const inputRect = input?.getBoundingClientRect();
        return {
          name: `${element.tagName.toLowerCase()} «${(element.textContent ?? element.getAttribute('aria-label') ?? '').trim().slice(0, 40)}»`,
          width: rect.width,
          height: rect.height,
          hitEdges: hits.every(Boolean),
          box:
            inputRect && getComputedStyle(input!).opacity !== '0'
              ? { width: inputRect.width, height: inputRect.height }
              : null,
        };
      }),
    );
  }
  return readings;
}

function auditTargets(
  where: string,
  readings: TargetReading[],
  minHeight: number,
  minWidth = 24,
): string[] {
  const problems: string[] = [];
  for (const reading of readings) {
    const size = `${Math.round(reading.width)}×${Math.round(reading.height)} px`;
    if (reading.height < minHeight - TOLERANCE || reading.width < minWidth - TOLERANCE) {
      problems.push(`${where}: ${reading.name} mide ${size}, mínimo ${minWidth}×${minHeight}`);
    }
    if (!reading.hitEdges) {
      problems.push(`${where}: ${reading.name} no recibe el clic en todo su alto (${size})`);
    }
    if (
      reading.box &&
      (reading.box.width < 20 - TOLERANCE || reading.box.height < 20 - TOLERANCE)
    ) {
      problems.push(
        `${where}: la casilla de ${reading.name} mide ${reading.box.width}×${reading.box.height} px`,
      );
    }
  }
  return problems;
}

test('casillas, selectores y enlaces en línea alcanzan el área mínima de control', async () => {
  test.setTimeout(120_000);
  context = await launchPhaseApp('tradia-controls-e2e');
  const { page } = context;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible({
    timeout: 30_000,
  });
  const failures: string[] = [];
  const CONTROL_MIN = 44;
  const INLINE_MIN = 24;
  const checkbox = 'label:has(> input[type="checkbox"])';
  const inlineLink = 'a:not([class])';

  await openPage(page, 'Fuentes');
  await waitForSettled(page, 'fuentes');
  const sources = await readTargets(page, `.source-active`);
  expect(sources.length, 'Fuentes: sin casillas «Activa»').toBeGreaterThan(0);
  failures.push(...auditTargets('Fuentes', sources, CONTROL_MIN));

  await openPage(page, 'Dinero real');
  await waitForSettled(page, 'dinero-real');
  const declarations = await readTargets(page, checkbox);
  expect(declarations.length, 'Dinero real: sin casillas de declaración').toBeGreaterThan(0);
  failures.push(...auditTargets('Dinero real', declarations, CONTROL_MIN));
  await page.screenshot({ path: resolve(evidenceDir, 'controles-dinero-real.png') });

  await openPage(page, 'Ajustes');
  await waitForSettled(page, 'ajustes');
  const selects = await readTargets(page, 'select');
  expect(selects.length, 'Ajustes: sin selectores').toBeGreaterThan(0);
  failures.push(...auditTargets('Ajustes', selects, CONTROL_MIN));
  await expect(page.locator('#news-alert-lead')).toBeVisible();
  failures.push(...auditTargets('Ajustes', await readTargets(page, checkbox), CONTROL_MIN));

  const links: TargetReading[] = [];
  for (const [link, heading, route] of [
    ['Ajustes', 'Ajustes', 'ajustes'],
    ['Calendario', 'Calendario', 'calendario'],
    ['Órdenes', 'Órdenes', 'ordenes'],
  ] as const) {
    if (route !== 'ajustes') {
      await openPage(page, link, heading);
      await waitForSettled(page, route);
    }
    const found = await readTargets(page, inlineLink);
    failures.push(...auditTargets(heading, found, INLINE_MIN));
    links.push(...found);
  }
  for (const name of ['Ajustes', 'Revisar cuenta paper', 'lista de comprobación']) {
    expect(
      links.some((link) => link.name.includes(`«${name}`)),
      `no se midió el enlace en línea «${name}»`,
    ).toBe(true);
  }
  expect(failures, failures.join('\n')).toEqual([]);
});
