import type { MacroObservation, MacroSeriesSnapshot } from '../../../../shared/ipc';

export const indicators = [
  { id: 'DFF', name: 'Tipo efectivo federal', color: 'dff' },
  { id: 'CPIAUCSL', name: 'IPC de EE. UU. · interanual', color: 'cpi' },
  { id: 'DGS2', name: 'Treasury · 2 años', color: 'yield2y' },
  { id: 'DGS10', name: 'Treasury · 10 años', color: 'yield10y' },
  { id: 'T10Y2Y', name: 'Diferencial 10–2', color: 'spread' },
  { id: 'VIXCLS', name: 'Volatilidad VIX', color: 'vix' },
] as const;

/** CPI levels are compared by calendar month, never by array offset. */
export function displayObservations(series: MacroSeriesSnapshot): MacroObservation[] {
  const points = series.observations.filter((point) => Number.isFinite(point.value));
  if (series.id !== 'CPIAUCSL') return points;
  const months = new Map(points.map((point) => [point.date.slice(0, 7), point.value]));
  return points.flatMap((point) => {
    const previous = months.get(`${Number(point.date.slice(0, 4)) - 1}${point.date.slice(4, 7)}`);
    return previous !== undefined && previous > 0
      ? [{ date: point.date, value: Math.round((point.value / previous - 1) * 1_000_000) / 10_000 }]
      : [];
  });
}

export const formatNumber = (value: number) =>
  new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    value,
  );
export const formatDate = (date: string) =>
  new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium', timeZone: 'UTC' }).format(
    new Date(`${date}T00:00:00Z`),
  );
