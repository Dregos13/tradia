import tokens from '../../design/news.tokens.json';
/** Keep this surface scoped so other phase screens can adopt tokens independently. */
export function sourceTokenStylesheet(): string {
  const theme = (mode: 'light' | 'dark') =>
    Object.entries(tokens.color.reliability)
      .map(
        ([key, value]) =>
          `--source-${key}:${value[mode]};--source-${key}-surface:${value[`${mode}Surface`]};`,
      )
      .join('');
  return `.sources-page{${theme('light')}}@media(prefers-color-scheme:dark){.sources-page{${theme('dark')}}}`;
}
