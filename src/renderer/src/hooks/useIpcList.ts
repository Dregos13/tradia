import { useCallback, useEffect, useRef, useState } from 'react';

/** Ignore stale IPC responses and release subscriptions when the query changes. */
export function useIpcList<T>(
  read: () => Promise<T[]>,
  subscribe: ((reload: () => void) => () => void) | undefined,
  errorMessage: string,
) {
  const [state, setState] = useState({
    items: [] as T[],
    loading: true,
    error: null as string | null,
  });
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const version = ++generation.current;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const items = await read();
      if (version === generation.current) setState({ items, loading: false, error: null });
    } catch {
      if (version === generation.current)
        setState((previous) => ({ ...previous, loading: false, error: errorMessage }));
    }
  }, [read, errorMessage]);
  useEffect(() => {
    const off = subscribe?.(() => void reload());
    void reload();
    return () => {
      generation.current++;
      off?.();
    };
  }, [reload, subscribe]);
  return { ...state, reload };
}
