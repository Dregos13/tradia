import tokens from '../../design/broker.tokens.json';
export const number = (value: number) =>
  value.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 2 });
export const signed = (value: number | null, unit: string) =>
  value === null ? 'No calculado' : `${value < 0 ? '−' : '+'}${number(Math.abs(value))} ${unit}`;
export function DeviationIcon({ kind }: { kind: 'paper' | 'outside' | 'within' }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path
        d={
          kind === 'paper'
            ? 'M9 3h6M10 3v7L4 20h16l-6-10V3M7 15h10'
            : kind === 'outside'
              ? 'M12 3 2 21h20L12 3ZM12 9v5M12 17v1'
              : 'm5 12 4 4 10-10'
        }
      />
    </svg>
  );
}
export function deviationTokens() {
  const theme = (mode: 'light' | 'dark') =>
    Object.entries(tokens.color.deviation)
      .map(
        ([key, value]) =>
          `--deviation-${key}:${value[mode]};--deviation-${key}-surface:${value[`${mode}Surface`]};`,
      )
      .join('') +
    `--deviation-paper:${tokens.color.paper[mode]};--deviation-paper-surface:${tokens.color.paper[`${mode}Surface`]};`;
  return `.deviation-page{--deviation-table-min:${tokens.size.deviationTableMin};${theme('light')}}@media(prefers-color-scheme:dark){.deviation-page{${theme('dark')}}}`;
}
