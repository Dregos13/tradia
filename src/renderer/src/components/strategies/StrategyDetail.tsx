import { useState } from 'react';
import {
  STRATEGY_STATUSES,
  type Strategy,
  type StrategyChangelogEntry,
  type StrategyStatus,
} from '../../../../shared/strategy';
import { metrics, number, date, statusLabels } from './model';
import { StrategyStatus as StatusBadge } from './StrategyLibrary';
export function StrategyDetail({
  strategy: s,
  latest,
  history,
  changeStatus,
}: {
  strategy: Strategy;
  latest: Strategy;
  history: StrategyChangelogEntry[];
  changeStatus: (status: StrategyStatus) => Promise<void>;
}) {
  const historical = s.version !== latest.version;
  const [status, setStatus] = useState(s.status);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  return (
    <>
      <a href="#estrategias">Volver a la biblioteca</a>
      <header className="strategy-heading">
        <div>
          <h2>{s.name}</h2>
          <StatusBadge status={s.status} />
          <p>
            Versión v{s.version} · {date(s.versionCreatedAt)}
          </p>
        </div>
        <div className="strategy-actions">
          <label>
            Versión
            <select
              aria-label="Versión"
              value={s.version}
              onChange={(e) => {
                window.location.hash = `estrategias/${s.id}/v${e.target.value}`;
              }}
            >
              {history
                .filter((x) => x.kind === 'version' && x.version)
                .map((x) => (
                  <option key={x.id} value={x.version!}>
                    v{x.version}
                  </option>
                ))}
            </select>
          </label>
          {!historical && <a href={`#estrategias/${s.id}/editar`}>Editar</a>}
        </div>
      </header>
      {historical && <p className="strategy-section">Versión histórica · solo lectura</p>}
      <section className="strategy-section" aria-labelledby="strategy-evidence">
        <h3 id="strategy-evidence">Resumen de evidencia</h3>
        <p>Procedencia y periodo del último resultado: no disponibles.</p>
        <dl className="strategy-metrics">
          {metrics.map(([key, label, unit]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>
                {key === 'profitFactor' && s.metricsSummary?.profitFactor === null
                  ? '∞'
                  : number(s.metricsSummary?.[key], unit)}
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="strategy-section">
        <h3>Hipótesis</h3>
        <p>{s.hypothesis}</p>
      </section>
      <section className="strategy-section">
        <h3>Reglas reproducibles</h3>
        <dl className="strategy-grid">
          {(['entry', 'exit', 'stop', 'target'] as const).map((key) => (
            <div key={key}>
              <dt>{{ entry: 'Entrada', exit: 'Salida', stop: 'Stop', target: 'Objetivo' }[key]}</dt>
              <dd>{s.rules[key]}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="strategy-section">
        <h3>Mercados y periodos</h3>
        <p>{s.markets.join(', ')}</p>
        <dl>
          {(['trainingPeriod', 'outOfSamplePeriod'] as const).map((key) => (
            <div key={key}>
              <dt>{key === 'trainingPeriod' ? 'Entrenamiento' : 'Fuera de muestra'}</dt>
              <dd>{s[key] ? `${s[key].desde} → ${s[key].hasta}` : 'Sin datos'}</dd>
            </div>
          ))}
        </dl>
        <p>Validación y temporalidad: no documentadas en el contrato actual.</p>
      </section>
      <section className="strategy-section">
        <h3>Régimen</h3>
        <p>{s.regime}</p>
      </section>
      <section className="strategy-section">
        <h3>Costes asumidos</h3>
        <p>
          Comisión {number(s.assumedCosts.commissionPct, '%')} · mínimo{' '}
          {number(s.assumedCosts.commissionMin, ' USD')} · slippage{' '}
          {number(s.assumedCosts.slippageBps, ' pb')} · spread{' '}
          {number(s.assumedCosts.spreadBps, ' pb')}
        </p>
      </section>
      <section className="strategy-section">
        <h3>Parámetros</h3>
        {Object.keys(s.parameters).length ? (
          <dl>
            {Object.entries(s.parameters).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>
                  {number(value)}
                  {s.parameterRanges[key] &&
                    ` · rango ${s.parameterRanges[key].min}–${s.parameterRanges[key].max}, paso ${s.parameterRanges[key].step}`}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p>Sin parámetros definidos</p>
        )}
      </section>
      {!historical && (
        <section className="strategy-section">
          <h3>Cambiar estado</h3>
          <p>El cambio de estado se registra sin crear otra versión.</p>
          <form
            className="strategy-actions"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              setMessage('');
              try {
                await changeStatus(status);
                setMessage('Estado actualizado');
              } catch {
                setError('No pudimos cambiar el estado. Inténtalo de nuevo.');
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Nuevo estado
              <select
                aria-label="Nuevo estado"
                value={status}
                onChange={(e) => setStatus(e.target.value as StrategyStatus)}
              >
                {STRATEGY_STATUSES.map((x) => (
                  <option key={x} value={x}>
                    {statusLabels[x]}
                  </option>
                ))}
              </select>
            </label>
            <button disabled={busy || status === s.status}>Cambiar estado</button>
          </form>
          {message && <p role="status">{message}</p>}
          {error && <p role="alert">{error}</p>}
        </section>
      )}
      <section className="strategy-section">
        <h3>Registro de cambios</h3>
        <ol className="strategy-history">
          {history.map((x) => (
            <li key={x.id}>
              <strong>
                {x.kind === 'version' ? (
                  <a href={`#estrategias/${s.id}/v${x.version}`}>v{x.version}</a>
                ) : (
                  `${x.fromStatus ? statusLabels[x.fromStatus] : ''} → ${x.toStatus ? statusLabels[x.toStatus] : ''}`
                )}
              </strong>{' '}
              · <time dateTime={x.createdAt}>{date(x.createdAt)}</time>
              <p>{x.note}</p>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
