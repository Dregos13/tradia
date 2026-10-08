import { describe, expect, it } from 'vitest';
import base from '../../../.orquesta/design/fase-0-1/tokens.json';
import market from '../../../.orquesta/design/fase-1/tokens.json';
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
