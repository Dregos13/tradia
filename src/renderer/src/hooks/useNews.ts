import { useCallback } from 'react';
import type { NewsListQuery } from '../../../shared/ipc';
import { useIpcList } from './useIpcList';

const subscribe = (reload: () => void) => window.tradia.news.onUpdated(reload);
export function useNews(query: NewsListQuery = {}) {
  const { desde, hasta, priority, reliability, ticker, confirmed, sourceId, limit } = query;
  const read = useCallback(
    () =>
      window.tradia.news.list({
        ...(desde !== undefined ? { desde } : {}),
        ...(hasta !== undefined ? { hasta } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(reliability !== undefined ? { reliability } : {}),
        ...(ticker !== undefined ? { ticker } : {}),
        ...(confirmed !== undefined ? { confirmed } : {}),
        ...(sourceId !== undefined ? { sourceId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      }),
    [desde, hasta, priority, reliability, ticker, confirmed, sourceId, limit],
  );
  const { items, ...state } = useIpcList(
    read,
    subscribe,
    'No pudimos consultar las noticias. Inténtalo de nuevo.',
  );
  return { ...state, items };
}
