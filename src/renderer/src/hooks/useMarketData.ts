import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DataStatusEntry,
  GetBarsRequest,
  MacroSeriesSnapshot,
  MarketBarsResult,
  WatchlistItem,
} from '../../../shared/ipc';

export interface MarketDataState {
  watchlist: WatchlistItem[];
  series: MacroSeriesSnapshot[];
  statuses: DataStatusEntry[];
  bars: MarketBarsResult | null;
  loading: boolean;
  error: string | null;
  statusError: string | null;
}

/** Reads IPC snapshots and reconciles background updates; never accesses credentials. */
export function useMarketData(request?: GetBarsRequest) {
  const [state, setState] = useState<MarketDataState>({
    watchlist: [],
    series: [],
    statuses: [],
    bars: null,
    loading: true,
    error: null,
    statusError: null,
  });
  const generation = useRef(0);
  const ticker = request?.ticker;
  const desde = request?.desde;
  const hasta = request?.hasta;
  const reload = useCallback(async () => {
    const version = ++generation.current;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const api = window.tradia;
      const [watchlist, series, statuses, bars] = await Promise.all([
        api.watchlist.list(),
        api.macro.getSeries(),
        api.dataStatus.get().catch(() => null),
        ticker
          ? api.market.getBars({ ticker, ...(desde ? { desde } : {}), ...(hasta ? { hasta } : {}) })
          : Promise.resolve(null),
      ]);
      if (version === generation.current)
        setState({
          watchlist,
          series,
          statuses: statuses ?? [],
          bars,
          loading: false,
          error: null,
          statusError:
            statuses === null
              ? 'No pudimos comprobar el estado del dato. Su fiabilidad está pendiente de verificar.'
              : null,
        });
    } catch {
      if (version === generation.current)
        setState((previous) => ({
          ...previous,
          loading: false,
          error: 'No pudimos consultar los datos. Inténtalo de nuevo.',
        }));
    }
  }, [ticker, desde, hasta]);
  useEffect(() => {
    const offMarket = window.tradia.market.onUpdated(() => void reload());
    const offStatus = window.tradia.dataStatus.onChanged((entry) => {
      // Invalidate an older snapshot so it cannot overwrite this event.
      generation.current++;
      setState((previous) => ({
        ...previous,
        loading: false,
        statuses: [...previous.statuses.filter((item) => item.key !== entry.key), entry],
        series: previous.series.map((series) =>
          entry.key === `macro:${series.id}` ? { ...series, status: entry } : series,
        ),
      }));
      void reload();
    });
    void reload();
    return () => {
      generation.current++;
      offMarket();
      offStatus();
    };
  }, [reload]);
  return { ...state, reload, refreshNow: () => window.tradia.market.refreshNow() };
}
