import type { DataStatusEntry } from '../../../../shared/ipc';

const states = {
  fiable: { label: 'Fiable', token: 'reliable', symbol: '✓' },
  actualizando: { label: 'Actualizando', token: 'updating', symbol: '◌' },
  desactualizado: { label: 'Desactualizado', token: 'stale', symbol: '◷' },
  'no-fiable': { label: 'No fiable', token: 'unreliable', symbol: '!' },
};
export function MarketStatus({
  status,
  simulated,
}: {
  status?: DataStatusEntry;
  simulated: boolean;
}) {
  const state = status ? states[status.state] : null;
  return (
    <div className="market-status" aria-live="polite">
      {state ? (
        <span className={`market-badge market-badge-${state.token}`}>
          <span aria-hidden="true">{state.symbol}</span> {state.label}
        </span>
      ) : (
        <span className="market-badge">Estado pendiente</span>
      )}
      {simulated && <span className="market-badge market-badge-simulated">◇ Datos simulados</span>}
    </div>
  );
}
export function HistoricalProgress({ ticker, active }: { ticker: string; active: boolean }) {
  if (!active) return null;
  return (
    <div className="market-progress" role="status">
      <label htmlFor={`history-${ticker}`}>Descargando histórico de {ticker}…</label>
      <progress id={`history-${ticker}`} aria-label={`Descarga histórica de ${ticker}`} />
      <span>El gráfico se actualizará cuando estén disponibles las velas ajustadas.</span>
    </div>
  );
}
