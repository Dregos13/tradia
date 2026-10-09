import { useRef, useState } from 'react';
import type { Strategy, StrategyCosts } from '../../../../shared/strategy';
import { useBacktest, useBacktestHistory } from '../../hooks/useBacktest';
import { BacktestHistory } from './BacktestHistory';
import './backtest.css';
const costLabels: Record<keyof StrategyCosts, string> = {
  commissionPct: 'Comisión (%)',
  commissionMin: 'Comisión mínima (USD)',
  slippageBps: 'Slippage (pb)',
  spreadBps: 'Spread (pb)',
};
export function BacktestLauncher({
  strategy: s,
  readOnly = false,
}: {
  strategy: Strategy;
  readOnly?: boolean;
}) {
  const state = useBacktest(s.id, s.version);
  const history = useBacktestHistory(s.id, s.version);
  const [confirm, setConfirm] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [validation, setValidation] = useState('');
  const final = history.items.find((run) => run.kind === 'prueba-final');
  return (
    <>
      <section className="strategy-section">
        <h3>Lanzar backtest</h3>
        <p>
          Entrenamiento 60 % · validación 20 % · prueba final reservada 20 %. El backtest deja
          intacta la prueba final.
        </p>
        {readOnly && <p>Versión histórica · lanzador en solo lectura.</p>}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (readOnly || state.busy) return;
            const data = new FormData(event.currentTarget);
            const desde = String(data.get('desde'));
            const hasta = String(data.get('hasta'));
            const params = Object.fromEntries(
              Object.keys(s.parameters).map((key) => [key, Number(data.get(`param:${key}`))]),
            );
            if (desde >= hasta) {
              setValidation('La fecha inicial debe ser anterior a la final.');
              return;
            }
            if (
              ('fast' in params && 'slow' in params && params.fast >= params.slow) ||
              ('fastPeriod' in params &&
                'slowPeriod' in params &&
                params.fastPeriod >= params.slowPeriod)
            ) {
              setValidation('La media rápida debe ser menor que la lenta.');
              return;
            }
            setValidation('');
            void state.launch({
              strategyId: s.id,
              version: s.version,
              desde,
              hasta,
              initialCash: Number(data.get('cash')),
              params,
              costs: Object.fromEntries(
                Object.keys(costLabels).map((key) => [key, Number(data.get(key))]),
              ),
              monteCarlo: { simulations: Number(data.get('simulations')), seed: 1 },
            });
          }}
        >
          <fieldset disabled={state.busy || readOnly} className="backtest-fields">
            <legend>Periodo, parámetros y costes</legend>
            <div className="strategy-grid">
              <label>
                Desde
                <input
                  name="desde"
                  type="date"
                  required
                  defaultValue={s.trainingPeriod?.desde ?? ''}
                />
              </label>
              <label>
                Hasta
                <input
                  name="hasta"
                  type="date"
                  required
                  defaultValue={s.outOfSamplePeriod?.hasta ?? s.trainingPeriod?.hasta ?? ''}
                />
              </label>
              <label>
                Capital inicial (USD)
                <input
                  name="cash"
                  type="number"
                  min="1"
                  max="100000000"
                  step="any"
                  required
                  defaultValue="10000"
                />
              </label>
              <label>
                Simulaciones Monte Carlo
                <input
                  name="simulations"
                  type="number"
                  min="1"
                  max="100000"
                  required
                  defaultValue="1000"
                />
              </label>
              {Object.entries(s.parameters).map(([key, value]) => (
                <label key={key}>
                  Parámetro {key}
                  <input
                    name={`param:${key}`}
                    type="number"
                    required
                    step={s.parameterRanges[key]?.step ?? 'any'}
                    min={s.parameterRanges[key]?.min}
                    max={s.parameterRanges[key]?.max}
                    defaultValue={value}
                  />
                </label>
              ))}
              {(Object.keys(costLabels) as (keyof StrategyCosts)[]).map((key) => (
                <label key={key}>
                  {costLabels[key]}
                  <input
                    name={key}
                    type="number"
                    min="0"
                    step="any"
                    required
                    defaultValue={s.assumedCosts[key]}
                  />
                </label>
              ))}
            </div>
            <button className="strategy-primary" type="submit">
              Lanzar backtest
            </button>
          </fieldset>
        </form>
        {validation && <p role="alert">{validation}</p>}
        {state.error && <p role="alert">{state.error}</p>}
        {state.busy && (
          <div role="status" aria-live="polite">
            <p>
              {state.progress?.stage ?? 'Preparando'} · {state.progress?.detail} ·{' '}
              {state.progress?.percent ?? 0} %
            </p>
            <progress
              aria-label="Progreso del backtest"
              max="100"
              value={state.progress?.percent ?? 0}
            />
            <p>Puedes seguir usando Tradia.</p>
          </div>
        )}
        <section className="backtest-final">
          <h4>Prueba final · {final ? 'ejecutada y bloqueada' : 'bloqueada sin ejecutar'}</h4>
          <p>
            Solo puede ejecutarse una vez por versión, usando la configuración del último backtest
            guardado.
          </p>
          {final ? (
            <a href={`#estrategias/${s.id}/backtest/${final.id}`}>Ver prueba final</a>
          ) : (
            <button
              ref={confirmButton}
              disabled={
                readOnly ||
                state.busy ||
                history.loading ||
                !!history.error ||
                !history.items.length
              }
              onClick={() => setConfirm(true)}
            >
              Ejecutar prueba final
            </button>
          )}
          {!history.loading && !history.items.length && (
            <p>Primero guarda un backtest de entrenamiento y validación.</p>
          )}
          {confirm && (
            <div
              className="backtest-notice notice-method"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setConfirm(false);
                  confirmButton.current?.focus();
                }
              }}
            >
              <strong>Confirmar prueba final bloqueada</strong>
              <p>
                Consumirás la única prueba final de v{s.version}. No podrás repetirla con otros
                parámetros.
              </p>
              <div className="strategy-actions">
                <button
                  autoFocus
                  onClick={() => {
                    setConfirm(false);
                    confirmButton.current?.focus();
                  }}
                >
                  Cancelar
                </button>
                <button
                  disabled={state.busy}
                  onClick={() => {
                    setConfirm(false);
                    void state.launch();
                  }}
                >
                  Confirmar y ejecutar prueba final
                </button>
              </div>
            </div>
          )}
        </section>
      </section>
      <BacktestHistory strategyId={s.id} version={s.version} />
    </>
  );
}
