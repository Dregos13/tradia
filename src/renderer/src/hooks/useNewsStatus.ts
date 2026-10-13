import { useCallback, useEffect, useRef, useState } from 'react';
import type { NewsStatus } from '../../../shared/ai';

export function useNewsStatus() {
  const [status, setStatus] = useState<NewsStatus | null>(null);
  const [error, setError] = useState('');
  const version = useRef(0);
  const active = useRef(false);
  const refresh = useCallback(async () => {
    const generation = ++version.current;
    try {
      const value = await window.tradia.ai.newsStatus();
      if (active.current && generation === version.current) {
        setStatus(value);
        setError('');
      }
    } catch {
      if (active.current && generation === version.current)
        setError('No se pudo consultar el estado de la suscripción. Prueba de nuevo.');
    }
  }, []);
  useEffect(() => {
    active.current = true;
    const off = window.tradia.ai.onNewsStatusChanged((value) => {
      version.current++;
      setStatus(value);
      setError('');
    });
    void refresh();
    return () => {
      active.current = false;
      version.current++;
      off();
    };
  }, [refresh]);
  return { status, error, refresh };
}
