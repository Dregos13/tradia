import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrokerOrder, ReconcileStatusResult } from '../../../shared/broker';

export function useOrders() {
  const [orders, setOrders] = useState<BrokerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const generation = useRef(0);
  const updates = useRef(new Map<number, BrokerOrder>());
  const update = useCallback((order: BrokerOrder) => {
    updates.current.set(order.id, order);
    setOrders((previous) => [order, ...previous.filter((row) => row.id !== order.id)]);
    setUpdatedAt(new Date().toISOString());
  }, []);
  const reload = useCallback(async () => {
    const version = ++generation.current;
    updates.current.clear();
    setLoading(true);
    setError(null);
    try {
      const rows: BrokerOrder[] = [];
      let page: BrokerOrder[];
      do {
        page = await window.tradia.orders.list({ limit: 500, offset: rows.length });
        rows.push(...page);
      } while (page.length === 500 && version === generation.current);
      if (version !== generation.current) return;
      const merged = new Map(rows.map((row) => [row.id, row]));
      updates.current.forEach((row) => merged.set(row.id, row));
      setOrders([...merged.values()]);
      setUpdatedAt(new Date().toISOString());
    } catch {
      if (version === generation.current)
        setError('No se pudieron actualizar las órdenes. Inténtalo de nuevo.');
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    const off = window.tradia.broker.onOrderUpdated(update);
    void reload();
    return () => {
      generation.current++;
      off();
    };
  }, [reload, update]);
  return { orders, loading, error, updatedAt, reload, update };
}

export function useReconciliation() {
  const [status, setStatus] = useState<ReconcileStatusResult>({
    lastRun: null,
    openDiscrepancies: [],
  });
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const revision = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(false);
  const reload = useCallback(async () => {
    const version = ++generation.current;
    const before = revision.current;
    try {
      const next = await window.tradia.reconcile.status();
      if (version === generation.current) {
        setStatus((previous) =>
          before === revision.current
            ? next
            : { ...next, openDiscrepancies: previous.openDiscrepancies },
        );
        setError(null);
      }
    } catch {
      if (version === generation.current)
        setError('No se pudo consultar la conciliación. Inténtalo de nuevo.');
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const off = window.tradia.reconcile.onDiscrepancy((event) => {
      revision.current++;
      setStatus((previous) => ({ ...previous, openDiscrepancies: event.discrepancies }));
      void reload();
    });
    void reload();
    return () => {
      mounted.current = false;
      generation.current++;
      off();
    };
  }, [reload]);
  const run = async () => {
    if (busy.current) return;
    busy.current = true;
    setRunning(true);
    setError(null);
    try {
      const lastRun = await window.tradia.reconcile.run();
      if (!mounted.current) return;
      if (mounted.current) setStatus((previous) => ({ ...previous, lastRun }));
      await reload();
    } catch {
      if (mounted.current) setError('No se pudo conciliar con el broker. Inténtalo de nuevo.');
    } finally {
      busy.current = false;
      if (mounted.current) setRunning(false);
    }
  };
  return { ...status, loading, running, error, reload, run };
}
export type ReconciliationState = ReturnType<typeof useReconciliation>;
