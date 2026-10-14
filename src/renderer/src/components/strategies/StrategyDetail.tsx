import { LiveShortStatus } from './LiveShortStatus';
import { ExecutionNotice } from './ExecutionNotice';
import { strategySide } from '../../../../shared/strategyRules';
import { ruleLabels } from './ruleValidation';
import { strategyExecution } from './ruleValidation';
import { StrategyHealth } from './StrategyHealth';
import { RegimeBacktestComparison } from './RegimeBacktestComparison';
import { regimeLabels } from './regimeLabels';
import { StressResults } from './StressResults';
import { BacktestLauncher } from '../backtest/BacktestLauncher';
import { useCallback, useRef, useState } from 'react';
import { useIpcList } from '../../hooks/useIpcList';
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
  const readEvidence = useCallback(async () => {
    const runs = await window.tradia.backtest.list({ strategyId: s.id, version: s.version });
    const latestRun = [...runs].sort((a, b) => b.id - a.id)[0];
    if (!latestRun) return [];
    const report = await window.tradia.backtest.get(latestRun.id);
    return report ? [report] : [];
  }, [s.id, s.version]);
  const evidence = useIpcList(
    readEvidence,
    undefined,
    'No pudimos consultar la evidencia guardada.',
  );
  const report = evidence.items[0];
  const execution = strategyExecution(s);
  const runnable = { ...s, executable: execution.executable };
  const side = s.executable ? 'largo' : strategySide(s.rules);
  const historical = s.version !== latest.version;
  const [status, setStatus] = useState(s.status);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const statusSelect = useRef<HTMLSelectElement>(null);
  return (
    <>
      <a href="#estrategias">Volver a la biblioteca</a>
      <header className="strategy-heading" data-layout-block="cabecera">
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
      {historical && (
        <p className="strategy-section" data-layout-block="seccion">
          Versión histórica · solo lectura
        </p>
      )}
      {(!s.executable || execution.parsed.ok) && (
        <ExecutionNotice
          executable={execution.executable}
          reason={execution.reason}
          strategyId={s.id}
          readOnly={historical}
        />
      )}
      <StrategyHealth strategy={latest} />
      <section
        className="strategy-section"
        data-layout-block="seccion"
        aria-labelledby="strategy-evidence"
      >
        <h3 id="strategy-evidence">Resumen de evidencia</h3>
        {evidence.loading ? (
          <p role="status">Cargando evidencia…</p>
        ) : evidence.error ? (
          <p role="alert">
            {evidence.error}{' '}
            <button onClick={() => void evidence.reload()}>Reintentar evidencia</button>
          </p>
        ) : report ? (
          <p>
            Último resultado:{' '}
            {report.dataSource === 'simulated' ? 'Datos simulados' : 'Datos reales'} · Fuente:{' '}
            {report.providerId} · Periodo ejecutado: {report.config.desde} →{' '}
            {report.config.ejecutadoHasta ?? report.config.hasta} ·{' '}
            <a href={`#estrategias/${s.id}/backtest/${report.id}`}>Consultar informe</a>
          </p>
        ) : (
          <p>Aún no hay resultados guardados para esta versión.</p>
        )}
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
      <section className="strategy-section" data-layout-block="seccion">
        <h3>Hipótesis</h3>
        <p>{s.hypothesis}</p>
      </section>
      <section className="strategy-section" data-layout-block="seccion">
        <h3>Reglas reproducibles</h3>
        <p>Opera en: {side === 'ambos' ? 'largo y corto' : side}.</p>
        {side !== 'largo' && <LiveShortStatus />}
        <dl className="strategy-grid">
          {(['entry', 'exit', 'entryShort', 'exitShort', 'stop', 'target'] as const).map((key) => (
            <div key={key}>
              <dt>{ruleLabels[key]}</dt>
              <dd>{s.rules[key]?.trim() || 'No configurada'}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="strategy-section" data-layout-block="seccion">
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
        {report && (
          <>
            <p>Temporalidad: sesiones diarias.</p>
            {report.split ? (
              <p>
                Validación: {report.split.validation.startDate} → {report.split.validation.endDate}.
                Prueba final reservada: {report.split.test.startDate} → {report.split.test.endDate}.
              </p>
            ) : (
              <p>Resultado de prueba final.</p>
            )}
            <p>
              Walk-forward:{' '}
              {report.walkForward
                ? `${report.walkForward.windows.length} ventanas evaluadas`
                : 'no ejecutado'}
              .
            </p>
          </>
        )}
      </section>
      <section className="strategy-section" data-layout-block="seccion">
        <h3>Régimen de mercado</h3>
        <dl className="strategy-grid">
          <div>
            <dt>Funciona en</dt>
            <dd>
              {s.worksIn.map((label) => regimeLabels[label]).join(', ') ||
                'Sin preferencia declarada'}
            </dd>
          </div>
          <div>
            <dt>Falla en</dt>
            <dd>
              {s.failsIn.map((label) => regimeLabels[label]).join(', ') ||
                'Sin limitaciones declaradas'}
            </dd>
          </div>
        </dl>
        <p>{s.regime}</p>
      </section>
      <RegimeBacktestComparison
        key={`regime:${s.id}:${s.version}`}
        strategy={runnable}
        readOnly={historical}
      />
      <section className="strategy-section" data-layout-block="seccion">
        <h3>Costes asumidos</h3>
        <p>
          Comisión {number(s.assumedCosts.commissionPct, '%')} · mínimo{' '}
          {number(s.assumedCosts.commissionMin, ' USD')} · slippage{' '}
          {number(s.assumedCosts.slippageBps, ' pb')} · spread{' '}
          {number(s.assumedCosts.spreadBps, ' pb')}
        </p>
      </section>
      <section className="strategy-section" data-layout-block="seccion">
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
        <section className="strategy-section" data-layout-block="seccion">
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
                // El botón queda desactivado durante el cambio y, si acierta,
                // también después: el foco vuelve al selector y no cae en body.
                statusSelect.current?.focus();
              }
            }}
          >
            <label>
              Nuevo estado
              <select
                ref={statusSelect}
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
      <StressResults
        key={`${s.id}:${s.version}`}
        executable={execution.executable}
        strategyId={s.id}
        version={s.version}
        readOnly={historical}
      />
      <BacktestLauncher strategy={runnable} readOnly={historical} />
      <section className="strategy-section" data-layout-block="seccion">
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
