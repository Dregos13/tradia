import tokens from '../design/onboarding.tokens.json';
import clarity from '../design/data-clarity.tokens.json';
export function dataStateTokenStylesheet() {
  const theme = (mode: 'light' | 'dark') =>
    [
      ...Object.entries(clarity.color.semantic).flatMap(([key, value]) => [
        `--data-clarity-${key}:${value[mode]}`,
        `--data-clarity-${key}-surface:${value[`${mode}Surface`]}`,
      ]),
      ...Object.entries(clarity.color[mode]).map(
        ([key, value]) => `--data-clarity-${key}:${value}`,
      ),
      ...Object.entries(clarity.typography.size).flatMap(([key, value]) => [
        `--data-clarity-type-${key}:${value.value}`,
        `--data-clarity-leading-${key}:${value.lineHeight}`,
      ]),
      ...Object.entries(clarity.spacing).map(([key, value]) => `--data-clarity-${key}:${value}`),
      ...Object.entries(clarity.size).map(([key, value]) => `--data-clarity-${key}:${value}`),
      `--data-clarity-control-radius:${clarity.radius.control}`,
      `--data-clarity-focus-width:${clarity.focus.width}`,
      `--data-clarity-focus-offset:${clarity.focus.offset}`,
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
