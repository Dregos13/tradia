// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RegimeOverview } from '../../../shared/ai';
import { createSimulatedAdapter } from '../adapters/simulated';
import { useAi } from './useAi';
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
it('descarta respuestas tardías y retira las suscripciones al desmontar', async () => {
  const old = await adapter.api.ai.regimeOverview();
  let resolve!: (value: RegimeOverview) => void;
  vi.spyOn(adapter.api.ai, 'regimeOverview')
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({ ...old, computedAt: '2026-10-10T12:00:00Z' });
  let hook!: ReturnType<typeof renderHook<ReturnType<typeof useAi>, unknown>>;
  await act(async () => {
    hook = renderHook(() => useAi());
  });
  await act(async () => {
    adapter.emitAiChanged('regimen');
  });
  await act(async () => {
    resolve({ ...old, computedAt: '2020-01-01T00:00:00Z' });
  });
  expect(hook.result.current.overview?.computedAt).toBe('2026-10-10T12:00:00Z');
  expect(adapter.listenerCount()).toBe(2);
  hook.unmount();
  expect(adapter.listenerCount()).toBe(0);
});
it('ignora una respuesta iniciada antes de perder conexión', async () => {
  let resolve!: (value: RegimeOverview) => void;
  vi.spyOn(adapter.api.ai, 'regimeOverview').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const old = await createSimulatedAdapter().api.ai.regimeOverview();
  const hook = renderHook(() => useAi());
  await act(async () => {});
  await act(async () => {
    adapter.emitConnectivity({
      status: 'offline',
      lastCheckedAt: null,
      nextRetryAt: null,
      attempt: 1,
    });
    resolve(old);
  });
  expect(hook.result.current.overview).toBeNull();
  expect(hook.result.current.offline).toBe(true);
  expect(hook.result.current.loading).toBe(false);
});
it('presenta fallo de comprobación de conexión y permite recuperarlo', async () => {
  vi.spyOn(adapter.api.connectivity, 'getState').mockRejectedValue(new Error('IPC'));
  const hook = renderHook(() => useAi());
  await act(async () => {});
  expect(hook.result.current.errors).toEqual([
    'No se pudo comprobar la conexión. Reintenta conexión.',
  ]);
  await act(async () => {
    await hook.result.current.reconnect();
  });
  expect(hook.result.current.errors).toEqual([]);
  expect(hook.result.current.overview?.market?.ticker).toBe('SPY');
});
