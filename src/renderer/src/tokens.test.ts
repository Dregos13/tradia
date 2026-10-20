import { readFileSync } from 'node:fs';
import broker from './design/broker.tokens.json';
import clarity from './design/data-clarity.tokens.json';
import { describe, expect, it } from 'vitest';
import news from './design/news.tokens.json';
import base from './design/base.tokens.json';
import market from './design/market.tokens.json';
import risk from './design/risk.tokens.json';
const tokens = {
  ...base,
  size: { ...base.size, ...market.size, controlMin: base.size.controlMin },
  spacing: { ...base.spacing, ...market.spacing },
};
import { tokenStylesheet } from './tokens';

describe('Tokens aprobados', () => {
  it('publica las familias y los pesos exactos de la marca desde la base', () => {
    expect(base.meta.name).toBe('Tradia — Telemetría de box');
    expect(base.typography.family.interface.value).toMatch(/^Sora,/);
    expect(base.typography.family.editorial.value).toBe(base.typography.family.interface.value);
    expect(base.typography.family.numeric.value).toMatch(/^'IBM Plex Mono',/);
    expect(base.typography.weight).toEqual({ regular: 400, medium: 500, semibold: 600, bold: 700 });
    for (const [name, token] of Object.entries(base.typography.family))
      expect(tokenStylesheet()).toContain(`--font-${name}:${token.value};`);
    for (const [name, value] of Object.entries(base.typography.weight))
      expect(tokenStylesheet()).toContain(`--weight-${name}:${value};`);
  });

  it('incluye los cuatro woff2 con sus licencias y carga local con swap', () => {
    const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
    const faces = css.match(/@font-face\s*\{[^}]+\}/g) ?? [];
    expect(faces).toHaveLength(4);
    for (const face of faces) {
      expect(face).toContain('font-display: swap;');
      const path = face.match(/url\('(.+?)'\)/)?.[1];
      expect(path).toMatch(/^\.\/assets\/fonts\/.+\.woff2$/);
      const font = readFileSync(new URL(path!, import.meta.url));
      expect(font.subarray(0, 4).toString()).toBe('wOF2');
    }
    for (const file of ['OFL-Sora.txt', 'OFL-IBMPlexMono.txt']) {
      const license = readFileSync(new URL(`./assets/fonts/${file}`, import.meta.url), 'utf8');
      expect(license).toMatch(/SIL OPEN FONT LICENSE Version 1.1/i);
    }
  });

  it('usa el monograma Arco de una sola pieza y sin trazos', () => {
    const svg = readFileSync(new URL('./assets/brand/tradia-mark.svg', import.meta.url), 'utf8');
    expect(svg).toContain('viewBox="0 0 48 48"');
    expect(svg).toContain('fill="currentColor"');
    expect(svg).toContain('M4 14.8Q19 6.2 44 4.2Q35 8.6 26.6 11.6L24 43L21.4 12.4Q12 14 4 16.4Z');
    expect(svg.match(/<path\b/g)).toHaveLength(1);
    expect(svg).not.toMatch(/stroke[=\s-]|transform=/);
  });

  it('traduce ambos temas y los estados sin duplicar valores', () => {
    const css = tokenStylesheet();
    for (const mode of ['light', 'dark'] as const) {
      for (const [name, token] of Object.entries(tokens.color[mode]))
        expect(css).toContain(`--color-${name}:${token.value};`);
      for (const [name, token] of Object.entries(tokens.color.state))
        expect(css).toContain(`--state-${name}:${token[mode]};`);
    }
    for (const mode of ['light', 'dark'] as const) {
      for (const [name, token] of Object.entries(market.color.dataStatus)) {
        expect(css).toContain(`--dataStatus-${name}:${token[mode]};`);
        expect(css).toContain(`--dataStatus-${name}-surface:${token[`${mode}Surface`]};`);
      }
      for (const [name, token] of Object.entries(market.color.candle))
        expect(css).toContain(`--candle-${name}:${token[mode]};`);
      for (const [name, token] of Object.entries(market.color.series))
        expect(css).toContain(`--series-${name}:${token[mode]};`);
    }
    expect(css).toContain('@media(prefers-color-scheme:dark)');
    expect(css).toContain(`--size-controlMin:${tokens.size.controlMin};`);
    expect(css).toContain(`--size-readingMax:${tokens.size.readingMax};`);
  });

  it('traduce los alias semánticos de ritmo como variables --space-*', () => {
    const css = tokenStylesheet();
    const semanticSpacing = [
      'page-inline-wide',
      'page-inline-compact',
      'page-inline-narrow',
      'page-block-wide',
      'page-block-compact',
      'section-gap',
      'section-gap-compact',
      'block-gap-min',
      'card-padding',
      'card-padding-compact',
      'title-content-gap',
      'form-field-gap',
      'label-control-gap',
      'table-row-block',
    ] as const;

    for (const name of semanticSpacing)
      expect(css).toContain(`--space-${name}:${tokens.spacing[name]};`);
  });
});

it('traduce las insignias del feed en ambos temas', () => {
  const css = tokenStylesheet();
  for (const mode of ['light', 'dark'] as const)
    for (const group of [
      'reliability',
      'newsPriority',
      'confirmation',
      'impactLevel',
      'calendar',
    ] as const)
      for (const [name, token] of Object.entries(news.color[group])) {
        expect(css).toContain(`--${group}-${name}:${token[mode]};`);
        expect(css).toContain(`--${group}-${name}-surface:${token[`${mode}Surface`]};`);
      }
});

it('mantiene completos los tokens semánticos de riesgo en ambos temas', () => {
  expect(risk.meta.extends).toBe('./base.tokens.json');
  expect(risk.meta.contrastStandard).toBe('WCAG 2.2 AA');
  expect(risk.size.controlMin).toBe('44px');

  for (const group of ['riskStatus', 'decision'] as const)
    for (const token of Object.values(risk.color[group])) {
      expect(token.light).toMatch(/^#[0-9A-F]{6}$/);
      expect(token.lightSurface).toMatch(/^#[0-9A-F]{6}$/);
      expect(token.dark).toMatch(/^#[0-9A-F]{6}$/);
      expect(token.darkSurface).toMatch(/^#[0-9A-F]{6}$/);
      expect(token.label.length).toBeGreaterThan(0);
    }
});

it('traduce la insignia paper y el diálogo desde los tokens de broker', () => {
  const css = tokenStylesheet();
  for (const mode of ['light', 'dark'] as const) {
    expect(css).toContain(`--broker-paper:${broker.color.paper[mode]};`);
    expect(css).toContain(`--broker-paper-surface:${broker.color.paper[`${mode}Surface`]};`);
  }
  expect(css).toContain(`--broker-dialogMax:${broker.size.dialogMax};`);
  expect(css).toContain(`--broker-floating:${broker.shadow.floating.value};`);
});

/** WCAG 2.2: linearize sRGB before calculating relative luminance. */
function contrast(text: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  const values = [luminance(text), luminance(background)].sort((a, b) => a - b);
  return (values[1]! + 0.05) / (values[0]! + 0.05);
}

it('publica la escala de telemetría y el foco desde la base, sin heredar los de Mercado', () => {
  expect(base.typography.size).toEqual({
    xs: { value: '13px', lineHeight: '18px' },
    sm: { value: '14px', lineHeight: '21px' },
    md: { value: '16px', lineHeight: '24px' },
    lg: { value: '18px', lineHeight: '26px' },
    xl: { value: '24px', lineHeight: '30px' },
    '2xl': { value: '36px', lineHeight: '40px' },
  });
  for (const [name, token] of Object.entries(base.typography.size)) {
    expect(tokenStylesheet()).toContain(`--type-${name}:${token.value};`);
    expect(tokenStylesheet()).toContain(`--type-${name}-line:${token.lineHeight};`);
  }
  expect(tokenStylesheet()).toContain('--focus-width:2px;--focus-offset:2px;--focus-style:solid;');
});

it('conserva los tamaños de composición de Mercado al aplicar la base legible', () => {
  for (const name of ['contentMax', 'watchlist', 'chartMinHeight'] as const) {
    expect(tokenStylesheet()).toContain(`--size-${name}:${market.size[name]};`);
  }
});

for (const mode of ['light', 'dark'] as const) {
  it(`avisos y conectores: sus estados cumplen contraste AA en tema ${mode}`, () => {
    const palette = clarity.color[mode];
    for (const token of Object.values(clarity.color.semantic)) {
      const surface = token[`${mode}Surface`];
      expect(contrast(token[mode], surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.text, surface)).toBeGreaterThanOrEqual(4.5);
    }
    for (const surface of [palette.canvas, palette.surface, palette.surfaceSubtle]) {
      expect(contrast(palette.textMuted, surface)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(palette.inverse, palette.accent)).toBeGreaterThanOrEqual(4.5);
  });
}
