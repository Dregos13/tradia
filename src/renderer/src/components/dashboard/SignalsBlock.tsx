import type { Signal } from '../../../../shared/signals';
import type { JournalEntry } from '../../../../shared/journal';
import { direction, number, time } from './model';
const decisions = { aprobada: '✓ Aprobada', reducida: '△ Reducida', vetada: '× Vetada' };
export function SignalsBlock({
  signals,
  contradictions,
  stopped,
}: {
  signals: Signal[];
  contradictions: JournalEntry[];
  stopped: boolean;
}) {
  const rows = [
    ...signals.map((signal) => ({ kind: 'signal' as const, value: signal })),
    ...contradictions.map((entry) => ({ kind: 'conflict' as const, value: entry })),
  ].sort((a, b) => b.value.createdAt.localeCompare(a.value.createdAt));
  return (
    <>
      {stopped && <p className="dashboard-stop">No se admiten nuevas señales.</p>}
      {!rows.length && (
        <p>
          Todavía no hay señales. <a href="#estrategias">Activa una estrategia</a> y espera el
          siguiente cierre de vela.
        </p>
      )}
      <ol className="dashboard-signals">
        {rows.map((row) =>
          row.kind === 'signal' ? (
            <li key={`signal-${row.value.id}`}>
              <div className="dashboard-signal-summary">
                <time dateTime={row.value.createdAt}>{time(row.value.createdAt)}</time>
                <strong>{row.value.ticker}</strong>
                <span>{direction(row.value.direction)}</span>
                <span className={`dashboard-badge dashboard-${row.value.decision.status}`}>
                  {decisions[row.value.decision.status]}
                </span>
              </div>
              <div>
                <strong>Confianza {number(row.value.confidence * 100)} %</strong>
                <progress
                  aria-label={`Confianza de ${row.value.ticker}`}
                  max={100}
                  value={Math.min(100, Math.max(0, row.value.confidence * 100))}
                  aria-valuenow={Math.min(100, Math.max(0, row.value.confidence * 100))}
                  aria-valuetext={`${number(row.value.confidence * 100)} %`}
                />
                <p>{row.value.reason}</p>
                <p>
                  {row.value.strategies
                    .map((strategy) => `${strategy.name} · v${strategy.version}`)
                    .join(' · ')}
                </p>
                {row.value.decision.reasons.map((reason, index) => (
                  <p key={index}>Riesgo: {reason.message}</p>
                ))}
                <a href={`#diario?signalId=${row.value.id}`}>Ver en Diario · {row.value.ticker}</a>
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
