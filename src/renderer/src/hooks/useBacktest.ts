import { useCallback, useEffect, useRef, useState } from 'react';
import type { BacktestProgressEvent, BacktestRunRequest } from '../../../shared/backtest';
import { useIpcList } from './useIpcList';
export function useBacktestHistory(strategyId: number, version: number) {
  const read = useCallback(
    () => window.tradia.backtest.list({ strategyId, version }),
    [strategyId, version],
  );
  return useIpcList(read, undefined, 'No pudimos cargar el historial. Reintenta la consulta.');
}
export function useBacktestReport(id: number) {
  const read = useCallback(async () => [await window.tradia.backtest.get(id)], [id]);
  const state = useIpcList(read, undefined, 'No pudimos cargar el informe. Reintenta la consulta.');
  return { ...state, report: state.items[0] };
}
export function useBacktest(strategyId: number, version: number) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState<BacktestProgressEvent | null>(null);
  const active = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ticket = useRef<string | null>(null);
  useEffect(
    () =>
      window.tradia.backtest.onProgress((event) => {
        if (!active.current || event.strategyId !== strategyId) return;
        if (ticket.current && ticket.current !== event.ticket) return;
        ticket.current = event.ticket;
        setProgress(event);
      }),
    [strategyId],
  );
  const launch = async (request?: BacktestRunRequest) => {
    if (active.current) return;
    active.current = true;
    ticket.current = null;
    setBusy(true);
    setError('');
    setProgress(null);
    try {
      const report = request
        ? await window.tradia.backtest.run(request)
        : await window.tradia.backtest.runFinalTest({ strategyId, version });
      if (!mounted.current) return;
      window.location.hash = `estrategias/${strategyId}/backtest/${report.id}`;
    } catch (cause) {
      if (!mounted.current) return;
      setError(
        `No se pudo completar el backtest. ${cause instanceof Error ? cause.message : 'Revisa la configuración y reintenta.'}`,
      );
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return { busy, error, progress, launch };
}
