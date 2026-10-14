import broker from './design/broker.tokens.json';
import clarity from './design/data-clarity.tokens.json';
import { describe, expect, it } from 'vitest';
import news from './design/news.tokens.json';
import base from './design/base.tokens.json';
import market from './design/market.tokens.json';
import risk from './design/risk.tokens.json';
const tokens = base;
import { tokenStylesheet } from './tokens';

describe('Tokens aprobados', () => {
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

for (const mode of ['light', 'dark'] as const) {
  describe(`Contraste AA de la base: ${mode}`, () => {
    for (const pair of base.contrastPairs) {
      it(`${pair.text} / ${pair.background} ≥ 4,5:1`, () => {
        const palette: Record<string, { value: string }> = base.color[mode];
        expect(
          contrast(palette[pair.text]!.value, palette[pair.background]!.value),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
    for (const [name, token] of Object.entries(base.color.state)) {
      it(`${name}: etiqueta y cuerpo / fondo ≥ 4,5:1`, () => {
        expect(contrast(token[mode], token[`${mode}Surface`])).toBeGreaterThanOrEqual(4.5);
        expect(
          contrast(base.color[mode].text.value, token[`${mode}Surface`]),
        ).toBeGreaterThanOrEqual(4.5);
      });
    }
    it('foco / superficie y foco de navegación / barra lateral ≥ 3:1', () => {
      expect(
        contrast(base.color[mode].focus.value, base.color[mode].surface.value),
      ).toBeGreaterThanOrEqual(3);
      expect(
        contrast(base.color[mode].sidebarText.value, base.color[mode].sidebar.value),
      ).toBeGreaterThanOrEqual(3);
    });
  });
}

it('publica la escala legible y el foco desde la base, sin heredar la escala antigua de Mercado', () => {
  expect(base.typography.size.md).toEqual({ value: '16px', lineHeight: '24px' });
  expect(base.typography.size.sm).toEqual({ value: '15px', lineHeight: '22px' });
  expect(base.typography.size.xs).toEqual({ value: '14px', lineHeight: '20px' });
  for (const [name, token] of Object.entries(base.typography.size)) {
    expect(Number.parseInt(token.value)).toBeGreaterThanOrEqual(14);
    expect(tokenStylesheet()).toContain(`--type-${name}:${token.value};`);
    expect(tokenStylesheet()).toContain(`--type-${name}-line:${token.lineHeight};`);
  }
  expect(tokenStylesheet()).toContain('--focus-width:3px;--focus-offset:2px;--focus-style:solid;');
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
