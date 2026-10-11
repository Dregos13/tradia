import { useSyncExternalStore } from 'react';
import type { DataFreshnessSummary, TradiaApi } from '../../../shared/ipc';

interface Snapshot {
  summary: DataFreshnessSummary | null;
  error: boolean;
}
// One snapshot and one push subscription per adapter, shared by every surface.
const stores = new WeakMap<TradiaApi, ReturnType<typeof createStore>>();
function createStore(api: TradiaApi) {
  let snapshot: Snapshot = { summary: null, error: false };
  let generation = 0;
  let unsubscribe: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const reload = async () => {
    const version = ++generation;
    try {
      const summary = await api.dataStatus.freshness();
      if (version !== generation) return;
      snapshot = { summary, error: false };
    } catch {
      if (version !== generation) return;
      snapshot = { ...snapshot, error: true };
    }
    listeners.forEach((listener) => listener());
  };
  return {
    getSnapshot: () => snapshot,
    reload,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        unsubscribe = api.dataStatus.onChanged(() => void reload());
        void reload();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          generation++;
          unsubscribe?.();
          unsubscribe = undefined;
        }
      };
    },
  };
}
export function useDataFreshness() {
  const api = window.tradia;
  let store = stores.get(api);
  if (!store) {
    store = createStore(api);
    stores.set(api, store);
  }
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { ...snapshot, reload: store.reload };
}
