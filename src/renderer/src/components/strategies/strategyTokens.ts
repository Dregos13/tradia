import tokens from '../../design/strategy.tokens.json';
export function strategyTokenStylesheet() {
  const theme = (mode: 'light' | 'dark') =>
    Object.entries(tokens.color.strategyStatus)
      .map(
        ([key, value]) =>
          `--strategy-${key}:${value[mode]};--strategy-${key}-surface:${value[`${mode}Surface`]};`,
      )
      .join('');
  const evidence = (mode: 'light' | 'dark') =>
    (['chart', 'heatmap', 'notice'] as const)
      .map((group) =>
        Object.entries(tokens.color[group])
          .map(
            ([key, value]) =>
              `--${group}-${key}:${value[mode]};${'lightSurface' in value ? `--${group}-${key}-surface:${value[`${mode}Surface`]};` : ''}`,
          )
          .join(''),
      )
      .join('');
  return `.strategies-page{${theme('light')}${evidence('light')}}@media(prefers-color-scheme:dark){.strategies-page{${theme('dark')}${evidence('dark')}}}`;
}
