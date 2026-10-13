import tokens from '../../design/live.tokens.json';
import type { LiveRequirementState } from '../../../../shared/live';

export const usd = (value: number) =>
  // This numeric locale shares Spanish separators and groups four-digit sums.
  `${value.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
export const timestamp = (value: string) =>
  new Date(value).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });

export function liveTokens() {
  const theme = (mode: 'light' | 'dark') => {
    const declarations = Object.entries(tokens.color)
      .flatMap(([group, entries]) =>
        Object.entries(entries).flatMap(([key, entry]) => {
          if (typeof entry !== 'object') return [];
          const value = entry as {
            light: string;
            dark: string;
            lightSurface?: string;
            darkSurface?: string;
          };
          return [
            `--live-${group}-${key}:${value[mode]};`,
            ...(value[`${mode}Surface`]
              ? [`--live-${group}-${key}-surface:${value[`${mode}Surface`]};`]
              : []),
          ];
        }),
      )
      .join('');
    return `${declarations}--live-overlay:${tokens.color.overlay[mode]};--live-live-banner-text:${tokens.color.live.banner[`${mode}Text`]};`;
  };
  const scope = '.live-checklist-page,.live-dialog-scope,.live-surface';
  return `${scope}{--live-short-label:${tokens.size.shortRequirementLabel};--live-banner-min:${tokens.size.liveBannerMin};--live-dialog-max:${tokens.size.dialogMax};--live-panel-min:${tokens.size.limitsPanelMin};--live-shadow:${tokens.shadow.floating.value};${theme('light')}}@media(prefers-color-scheme:dark){${scope}{${theme('dark')}}}`;
}

export function LiveIcon({ kind = 'shield' }: { kind?: 'shield' | 'lock' | LiveRequirementState }) {
  return (
    <svg
      className="live-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      {kind === 'shield' ? (
        <>
          <path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7Z" />
          <path d="M12 8v5m0 3v1" />
        </>
      ) : kind === 'lock' ? (
        <>
          <rect x="5" y="10" width="14" height="11" rx="2" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          {kind === 'cumplido' ? (
            <path d="m7 12 3 3 7-7" />
          ) : kind === 'revisar' ? (
            <path d="M12 6v6l4 2" />
          ) : (
            <path d="m8 8 8 8m0-8-8 8" />
          )}
        </>
      )}
    </svg>
  );
}

export function RequirementStatus({ state }: { state: LiveRequirementState }) {
  const key = { cumplido: 'complete', pendiente: 'pending', revisar: 'review' } as const;
  return (
    <span className={`live-badge live-requirement-${key[state]}`}>
      <LiveIcon kind={state} />
      {tokens.color.requirement[key[state]].label}
    </span>
  );
}
