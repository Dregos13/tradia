import { useCallback, useEffect, useRef, useState } from 'react';
import type { JournalListQuery, JournalPage } from '../../../shared/journal';

export const JOURNAL_PAGE_SIZE = 20;
export function useJournal() {
  const [query, setQuery] = useState<JournalListQuery>({});
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<JournalPage>({
    entries: [],
    total: 0,
    limit: JOURNAL_PAGE_SIZE,
    offset: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const version = ++generation.current;
    setLoading(true);
    setError(false);
    try {
      const result = await window.tradia.journal.list({
        ...query,
        offset,
        limit: JOURNAL_PAGE_SIZE,
      });
      if (version !== generation.current) return;
      if (offset > 0 && offset >= result.total) {
        setOffset(Math.max(0, Math.ceil(result.total / JOURNAL_PAGE_SIZE) - 1) * JOURNAL_PAGE_SIZE);
      } else setPage(result);
    } catch {
      if (version === generation.current) setError(true);
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [query, offset]);
  useEffect(() => {
    const off = window.tradia.journal.onUpdated(() => void reload());
    void reload();
    return () => {
      generation.current++;
      off();
    };
  }, [reload]);
  const apply = (filters: JournalListQuery) => {
    setQuery(filters);
    setOffset(0);
    setSavedPath(null);
    setExportError(false);
  };
  const exportCsv = async () => {
    setExporting(true);
    setExportError(false);
    setSavedPath(null);
    try {
      const result = await window.tradia.journal.exportCsv({ query });
      if (!result.canceled) {
        if (!result.path) throw new Error('Missing export path');
        setSavedPath(result.path);
      }
    } catch {
      setExportError(true);
    } finally {
      setExporting(false);
    }
  };
  return {
    ...page,
    query,
    offset,
    setOffset,
    loading,
    error,
    reload,
    apply,
    exporting,
    exportError,
    savedPath,
    exportCsv,
  };
}
