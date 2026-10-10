import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelCard, Prediction, RegimeOverview } from '../../../shared/ai';

export function useAi() {
  const [overview, setOverview] = useState<RegimeOverview | null>(null);
  const [predictions, setPredictions] = useState<Prediction[]>([]);
  const [model, setModel] = useState<ModelCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const generation = useRef(0);
  const disconnected = useRef(false);
  const reload = useCallback(async () => {
    if (disconnected.current) return;
    const id = ++generation.current;
    setLoading(true);
    setErrors([]);
    const results = await Promise.allSettled([
      window.tradia.ai.regimeOverview(),
      window.tradia.ai.predictions(),
      window.tradia.ai.modelCard(),
    ]);
    if (id !== generation.current) return;
    const [regime, estimates, card] = results;
    if (regime.status === 'fulfilled') setOverview(regime.value);
    if (estimates.status === 'fulfilled') setPredictions(estimates.value);
    if (card.status === 'fulfilled') setModel(card.value);
    setErrors(
      results.flatMap((result, index) =>
        result.status === 'rejected'
          ? [
              [
                'No se pudo actualizar el régimen.',
                'No se pudieron actualizar las predicciones.',
                'No se pudo verificar la ficha del modelo. El modelo queda no apto hasta resolverlo.',
              ][index]!,
            ]
          : [],
      ),
    );
    setLoading(false);
  }, []);
  const reconnect = useCallback(async () => {
    try {
      const state = await window.tradia.connectivity.checkNow();
      disconnected.current = state.status !== 'online';
      setOffline(disconnected.current);
      if (!disconnected.current) await reload();
    } catch {
      setErrors(['No se pudo comprobar la conexión. Reintenta conexión.']);
    }
  }, [reload]);
  useEffect(() => {
    let active = true;
    let connectionVersion = 0;
    const applyConnection = (status: string) => {
      disconnected.current = status !== 'online';
      setOffline(disconnected.current);
      if (disconnected.current) {
        generation.current++;
        setLoading(false);
      } else void reload();
    };
    const offConnection = window.tradia.connectivity.onChanged((state) => {
      connectionVersion++;
      applyConnection(state.status);
    });
    const offAi = window.tradia.ai.onChanged((event) => {
      if (event.kind === 'regimen' || event.kind === 'prediccion') void reload();
    });
    void window.tradia.connectivity
      .getState()
      .then((state) => {
        if (active && connectionVersion === 0) applyConnection(state.status);
      })
      .catch(() => {
        if (active && connectionVersion === 0) {
          setErrors(['No se pudo comprobar la conexión. Reintenta conexión.']);
          setLoading(false);
        }
      });
    return () => {
      active = false;
      generation.current++;
      offAi();
      offConnection();
    };
  }, [reload]);
  return { overview, predictions, model, loading, offline, errors, reload, reconnect };
}
