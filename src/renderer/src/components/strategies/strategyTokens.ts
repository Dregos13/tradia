import tokens from '../../design/strategy.tokens.json';
export function strategyTokenStylesheet() {
  const theme = (mode: 'light' | 'dark') =>
    Object.entries(tokens.color.strategyStatus)
      .map(
        ([key, value]) =>
          `--strategy-${key}:${value[mode]};--strategy-${key}-surface:${value[`${mode}Surface`]};`,
      )
      .join('');
  return `.strategies-page{${theme('light')}}@media(prefers-color-scheme:dark){.strategies-page{${theme('dark')}}}`;
}
