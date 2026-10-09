import tokens from '../../design/dashboard.tokens.json';
export function dashboardTokenStylesheet() {
  const theme = (mode: 'light' | 'dark') =>
    Object.entries(tokens.color.signal)
      .map(
        ([key, value]) =>
          `--dashboard-${key}:${value[mode]};--dashboard-${key}-surface:${value[`${mode}Surface`]};`,
      )
      .join('') +
    Object.entries(tokens.color.strategy)
      .map(
        ([key, value]) =>
          `--dashboard-strategy-${key}:${value[mode]};--dashboard-strategy-${key}-surface:${value[`${mode}Surface`]};`,
      )
      .join('') +
    `--dashboard-paper:${tokens.color.strategy.paper[mode]};--dashboard-paper-surface:${tokens.color.strategy.paper[`${mode}Surface`]};`;
  return `.dashboard{${theme('light')}--dashboard-gap:${tokens.size.dashboardGap};}@media(prefers-color-scheme:dark){.dashboard{${theme('dark')}}}`;
}
