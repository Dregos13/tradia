import type { MacroObservation } from '../../../../shared/ipc';
import { formatNumber } from './model';

export function MacroSparkline({ points, name }: { points: MacroObservation[]; name: string }) {
  if (points.length < 2)
    return <p className="macro-chart-empty">Histórico insuficiente para el minigráfico.</p>;
  const values = points.map((point) => point.value);
  const min = Math.min(...values);
  const range = Math.max(...values) - min;
  const firstTime = Date.parse(points[0]!.date);
  const span = Date.parse(points.at(-1)!.date) - firstTime;
  const path = points
    .map(
      (point) =>
        `${8 + ((Date.parse(point.date) - firstTime) / (span || 1)) * 284},${range ? 72 - ((point.value - min) / range) * 56 : 44}`,
    )
    .join(' ');
  const first = points[0]!.value;
  const last = points.at(-1)!.value;
  return (
    <svg
      className="macro-spark"
      viewBox="0 0 300 88"
      role="img"
      aria-label={`${name}: ${last > first ? 'tendencia ascendente' : last < first ? 'tendencia descendente' : 'sin variación'}, de ${formatNumber(first)} a ${formatNumber(last)} entre ${points[0]!.date} y ${points.at(-1)!.date}.`}
    >
      <line x1="8" x2="292" y1="80" y2="80" className="macro-baseline" />
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
