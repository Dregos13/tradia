import news from './design/news.tokens.json';
import base from './design/base.tokens.json';
import market from './design/market.tokens.json';
const tokens = { ...market, color: { ...market.color, state: base.color.state } };

/** Translate the approved source tokens; no duplicated palette in renderer styles. */
export function tokenStylesheet(): string {
  const declarations = (values: Record<string, string | number>, prefix: string) =>
    Object.entries(values)
      .map(([key, value]) => `--${prefix}-${key}:${value};`)
      .join('');
  const theme = (mode: 'light' | 'dark') =>
    declarations(
      Object.fromEntries(
        Object.entries(tokens.color[mode]).map(([key, token]) => [key, token.value]),
      ),
      'color',
    ) +
    declarations(
      Object.fromEntries(
        Object.entries(tokens.color.state).flatMap(([key, token]) => [
          [key, token[mode]],
          [`${key}-surface`, token[`${mode}Surface`]],
        ]),
      ),
      'state',
    ) +
    [
      'candle',
      'series',
      'dataStatus',
      'reliability',
      'newsPriority',
      'confirmation',
      'impactLevel',
      'calendar',
    ]
      .map((group) =>
        declarations(
          Object.fromEntries(
            Object.entries(
              {
                ...market.color,
                reliability: news.color.reliability,
                newsPriority: news.color.newsPriority,
                confirmation: news.color.confirmation,
                impactLevel: news.color.impactLevel,
                calendar: news.color.calendar,
              }[group as 'candle'],
            ).flatMap(([key, token]) => {
              const values = token as {
                light: string;
                dark: string;
                lightSurface?: string;
                darkSurface?: string;
              };
              const surface = mode === 'light' ? values.lightSurface : values.darkSurface;
              return [[key, values[mode]], ...(surface ? [[`${key}-surface`, surface]] : [])];
            }),
          ),
          group,
        ),
      )
      .join('');
  const common =
    declarations(tokens.spacing, 'space') +
    declarations(tokens.radius, 'radius') +
    declarations(tokens.size, 'size') +
    declarations(tokens.motion, 'motion') +
    declarations(tokens.typography.weight, 'weight') +
    declarations(tokens.typography.tracking, 'tracking') +
    declarations(
      Object.fromEntries(
        Object.entries(tokens.typography.family).map(([key, token]) => [key, token.value]),
      ),
      'font',
    ) +
    declarations(
      Object.fromEntries(
        Object.entries(tokens.typography.size).flatMap(([key, token]) => [
          [key, token.value],
          [`${key}-line`, token.lineHeight],
        ]),
      ),
      'type',
    ) +
    declarations(
      Object.fromEntries(Object.entries(tokens.shadow).map(([key, token]) => [key, token.value])),
      'shadow',
    );
  return `:root{${common}${theme('light')}}@media(prefers-color-scheme:dark){:root{${theme('dark')}}}`;
}

export function applyTokens(): void {
  const style = document.createElement('style');
  style.id = 'tradia-design-tokens';
  style.textContent = tokenStylesheet();
  document.head.append(style);
}
