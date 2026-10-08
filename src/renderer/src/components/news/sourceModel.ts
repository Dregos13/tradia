import type { TestSourceResult } from '../../../../shared/ipc';

export const providers = {
  finnhub: 'Finnhub',
  alphavantage: 'Alpha Vantage',
  newsapi: 'NewsAPI',
  gdelt: 'GDELT',
};
export type Provider = keyof typeof providers;
export const reliabilityLabels = {
  oficial: 'Oficial',
  agencia: 'Agencia',
  prensa: 'Prensa',
  redes: 'Redes',
};
export type ConnectionState = { testing: boolean; result?: TestSourceResult };
export function validFeedUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
// Never render arbitrary IPC exceptions (they could contain credentials).
export function connectionError(error: string | null): string {
  if (/401|403|auth|clave/i.test(error ?? ''))
    return 'El proveedor rechazó la clave de API. Comprueba que esté activa o guárdala de nuevo.';
  if (/429|rate.limit|cuota|límite/i.test(error ?? ''))
    return 'Límite temporal de peticiones alcanzado. Espera unos minutos antes de reintentar.';
  return 'No se pudo leer la fuente. Comprueba la URL o la conexión e inténtalo de nuevo.';
}
