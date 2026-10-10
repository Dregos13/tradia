// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ModelHealthOverview } from '../../../shared/ai';
import { createSimulatedAdapter } from '../adapters/simulated';
import { useModelHealth } from './useModelHealth';
let adapter: ReturnType<typeof createSimulatedAdapter>;
beforeEach(() => {
  adapter = createSimulatedAdapter();
  window.tradia = adapter.api;
  adapter.emitConnectivity({
    status: 'online',
    lastCheckedAt: null,
    nextRetryAt: null,
    attempt: 0,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('descarta respuestas tardías al perder conexión y retira suscripciones', async () => {
  const value = await adapter.api.ai.health();
  let finish!: (value: ModelHealthOverview) => void;
  vi.spyOn(adapter.api.ai, 'health').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const stopAi = vi.fn();
  const stopConnection = vi.fn();
  const subscribeAi = adapter.api.ai.onChanged;
  const subscribeConnection = adapter.api.connectivity.onChanged;
  vi.spyOn(adapter.api.ai, 'onChanged').mockImplementation((listener) => {
    const off = subscribeAi(listener);
    return () => {
      off();
      stopAi();
    };
  });
  vi.spyOn(adapter.api.connectivity, 'onChanged').mockImplementation((listener) => {
    const off = subscribeConnection(listener);
    return () => {
      off();
      stopConnection();
    };
  });
  const { result, unmount } = renderHook(useModelHealth);
  await waitFor(() => expect(adapter.api.ai.health).toHaveBeenCalled());
  await act(async () => {
    adapter.emitConnectivity({
      status: 'offline',
      lastCheckedAt: null,
      nextRetryAt: null,
      attempt: 1,
    });
    finish(value);
  });
  expect(result.current.overview).toBeNull();
  expect(result.current.offline).toBe(true);
  unmount();
  expect(stopAi).toHaveBeenCalledOnce();
  expect(stopConnection).toHaveBeenCalledOnce();
});
it('recarga solamente por cambios de salud y mantiene la última evidencia tras error', async () => {
  const health = vi.spyOn(adapter.api.ai, 'health');
  let notify!: Parameters<typeof adapter.api.ai.onChanged>[0];
  vi.spyOn(adapter.api.ai, 'onChanged').mockImplementation((listener) => {
    notify = listener;
    return () => {};
  });
  const { result } = renderHook(useModelHealth);
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(health).toHaveBeenCalledOnce();
  const previous = result.current.overview;
  await act(async () => {
    notify({ kind: 'noticias', at: '2026-10-10T12:00:00Z' });
  });
  expect(health).toHaveBeenCalledOnce();
  health.mockRejectedValue(new Error('fuente'));
  await act(async () => {
    notify({ kind: 'salud', at: '2026-10-10T12:00:00Z' });
  });
  expect(health).toHaveBeenCalledTimes(2);
  expect(result.current.overview).toBe(previous);
  expect(result.current.error).toBe('No se pudo calcular la salud de los modelos');
});
