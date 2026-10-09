import { useCallback } from 'react';
import type {
  CreateStrategyRequest,
  UpdateStrategyRequest,
  SetStrategyStatusRequest,
} from '../../../shared/strategy';
import { useIpcList } from './useIpcList';
const list = () => window.tradia.strategies.list();
export function useStrategies() {
  const state = useIpcList(
    list,
    undefined,
    'No pudimos consultar las estrategias. Inténtalo de nuevo.',
  );
  return {
    ...state,
    strategies: state.items,
    create: async (request: CreateStrategyRequest) => {
      const result = await window.tradia.strategies.create(request);
      await state.reload();
      return result;
    },
    update: async (request: UpdateStrategyRequest) => {
      const result = await window.tradia.strategies.update(request);
      await state.reload();
      return result;
    },
    setStatus: async (request: SetStrategyStatusRequest) => {
      const result = await window.tradia.strategies.setStatus(request);
      await state.reload();
      return result;
    },
  };
}
export function useStrategy(id: number, version?: number) {
  const read = useCallback(async () => {
    const [strategy, latest, history] = await Promise.all([
      window.tradia.strategies.get(version === undefined ? { id } : { id, version }),
      window.tradia.strategies.get({ id }),
      window.tradia.strategies.history(id),
    ]);
    return [{ strategy, latest, history }];
  }, [id, version]);
  const state = useIpcList(
    read,
    undefined,
    'No pudimos cargar la ficha y su historial. Inténtalo de nuevo.',
  );
  return { ...state, ...state.items[0] };
}
