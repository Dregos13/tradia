import type { MacroSeriesSnapshot } from '../../../../shared/ipc';
import { MacroSparkline } from './MacroSparkline';
import { displayObservations, formatDate, formatNumber, indicators } from './model';

const statuses = {
  fiable: { label: 'Fiable', symbol: '✓', token: 'reliable' },
  actualizando: { label: 'Actualizando', symbol: '◌', token: 'updating' },
  desactualizado: { label: 'Desactualizado', symbol: '◷', token: 'stale' },
  'no-fiable': { label: 'No fiable', symbol: '!', token: 'unreliable' },
};
export function MacroCard({
  indicator,
  series,
}: {
  indicator: (typeof indicators)[number];
  series?: MacroSeriesSnapshot;
}) {
  const points = series ? displayObservations(series) : [];
  const lastPoint = points.at(-1);
  const latest = lastPoint?.date === series?.observations.at(-1)?.date ? lastPoint : undefined;
  const previous = points.at(-2);
  const date = series?.observations.at(-1)?.date;
  const status = series?.status ? statuses[series.status.state] : null;
  const unit = indicator.id === 'VIXCLS' ? 'puntos' : indicator.id === 'T10Y2Y' ? 'pp' : '%';
  const change =
    latest && previous ? Math.round((latest.value - previous.value) * 100) / 100 : null;
  return (
    <article
      className={`macro-card macro-series-${indicator.color}`}
      aria-labelledby={`macro-${indicator.id}`}
    >
      <div className="macro-card-head">
        <span className="macro-code">{indicator.id}</span>
        <span className={`macro-badge macro-status-${status?.token ?? 'unknown'}`}>
          <span aria-hidden="true">{status?.symbol ?? '—'} </span>
          {status?.label ?? 'Sin evaluar'}
        </span>
      </div>
      <h3 id={`macro-${indicator.id}`}>{indicator.name}</h3>
      <div className="macro-value">
        {latest ? `${formatNumber(latest.value)} ${unit}` : 'Sin dato'}
      </div>
      <p className="macro-change">
        {change === null
          ? 'Histórico insuficiente para comparar.'
          : `${change > 0 ? '▲ +' : change < 0 ? '▼ ' : '= '}${formatNumber(change)} ${indicator.id === 'VIXCLS' ? 'puntos' : 'pp'} respecto al dato ${indicator.id === 'CPIAUCSL' ? 'mensual' : 'diario'} anterior`}
      </p>
      <MacroSparkline points={points} name={indicator.name} />
      {indicator.id === 'T10Y2Y' && latest && latest.value < 0 && (
        <p className="macro-warning">Curva invertida · el bono a 2 años supera al de 10 años.</p>
      )}
      {indicator.id === 'VIXCLS' && latest && (
        <p className="macro-band">
          Banda {latest.value < 20 ? 'baja' : latest.value < 30 ? 'media' : 'alta'}{' '}
          <span>(baja &lt; 20 · media 20–&lt;30 · alta ≥ 30)</span>
        </p>
      )}
      <div className="macro-meta">
        <span>{indicator.id === 'CPIAUCSL' ? 'Dato mensual' : 'Dato diario'}</span>
        {date ? (
          <time dateTime={date}>{formatDate(date)}</time>
        ) : (
          <span>Sin fecha de observación</span>
        )}
      </div>
      {series?.status?.reason && <p className="macro-reason">{series.status.reason}</p>}
    </article>
  );
}
