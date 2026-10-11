import { useEffect, useState } from 'react';
import { DataFreshness, sessionDateLabel } from '../DataFreshness';
import { useDataFreshness } from '../../hooks/useDataFreshness';
import type { SystemState } from '../../hooks/useSystemState';
import type { DashboardState } from './useDashboard';
import { timestamp } from './model';
export function ConnectionBlock({ system, state }: { system: SystemState; state: DashboardState }) {
  const { summary } = useDataFreshness();
  const [lastClose, setLastClose] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void window.tradia.watchlist
      .list()
      .then(async (watchlist) => {
        const results = await Promise.allSettled(
          watchlist.map((item) =>
            window.tradia.market.getBars({
              ticker: item.ticker,
              ...(summary?.expectedSessionDate ? { desde: summary.expectedSessionDate } : {}),
            }),
          ),
        );
        const dates = results
          .flatMap((result) =>
            result.status === 'fulfilled' ? result.value.bars.map((bar) => bar.date) : [],
          )
          .sort();
        if (active) setLastClose(dates.at(-1) ?? null);
      })
      .catch(() => {
        if (active) setLastClose(null);
      });
    return () => {
      active = false;
    };
  }, [summary?.updatedAt]);
  const status = system.connectionError
    ? 'No disponible'
    : system.connectivity?.status === 'online'
      ? 'En línea'
      : system.connectivity?.status === 'offline'
        ? 'Sin conexión'
        : 'Comprobando…';
  const health = (prefix: string) => {
    const providerKeys =
      prefix === 'ticker:'
        ? ['provider:tiingo', 'provider:simulated']
        : ['provider:fred', 'provider:macro-simulated'];
    const entries = (state.statuses.data ?? []).filter(
      (row) => row.key.startsWith(prefix) || providerKeys.includes(row.key),
    );
    return entries.some((row) => row.state === 'no-fiable')
      ? 'No disponible'
      : entries.some((row) => row.state === 'desactualizado')
        ? 'Con retraso'
        : entries.length && entries.every((row) => row.state === 'fiable')
          ? 'Disponible'
          : entries.length
            ? 'Sin evaluar'
            : 'Sin configurar';
  };
  const latest = (prefix: string) =>
    summary?.items
      .filter(
        (item) =>
          item.key.startsWith(prefix) ||
          item.key === (prefix === 'ticker:' ? 'provider:tiingo' : 'provider:fred'),
      )
      .map((item) => item.lastDataDate)
      .filter((date): date is string => !!date)
      .sort()
      .at(-1) ?? null;
  return (
    <>
      <DataFreshness offline={system.connectivity?.status === 'offline'} />
      <p className="dashboard-connection">
        <strong>{status}</strong>
      </p>
      <div className="dashboard-row">
        <div>
          <strong>Precios · {providerName(state, false)}</strong>
          <p>Último cierre {sessionDateLabel(latest('ticker:') ?? lastClose)}</p>
        </div>
        <span>{health('ticker:')}</span>
      </div>
      <div className="dashboard-row">
        <div>
          <strong>Macro · {providerName(state, true)}</strong>
          <p>
            Última observación{' '}
            {sessionDateLabel(
              latest('macro:') ??
                state.macro.data
                  ?.flatMap((series) => series.observations.map((point) => point.date))
                  .sort()
                  .at(-1) ??
                null,
            )}
          </p>
        </div>
        <span>{health('macro:')}</span>
      </div>
      {(state.sources.data ?? []).map((source) => (
        <div className="dashboard-row" key={source.id}>
          <div>
            <strong>Noticias · {source.name}</strong>
            <p>{timestamp(source.lastFetchedAt)}</p>
          </div>
          <span>
            {!source.active
              ? 'En pausa'
              : source.lastStatus === 'error'
                ? 'No disponible'
                : source.lastFetchedAt &&
                    Date.now() - Date.parse(source.lastFetchedAt) > source.intervalSeconds * 2000
                  ? 'Con retraso'
                  : source.lastStatus === 'ok'
                    ? 'Disponible'
                    : 'Sin evaluar'}
          </span>
        </div>
      ))}
      {!state.sources.data?.length && (
        <p>
          No hay fuentes de noticias. <a href="#fuentes">Configurar fuentes</a>
        </p>
      )}
    </>
  );
}

function providerName(state: DashboardState, macro: boolean) {
  const entries = state.statuses.data ?? [];
  const names: Record<string, string> = macro
    ? { 'provider:fred': 'FRED', 'provider:macro-simulated': 'Simulado' }
    : { 'provider:tiingo': 'Tiingo', 'provider:simulated': 'Simulado' };
  return (
    entries
      .filter((entry) => entry.key in names)
      .map((entry) => names[entry.key])
      .join(' / ') || 'Sin configurar'
  );
}
