import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import base from './design/base.tokens.json';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
/** Cuerpo de la primera regla cuyo selector es exactamente `selector`. */
const rule = (css: string, selector: string): string => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `no hay regla «${selector}»`).not.toBeNull();
  return match![1]!;
};

const styles = read('./styles.css');

describe('Legibilidad y jerarquía de la identidad', () => {
  it('la escala xs, la más pequeña, sigue en 13 px, el mínimo de la guía', () => {
    expect(Number.parseFloat(base.typography.size.xs.value)).toBeGreaterThanOrEqual(13);
  });

  it('los small de toda la app usan la escala xs y no el tamaño por defecto del navegador', () => {
    expect(rule(styles, 'small')).toMatch(/font-size:\s*var\(--type-xs\)/);
    for (const file of [
      './components/strategies/strategies.css',
      './components/risk/risk.css',
      './components/settings/settings.css',
    ]) {
      expect(read(file), file).not.toMatch(
        /small\s*\{[^}]*font-size:\s*(?:smaller|0\.|\d+(?:\.\d+)?px)/,
      );
    }
  });

  it('el h2 de cabecera es un subtítulo (lg) y nunca supera al h1 de 24 px de la barra superior', () => {
    const h1 = Number.parseFloat(base.typography.size.xl.value);
    expect(rule(styles, '.top h1')).toMatch(/font-size:\s*var\(--type-xl\)/);
    expect(rule(styles, '.headline h2')).toMatch(/var\(--type-lg\)/);
    expect(Number.parseFloat(base.typography.size.lg.value)).toBeLessThan(h1);
    for (const file of [
      './components/strategies/strategies.css',
      './components/risk/risk.css',
      './components/ai/ai.css',
      './components/live/checklist.css',
      './components/onboarding/onboarding.css',
    ]) {
      expect(read(file), file).not.toMatch(/h2\s*\{[^}]*var\(--type-2xl\)/);
    }
  });

  it('la barra de estado no recorta con puntos suspensivos ni oculta el desbordamiento', () => {
    const css = styles.slice(styles.indexOf('.statusbar {'));
    const block = css.slice(0, css.indexOf('.skip-link'));
    expect(block).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(block).toMatch(/flex-wrap:\s*wrap/);
    // Por debajo de 1200 px se usan las etiquetas cortas y las largas quedan solo para lectores.
    expect(block).toMatch(
      /@media \(max-width: 1200px\)[\s\S]*\.statusbar-label-short\s*\{\s*display:\s*inline/,
    );
  });
});
