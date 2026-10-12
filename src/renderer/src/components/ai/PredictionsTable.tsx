import type { DataFreshnessSummary } from '../../../../shared/ipc';
import { freshnessTitle, sessionDateLabel } from '../DataFreshness';
import { useId, useState } from 'react';
import type { ModelCard, Prediction } from '../../../../shared/ai';
import { date, Fitness, percent, TableWrap } from './presentation';
export function PredictionsTable({
  predictions,
  summary,
  pauseReason,
  offline = false,
  model,
  modelUnavailable = false,
  expectedSessionDate = null,
}: {
  predictions: Prediction[];
  summary: DataFreshnessSummary | null;
  pauseReason?: string;
  offline?: boolean;
  model: ModelCard | null;
  modelUnavailable?: boolean;
  /** Última sesión esperada ('YYYY-MM-DD'); las predicciones anteriores están desactualizadas. */
  expectedSessionDate?: string | null;
}) {
  const id = useId();
  const [ticker, setTicker] = useState('');
  const tickers = [...new Set(predictions.map((row) => row.ticker))];
  const selected = tickers.includes(ticker) ? ticker : '';
  const ordered = [...predictions].sort(
    (a, b) =>
      b.sessionDate.localeCompare(a.sessionDate) ||
      b.createdAt.localeCompare(a.createdAt) ||
      b.id - a.id,
  );
  const latest = new Map<string, Prediction>();
  for (const row of ordered) if (!latest.has(row.ticker)) latest.set(row.ticker, row);
  const current = [...latest.values()];
  const history = ordered.filter((row) => latest.get(row.ticker)?.id !== row.id);
  const visible = (rows: Prediction[]) =>
    rows.filter((row) => !selected || row.ticker === selected);
  const openModel = () => {
    const target = document.getElementById('ai-model-card');
    target?.scrollIntoView({ block: 'start' });
    target?.focus({ preventScroll: true });
  };
  const latestSession =
    predictions
      .map((row) => row.sessionDate)
      .sort()
      .at(-1) ?? null;
  const stale =
    expectedSessionDate !== null && latestSession !== null && latestSession < expectedSessionDate;
  const renderTable = (rows: Prediction[], historic = false) => (
    <TableWrap label={historic ? 'Histórico de predicciones' : 'Predicciones por activo'}>
      <table>
        <caption>
          {historic
            ? 'Predicciones de cierres anteriores'
            : 'Probabilidades estimadas al cierre diario'}
        </caption>
        <thead>
          <tr>
            {[
              'Activo y horizonte',
              'Probabilidad de subida',
              'Probabilidad de bajada',
              'Volatilidad esperada',
              'Modelo y aptitud',
              'Calculado',
            ].map((label) => (
              <th scope="col" key={label}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {visible(rows).map((row) => {
            const card =
              !modelUnavailable &&
              model?.id === row.modelCardId &&
              model.version === row.modelVersion &&
              model.hash === row.modelHash
                ? model
                : null;
            return (
              <tr key={row.id}>
                <th scope="row">
                  {row.ticker}
                  <small>Próximas {row.horizonDays} sesiones</small>
                </th>
                <td className="ai-numeric">
                  {percent(row.probUp)}
                  <svg
                    className="ai-probability"
                    viewBox="0 0 100 10"
                    preserveAspectRatio="none"
                    role="img"
                    aria-label={`Probabilidad estimada: subida ${percent(row.probUp)}, bajada ${percent(row.probDown)}, horizonte ${row.horizonDays} sesiones`}
                  >
                    <rect className="ai-prob-down" width="100" height="10" />
                    <rect className="ai-prob-up" width={row.probUp * 100} height="10" />
                  </svg>
                </td>
                <td className="ai-numeric">{percent(row.probDown)}</td>
                <td className="ai-numeric">
                  {row.expectedVolatility === null
                    ? 'No calculada'
                    : percent(row.expectedVolatility)}
                  <small>{row.horizonDays} sesiones</small>
                </td>
                <td>
                  <span className="ai-numeric">
                    v{row.modelVersion} · {row.modelHash.slice(0, 12)}
                  </span>
                  <small>
                    <Fitness card={card} />
                  </small>
                  {card && (
                    <button type="button" className="button" onClick={openModel}>
                      Ver ficha del modelo
                    </button>
                  )}
                </td>
                <td>
                  <time dateTime={row.createdAt}>{date(row.createdAt)}</time>
                  <small>
                    {!historic && 'Último cierre disponible · '}Cierre {date(row.sessionDate)}
                    {!historic &&
                      expectedSessionDate &&
                      row.sessionDate < expectedSessionDate &&
                      ' · Desactualizada'}
                  </small>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
  if (pauseReason)
    return (
      <section className="ai-section" aria-labelledby="ai-predictions-title">
        <h3 id="ai-predictions-title">Predicción por activo</h3>
        <p role="status">
          {freshnessTitle(
            {
              state:
                summary && summary.state !== 'current' && summary.state !== 'no-data'
                  ? summary.state
                  : 'stale',
              sinceDate: summary?.sinceDate ?? null,
            },
            { offline, snapshotSessionDate: latestSession ?? undefined },
          )}
        </p>
        {latestSession && (
          <p>
            Calculado con el cierre del{' '}
            <time dateTime={latestSession}>{sessionDateLabel(latestSession)}</time>
          </p>
        )}
        <p>En pausa: {pauseReason}. No se calculan nuevas probabilidades hasta ponerse al día.</p>
      </section>
    );
  return (
    <section className="ai-section" aria-labelledby="ai-predictions-title">
      <h3 id="ai-predictions-title">Predicción por activo</h3>
      <p>No crea señales por sí solo · Riesgo conserva el veto.</p>
      {stale && (
        <div className="ai-warning" role="status">
          <p>
            {freshnessTitle({ state: 'stale', sinceDate: summary?.sinceDate ?? null })} · se
            esperaba la sesión del {date(expectedSessionDate)}. No se crean predicciones nuevas
            hasta ponerse al día.
          </p>
        </div>
      )}
      {!predictions.length ? (
        <p>Aún no hay estimaciones por activo.</p>
      ) : (
        <>
          <label className="ai-filter" htmlFor={id}>
            Activo
            <select id={id} value={selected} onChange={(event) => setTicker(event.target.value)}>
              <option value="">Todos los activos</option>
              {tickers.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </label>
          <p>Una predicción por activo, correspondiente a su último cierre disponible.</p>
          {renderTable(current)}
          {!!visible(history).length && (
            <details>
              <summary>Histórico de predicciones ({visible(history).length})</summary>
              {renderTable(history, true)}
            </details>
          )}
          <p className="ai-hint">
            Una probabilidad no significa que el precio vaya a subir. Expresa la frecuencia estimada
            para este horizonte según este modelo.
          </p>
          <p>
            Solo los modelos aptos pueden confirmar o reducir una señal existente. No pueden
            crearla.
          </p>
        </>
      )}
    </section>
  );
}
