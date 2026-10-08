import { useEffect, useRef, useState } from 'react';
import type { DataStatusEntry, MarketRefreshRejection } from '../../../shared/ipc';

const providers: Record<string, string> = {
  tiingo: 'Tiingo',
  fred: 'FRED',
  simulated: 'Proveedor simulado',
  'macro-simulated': 'Proveedor macro simulado',
};
const rejections: Record<MarketRefreshRejection, string> = {
  'sin-conexion': 'Sin conexión. Reintenta cuando vuelva internet.',
  'sin-proveedor': 'Configura el proveedor en Ajustes para actualizar.',
  'sin-activos': 'Añade un activo a tu lista para actualizar.',
  'en-curso': 'Ya hay una actualización en curso.',
};
export function lastCorrectDate(value: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return 'No hay un dato correcto registrado.';
  return (
    new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value)) + ' (Madrid)'
  );
}

/** Global provider health, independent of the selected page and notification permission. */
export function ProviderBanner() {
  const [entries, setEntries] = useState<DataStatusEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const pending = useRef(false);
  useEffect(() => {
    let active = true;
    const events = new Map<string, DataStatusEntry>();
    const off = window.tradia.dataStatus.onChanged((entry) => {
      events.set(entry.key, entry);
      setEntries((previous) => [...previous.filter((item) => item.key !== entry.key), entry]);
      setMessage('');
    });
    void window.tradia.dataStatus
      .get()
      .then((snapshot) => {
        if (!active) return;
        const merged = new Map(snapshot.map((entry) => [entry.key, entry]));
        events.forEach((entry, key) => merged.set(key, entry));
        setEntries([...merged.values()]);
      })
      .catch(() => {
        /* Local surfaces expose status retrieval failures. */
      });
    return () => {
      active = false;
      off();
    };
  }, []);
  const affected = entries.filter(
    (entry) =>
      entry.key.startsWith('provider:') &&
      (entry.state === 'no-fiable' || entry.state === 'desactualizado'),
  );
  if (!affected.length) return null;
  const retry = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage('');
    try {
      const result = await window.tradia.market.refreshNow();
      setMessage(
        result.accepted
          ? 'Actualización solicitada. Esperando datos verificados.'
          : result.reason
            ? rejections[result.reason]
            : 'No se pudo iniciar la actualización.',
      );
    } catch {
      setMessage('No pudimos iniciar la actualización. Inténtalo de nuevo.');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="provider-banners">
      {affected.map((entry) => (
        <aside
          className="provider-banner"
          role="alert"
          key={entry.key}
          aria-label={`Estado de ${providers[entry.key.slice(9)] ?? entry.key.slice(9)}`}
        >
          <div>
            <strong>
              {providers[entry.key.slice(9)] ?? entry.key.slice(9)} ·{' '}
              {entry.state === 'no-fiable' ? 'No fiable' : 'Desactualizado'}
            </strong>
            <p>{entry.reason ?? 'El proveedor no dispone de datos verificados dentro de plazo.'}</p>
            <p>
              Mostramos los últimos datos disponibles. Último dato correcto:{' '}
              {lastCorrectDate(entry.lastOkAt)}
            </p>
          </div>
          <button className="button" disabled={busy} onClick={() => void retry()}>
            {busy ? 'Reintentando…' : 'Reintentar'}
          </button>
        </aside>
      ))}
      <p role="status">{message}</p>
    </div>
  );
}
