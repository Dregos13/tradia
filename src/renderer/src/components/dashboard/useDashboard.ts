import { useCallback, useEffect, useRef, useState } from 'react';
import type { DataStatusEntry, MacroSeriesSnapshot, NewsSource } from '../../../../shared/ipc';
import type { JournalEntry } from '../../../../shared/journal';
import type { KillSwitchState } from '../../../../shared/risk';
import type {
  PaperPortfolioOverview,
  Signal,
  SignalStrategyState,
} from '../../../../shared/signals';

export interface Snapshot<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
}
export interface DashboardData {
  signals: Signal[];
  strategies: SignalStrategyState[];
  portfolio: PaperPortfolioOverview;
  macro: MacroSeriesSnapshot[];
  sources: NewsSource[];
  statuses: DataStatusEntry[];
  stop: KillSwitchState;
  contradictions: JournalEntry[];
}
export type DashboardState = { [K in keyof DashboardData]: Snapshot<DashboardData[K]> };
const empty = () => ({ data: null, loading: true, error: false });
const initial = (): DashboardState => ({
  signals: empty(),
  strategies: empty(),
  portfolio: empty(),
  macro: empty(),
  sources: empty(),
  statuses: empty(),
  stop: empty(),
  contradictions: empty(),
});

/** Partial failures preserve known data. Generations prevent stale IPC responses after events/unmount. */
export function useDashboard(offline = false) {
  const offlineRef = useRef(offline);
  offlineRef.current = offline;
  const [state, setState] = useState(initial);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const generation = useRef(0);
  const latestStop = useRef<KillSwitchState | null>(null);
  const statusEvents = useRef(new Map<string, DataStatusEntry>());
  const signalEvents = useRef(new Map<number, Signal>());
  const reload = useCallback(async () => {
    const version = ++generation.current;
    setState(
      (previous) =>
        Object.fromEntries(
          Object.entries(previous).map(([key, value]) => [
            key,
            { ...value, loading: value.data === null },
          ]),
        ) as DashboardState,
    );
    const api = window.tradia;
    let succeeded = false;
    const load = async <K extends keyof DashboardData>(
      key: K,
      read: () => Promise<DashboardData[K]>,
    ) => {
      try {
        let data = await read();
        if (version !== generation.current) return;
        succeeded = true;
        if (key === 'stop' && latestStop.current) data = latestStop.current as DashboardData[K];
        if (key === 'statuses') {
          const merged = new Map((data as DataStatusEntry[]).map((entry) => [entry.key, entry]));
          statusEvents.current.forEach((entry) => merged.set(entry.key, entry));
          data = [...merged.values()] as DashboardData[K];
        }
        if (key === 'macro')
          data = (data as MacroSeriesSnapshot[]).map((series) => ({
            ...series,
            status: statusEvents.current.get(`macro:${series.id}`) ?? series.status,
          })) as DashboardData[K];
        if (key === 'signals') {
          const merged = new Map((data as Signal[]).map((signal) => [signal.id, signal]));
          signalEvents.current.forEach((signal) => merged.set(signal.id, signal));
          data = [...merged.values()]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
            .slice(0, 20) as DashboardData[K];
        }
        setState((previous) =>
          offlineRef.current && key !== 'stop' && previous[key].data !== null
            ? previous
            : { ...previous, [key]: { data, loading: false, error: false } },
        );
      } catch {
        if (version === generation.current)
          setState((previous) => ({
            ...previous,
            [key]: { ...previous[key], loading: false, error: true },
          }));
      }
    };
    await Promise.all([
      load('signals', () => api.signals.list({ limit: 20 })),
      load('strategies', () => api.signals.strategies()),
      load('portfolio', () => api.risk.getPortfolio()),
      load('stop', () => api.risk.getKillSwitch()),
      load('macro', () => api.macro.getSeries()),
      load('sources', () => api.sources.list()),
      load('statuses', () => api.dataStatus.get()),
      load(
        'contradictions',
        async () => (await api.journal.list({ type: 'contradiccion', limit: 20 })).entries,
      ),
    ]);
    if (version === generation.current && succeeded && !offlineRef.current)
      setUpdatedAt(new Date().toISOString());
  }, []);
  useEffect(() => {
    const api = window.tradia;
    const refresh = () => {
      void reload();
    };
    const off = [
      api.signals.onNew(({ signal }) => {
        if (offlineRef.current) return;
        signalEvents.current.set(signal.id, signal);
        if (signalEvents.current.size > 20)
          signalEvents.current.delete(signalEvents.current.keys().next().value!);
        setState((previous) => ({
          ...previous,
          signals: {
            data: [
              signal,
              ...(previous.signals.data ?? []).filter((row) => row.id !== signal.id),
            ].slice(0, 20),
            loading: false,
            error: false,
          },
        }));
        refresh();
      }),
      api.risk.onChanged((overview) => {
        latestStop.current = overview.killSwitch;
        setState((previous) => ({
          ...previous,
          stop: { data: overview.killSwitch, loading: false, error: false },
        }));
        refresh();
      }),
      api.risk.onVetoed(refresh),
      api.market.onUpdated(refresh),
      api.dataStatus.onChanged((entry) => {
        if (offlineRef.current) return;
        statusEvents.current.set(entry.key, entry);
        refresh();
      }),
      api.news.onUpdated(refresh),
      api.journal.onUpdated(refresh),
    ];
    refresh();
    return () => {
      generation.current++;
      off.forEach((unsubscribe) => unsubscribe());
      signalEvents.current.clear();
    };
  }, [reload]);
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) void reload();
    wasOffline.current = offline;
  }, [offline, reload]);
  return { state, updatedAt, reload };
}
