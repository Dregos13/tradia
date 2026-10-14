import { useRef, useState } from 'react';
import { ENGINE_DISPLAY_NAMES, getNewsSubscriptionCopy } from '../../../../shared/newsSubscription';
import type { NewsEngine, NewsStatus } from '../../../../shared/ai';
import { useNewsStatus } from '../../hooks/useNewsStatus';
import './subscription.css';

type Props = {
  status: NewsStatus | null;
  error: string;
  busy: boolean;
  onRetry: () => void;
  context: 'noticias' | 'ajustes';
  canRetry?: boolean;
  engine?: NewsEngine;
};

export function SubscriptionNotice({
  status,
  error,
  busy,
  onRetry,
  context,
  canRetry = true,
  engine,
}: Props) {
  const retried = useRef(false);
  const failed = status?.provider === 'suscripcion' && status.state !== 'ok';
  if (!failed && !error && !busy && !retried.current) return null;
  const activeEngine =
    engine && engine !== 'local'
      ? engine
      : status?.engine && status.engine !== 'local'
        ? status.engine
        : 'suscripcion-claude';
  const engineName = ENGINE_DISPLAY_NAMES[activeEngine] ?? 'Claude Code';
  const copy = failed
    ? getNewsSubscriptionCopy(status.state as Exclude<NewsStatus['state'], 'ok'>, activeEngine, {
        context,
      })
    : null;
  const step = copy?.step ?? status?.message;

  return (
    <div
      role="status"
      aria-label="Estado de la suscripción"
      aria-live="polite"
      aria-busy={busy}
      className={`subscription-notice ${busy || status?.state === 'tope-diario' ? 'subscription-paused' : failed || error ? 'subscription-failed' : 'subscription-recovered'}`}
    >
      <div>
        <strong>
          {busy
            ? 'Comprobando la suscripción…'
            : error ||
              copy?.title ||
              (status?.provider === 'suscripcion'
                ? `Suscripción recuperada · los nuevos titulares volverán a analizarse con ${engineName}.`
                : 'Analizador local seleccionado')}
        </strong>
        {busy ? (
          <p>
            Los titulares siguen visibles. No se enviará otra comprobación hasta que termine esta.
          </p>
        ) : (
          step && <p>{step}</p>
        )}
      </div>
      <button
        className="button"
        type="button"
        aria-disabled={busy || !canRetry}
        onClick={() => {
          if (busy || !canRetry) return;
          retried.current = true;
          onRetry();
        }}
      >
        {busy ? 'Probando…' : 'Probar de nuevo'}
      </button>
    </div>
  );
}

export function NewsSubscriptionNotice() {
  const { status, error, refresh } = useNewsStatus();
  const [busy, setBusy] = useState(false);
  const [testError, setTestError] = useState('');
  const pending = useRef(false);
  async function retry() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setTestError('');
    try {
      await window.tradia.ai.testLlm();
      await refresh();
    } catch {
      setTestError('No se pudo comprobar la suscripción. Comprueba la conexión y vuelve a probar.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <SubscriptionNotice
      status={status}
      error={error || testError}
      busy={busy}
      onRetry={() => void retry()}
      context="noticias"
    />
  );
}
