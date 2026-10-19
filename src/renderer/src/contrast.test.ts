import { describe, expect, it } from 'vitest';
import base from './design/base.tokens.json';

/** WCAG 2.2: sRGB channels must be linearized before relative luminance. */
function contrast(foreground: string, background: string): number {
  const luminance = (hex: string): number => {
    const linear = [1, 3, 5].map((offset) => {
      const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
  };
  const a = luminance(foreground);
  const b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

it('calcula luminancia lineal, es simétrico y no redondea un fallo al umbral AA', () => {
  expect(contrast('#000000', '#FFFFFF')).toBe(21);
  expect(contrast('#FFFFFF', '#FFFFFF')).toBe(1);
  expect(contrast('#777777', '#FFFFFF')).toBeCloseTo(4.478, 3);
  expect(contrast('#777777', '#FFFFFF')).toBeLessThan(4.5);
  expect(contrast('#FFFFFF', '#777777')).toBe(contrast('#777777', '#FFFFFF'));
});

const surfaces = ['canvas', 'surface', 'surfaceSubtle', 'surfaceStrong', 'accentSoft'] as const;

for (const mode of ['light', 'dark'] as const) {
  describe(`Contraste AA de la base: ${mode}`, () => {
    const palette: Record<string, { value: string }> = base.color[mode];
    const assertPair = (foreground: string, background: string, minimum: number) => {
      const ratio = contrast(palette[foreground]!.value, palette[background]!.value);
      expect(ratio, `${foreground} / ${background}: ${ratio.toFixed(3)}:1`).toBeGreaterThanOrEqual(
        minimum,
      );
    };

    for (const pair of base.contrastPairs) {
      it(`${pair.text} / ${pair.background} ≥ 4,5:1 (par del contrato)`, () => {
        assertPair(pair.text, pair.background, 4.5);
      });
    }

    for (const background of surfaces) {
      for (const foreground of ['text', 'textMuted', 'textFaint', 'accent'] as const) {
        it(`${foreground} / ${background} ≥ 4,5:1`, () => {
          assertPair(foreground, background, 4.5);
        });
      }
      for (const foreground of ['focus', 'borderStrong'] as const) {
        it(`${foreground} / ${background} ≥ 3:1`, () => {
          assertPair(foreground, background, 3);
        });
      }
    }

    for (const foreground of ['sidebarText', 'textMuted', 'accent'] as const) {
      it(`navegación y símbolo: ${foreground} / sidebar ≥ 4,5:1`, () => {
        assertPair(foreground, 'sidebar', 4.5);
      });
    }
    it('foco de navegación / sidebar ≥ 3:1', () => {
      assertPair('focus', 'sidebar', 3);
    });
    it('selección de navegación: texto y filete / surface ≥ 4,5:1', () => {
      assertPair('sidebarText', 'surface', 4.5);
    });

    for (const [name, token] of Object.entries(base.color.state)) {
      it(`${name}: etiqueta y cuerpo / fondo ≥ 4,5:1`, () => {
        const foreground = token[mode];
        const background = token[`${mode}Surface`];
        expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(base.color[mode].text.value, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrast(foreground, base.color[mode].surface.value)).toBeGreaterThanOrEqual(4.5);
      });
    }
  });
}
