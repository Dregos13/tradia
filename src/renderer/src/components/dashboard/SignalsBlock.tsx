import { assetSymbol, fxLabel } from '../assetPresentation';
import {
  FX_ANALYSIS_ONLY_REASON,
  FX_BROKER_REJECTION_REASON,
  isFxSymbol,
} from '../../../../shared/fxTrading';
import { useDataFreshness } from '../../hooks/useDataFreshness';
import { sessionDateLabel } from '../DataFreshness';
import type { Signal, SignalStrategyState } from '../../../../shared/signals';
import type { JournalEntry } from '../../../../shared/journal';
import { direction, number, time } from './model';
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
/** Qué pasa con la señal de una divisa según su destino y su estado ya decidido. */
function fxDestinationText(signal: Signal): string {
  if (signal.destination === 'solo-analisis') {
    return `No abre posición: ${signal.destinationReason ?? FX_ANALYSIS_ONLY_REASON}.`;
  }
  if (signal.decision.status === 'vetada') {
    const why = signal.decision.reasons[0]?.message;
    return why ? `Riesgo la vetó: ${why}.` : 'Riesgo la vetó; no se opera.';
  }
  return 'Se opera en la cartera simulada.';
}
const decisions = { aprobada: '✓ Aprobada', reducida: '△ Reducida', vetada: '× Vetada' };
export function SignalsBlock({
  signals,
  contradictions,
  stopped,
  strategies = [],
}: {
  signals: Signal[];
  contradictions: JournalEntry[];
  stopped: boolean;
  strategies?: SignalStrategyState[];
}) {
  const { summary } = useDataFreshness();
  const paperCount = strategies.filter((strategy) => strategy.status === 'paper').length;
  const paused = summary && summary.state !== 'current' && summary.state !== 'no-data';
  const rows = [
    ...signals.map((signal) => ({ kind: 'signal' as const, value: signal })),
    ...contradictions.map((entry) => ({ kind: 'conflict' as const, value: entry })),
  ].sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt));
  return (
    <>
      {stopped && <p className="dashboard-stop">No se admiten nuevas señales.</p>}
      {!rows.length && (
        <p>
          {paused ? (
            `Sin señales nuevas: en pausa hasta poner al día los datos del ${sessionDateLabel(summary.sinceDate)}.`
          ) : paperCount ? (
            `Sin señales nuevas: ${paperCount} estrategias en paper esperan el siguiente cierre verificado.`
          ) : (
            <>
              Todavía no hay señales. <a href="#estrategias">Activa una estrategia</a> y espera el
              siguiente cierre de vela.
            </>
          )}
        </p>
      )}
      <ol className="dashboard-signals">
        {rows.map((row) =>
          row.kind === 'signal' ? (
            <li key={`signal-${row.value.id}`}>
              <div className="dashboard-signal-summary">
                <time dateTime={row.value.createdAt}>{time(row.value.createdAt)}</time>
                <strong>{assetSymbol(row.value.ticker)}</strong>
                <span>{direction(row.value.direction)}</span>
                <span className={`dashboard-badge dashboard-${row.value.decision.status}`}>
                  {decisions[row.value.decision.status]}
                </span>
              </div>
              <div>
                <strong>Confianza {number(row.value.confidence * 100)} %</strong>
                <progress
                  aria-label={`Confianza de ${assetSymbol(row.value.ticker)}`}
                  max={100}
                  value={Math.min(100, Math.max(0, row.value.confidence * 100))}
                  aria-valuenow={Math.min(100, Math.max(0, row.value.confidence * 100))}
                  aria-valuetext={`${number(row.value.confidence * 100)} %`}
                />
                {isFxSymbol(row.value.ticker) && (
                  <p className="dashboard-fx-destination">
                    <strong>{fxLabel(row.value.ticker)}.</strong> {fxDestinationText(row.value)} No
                    va al bróker ni usa dinero real. {capitalize(FX_BROKER_REJECTION_REASON)}.
                  </p>
                )}
                <p>{row.value.reason}</p>
                <p>
                  {row.value.strategies
                    .map((strategy) => `${strategy.name} · v${strategy.version}`)
                    .join(' · ')}
                </p>
                {row.value.decision.reasons.map((reason, index) => (
                  <p key={index}>Riesgo: {reason.message}</p>
                ))}
                <a href={`#diario?signalId=${row.value.id}`}>
                  Ver en Diario · {assetSymbol(row.value.ticker)}
                </a>
              </div>
            </li>
          ) : (
            <li key={`conflict-${row.value.id}`}>
              <div className="dashboard-signal-summary">
                <time dateTime={row.value.createdAt}>{time(row.value.createdAt)}</time>
                <strong>{row.value.ticker ?? 'Sin activo'}</strong>
                <span className="dashboard-badge dashboard-conflict">
                  ↔ Sin señal · Contradicción
                </span>
              </div>
              <p>{row.value.reason}</p>
              <p>
                {row.value.strategies
                  .map((strategy) => `${strategy.name} · v${strategy.version}`)
                  .join(' · ')}
              </p>
              <a href={`#diario?entryId=${row.value.id}`}>Ver en Diario · contradicción</a>
            </li>
          ),
        )}
      </ol>
    </>
  );
}
