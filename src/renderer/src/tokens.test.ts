import { describe, expect, it } from 'vitest';
import tokens from '../../../.orquesta/design/fase-0-1/tokens.json';
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
    expect(css).toContain('@media(prefers-color-scheme:dark)');
    expect(css).toContain(`--size-controlMin:${tokens.size.controlMin};`);
  });
});
