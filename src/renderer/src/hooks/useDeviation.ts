import { useCallback, useEffect, useRef, useState } from 'react';
import type { DeviationPeriod, DeviationReport } from '../../../shared/broker';

export function useDeviation() {
  const [period, setPeriod] = useState<DeviationPeriod>('semanal');
  const [report, setReport] = useState<DeviationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const next = await window.tradia.deviation.report({ period });
      if (version === generation.current) setReport(next);
    } catch {
      if (version === generation.current)
        setError('No se pudo calcular el informe. Comprueba la conexión e inténtalo de nuevo.');
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [period]);
  useEffect(() => {
    void reload();
    return () => {
      generation.current++;
    };
  }, [reload]);
  return {
    period,
    setPeriod,
    report: report?.period === period ? report : null,
    loading,
    error,
    reload,
  };
}
