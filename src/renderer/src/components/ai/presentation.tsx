import type { ReactNode } from 'react';
import type { ModelCard, RegimeLabel } from '../../../../shared/ai';
import { isModelEligible } from '../../../../shared/ai';
import tokens from '../../design/ai.tokens.json';
export const number = (value: number, digits = 1) =>
  value.toLocaleString('es-ES', { maximumFractionDigits: digits });
export const percent = (value: number) => `${number(value * 100)} %`;
export const date = (value: string) =>
  new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleString(
    'es-ES',
    value.length === 10
      ? { dateStyle: 'medium' }
      : {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          timeZoneName: 'short',
        },
  );
const regimes = {
  tendencia: 'trend',
  lateral: 'sideways',
  'volatilidad-alta': 'highVolatility',
  'volatilidad-baja': 'lowVolatility',
} as const;
export const regimeLabel = (label: RegimeLabel) => tokens.color.regime[regimes[label]].label;
export function Badge({ kind, children }: { kind: string; children: ReactNode }) {
  return <span className={`ai-badge ai-${kind}`}>{children}</span>;
}
export function RegimeBadge({ label }: { label: RegimeLabel }) {
  return <Badge kind={`regime-${regimes[label]}`}>{regimeLabel(label)}</Badge>;
}
export function Fitness({ card }: { card: ModelCard | null }) {
  if (!card)
    return <Badge kind="modelFitness-unrated">Sin evaluar · no apto para apoyar señales</Badge>;
  if (card.dataOrigin === 'sintetico')
    return <Badge kind="modelFitness-synthetic">Datos sintéticos · no apto</Badge>;
  if (!isModelEligible(card))
    return <Badge kind="modelFitness-synthetic">No mejora la referencia · no apto</Badge>;
  return (
    <Badge kind={card.eligible ? 'modelFitness-eligible' : 'modelFitness-unrated'}>
      {card.eligible
        ? 'Apto para apoyar señales'
        : (card.ineligibleReason ?? 'No apto para apoyar señales')}
    </Badge>
  );
}
export function TableWrap({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <p className="ai-hint">Desplázate horizontalmente para ver todas las columnas.</p>
      <div className="ai-table-wrap" role="region" aria-label={label} tabIndex={0}>
        {children}
      </div>
    </>
  );
}
export function aiTokens() {
  const theme = (mode: 'light' | 'dark') =>
    Object.entries(tokens.color)
      .flatMap(([group, entries]) =>
        Object.entries(entries).map(([key, value]) => {
          const color = value as {
            light: string;
            dark: string;
            lightSurface?: string;
            darkSurface?: string;
          };
          return `--ai-${group}-${key}:${color[mode]};--ai-${group}-${key}-surface:${color[`${mode}Surface`] ?? color[mode]};`;
        }),
      )
      .join('');
  return `.ai-page{--ai-filter-max:${tokens.size.dialogMax};--ai-table-min:${tokens.size.regimeTableMin};--ai-chart-height:${tokens.size.calibrationChartMinHeight};--ai-track-height:${tokens.size.probabilityTrack};${theme('light')}}@media(prefers-color-scheme:dark){.ai-page{${theme('dark')}}}`;
}
