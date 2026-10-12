import { useEffect, useId, useRef, useState } from 'react';
import {
  LIVE_SMOKE_NOTIONAL_USD,
  LIVE_SMOKE_TICKER,
  type LiveSmokeTestResult,
} from '../../../../shared/live';
import { slippage, time } from '../orders/orderPresentation';
import { LiveIcon, liveTokens, usd } from './presentation';
import { LiveNavigation } from './LiveNavigation';
import { SmokeConfirmation } from './SmokeConfirmation';
import { SmokeProgress } from './SmokeProgress';
import { useLiveState } from './useLiveState';
import { useLiveSafety } from './useLiveSafety';
import './checklist.css';
import './live.css';

const stateLabels = {
  'no-ejecutada': 'No ejecutada',
  'en-curso': 'En curso',
  'cerrada-conciliada': 'Cerrada y conciliada',
  'fallida-posicion-abierta': 'Fallida con posición abierta',
  'fallida-sin-posicion': 'Fallida sin posición',
};
export interface SmokeTestPanelProps {
  onOpenJournal?: () => void;
  onOpenOrders?: () => void;
  onOpenReconciliation?: () => void;
  onOpenConnection?: () => void;
}
export function SmokeTestPanel({
  onOpenJournal,
  onOpenOrders,
  onOpenReconciliation,
  onOpenConnection,
}: SmokeTestPanelProps = {}) {
  const id = useId();
  const live = useLiveState();
  const safety = useLiveSafety();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<LiveSmokeTestResult | null>(null);
  const working = useRef(false);
  const mounted = useRef(false);
  const outcome = useRef<HTMLParagraphElement>(null);
  const canRun = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (live.state) setResult(live.state.smokeTest);
  }, [live.state]);
  const running = busy || result?.state === 'en-curso';
  const failed =
    result?.state === 'fallida-posicion-abierta' || result?.state === 'fallida-sin-posicion';
  const reasons = [
    ...(live.loading ? ['Cargando historial de la prueba…'] : []),
    ...(live.error ? [live.error] : []),
    ...(live.state?.mode !== 'activo' ? ['El modo real debe estar activo.'] : []),
    ...(!live.state?.hasCredentials || !live.state.accountMasked
      ? ['Verifica las claves y la cuenta live.']
      : []),
    ...(!safety.online ? ['Sin conexión verificada · no se puede ejecutar la prueba.'] : []),
    ...(safety.stop?.active !== false ? ['La parada debe estar verificada e inactiva.'] : []),
    ...(!live.state?.limits ||
    live.state.limits.orderUsd < LIVE_SMOKE_NOTIONAL_USD ||
    live.state.limits.capitalUsd < LIVE_SMOKE_NOTIONAL_USD ||
    live.state.limits.openPositions < 1
      ? ['Los límites confirmados deben permitir la prueba de 1,00 USD.']
      : []),
    ...(failed || error ? ['Revisa la orden y su conciliación antes de repetir una prueba.'] : []),
  ];
  canRun.current = reasons.length === 0 && !running;
  useEffect(() => {
    if (!canRun.current) setConfirm(false);
  }, [live.loading, live.error, live.state, safety.online, safety.stop, running, failed]);
  async function execute() {
    if (working.current || !canRun.current) return;
    working.current = true;
    setConfirm(false);
    setError('');
    setBusy(true);
    // Start a new timeline, never show the previous successful run as current progress.
    setResult(null);
    try {
      const next = await window.tradia.live.smokeTest({ confirm: true });
      if (mounted.current) {
        setResult(next);
        outcome.current?.focus();
      }
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error
            ? cause.message
            : 'No se pudo completar la prueba. Revisa la orden y concilia antes de repetir.',
        );
        // A request may have reached the broker. Read persisted progress, never resend it.
        await live.reload();
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section
      className="live-surface live-sheet live-smoke"
      aria-labelledby={`${id}-title`}
      aria-busy={live.loading}
    >
      <style>{liveTokens()}</style>
      <header className="live-panel-head">
        <h3 id={`${id}-title`}>Prueba de humo · {usd(LIVE_SMOKE_NOTIONAL_USD)} reales</h3>
      </header>
      <p className="live-warning">
        <LiveIcon /> Esta prueba compra una fracción de {LIVE_SMOKE_TICKER}, la vende y concilia el
        resultado. Usa dinero real.
      </p>
      <p
        ref={outcome}
        tabIndex={-1}
        role={failed ? 'alert' : 'status'}
        className={`live-smoke-status ${failed ? 'live-smoke-failed' : ''}`}
      >
        <strong>{running ? 'En curso' : stateLabels[result?.state ?? 'no-ejecutada']}</strong>
        {result?.state === 'fallida-posicion-abierta' &&
          ' · Queda una posición real abierta. Revisa su cierre en Órdenes.'}
      </p>
      {!safety.online && result && (
        <p role="status">
          Sin conexión · último paso conservado. Comprueba la cuenta antes de continuar.
        </p>
      )}
      <SmokeProgress result={result} running={running} />
      {result && (
        <p>El límite de protección no es la referencia usada para calcular el slippage.</p>
      )}
      {result && (
        <dl className="live-result-facts">
          <div>
            <dt>Hora de inicio</dt>
            <dd>
              {result.startedAt ? (
                <time dateTime={result.startedAt}>{time(result.startedAt)}</time>
              ) : (
                'No disponible'
              )}
            </dd>
          </div>
          <div>
            <dt>Hora de finalización</dt>
            <dd>
              {result.finishedAt ? (
                <time dateTime={result.finishedAt}>{time(result.finishedAt)}</time>
              ) : (
                'Pendiente'
              )}
            </dd>
          </div>
          <div>
            <dt>Límite de protección de la compra</dt>
            <dd>{result.requestedPrice === null ? 'No disponible' : usd(result.requestedPrice)}</dd>
          </div>
          <div>
            <dt>Precio ejecutado compra</dt>
            <dd>{result.buyExecutedPrice === null ? 'Pendiente' : usd(result.buyExecutedPrice)}</dd>
          </div>
          <div>
            <dt>Precio ejecutado cierre</dt>
            <dd>
              {result.sellExecutedPrice === null ? 'Pendiente' : usd(result.sellExecutedPrice)}
            </dd>
          </div>
          <div>
            <dt>Slippage de compra respecto a la referencia</dt>
            <dd>{slippage(result.slippageBps)}</dd>
          </div>
          <div>
            <dt>Nocional</dt>
            <dd>
              {usd(result.notionalUsd)} · {result.ticker}
            </dd>
          </div>
          <div>
            <dt>Conciliación</dt>
            <dd>
              {result.discrepancies === null
                ? 'Pendiente'
                : result.discrepancies === 0
                  ? 'Sin diferencias'
                  : `${result.discrepancies} descuadres`}
              {result.reconcileRunId !== null && (
                <small> · Revisión #{result.reconcileRunId}</small>
              )}
            </dd>
          </div>
        </dl>
      )}
      {result && (result.failedStep || result.error) && (
        <p role="alert">
          {result.failedStep ? (
            <>
              Paso fallido:{' '}
              {result.failedStep === 'compra-enviada'
                ? 'Compra enviada / ejecución de compra'
                : result.failedStep === 'posicion-cerrada'
                  ? 'Posición cerrada'
                  : 'Conciliación sin descuadres'}
              .{' '}
            </>
          ) : (
            'Prueba fallida: '
          )}
          {result.error}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {!!reasons.length && (
        <ul className="live-prerequisites" aria-label="Requisitos de la prueba">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <p className="live-meta">
        El proceso principal comprueba también el mercado, la cuenta y el riesgo antes de enviar la
        orden.
      </p>
      <div className="live-actions">
        <button
          className="button live-primary"
          disabled={!canRun.current}
          onClick={() => setConfirm(true)}
        >
          {running ? 'Prueba en curso…' : 'Ejecutar prueba de 1,00 USD'}
        </button>
        {result && (
          <LiveNavigation label="Ver entrada en Diario" href="#diario" onOpen={onOpenJournal} />
        )}
        {(failed || error) && (
          <LiveNavigation label="Ver orden y cierre" href="#ordenes" onOpen={onOpenOrders} />
        )}
        {(result?.failedStep === 'conciliacion-ok' || error) && (
          <LiveNavigation
            label="Revisar conciliación"
            href="#ordenes"
            onOpen={onOpenReconciliation}
          />
        )}
        {!safety.online && (
          <LiveNavigation label="Ver conexión" href="#ajustes" onOpen={onOpenConnection} />
        )}
        {live.error && (
          <button className="button" onClick={() => void live.reload()}>
            Reintentar historial
          </button>
        )}
      </div>
      {confirm && (
        <SmokeConfirmation onCancel={() => setConfirm(false)} onConfirm={() => void execute()} />
      )}
    </section>
  );
}
