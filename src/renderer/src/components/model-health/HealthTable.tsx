import { Fragment, useId, useState } from 'react';
import type { ModelHealthRow, ModelHealthState } from '../../../../shared/ai';
import {
  DEGRADE_DEVIATION_PCT,
  DEGRADE_MIN_CONSECUTIVE_REVIEWS,
  DEGRADE_MIN_TRADES,
  DRIFT_BRIER_DELTA,
  DRIFT_BRIER_WINDOW,
  DRIFT_PSI_MIN_FEATURES,
  DRIFT_PSI_THRESHOLD,
  DRIFT_SUSTAIN_SESSIONS,
} from '../../../../shared/ai';
import { Badge, date, number, TableWrap } from '../ai/presentation';
export const healthStates: Record<ModelHealthState, { label: string; kind: string }> = {
  saludable: { label: 'Saludable', kind: 'healthy' },
  observacion: { label: 'En observación', kind: 'watch' },
  degradada: { label: 'Degradada', kind: 'degraded' },
  insuficiente: { label: 'Sin datos suficientes', kind: 'unknown' },
};
const metric = (value: number | null) => (value === null ? 'Sin referencia' : number(value, 3));
function HealthRow({ row }: { row: ModelHealthRow }) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const data = row.dataDrift;
  const results = row.resultsDrift;
  const strategy = row.strategyEval;
  return (
    <Fragment>
      <tr>
        <th scope="row">
          {row.name}
          <small>{row.subject === 'modelo' ? 'Modelo' : 'Estrategia'}</small>
        </th>
        <td>
          <Badge kind={`health-${healthStates[row.state].kind}`}>
            {healthStates[row.state].label}
          </Badge>
          {row.reason && <small>{row.reason}</small>}
        </td>
        <td>
          {data
            ? `${data.driftedFeatures} variables con PSI > ${number(DRIFT_PSI_THRESHOLD, 2)}`
            : 'No aplica'}
          {data?.driftSince && (
            <small>
              desde <time dateTime={data.driftSince}>{date(data.driftSince)}</time>
            </small>
          )}
        </td>
        <td>
          {results ? (
            <>
              Brier móvil {metric(results.rollingBrier)}
              <small>
                Ficha {metric(results.cardBrier)} · diferencia {metric(results.delta)} · umbral +
                {number(DRIFT_BRIER_DELTA, 2)}
              </small>
              <small>
                {results.resolvedCount}/{DRIFT_BRIER_WINDOW} predicciones resueltas
              </small>
              {results.delta !== null &&
                results.delta > DRIFT_BRIER_DELTA &&
                results.driftSince && (
                  <small>
                    desde <time dateTime={results.driftSince}>{date(results.driftSince)}</time>
                  </small>
                )}
            </>
          ) : strategy ? (
            <>
              {strategy.trades} operaciones · desviación {metric(strategy.deviationPct)} %
              <small>
                Umbral ±{DEGRADE_DEVIATION_PCT} % · mínimo {DEGRADE_MIN_TRADES} operaciones
              </small>
            </>
          ) : (
            'No evaluado · faltan datos de referencia'
          )}
        </td>
        <td>
          {data && (
            <p>
              Desde hace {data.sessions} sesiones · mínimo {DRIFT_SUSTAIN_SESSIONS} en{' '}
              {DRIFT_PSI_MIN_FEATURES} variables
            </p>
          )}
          {strategy && (
            <p>
              Desde hace {strategy.consecutiveReviews} revisiones mensuales · mínimo{' '}
              {DEGRADE_MIN_CONSECUTIVE_REVIEWS}
            </p>
          )}
          {results && <small>Ventana de {DRIFT_BRIER_WINDOW} predicciones.</small>}
        </td>
        <td>
          {row.lastReviewedAt ? (
            <time dateTime={row.lastReviewedAt}>{date(row.lastReviewedAt)}</time>
          ) : (
            'Sin revisión'
          )}
        </td>
        <td>
          <button
            className="button"
            aria-expanded={expanded}
            aria-controls={id}
            aria-label={`${expanded ? 'Ocultar' : 'Ver'} detalle de ${row.name}`}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Ocultar detalle' : 'Ver detalle'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr id={id}>
          <td colSpan={7}>
            <div className="health-details">
              {data?.features.map((feature) => (
                <div key={feature.name}>
                  <strong>{feature.name}</strong>
                  <p className="ai-numeric">
                    PSI {number(feature.psi, 3)} · umbral &gt; {number(DRIFT_PSI_THRESHOLD, 2)}
                    {feature.overThreshold && feature.overThresholdSince && (
                      <>
                        {' · desde '}
                        <time dateTime={feature.overThresholdSince}>
                          {date(feature.overThresholdSince)}
                        </time>
                      </>
                    )}
                  </p>
                  <p>
                    {feature.overThreshold ? 'Sobre el umbral' : 'Dentro del rango'}. Persistencia
                    conjunta: {data.sessions} sesiones hasta la última revisión.
                  </p>
                </div>
              ))}
              {strategy && (
                <div>
                  <strong>Evidencia de rendimiento</strong>
                  <p>
                    {strategy.trades} operaciones · desviación {metric(strategy.deviationPct)} %
                    frente al backtest · {strategy.consecutiveReviews} revisiones mensuales
                    consecutivas.
                  </p>
                  <p>
                    Racha perdedora actual: {strategy.losingStreak ?? 'Sin datos'} · máximo de
                    backtest: {strategy.maxLosingStreakBacktest ?? 'Sin referencia'}. Una racha mala
                    aislada no degrada una estrategia.
                  </p>
                </div>
              )}
              {row.state === 'degradada' && (
                <p>Drift sostenido. No se debe a una sola racha perdedora.</p>
              )}
              {!data && !results && !strategy && <p>No evaluado · faltan datos de referencia</p>}
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
export function HealthTable({ rows }: { rows: ModelHealthRow[] }) {
  return (
    <section className="ai-section" aria-labelledby="health-table-title">
      <h3 id="health-table-title">Revisión de modelos y estrategias</h3>
      {!rows.length ? (
        <>
          <p>Aún no hay predicciones resueltas ni operaciones suficientes</p>
          <p>La salud aparecerá cuando exista una muestra evaluable.</p>
        </>
      ) : (
        <TableWrap label="Salud de modelos y estrategias">
          <table>
            <caption>La persistencia evita degradar por una racha aislada</caption>
            <thead>
              <tr>
                {[
                  'Modelo o estrategia',
                  'Estado',
                  'Drift de datos',
                  'Drift de resultados',
                  'Persistencia',
                  'Última revisión',
                  'Acción',
                ].map((label) => (
                  <th scope="col" key={label}>
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <HealthRow key={`${row.subject}-${row.subjectId}`} row={row} />
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </section>
  );
}
