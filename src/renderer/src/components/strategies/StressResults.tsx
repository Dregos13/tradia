import { useCallback, useEffect, useRef, useState } from 'react';
import type { StressResultDto } from '../../../../shared/backtest';
import { useIpcList } from '../../hooks/useIpcList';
import { number } from './model';

import { ExecutionNotice } from './ExecutionNotice';

const crises = ['2008', '2020', '2022'] as const;
const percent = (value: number | null) => number(value == null ? null : value * 100, ' %');

function MiniEquity({ result }: { result: StressResultDto }) {
  const values = result.equityCurve.map((point) => point.equity).filter(Number.isFinite);
  if (!values.length) return <p>Sin curva de capital disponible</p>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const path = values
    .map((value, index) => {
      const x = values.length === 1 ? 90 : 4 + (index / (values.length - 1)) * 172;
      const y = max === min ? 24 : 44 - ((value - min) / (max - min)) * 40;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg
      className="stress-equity"
      viewBox="0 0 180 48"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Capital en ${result.crisisId}: de ${number(values[0], ' USD')} a ${number(values.at(-1), ' USD')}; mínimo ${number(min, ' USD')}, máximo ${number(max, ' USD')}.`}
    >
      <path d={path} />
      {values.length === 1 && <circle cx="90" cy="24" r="2" />}
    </svg>
  );
}

function CrisisResult({ result }: { result: StressResultDto }) {
  // Older persisted runs used null for both missing curves and no drawdown episode.
  const curve = result.equityCurve;
  const flatOrRising =
    curve.length > 0 &&
    curve.every(
      (point, index) =>
        Number.isFinite(point.equity) && (index === 0 || point.equity >= curve[index - 1]!.equity),
    );
  const drawdown = result.maxDrawdown ?? (flatOrRising ? 0 : null);
  const difference =
    result.totalReturn == null || result.benchmarkReturn == null
      ? null
      : (result.totalReturn - result.benchmarkReturn) * 100;
  return (
    <>
      <p>
        {result.crisisName}
        <span className="stress-period">
          <time dateTime={result.desde}>{result.desde}</time> →{' '}
          <time dateTime={result.hasta}>{result.hasta}</time>
        </span>
      </p>
      <span
        className={`strategy-status strategy-${result.dataSource === 'simulated' ? 'research' : 'active'}`}
      >
        {result.dataSource === 'simulated' ? 'Datos simulados' : 'Datos reales'}
      </span>
      <p className="stress-provider">Fuente: {result.providerId}</p>
      {result.sessions === 0 && <p>La fuente no dispone de sesiones para esta crisis.</p>}
      <MiniEquity result={result} />
      <dl className="stress-metrics">
        <dt>Rentabilidad</dt>
        <dd>{percent(result.totalReturn)}</dd>
        <dt>Drawdown máximo</dt>
        <dd>{percent(drawdown == null ? null : drawdown === 0 ? 0 : -drawdown)}</dd>
        <dt>Operaciones</dt>
        <dd>{number(result.trades)}</dd>
        <dt>Comprar y mantener {result.benchmarkTicker}</dt>
        <dd>{percent(result.benchmarkReturn)}</dd>
        <dt>Diferencia frente a {result.benchmarkTicker}</dt>
        <dd>
          {difference == null
            ? 'Sin datos'
            : `${difference > 0 ? '+' : ''}${number(difference, ' pp')}`}
        </dd>
      </dl>
    </>
  );
}

export function StressResults({
  strategyId,
  version,
  readOnly = false,
  executable,
}: {
  strategyId: number;
  version: number;
  readOnly?: boolean;
  executable: boolean;
}) {
  const read = useCallback(
    () => window.tradia.stress.get({ strategyId, version }),
    [strategyId, version],
  );
  const state = useIpcList(
    read,
    undefined,
    'No pudimos consultar las pruebas de estrés. Reintenta la consulta.',
  );
  const [results, setResults] = useState<StressResultDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const mounted = useRef(false);
  const running = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const items = results ?? state.items;
  const run = async () => {
    if (!executable || readOnly || running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setSuccess(false);
    try {
      const rows = await window.tradia.stress.run({ strategyId, version });
      if (mounted.current) {
        setResults(rows);
        setSuccess(true);
      }
    } catch (cause) {
      if (mounted.current)
        setError(
          `No se pudieron completar las pruebas de estrés. ${cause instanceof Error ? cause.message : 'Inténtalo de nuevo.'}`,
        );
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section
      className="strategy-section"
      aria-labelledby="stress-heading"
      aria-busy={state.loading || busy}
    >
      <h3 id="stress-heading">Comportamiento en crisis</h3>
      {!executable && <ExecutionNotice />}
      {state.loading && <p role="status">Cargando pruebas de estrés…</p>}
      {state.error && results === null && (
        <div role="alert">
          <p>{state.error}</p>
          <button onClick={() => void state.reload()}>Reintentar consulta de estrés</button>
        </div>
      )}
      {!state.loading && !state.error && items.length === 0 && (
        <p>
          Aún no hay pruebas de estrés guardadas para esta versión. Evalúa su comportamiento en
          2008, 2020 y 2022.
        </p>
      )}
      {items.length > 0 && (
        <div className="stress-grid">
          {crises.map((id) => {
            const result = items.find((item) => item.crisisId === id);
            return (
              <article className="stress-result" key={id} aria-labelledby={`stress-${id}`}>
                <h4 id={`stress-${id}`}>{id}</h4>
                {result ? (
                  <CrisisResult result={result} />
                ) : (
                  <p>Sin resultado guardado para esta crisis.</p>
                )}
              </article>
            );
          })}
        </div>
      )}
      {readOnly ? (
        <p>Versión histórica · pruebas guardadas en solo lectura.</p>
      ) : (
        <button disabled={!executable || state.loading || busy} onClick={() => void run()}>
          {busy ? 'Ejecutando pruebas de estrés…' : 'Ejecutar pruebas de estrés'}
        </button>
      )}
      {busy && (
        <p role="status">
          Evaluando las crisis de 2008, 2020 y 2022. El resultado se guardará en esta versión.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {success && <p role="status">Pruebas de estrés guardadas.</p>}
    </section>
  );
}
