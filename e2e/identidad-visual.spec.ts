import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closePhaseApp, launchPhaseApp, openPage, type PhaseApp } from './phase-6-7.helpers';

/**
 * E2E de la identidad visual «Telemetría de box»: el logo nuevo en la barra
 * lateral, las familias Sora e IBM Plex Mono cargadas desde la propia app,
 * ninguna petición a dominios externos para fuentes y el contraste calculado
 * con getComputedStyle en títulos, texto secundario, botones y foco de seis
 * pantallas, en tema claro y oscuro. Las capturas «después» van a
 * docs/qa/capturas/identidad/.
 */

const evidenceDir = resolve('docs/qa/capturas/identidad');
const THEMES = ['light', 'dark'] as const;
const THEME_NAME = { light: 'claro', dark: 'oscuro' } as const;
const SCREENS = [
  { link: 'Inicio', heading: 'Estado del sistema', slug: 'inicio' },
  { link: 'Mercado', heading: 'Mercado', slug: 'mercado' },
  { link: 'Estrategias', heading: 'Estrategias', slug: 'estrategias' },
  { link: 'Riesgo', heading: 'Riesgo', slug: 'riesgo' },
  { link: 'Noticias', heading: 'Noticias', slug: 'noticias' },
  { link: 'Ajustes', heading: 'Ajustes', slug: 'ajustes' },
] as const;

const TEXT_MIN = 4.5;
const UI_MIN = 3;

interface Sample {
  label: string;
  ratio: number;
  fg: string;
  bg: string;
}

/** Contraste WCAG calculado en la página con los estilos resueltos. */
async function measureContrast(page: Page): Promise<{
  heading: Sample;
  secondary: Sample[];
  buttons: Sample[];
  focus: Sample;
}> {
  return page.evaluate(() => {
    type Rgba = [number, number, number, number];
    const parse = (value: string): Rgba => {
      const m = value.match(/[\d.]+/g)!.map(Number);
      return [m[0]!, m[1]!, m[2]!, m[3] ?? 1];
    };
    const over = (top: Rgba, base: Rgba): Rgba => {
      const a = top[3] + base[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const mix = (i: number) => (top[i]! * top[3] + base[i]! * base[3] * (1 - top[3])) / a;
      return [mix(0), mix(1), mix(2), a];
    };
    const background = (node: Element): Rgba => {
      const chain: Rgba[] = [];
      for (let el: Element | null = node; el; el = el.parentElement) {
        chain.push(parse(getComputedStyle(el).backgroundColor));
      }
      return chain.reduceRight<Rgba>((acc, layer) => over(layer, acc), [255, 255, 255, 1]);
    };
    const lum = ([r, g, b]: Rgba) => {
      const f = (c: number) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a: Rgba, b: Rgba) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const hex = (c: Rgba) => `rgb(${c.slice(0, 3).map(Math.round).join(',')})`;
    const sample = (label: string, fg: Rgba, bg: Rgba): Sample => {
      const flat = over(fg, bg);
      return { label, ratio: ratio(flat, bg), fg: hex(flat), bg: hex(bg) };
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const main = document.querySelector('main')!;
    const h1 = document.querySelector('h1')!;
    const mutedColor = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-textMuted')
      .trim();
    const probe = document.createElement('span');
    probe.style.color = mutedColor;
    document.body.append(probe);
    const mutedRgb = getComputedStyle(probe).color;
    probe.remove();
    const secondary = [...main.querySelectorAll('p, span, small, li, dd, td, label')]
      .filter(
        (el) =>
          visible(el) &&
          el.childElementCount === 0 &&
          (el.textContent ?? '').trim().length > 0 &&
          getComputedStyle(el).color === mutedRgb,
      )
      .slice(0, 12)
      .map((el) =>
        sample(
          (el.textContent ?? '').trim().slice(0, 40),
          parse(getComputedStyle(el).color),
          background(el),
        ),
      );
    const buttons = [...main.querySelectorAll('button, a[class*="button"], a[class*="primary"]')]
      .filter((el) => visible(el) && !(el as HTMLButtonElement).disabled)
      .slice(0, 8)
      .map((el) => {
        const style = getComputedStyle(el);
        return sample(
          (el.textContent ?? '').trim().slice(0, 40) || el.getAttribute('aria-label') || 'botón',
          parse(style.color),
          background(el),
        );
      });
    const first = main.querySelector('button:not(:disabled), a[href], input, select')!;
    (first as HTMLElement).focus();
    const fs = getComputedStyle(first);
    const parent = first.parentElement!;
    const focus = sample(
      `foco ${first.tagName.toLowerCase()} ${fs.outlineWidth} ${fs.outlineStyle}`,
      parse(fs.outlineColor),
      background(parent),
    );
    return {
      heading: sample('h1', parse(getComputedStyle(h1).color), background(h1)),
      secondary,
      buttons,
      focus,
    };
  });
}

for (const colorScheme of THEMES) {
  test.describe(`identidad visual · tema ${THEME_NAME[colorScheme]}`, () => {
    test.describe.configure({ mode: 'serial' });
    let context: PhaseApp | undefined;
    const external: string[] = [];

    test.beforeAll(async () => {
      mkdirSync(evidenceDir, { recursive: true });
      context = await launchPhaseApp('tradia-identidad-', { onboarding: 'manual' });
      context.page.on('request', (request) => {
        const { protocol, hostname } = new URL(request.url());
        if (
          (protocol === 'http:' || protocol === 'https:') &&
          !['127.0.0.1', 'localhost'].includes(hostname)
        ) {
          external.push(request.url());
        }
      });
      await context.page.emulateMedia({ colorScheme });
    });

    test.afterAll(async () => {
      await closePhaseApp(context);
    });

    test('aviso de riesgo inicial con la marca nueva', async () => {
      const { page } = context!;
      await expect(page.getByRole('heading', { name: 'Antes de empezar' })).toBeVisible({
        timeout: 30_000,
      });
      await page.screenshot({
        path: resolve(evidenceDir, `despues-aviso-${THEME_NAME[colorScheme]}.png`),
      });
      await page.getByLabel('He leído y acepto').check();
      await page.getByRole('button', { name: 'Continuar', exact: true }).click();
      const tour = page.getByRole('dialog', { name: /^Paso \d+ de 10\./ });
      await expect(tour).toBeVisible({ timeout: 15_000 });
      await tour.getByRole('button', { name: 'Saltar tour', exact: true }).click();
      await expect(tour).toHaveCount(0, { timeout: 5_000 });
      await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible();
    });

    test('logo nuevo en la barra lateral', async () => {
      const { page } = context!;
      const logo = page.locator('.side').getByRole('img', { name: 'Tradia' });
      await expect(logo).toBeVisible();
      const mark = logo.locator('img.brand-mark');
      await expect(mark).toBeVisible();
      const info = await mark.evaluate(async (node) => {
        const img = node as HTMLImageElement;
        await img.decode();
        return { natural: img.naturalWidth, src: img.src };
      });
      expect(info.natural).toBeGreaterThan(0);
      expect(info.src.startsWith('file:') || info.src.startsWith('data:')).toBe(true);
      // Electron no deja a fetch leer file://: el SVG servido se lee desde disco.
      const svg = info.src.startsWith('data:')
        ? decodeURIComponent(info.src.split(',')[1]!)
        : readFileSync(fileURLToPath(info.src), 'utf8');
      expect(svg).toContain('M4 14.8Q19 6.2 44 4.2Q35 8.6 26.6 11.6L24 43L21.4 12.4Q12 14 4 16.4Z');
      expect(svg).not.toContain('M4 12C9 12 11 9 16 9');
      await expect(logo.getByText('Tradia', { exact: true })).toBeVisible();
    });

    test('Sora e IBM Plex Mono cargadas y sin peticiones externas', async () => {
      const { page } = context!;
      const fonts = await page.evaluate(async () => {
        for (const d of ['400 14px Sora', '600 14px Sora', '400 14px "IBM Plex Mono"']) {
          await document.fonts.load(d);
        }
        await document.fonts.ready;
        return {
          loaded: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
          body: getComputedStyle(document.body).fontFamily,
        };
      });
      expect(fonts.loaded).toContain('Sora');
      expect(fonts.loaded).toContain('IBM Plex Mono');
      expect(fonts.body).toMatch(/^Sora,/);
      expect(external, `peticiones externas: ${external.join(', ')}`).toEqual([]);
    });

    for (const screen of SCREENS) {
      test(`contraste y foco en ${screen.link}`, async () => {
        const { page } = context!;
        await openPage(page, screen.link, screen.heading);
        // Tras un clic, focus() no activa :focus-visible; una tecla fija la modalidad de teclado.
        await page.keyboard.press('Shift');
        const measured = await measureContrast(page);
        await page.screenshot({
          path: resolve(evidenceDir, `despues-${screen.slug}-${THEME_NAME[colorScheme]}.png`),
        });
        const low = (items: Sample[], min: number) =>
          items.filter((s) => s.ratio < min).map((s) => `${s.label}: ${s.ratio.toFixed(2)}`);
        expect(low([measured.heading], TEXT_MIN), 'título').toEqual([]);
        expect(low(measured.secondary, TEXT_MIN), 'texto secundario').toEqual([]);
        expect(low(measured.buttons, TEXT_MIN), 'botones').toEqual([]);
        expect(low([measured.focus], UI_MIN), 'foco').toEqual([]);
        expect(measured.buttons.length, 'hay botones que medir').toBeGreaterThan(0);
      });
    }
  });
}
