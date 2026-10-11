import type { ProviderTestResult, ProviderTestStatus } from '../../../shared/ipc';
import { DataStateIcon } from './DataStateIcon';
import { sessionDateLabel } from './DataFreshness';
const labels: Record<ProviderTestStatus, string> = {
  ok: 'Conectado',
  'sin-clave': 'Sin clave',
  'clave-rechazada': 'Clave rechazada',
  cuota: 'Cuota agotada',
  'sin-red': 'Sin red',
  error: 'Error del proveedor',
};
export function checkedAtLabel(value: string): string {
  const date = new Date(value);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const day =
    date.toDateString() === now.toDateString()
      ? 'hoy'
      : date.toDateString() === yesterday.toDateString()
        ? 'ayer'
        : date.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  return `${day} a las ${date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}
export function ProviderConnectionResult({
  provider,
  name,
  testing,
  result,
  onRetry,
  onRefresh,
}: {
  provider: 'tiingo' | 'fred';
  name: string;
  testing: boolean;
  result: ProviderTestResult | null;
  onRetry: () => void;
  onRefresh: () => void;
}) {
  const focusKey = () => document.getElementById(`${provider}-key`)?.focus();
  const status = result?.status;
  const message =
    status === 'ok' && result
      ? `Conectado. Último dato disponible: ${sessionDateLabel(result.latestDataDate)}. Comprobado ${checkedAtLabel(result.checkedAt)}${result.latencyMs === null ? '' : ` (${result.latencyMs} ms)`}.`
      : status === 'sin-clave'
        ? `Falta la clave de ${name}. Pégala arriba y pulsa «Guardar clave de ${name}».`
        : status === 'clave-rechazada'
          ? `${name} ha rechazado la clave. Comprueba que la has copiado entera o genera una nueva en tu cuenta.`
          : status === 'cuota'
            ? `Has agotado la cuota de peticiones de ${name}. Se renueva sola; vuelve a probar más tarde.`
            : status === 'sin-red'
              ? 'No hay conexión a internet. Tradia volverá a intentarlo al recuperar la red.'
              : status === 'error'
                ? `${name} no ha respondido como esperábamos: ${result?.message ?? 'no se pudo comprobar el proveedor'}. Vuelve a probar; si se repite, revisa el estado del servicio.`
                : 'Aún no has probado la conexión.';
  return (
    <div
      className={`provider-connection provider-connection--${testing ? 'testing' : (status ?? 'idle')}`}
    >
      <p id={`${provider}-test-help`} role="status" aria-live="polite">
        <strong>
          <DataStateIcon
            kind={status === 'ok' ? 'ok' : testing || !status ? 'pending' : 'warning'}
          />
          {testing ? 'Probando' : status ? labels[status] : 'Sin probar'}
        </strong>{' '}
        · {testing ? `Probando la conexión con ${name}…` : message}
      </p>
      {!testing && status && (
        <div className="settings-controls">
          {status === 'ok' ? (
            <button type="button" className="button" onClick={onRefresh}>
              Actualizar datos ahora
            </button>
          ) : status === 'sin-clave' || status === 'clave-rechazada' ? (
            <button type="button" className="button" onClick={focusKey}>
              {status === 'sin-clave' ? 'Añadir clave' : 'Cambiar clave'}
            </button>
          ) : (
            <button type="button" className="button" onClick={onRetry}>
              Probar de nuevo
            </button>
          )}
          {status === 'clave-rechazada' && (
            <a
              href={
                provider === 'tiingo'
                  ? 'https://www.tiingo.com/account/api/token'
                  : 'https://fredaccount.stlouisfed.org/apikeys'
              }
              target="_blank"
              rel="noreferrer"
            >
              Abrir mi cuenta de {name}
              <span className="sr-only"> (abre en el navegador)</span>
            </a>
          )}
        </div>
      )}
    </div>
  );
}
