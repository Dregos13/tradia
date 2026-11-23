import { describe, expect, it } from 'vitest';
import base from './design/base.tokens.json';
import market from './design/market.tokens.json';
import dashboard from './design/dashboard.tokens.json';

function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => {
      const c = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high! + 0.05) / (low! + 0.05);
}

type Node = Record<string, unknown>;
function colorLeaves(node: Node, path = ''): [string, Node][] {
  if (typeof node.light === 'string' && typeof node.dark === 'string') return [[path, node]];
  return Object.entries(node).flatMap(([key, value]) =>
    value && typeof value === 'object' ? colorLeaves(value as Node, `${path}.${key}`) : [],
  );
}

for (const mode of ['light', 'dark'] as const) {
  describe(`Contraste de Inicio y Mercado · ${mode}`, () => {
    // Se descubren estados, curvas y superficies desde los árboles de tokens;
    // cualquier estado o serie nuevos quedan cubiertos sin mantener una lista de pares.
    const surfaces = Object.entries(base.color[mode]).filter(
      ([name]) => name === 'canvas' || name.startsWith('surface'),
    );
    for (const [domain, tokens] of Object.entries({ market, dashboard })) {
      for (const [path, token] of colorLeaves(tokens.color)) {
        const foreground = token[mode] as string;
        if (!foreground.startsWith('#')) continue; // El velo de diálogo no contiene información.
        if (path.endsWith('.grid')) continue; // Retícula decorativa, nunca una serie de datos.
        const stateSurface = token[`${mode}Surface`];
        for (const [name, surface] of surfaces) {
          it(`${domain}${path} / ${name}: gráfico ≥ 3:1`, () => {
            expect(contrast(foreground, surface.value)).toBeGreaterThanOrEqual(3);
          });
          // SMA, RSI, ATR, variación y estados también se usan como etiquetas de texto.
          // surfaceStrong se usa en el distintivo ETF con textMuted (cubierto
          // por contrast.test), nunca detrás de estas etiquetas de dominio.
          // Las mechas sólo se dibujan: no son un color de texto.
          if (
            name !== 'surfaceStrong' &&
            !path.endsWith('.wick') &&
            (domain === 'market' || typeof stateSurface === 'string')
          ) {
            it(`${domain}${path} / ${name}: etiqueta ≥ 4,5:1`, () => {
              expect(contrast(foreground, surface.value)).toBeGreaterThanOrEqual(4.5);
            });
          }
        }
        if (typeof stateSurface === 'string') {
          it(`${domain}${path}: etiqueta y cuerpo / superficie de estado ≥ 4,5:1`, () => {
            expect(contrast(foreground, stateSurface)).toBeGreaterThanOrEqual(4.5);
            expect(contrast(base.color[mode].text.value, stateSurface)).toBeGreaterThanOrEqual(4.5);
          });
        }
      }
    }
  });
}
