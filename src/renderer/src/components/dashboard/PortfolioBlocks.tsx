import { useState } from 'react';
import type { PaperPortfolioOverview } from '../../../../shared/signals';
import { number, timestamp } from './model';
export function DrawdownBlock({ portfolio }: { portfolio: PaperPortfolioOverview | null }) {
  if (!portfolio) return <p>La cartera simulada todavía no está disponible.</p>;
  const { drawdownPct: current, drawdownLimitPct: limit } = portfolio;
  const ratio = limit > 0 ? current / limit : 1;
  return (
    <div className={ratio >= 1 ? 'dashboard-negative' : ratio >= 0.8 ? 'dashboard-caution' : ''}>
      <p className="dashboard-metric">Actual −{number(current)} %</p>
      <p>
        Máximo permitido −{number(limit)} % · quedan {number(Math.max(0, limit - current))} puntos
      </p>
      <div className="dashboard-limit-track">
        <progress
          aria-label="Drawdown frente a su límite"
          value={Math.min(current, limit)}
          max={limit || 1}
          aria-valuetext={`${number(current)} % de ${number(limit)} %`}
        />
      </div>
      <p>
        {ratio >= 1
          ? 'Límite alcanzado'
          : ratio >= 0.8
            ? 'Cautela · cerca del límite'
            : 'Dentro del límite'}
      </p>
      <p>Datos de {timestamp(portfolio.updatedAt)}</p>
      <a href="#riesgo">Ver límites de riesgo</a>
    </div>
  );
}
export function ExposureBlock({ portfolio }: { portfolio: PaperPortfolioOverview | null }) {
  const [view, setView] = useState<'asset' | 'sector'>('asset');
  const rows = [
    ...(view === 'asset'
      ? (portfolio?.exposureByAsset ?? [])
      : (portfolio?.exposureBySector ?? [])),
  ].sort((a, b) => b.pct - a.pct);
  return (
    <>
      <div className="dashboard-segment" role="group" aria-label="Vista de exposición">
        <button aria-pressed={view === 'asset'} onClick={() => setView('asset')}>
          Por activo
        </button>
        <button aria-pressed={view === 'sector'} onClick={() => setView('sector')}>
          Por sector
        </button>
      </div>
      {!rows.length && (
        <p>No hay exposición simulada {view === 'asset' ? 'por activo' : 'por sector'}.</p>
      )}
      <ul className="dashboard-list">
        {rows.map((row) => (
          <li key={row.key}>
            <div className="dashboard-row">
              <strong>{row.key === 'desconocido' ? 'Sector desconocido' : row.key}</strong>
              <span>{number(row.pct)} %</span>
            </div>
            <progress
              aria-label={`Exposición de ${row.key}`}
              value={row.pct}
              max={Math.max(100, row.pct)}
              aria-valuetext={`${number(row.pct)} %; ${row.limitPct === null ? 'sin límite aplicable' : `límite ${number(row.limitPct)} %`}`}
            />
            <p>
              {row.limitPct === null ? 'Sin límite aplicable' : `Límite ${number(row.limitPct)} %`}
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}
