import type { AddSourceRequest, UpdateSourceRequest, TestSourceRequest } from '../../../shared/ipc';
import { useIpcList } from './useIpcList';

const read = () => window.tradia.sources.list();
// There is no sources:updated channel: polling news also updates source health.
const subscribe = (reload: () => void) => window.tradia.news.onUpdated(reload);
export function useSources() {
  const { items, ...state } = useIpcList(
    read,
    subscribe,
    'No pudimos consultar las fuentes. Inténtalo de nuevo.',
  );
  return {
    ...state,
    sources: items,
    add: async (request: AddSourceRequest) => {
      const result = await window.tradia.sources.add(request);
      await state.reload();
      return result;
    },
    update: async (request: UpdateSourceRequest) => {
      const result = await window.tradia.sources.update(request);
      await state.reload();
      return result;
    },
    remove: async (id: number) => {
      const result = await window.tradia.sources.remove(id);
      await state.reload();
      return result;
    },
    test: async (request: TestSourceRequest) => {
      const result = await window.tradia.sources.test(request);
      await state.reload();
      return result;
    },
  };
}
