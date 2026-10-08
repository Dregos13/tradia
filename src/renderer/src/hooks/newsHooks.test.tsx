// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../adapters/simulated';
import { useNews } from './useNews';
import { currentCalendarWeek, useCalendar } from './useCalendar';
import { useSources } from './useSources';
import type { NewsItem } from '../../../shared/ipc';

let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(() => {
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('consulta noticias con filtros estables y recarga con news:updated', async () => {
  const list = vi.spyOn(simulation.api.news, 'list');
  const { result, rerender, unmount } = renderHook(() => useNews({ priority: 'maxima' }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.items).toHaveLength(1);
  rerender();
  expect(list).toHaveBeenCalledTimes(1);
  act(() => simulation.emitNewsUpdated({ newItems: 0, updatedAt: new Date().toISOString() }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  unmount();
  expect(simulation.listenerCount()).toBe(0);
});

it('cubre carga, error y reintento sin perder los datos anteriores', async () => {
  vi.spyOn(simulation.api.news, 'list').mockRejectedValueOnce(new Error('IPC'));
  const { result } = renderHook(() => useNews());
  expect(result.current.loading).toBe(true);
  await waitFor(() => expect(result.current.error).toContain('No pudimos'));
  await act(() => result.current.reload());
  expect(result.current.error).toBeNull();
  expect(result.current.items.length).toBeGreaterThan(0);
});

it('descarta respuestas antiguas cuando cambia el filtro', async () => {
  let resolve!: (items: NewsItem[]) => void;
  vi.spyOn(simulation.api.news, 'list').mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { result, rerender } = renderHook(({ ticker }) => useNews({ ticker }), {
    initialProps: { ticker: 'SPY' },
  });
  rerender({ ticker: 'AAPL' });
  await waitFor(() => expect(result.current.items[0]?.assets).toEqual(['AAPL']));
  await act(async () => resolve([]));
  expect(result.current.items[0]?.assets).toEqual(['AAPL']);
});

it('consulta el rango del calendario y recarga con calendar:updated', async () => {
  const query = { desde: '2026-10-05', hasta: '2026-10-11' };
  const list = vi.spyOn(simulation.api.calendar, 'list').mockResolvedValue([]);
  const { result, unmount } = renderHook(() => useCalendar(query));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(list).toHaveBeenCalledWith(query);
  act(() => simulation.emitCalendarUpdated({ updatedAt: new Date().toISOString() }));
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  unmount();
  expect(simulation.listenerCount()).toBe(0);
});

it('calcula lunes a domingo UTC incluso al cambiar de año', () => {
  expect(currentCalendarWeek(new Date('2027-01-03T23:30:00Z'))).toEqual({
    desde: '2026-12-28',
    hasta: '2027-01-03',
  });
});

it('recarga las fuentes tras altas, cambios, pruebas, bajas y eventos', async () => {
  const { result, unmount } = renderHook(() => useSources());
  await waitFor(() => expect(result.current.loading).toBe(false));
  let id = 0;
  await act(async () => {
    id = (
      await result.current.add({
        name: 'RSS local',
        kind: 'rss',
        connector: 'rss',
        reliability: 'prensa',
        url: 'https://example.com/feed',
      })
    ).id;
  });
  expect(result.current.sources).toHaveLength(4);
  await act(() => result.current.update({ id, active: false }));
  expect(result.current.sources.find((source) => source.id === id)?.active).toBe(false);
  await act(async () => {
    expect((await result.current.test({ id })).ok).toBe(true);
  });
  await act(() => result.current.remove(id));
  expect(result.current.sources).toHaveLength(3);
  const list = vi.spyOn(simulation.api.sources, 'list');
  act(() => simulation.emitNewsUpdated({ newItems: 0, updatedAt: new Date().toISOString() }));
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  unmount();
  expect(simulation.listenerCount()).toBe(0);
});

it('los ejemplos del calendario quedan dentro de la semana y declaran su origen simulado', async () => {
  const events = await simulation.api.calendar.list(currentCalendarWeek());
  expect(events).toHaveLength(5);
  expect(events.every((event) => event.origin === 'simulado')).toBe(true);
});
