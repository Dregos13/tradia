import type { StrategyStatus, StrategyMetricsSummary } from '../../../../shared/strategy';
export const statusLabels: Record<StrategyStatus, string> = {
  investigacion: 'Investigación',
  paper: 'Paper',
  activa: 'Activa',
  degradada: 'Degradada',
  retirada: 'Retirada',
};
export const statusTokens = {
  investigacion: 'research',
  paper: 'paper',
  activa: 'active',
  degradada: 'degraded',
  retirada: 'retired',
};
export const metrics: [keyof StrategyMetricsSummary, string, string][] = [
  ['totalReturnPct', 'Rentabilidad', '%'],
  ['maxDrawdownPct', 'Drawdown máximo', '%'],
  ['sharpe', 'Sharpe', ''],
  ['profitFactor', 'Factor de beneficio', ''],
  ['winRatePct', 'Tasa de acierto', '%'],
  ['expectancy', 'Expectativa', ' USD'],
  ['maxLosingStreak', 'Racha perdedora máxima', ''],
  ['trades', 'Operaciones', ''],
];
export const number = (value: number | null | undefined, unit = '') =>
  value == null
    ? 'Sin datos'
    : `${value.toLocaleString('es-ES', { maximumFractionDigits: 2 })}${unit}`;
export const date = (value: string) => new Date(value).toLocaleDateString('es-ES');
