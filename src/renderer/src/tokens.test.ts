import broker from './design/broker.tokens.json';
import { describe, expect, it } from 'vitest';
import news from './design/news.tokens.json';
import base from './design/base.tokens.json';
import market from './design/market.tokens.json';
import risk from './design/risk.tokens.json';
const tokens = { ...market, color: { ...market.color, state: base.color.state } };
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
