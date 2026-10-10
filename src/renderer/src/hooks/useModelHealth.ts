import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelHealthOverview, RetrainResolveRequest } from '../../../shared/ai';

export function useModelHealth() {
  const [overview, setOverview] = useState<ModelHealthOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [instructions, setInstructions] = useState<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(false);
  const disconnected = useRef(false);
  const resolving = useRef(false);
  const reload = useCallback(async () => {
    if (disconnected.current || resolving.current) return;
    const id = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const value = await window.tradia.ai.health();
      if (mounted.current && id === generation.current) setOverview(value);
    } catch {
      if (mounted.current && id === generation.current)
        setError('No se pudo calcular la salud de los modelos');
    } finally {
      if (mounted.current && id === generation.current) setLoading(false);
    }
  }, []);
  const reconnect = useCallback(async () => {
    try {
      const connection = await window.tradia.connectivity.checkNow();
      if (!mounted.current) return;
      disconnected.current = connection.status !== 'online';
      setOffline(disconnected.current);
      if (!disconnected.current) await reload();
    } catch {
      if (mounted.current) setError('No se pudo comprobar la conexión. Reintenta conexión.');
    }
  }, [reload]);
  const resolve = useCallback(async (request: RetrainResolveRequest) => {
    if (disconnected.current || resolving.current) return false;
    resolving.current = true;
    generation.current++;
    setLoading(false);
    setBusy(true);
    setError('');
    try {
      const result = await window.tradia.ai.resolveRetrain(request);
      if (!mounted.current) return false;
      setOverview(
        (current) =>
          current && {
            ...current,
            proposals: current.proposals.map((p) =>
              p.id === result.proposal.id ? result.proposal : p,
            ),
          },
      );
      setInstructions(result.instructions);
      return true;
    } catch {
      if (mounted.current)
        setError('No se pudo resolver la propuesta. Reintenta; no se ha confirmado ningún cambio.');
      return false;
    } finally {
      resolving.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    let connectionVersion = 0;
    const apply = (status: string) => {
      disconnected.current = status !== 'online';
      setOffline(disconnected.current);
      if (disconnected.current) {
        generation.current++;
        setLoading(false);
      } else void reload();
    };
    const offConnection = window.tradia.connectivity.onChanged((state) => {
      connectionVersion++;
      apply(state.status);
    });
    const offAi = window.tradia.ai.onChanged((event) => {
      if (event.kind === 'salud') void reload();
    });
    void window.tradia.connectivity
      .getState()
      .then((state) => {
        if (mounted.current && connectionVersion === 0) apply(state.status);
      })
      .catch(() => {
        if (mounted.current && connectionVersion === 0) {
          setError('No se pudo comprobar la conexión. Reintenta conexión.');
          setLoading(false);
        }
      });
    return () => {
      mounted.current = false;
      generation.current++;
      offConnection();
      offAi();
    };
  }, [reload]);
  return { overview, loading, offline, error, busy, instructions, reload, reconnect, resolve };
}
