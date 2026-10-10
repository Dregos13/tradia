import { useId, useState } from 'react';
import type { ModelCard, Prediction } from '../../../../shared/ai';
import { date, Fitness, percent, TableWrap } from './presentation';
export function PredictionsTable({
  predictions,
  model,
  modelUnavailable = false,
}: {
  predictions: Prediction[];
  model: ModelCard | null;
  modelUnavailable?: boolean;
}) {
  const id = useId();
  const [ticker, setTicker] = useState('');
  const tickers = [...new Set(predictions.map((row) => row.ticker))];
  const selected = tickers.includes(ticker) ? ticker : '';
  return (
    <section className="ai-section" aria-labelledby="ai-predictions-title">
      <h3 id="ai-predictions-title">Predicción por activo</h3>
      <p>No crea señales por sí solo · Riesgo conserva el veto.</p>
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
          <TableWrap label="Predicciones por activo">
            <table>
              <caption>Probabilidades estimadas al cierre diario</caption>
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
                {predictions
                  .filter((row) => !selected || row.ticker === selected)
                  .map((row) => {
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
                          {card && <a href="#ai-model-card">Ver ficha del modelo</a>}
                        </td>
                        <td>
                          <time dateTime={row.createdAt}>{date(row.createdAt)}</time>
                          <small>Cierre {date(row.sessionDate)}</small>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </TableWrap>
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
