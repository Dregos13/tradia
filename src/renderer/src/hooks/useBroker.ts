import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrokerCredentials, BrokerStatus } from '../../../shared/broker';

export function useBroker() {
  const [status, setStatus] = useState<BrokerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const mounted = useRef(false);
  const reload = useCallback(async () => {
    if (locked.current) return;
    setLoading(true);
    setError('');
    try {
      const next = await window.tradia.broker.status();
      if (mounted.current) setStatus(next);
    } catch {
      if (mounted.current) setError('No se pudo consultar la cuenta paper. Inténtalo de nuevo.');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void reload();
    window.addEventListener('focus', reload);
    return () => {
      mounted.current = false;
      window.removeEventListener('focus', reload);
    };
  }, [reload]);
  async function run(action: () => Promise<BrokerStatus>, credentials?: BrokerCredentials) {
    if (locked.current) return false;
    locked.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await action();
      if (!mounted.current) return false;
      setStatus(next);
      if (next.error) {
        setError(safeReason(next.error, credentials));
        return false;
      }
      return true;
    } catch (cause) {
      if (mounted.current)
        setError(safeReason(cause instanceof Error ? cause.message : '', credentials));
      return false;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return {
    status,
    loading,
    busy,
    error,
    reload,
    connect: async (credentials: BrokerCredentials) => {
      let clearDraft = false;
      const ok = await run(async () => {
        try {
          const tested = await window.tradia.broker.test(credentials);
          if (!tested.ok)
            throw new Error(
              tested.error ??
                'No se pudo autenticar la cuenta paper. Revisa la clave y el secreto.',
            );
          const next = await window.tradia.broker.connect(credentials);
          if (next.state !== 'conectada')
            throw new Error(next.error ?? 'No se pudo conectar la cuenta paper.');
          return next;
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : '';
          clearDraft =
            /live|no corresponden a una cuenta paper|llavero|keyring|kwallet|safeStorage|cifrad/i.test(
              reason,
            );
          throw cause;
        }
      }, credentials);
      return { ok, clearDraft: ok || clearDraft };
    },
    test: () =>
      run(async () => {
        const tested = await window.tradia.broker.test();
        if (!tested.ok)
          throw new Error(
            tested.error ??
              'No se pudo contactar con Alpaca Paper. Comprueba la conexión e inténtalo de nuevo.',
          );
        return window.tradia.broker.status();
      }),
    disconnect: () => run(() => window.tradia.broker.disconnect()),
    setExecution: (enabled: boolean) =>
      run(async () => {
        const saved = await window.tradia.settings.set({ brokerExecutionEnabled: enabled });
        if (!status) throw new Error('Cuenta paper no disponible.');
        return { ...status, executionEnabled: saved.brokerExecutionEnabled };
      }),
  };
}

function safeReason(reason: string, credentials?: BrokerCredentials) {
  let message = reason || 'No se pudo actualizar la cuenta paper. Inténtalo de nuevo.';
  for (const value of Object.values(credentials ?? {}))
    if (value) message = message.split(value).join('[oculto]');
  return message;
}
