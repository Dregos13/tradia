import { expect, test } from '@playwright/test';
import base from '../src/renderer/src/design/base.tokens.json';
import { closePhaseApp, launchPhaseApp } from './phase-6-7.helpers';

const rgb = (hex: string) =>
  `rgb(${[1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;

for (const colorScheme of ['light', 'dark'] as const) {
  test(`la navegación conserva foco visible con Tab en tema ${colorScheme}`, async () => {
    const context = await launchPhaseApp('tradia-legibility-');
    try {
      const { page } = context;
      await page.emulateMedia({ colorScheme });
      const fonts = await page.evaluate(async () => {
        for (const descriptor of [
          '400 14px Sora',
          '600 14px Sora',
          '400 14px "IBM Plex Mono"',
          '500 14px "IBM Plex Mono"',
          '600 14px "IBM Plex Mono"',
        ]) {
          await document.fonts.load(descriptor);
        }
        await document.fonts.ready;
        return {
          loaded: [...document.fonts]
            .filter((face) => face.status === 'loaded')
            .map((face) => face.family),
          // Electron no publica Resource Timing para file://. Las reglas CSS
          // conservan el origen real; document.fonts confirma la carga arriba.
          urls: [...document.styleSheets].flatMap((sheet) =>
            [...sheet.cssRules]
              .filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule)
              .map((rule) => {
                const source = rule.style
                  .getPropertyValue('src')
                  .match(/url\(["']?([^"')]+)["']?\)/)?.[1];
                return new URL(source!, sheet.href ?? document.baseURI).href;
              }),
          ),
          interface: getComputedStyle(document.body).fontFamily,
        };
      });
      expect(fonts.loaded).toContain('Sora');
      expect(fonts.loaded).toContain('IBM Plex Mono');
      expect(fonts.interface).toMatch(/^Sora,/);
      expect(fonts.urls).toHaveLength(4);
      for (const url of fonts.urls) {
        expect(new URL(url).protocol).toBe(new URL(page.url()).protocol);
        expect(new URL(url).origin).toBe(new URL(page.url()).origin);
      }
      for (const width of [1280, 760, 640]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await page.locator('html').evaluate((node) => getComputedStyle(node).fontSize)).toBe(
          '16px',
        );
        const skip = page.getByRole('link', { name: 'Saltar al contenido' });
        await page.evaluate(() => {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        });
        await page.keyboard.press('Tab');
        // Chromium retains sequential navigation's start point after blur.
        // Reset through the stable first link, then exercise actual Tab traversal.
        await skip.focus();
        const links = page.getByRole('navigation', { name: 'Principal' }).getByRole('link');
        for (let index = 0; index < (await links.count()); index++) {
          await page.keyboard.press('Tab');
          const link = links.nth(index);
          await expect(link).toBeFocused();
          expect(
            await link.evaluate((node) => {
              const style = getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              const side = node.closest('.side')!;
              return {
                visible: node.matches(':focus-visible'),
                width: style.outlineWidth,
                offset: style.outlineOffset,
                style: style.outlineStyle,
                color: style.outlineColor,
                expectedColor: getComputedStyle(side).color,
                controlHeight: rect.height >= 44,
                controlWidth: rect.width >= 44,
                insideWindow:
                  rect.right > 0 &&
                  rect.left < innerWidth &&
                  rect.top >= 0 &&
                  rect.bottom <= innerHeight,
              };
            }),
          ).toMatchObject({
            visible: true,
            width: base.focus.width,
            offset: base.focus.offset,
            style: base.focus.style,
            color: rgb(base.color[colorScheme].focus.value),
            expectedColor: rgb(base.color[colorScheme].sidebarText.value),
            controlHeight: true,
            controlWidth: true,
            insideWindow: true,
          });
        }
      }
    } finally {
      await closePhaseApp(context);
    }
  });
}
