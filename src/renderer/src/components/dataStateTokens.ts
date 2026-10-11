import tokens from '../design/onboarding.tokens.json';
export function dataStateTokenStylesheet() {
  const theme = (mode: 'light' | 'dark') =>
    [
      ...Object.entries(tokens.color.connection).flatMap(([key, value]) => [
        `--connection-${key}:${value[mode]}`,
        `--connection-${key}-surface:${value[`${mode}Surface`]}`,
      ]),
      ...Object.entries(tokens.color.freshness).flatMap(([key, value]) => [
        `--freshness-${key}:${value[mode]}`,
        `--freshness-${key}-surface:${value[`${mode}Surface`]}`,
      ]),
    ].join(';');
  return `:root{${theme('light')}}@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){${theme('dark')}}}:root[data-theme="dark"]{${theme('dark')}}`;
}
