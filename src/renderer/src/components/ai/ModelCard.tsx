import { useId, useState } from 'react';
import type { ModelCard as ModelCardData } from '../../../../shared/ai';
import { date, Fitness, number, percent, TableWrap } from './presentation';
export function ModelCard({
  model,
  unavailable = false,
}: {
  model: ModelCardData | null;
  unavailable?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');
  const panelId = useId();
  const chartId = useId();
  const bins =
    model?.calibration
      .filter((bin) => bin.count > 0)
      .sort((a, b) => a.meanPredicted - b.meanPredicted) ?? [];
  const copyHash = async () => {
    try {
      await navigator.clipboard.writeText(model!.hash);
      setCopyStatus('Hash copiado.');
    } catch {
      setCopyStatus('No se pudo copiar el hash. Selecciona el texto para copiarlo.');
    }
  };
  return (
    <section
      className="ai-section"
      data-layout-block="seccion"
      id="ai-model-card"
      tabIndex={-1}
      aria-labelledby="ai-model-title"
    >
      <h3 id="ai-model-title">Ficha del modelo · dirección y volatilidad</h3>
      {!model ? (
        <>
          <p>Aún no hay una versión de modelo cargada.</p>
          <p>
            No hay una ficha asociada a esta versión. El modelo no puede apoyar señales sin
            periodos, métricas y calibración guardados.
          </p>
        </>
      ) : (
        <>
          <Fitness card={unavailable ? null : model} />
          {unavailable && <p>Última ficha conservada. No se pudo verificar la ficha del modelo.</p>}
          <dl className="ai-model-facts">
            <div>
              <dt>Versión</dt>
              <dd>v{model.version}</dd>
            </div>
            <div>
              <dt>SHA-256 del archivo</dt>
              <dd className="ai-hash">{model.hash}</dd>
              <button className="button" onClick={() => void copyHash()}>
                Copiar hash
              </button>
              <span role="status">{copyStatus}</span>
            </div>
            <div>
              <dt>Horizonte</dt>
              <dd>{model.horizonDays} sesiones</dd>
            </div>
            <div>
              <dt>Origen</dt>
              <dd>{model.dataOrigin === 'sintetico' ? 'Datos sintéticos' : 'Datos reales'}</dd>
            </div>
            {(
              [
                ['Entrenamiento', model.trainingPeriod, '60 %'],
                ['Calibración', model.calibrationPeriod, '20 %'],
                ['Prueba final intacta', model.testPeriod, '20 %'],
              ] as const
            ).map(([label, period, share]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <time dateTime={period.desde}>{date(period.desde)}</time> –{' '}
                  <time dateTime={period.hasta}>{date(period.hasta)}</time> · {share}
                </dd>
              </div>
            ))}
            <div>
              <dt>Entrenado</dt>
              <dd>
                <time dateTime={model.trainedAt}>{date(model.trainedAt)}</time>
              </dd>
            </div>
            <div>
              <dt>Registrado</dt>
              <dd>
                <time dateTime={model.registeredAt}>{date(model.registeredAt)}</time>
              </dd>
            </div>
          </dl>
          <div className="ai-model-grid">
            <div>
              <h4>Evaluación fuera de muestra</h4>
              <p>
                En Brier, menos es mejor. 0 indica probabilidades perfectas; la comparación solo usa
                la prueba final fuera de muestra.
              </p>
              <dl className="ai-brier">
                <div>
                  <dt>Brier del modelo</dt>
                  <dd>{number(model.metrics.brierOos, 3)}</dd>
                </div>
                <div>
                  <dt>Brier de referencia</dt>
                  <dd>{number(model.metrics.brierBaseline, 3)}</dd>
                </div>
                <div>
                  <dt>Diferencia</dt>
                  <dd>{number(model.metrics.brierOos - model.metrics.brierBaseline, 3)}</dd>
                </div>
              </dl>
              <p>
                {model.metrics.brierOos < model.metrics.brierBaseline
                  ? 'Mejor que la referencia'
                  : 'No mejora la referencia · no apto para apoyar señales'}
              </p>
              {model.dataOrigin === 'sintetico' && (
                <p>
                  La mejora no elimina el bloqueo: el origen es sintético. Solo información. Este
                  modelo no puede influir en señales porque usa datos sintéticos.
                </p>
              )}
            </div>
            <div>
              <h4>Calibración fuera de muestra</h4>
              <p>
                Cuanto más cerca esté la línea del modelo de la diagonal, mejor corresponden sus
                porcentajes con lo observado.
              </p>
              {bins.length ? (
                <>
                  <svg
                    className="ai-calibration"
                    viewBox="0 0 440 320"
                    role="img"
                    aria-labelledby={chartId}
                  >
                    <title id={chartId}>
                      Calibración fuera de muestra: probabilidad estimada frente a frecuencia
                      observada. Los valores y casos están disponibles en Ver datos del gráfico.
                    </title>
                    {[0, 0.5, 1].map((value) => (
                      <g key={value}>
                        <line
                          className="ai-chart-grid"
                          x1="60"
                          x2="410"
                          y1={270 - 240 * value}
                          y2={270 - 240 * value}
                        />
                        <text x="50" y={275 - 240 * value} textAnchor="end">
                          {percent(value)}
                        </text>
                        <text x={60 + 350 * value} y="291" textAnchor="middle">
                          {percent(value)}
                        </text>
                      </g>
                    ))}
                    <line className="ai-chart-ideal" x1="60" y1="270" x2="410" y2="30" />
                    <polyline
                      className="ai-chart-model"
                      points={bins
                        .map((bin) => `${60 + 350 * bin.meanPredicted},${270 - 240 * bin.observed}`)
                        .join(' ')}
                    />
                    {bins.map((bin, index) => (
                      <circle
                        key={index}
                        className="ai-chart-point"
                        cx={60 + 350 * bin.meanPredicted}
                        cy={270 - 240 * bin.observed}
                        r="4"
                      />
                    ))}
                    <text x="235" y="317" textAnchor="middle">
                      Probabilidad estimada
                    </text>
                    <text transform="translate(15 150) rotate(-90)" textAnchor="middle">
                      Frecuencia observada
                    </text>
                  </svg>
                  <p className="ai-chart-legend">
                    <span>Calibración ideal · línea discontinua</span>
                    <span>Modelo · línea sólida</span>
                  </p>
                </>
              ) : (
                <p>Aún no hay casos de calibración fuera de muestra.</p>
              )}
              <button
                className="button"
                aria-expanded={expanded}
                aria-controls={panelId}
                onClick={() => setExpanded((value) => !value)}
              >
                Ver datos del gráfico
              </button>
              <div id={panelId} hidden={!expanded}>
                <TableWrap label="Datos de calibración">
                  <table>
                    <caption>
                      Todos los intervalos de calibración, incluidos los que no tienen casos
                    </caption>
                    <thead>
                      <tr>
                        {[
                          'Intervalo estimado',
                          'Probabilidad media',
                          'Frecuencia observada',
                          'Casos',
                        ].map((label) => (
                          <th scope="col" key={label}>
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {model.calibration.map((bin, index) => (
                        <tr key={index}>
                          <th scope="row">
                            {percent(bin.from)} – {percent(bin.to)}
                          </th>
                          <td>{bin.count ? percent(bin.meanPredicted) : 'Sin casos'}</td>
                          <td>{bin.count ? percent(bin.observed) : 'Sin casos'}</td>
                          <td>{bin.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
