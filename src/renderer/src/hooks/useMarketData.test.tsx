// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../adapters/simulated';
import { useMarketData } from './useMarketData';
let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(() => {
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('carga instantáneas y reconcilia velas y estados recibidos en segundo plano', async () => {
  await simulation.api.watchlist.add('AAPL');
  const getBars = vi.spyOn(simulation.api.market, 'getBars');
  const { result, unmount } = renderHook(() =>
    useMarketData({ ticker: 'AAPL', desde: '2025-01-01' }),
  );
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.watchlist[0]?.ticker).toBe('AAPL');
  expect(result.current.bars?.bars.length).toBeGreaterThan(0);
  expect(result.current.series).toHaveLength(6);
  const entry = {
    key: 'ticker:AAPL',
    state: 'no-fiable' as const,
    lastOkAt: null,
    updatedAt: '2026-10-08T12:00:00Z',
    consecutiveFailures: 1,
    reason: 'Proveedor caído',
  };
  act(() => {
    simulation.emitDataStatus(entry);
  });
  await waitFor(() => expect(result.current.statuses).toContainEqual(entry));
  const calls = getBars.mock.calls.length;
  act(() => {
    simulation.emitMarketUpdated({
      ticker: 'AAPL',
      source: 'simulated',
      lastDate: '2026-10-08',
      updatedAt: '2026-10-08T12:00:00Z',
    });
  });
  await waitFor(() => expect(getBars.mock.calls.length).toBeGreaterThan(calls));
  unmount();
  const afterUnmount = getBars.mock.calls.length;
  act(() => {
    simulation.emitMarketUpdated({
      ticker: 'AAPL',
      source: 'simulated',
      lastDate: '2026-10-09',
      updatedAt: '2026-10-09T12:00:00Z',
    });
  });
  expect(getBars.mock.calls.length).toBe(afterUnmount);
});
it('expone errores y permite reintentar sin mostrar errores IPC sin filtrar', async () => {
  const list = vi
    .spyOn(simulation.api.watchlist, 'list')
    .mockRejectedValueOnce(new Error('detalle privado'));
  const { result } = renderHook(() => useMarketData());
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toBe('No pudimos consultar los datos. Inténtalo de nuevo.');
  await act(async () => {
    await result.current.reload();
  });
  expect(result.current.error).toBeNull();
  expect(list).toHaveBeenCalledTimes(2);
});

it('conserva las velas si falla el estado del dato, sin afirmar que son fiables', async () => {
  await simulation.api.watchlist.add('AAPL');
  vi.spyOn(simulation.api.dataStatus, 'get').mockRejectedValueOnce(
    new Error('handler no disponible'),
  );
  const { result } = renderHook(() => useMarketData({ ticker: 'AAPL' }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.bars?.bars.length).toBeGreaterThan(0);
  expect(result.current.watchlist).toHaveLength(1);
  expect(result.current.statuses).toEqual([]);
  expect(result.current.statusError).toContain('fiabilidad está pendiente');
  expect(result.current.error).toBeNull();
});
