import { useCallback, useEffect, useRef, useState } from 'react';
import type { LiveState } from '../../../../shared/live';

/** Subscribe before reading: a late initial snapshot must not hide a live event. */
export function useLiveState() {
  const [state, setState] = useState<LiveState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const revision = useRef(0);
  const accept = useCallback((next: LiveState) => {
    revision.current++;
    if (!mounted.current) return;
    setState(next);
    setLoading(false);
    setError('');
  }, []);
  const reload = useCallback(async () => {
    const version = ++revision.current;
    setLoading(true);
    setError('');
    try {
      const next = await window.tradia.live.state();
      if (mounted.current && version === revision.current) accept(next);
    } catch {
      if (mounted.current && version === revision.current)
        setError('No se pudo consultar el modo real. Reintenta para verificar su estado.');
    } finally {
      if (mounted.current && version === revision.current) setLoading(false);
    }
  }, [accept]);
  useEffect(() => {
    mounted.current = true;
    const unsubscribe = window.tradia.live.onChanged(accept);
    void reload();
    window.addEventListener('focus', reload);
    return () => {
      mounted.current = false;
      revision.current++;
      unsubscribe();
      window.removeEventListener('focus', reload);
    };
  }, [accept, reload]);
  return { state, loading, error, reload, accept };
}
