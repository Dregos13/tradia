import { expect, test } from '@playwright/test';
import { closePhaseApp, launchPhaseApp } from './phase-6-7.helpers';

for (const colorScheme of ['light', 'dark'] as const) {
  test(`la navegación conserva foco visible con Tab en tema ${colorScheme}`, async () => {
    const context = await launchPhaseApp('tradia-legibility-');
    try {
      const { page } = context;
      await page.emulateMedia({ colorScheme });
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
            width: '3px',
            offset: '2px',
            style: 'solid',
            color: colorScheme === 'light' ? 'rgb(245, 243, 237)' : 'rgb(244, 245, 247)',
            expectedColor: colorScheme === 'light' ? 'rgb(245, 243, 237)' : 'rgb(244, 245, 247)',
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
