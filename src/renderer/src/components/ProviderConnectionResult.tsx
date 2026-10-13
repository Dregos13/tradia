import { useEffect, useRef } from 'react';
import type { ProviderTestResult, ProviderTestStatus } from '../../../shared/ipc';
import { DataStateIcon } from './DataStateIcon';
import { sessionDateLabel } from './DataFreshness';
const labels: Record<ProviderTestStatus, string> = {
  ok: 'Funciona',
  'sin-clave': 'Sin clave',
  'clave-rechazada': 'Clave no válida',
  cuota: 'Límite alcanzado',
  'sin-red': 'Sin conexión',
  error: 'No responde',
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
export function focusProviderKey(provider: 'tiingo' | 'fred') {
  const details = document.getElementById(`${provider}-key-details`);
  if (details instanceof HTMLDetailsElement) details.open = true;
  document.getElementById(`${provider}-key`)?.focus();
}
export function ProviderConnectionResult({
  provider,
  name,
  testing,
  result,
  onRetry,
  onRefresh,
  busy = false,
}: {
  provider: 'tiingo' | 'fred';
  name: string;
  testing: boolean;
  result: ProviderTestResult | null;
  onRetry: () => void;
  onRefresh: () => void;
  busy?: boolean;
}) {
  const status = result?.status;
  const message = testing
    ? `Comprobando la conexión con ${name}…`
    : status === 'ok'
      ? `${name} responde y sus datos están disponibles.`
      : status === 'sin-clave'
        ? `Falta la clave de ${name}.`
        : status === 'clave-rechazada'
          ? `La clave de ${name} no es válida. ${name} ha rechazado la clave guardada.`
          : status === 'cuota'
            ? `${name} no admite más consultas por ahora.`
            : status === 'sin-red'
              ? `Tradia no puede contactar con ${name} sin internet.`
              : status === 'error'
                ? `${name} no responde.`
                : 'Aún no has comprobado la conexión.';
  const help =
    status === 'sin-clave'
      ? `Pega una clave activa y pulsa «Guardar clave de ${name}». Después prueba la conexión.`
      : status === 'clave-rechazada'
        ? 'Comprueba que has copiado la clave entera o genera una nueva en tu cuenta. Guárdala y vuelve a probar.'
        : status === 'cuota'
          ? 'Espera a que se renueve la cuota y vuelve a probar. El proveedor no ha indicado cuándo se renueva.'
          : status === 'sin-red'
            ? 'Revisa tu conexión a internet y vuelve a probar al recuperar la red.'
            : status === 'error'
              ? 'Vuelve a probar; si se repite, revisa el estado del servicio.'
              : 'Prueba la conexión para saber si el conector responde.';
  const keyProblem = status === 'sin-clave' || status === 'clave-rechazada';
  // Una sola acción principal en «Siguiente paso»: arreglar la clave, actualizar los datos
  // si todo funciona o, en cualquier otro caso, volver a probar la conexión.
  const testPrimary = !keyProblem && status !== 'ok';
  const refocusTest = useRef(false);
  useEffect(() => {
    // El botón cambia de bloque al pasar a «Funciona»: no perder el foco de quien lo pulsó.
    if (testing || !refocusTest.current) return;
    refocusTest.current = false;
    if (!keyProblem) document.getElementById(`${provider}-test`)?.focus();
  }, [testing, status, keyProblem, provider]);
  const testButton = (
    <button
      id={`${provider}-test`}
      type="button"
      className={`button ${testPrimary || testing ? 'primary' : ''}`}
      disabled={testing || busy}
      aria-describedby={`${provider}-test-help`}
      onClick={() => {
        refocusTest.current = true;
        onRetry();
      }}
    >
      {testing ? 'Comprobando…' : 'Probar conexión'}
    </button>
  );
  return (
    <div className="connector-diagnosis">
      <div id={`${provider}-test-help`} role="status" aria-live="polite">
        <strong
          className={`connector-state connector-state--${testing ? 'testing' : (status ?? 'idle')}`}
        >
          <DataStateIcon
            kind={testing || !status ? 'pending' : status === 'ok' ? 'ok' : 'warning'}
          />
          {testing ? 'Comprobando…' : status ? labels[status] : 'Sin comprobar'}
        </strong>
        <p>{message}</p>
      </div>
      <dl className="connector-meta">
        <dt>Última comprobación</dt>
        <dd>{result ? checkedAtLabel(result.checkedAt) : 'Todavía no se ha comprobado'}</dd>
        <dt>Último dato</dt>
        <dd>
          {result?.latestDataDate ? sessionDateLabel(result.latestDataDate) : 'No disponible'}
        </dd>
      </dl>
      {!testing && (
        <div className="connector-next">
          <h4>{status && status !== 'ok' ? 'Cómo arreglarlo' : 'Siguiente paso'}</h4>
          {status !== 'ok' && <p>{help}</p>}
          {!testPrimary && (
            <div className="settings-controls">
              {status === 'ok' ? (
                <button type="button" className="button primary" onClick={onRefresh}>
                  Actualizar datos ahora
                </button>
              ) : (
                <button
                  type="button"
                  className="button primary"
                  onClick={() => focusProviderKey(provider)}
                >
                  {status === 'sin-clave' ? 'Añadir clave' : 'Revisar la clave'}
                </button>
              )}
            </div>
          )}
          {testPrimary && <div className="settings-controls">{testButton}</div>}
        </div>
      )}
      {/* Con el siguiente paso ya elegido, «Probar conexión» queda como acción secundaria. */}
      {(testing || !testPrimary) && (
        <div className="settings-controls">
          {testButton}
          {status === 'clave-rechazada' && !testing && (
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
      {status === 'error' && !testing && (
        <details>
          <summary>Detalles de la conexión</summary>
          <p>{result?.message.trim().replace(/[.!?…]+$/, '')}.</p>
        </details>
      )}
    </div>
  );
}
