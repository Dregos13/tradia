import { useEffect, useState } from 'react';
import type { SystemState } from '../hooks/useSystemState';

export function OfflineBanner({ state }: { state: SystemState }) {
  const offline = state.connectivity?.status === 'offline';
  const retryAt = state.connectivity?.nextRetryAt;
  const [now, setNow] = useState(Date.now);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!offline) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [offline, retryAt]);
  useEffect(() => {
    if (!offline) setError(false);
  }, [offline]);
  const seconds = retryAt ? Math.max(0, Math.ceil((Date.parse(retryAt) - now) / 1000)) : null;
  const retry = async () => {
    setChecking(true);
    setError(false);
    try {
      await window.tradia.connectivity.checkNow();
    } catch {
      setError(true);
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="connection-announcement" role="status" aria-live="polite">
      {offline && (
        <div className="offline-banner">
          <div>
            <strong>Sin conexión: las decisiones están en pausa.</strong>{' '}
            <span aria-live="off">
              {seconds !== null && Number.isFinite(seconds) && seconds > 0
                ? `Reintentando en ${seconds} s.`
                : 'Reintentando ahora…'}
            </span>
            {error && <p>No pudimos comprobar la conexión. Vuelve a intentarlo.</p>}
          </div>
          <button className="button" disabled={checking} onClick={() => void retry()}>
            {checking ? 'Comprobando…' : 'Comprobar ahora'}
          </button>
        </div>
      )}
    </div>
  );
}
