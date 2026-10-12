import { useRef, useState } from 'react';
import { NEWS_SUBSCRIPTION_COPY } from '../../../../shared/newsSubscription';
import type { NewsStatus } from '../../../../shared/ai';
import { useNewsStatus } from '../../hooks/useNewsStatus';
import './subscription.css';

type Props = {
  status: NewsStatus | null;
  error: string;
  busy: boolean;
  onRetry: () => void;
  context: 'noticias' | 'ajustes';
  canRetry?: boolean;
};

export function SubscriptionNotice({
  status,
  error,
  busy,
  onRetry,
  context,
  canRetry = true,
}: Props) {
  const retried = useRef(false);
  const failed = status?.provider === 'suscripcion' && status.state !== 'ok';
  if (!failed && !error && !busy && !retried.current) return null;
  const copy = failed
    ? NEWS_SUBSCRIPTION_COPY[status.state as Exclude<NewsStatus['state'], 'ok'>]
    : null;
  const step =
    context === 'noticias'
      ? copy?.step
          .replace('en este ajuste', 'en Ajustes')
          .replace(
            /Mientras tanto, se usa el analizador local\.|Hasta entonces se usa el analizador local\./,
            'Mientras tanto, las noticias se analizan con el analizador local.',
          )
      : copy?.step;
  return (
    <div
      role="status"
      aria-label="Estado de la suscripción"
      aria-busy={busy}
      className={`subscription-notice ${busy || status?.state === 'tope-diario' ? 'subscription-paused' : failed || error ? 'subscription-failed' : 'subscription-recovered'}`}
    >
      <div>
        <strong>
          {busy
            ? 'Comprobando la suscripción…'
            : error ||
              copy?.title ||
              'Suscripción recuperada · los nuevos titulares volverán a analizarse con Claude Code.'}
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
