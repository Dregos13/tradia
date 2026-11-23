import { describe, expect, it } from 'vitest';
import strategy from './design/strategy.tokens.json';
import risk from './design/risk.tokens.json';
import broker from './design/broker.tokens.json';
import live from './design/live.tokens.json';
import base from './design/base.tokens.json';

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
  };
  const values = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
}

type ColorToken = Record<string, unknown>;
/** Descubre cada estado desde el árbol real, incluidos estados que se añadan después. */
function leaves(node: ColorToken, path = ''): [string, ColorToken][] {
  if (typeof node.light === 'string' && typeof node.dark === 'string') return [[path, node]];
  return Object.entries(node).flatMap(([key, value]) =>
    value && typeof value === 'object' ? leaves(value as ColorToken, `${path}.${key}`) : [],
  );
}

for (const mode of ['light', 'dark'] as const) {
  describe(`Identidad de dominio · ${mode}`, () => {
    const palette = base.color[mode];
    for (const [domain, tokens] of Object.entries({ strategy, risk, broker, live })) {
      for (const [path, token] of leaves(tokens.color)) {
        const foreground = token[mode] as string;
        const background = token[`${mode}Surface`];
        if (typeof background !== 'string') continue;
        it(`${domain}${path}: texto y borde del estado sobre su superficie`, () => {
          expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(palette.text.value, background)).toBeGreaterThanOrEqual(4.5);
          // Los mismos estados aparecen como texto de errores sin relleno.
          for (const surface of [palette.canvas, palette.surface, palette.surfaceSubtle]) {
            expect(contrast(foreground, surface.value)).toBeGreaterThanOrEqual(4.5);
          }
        });
      }
    }
    for (const [name, token] of Object.entries(strategy.color.chart)) {
      // La rejilla es decorativa; las curvas y las fases contienen información.
      if (name === 'grid') continue;
      for (const surface of ['canvas', 'surface', 'surfaceSubtle'] as const) {
        it(`gráfico ${name} / ${surface}`, () => {
          expect(contrast(token[mode], palette[surface].value)).toBeGreaterThanOrEqual(3);
        });
      }
    }
    for (const [name, token] of Object.entries(strategy.color.heatmap)) {
      if (name === 'selected') continue;
      it(`mapa de calor ${name}: cifras y selección`, () => {
        expect(contrast(palette.text.value, token[mode])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(strategy.color.heatmap.selected[mode], token[mode])).toBeGreaterThanOrEqual(
          3,
        );
      });
    }
    it('dinero real: franja, hover, foco y aviso conservan contraste', () => {
      const colors = live.color.live;
      for (const background of [colors.banner[mode], colors.bannerHover[mode]]) {
        expect(contrast(colors.banner[`${mode}Text`], background)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(colors.text[mode], colors.surface[mode])).toBeGreaterThanOrEqual(4.5);
    });
  });
}
