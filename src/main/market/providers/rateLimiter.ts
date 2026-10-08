/**
 * Cuota de peticiones por proveedor, con ventanas deslizantes de una hora y
 * de un día. Cuando no hay hueco la petición espera su turno; si la espera
 * supera `maxWaitMs` o la cola ya está llena (`maxQueued`), `acquire()`
 * rechaza con un `MarketDataError` 'rate-limit' explícito — quien llama
 * decide si reintenta más tarde (el campo `retryAfterMs` dice cuándo).
 *
 * El reloj y la espera son inyectables para que las pruebas avancen el
 * tiempo sin pausas reales.
 */
import { MarketDataError, type RateLimits } from './types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface RateLimiterOptions {
  limits: RateLimits;
  /** Identificador del proveedor, para dar contexto al error de rechazo. */
  providerId?: string;
  /** Máximo de peticiones esperando turno; por encima se rechaza al instante. */
  maxQueued?: number;
  /** Espera máxima tolerada; si el hueco llega más tarde se rechaza. */
  maxWaitMs?: number;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?: () => number;
  /** Espera inyectable; por defecto setTimeout. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RateLimiter {
  /** Espera hasta que haya hueco en la cuota y lo ocupa; rechaza si no puede. */
  acquire(): Promise<void>;
  /** Ocupa un hueco si lo hay ahora mismo, sin esperar. */
  tryAcquire(): boolean;
  /** Peticiones que aún caben en cada ventana. */
  remaining(): { perHour: number; perDay: number };
  /** ms hasta que se libere un hueco (0 si lo hay ya). */
  waitTimeMs(): number;
}

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { perHour, perDay } = options.limits;
  const providerId = options.providerId ?? 'desconocido';
  const maxQueued = options.maxQueued ?? 32;
  const maxWaitMs = options.maxWaitMs ?? 300_000;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** Instantes de las peticiones ya consumidas, ascendente. */
  const stamps: number[] = [];
  let queued = 0;

  const prune = (): void => {
    const cutoff = now() - DAY_MS;
    while (stamps.length > 0 && stamps[0]! <= cutoff) stamps.shift();
  };

  const waitTimeMs = (): number => {
    // Una cuota de 0 no libera hueco nunca: espera infinita → rechazo.
    if (perHour <= 0 || perDay <= 0) return Number.POSITIVE_INFINITY;
    prune();
    const t = now();
    let wait = 0;
    if (stamps.length >= perDay) {
      // El hueco diario se libera cuando expire la petición que bloquea.
      wait = Math.max(wait, stamps[stamps.length - perDay]! + DAY_MS - t);
    }
    const inHour = stamps.filter((s) => t - s < HOUR_MS);
    if (inHour.length >= perHour) {
      wait = Math.max(wait, inHour[inHour.length - perHour]! + HOUR_MS - t);
    }
    return Math.max(0, wait);
  };

  const rateLimitError = (retryAfterMs: number, reason: string): MarketDataError =>
    new MarketDataError('rate-limit', `cuota del proveedor '${providerId}' agotada: ${reason}`, {
      provider: providerId,
      retryAfterMs,
    });

  return {
    acquire: async () => {
      if (queued >= maxQueued) {
        throw rateLimitError(waitTimeMs(), `cola llena (${maxQueued} peticiones en espera)`);
      }
      queued++;
      try {
        for (;;) {
          const wait = waitTimeMs();
          if (wait <= 0) {
            // Comprobación y ocupación en el mismo tick: no hay carrera.
            stamps.push(now());
            return;
          }
          if (wait > maxWaitMs) {
            throw rateLimitError(
              wait,
              `el siguiente hueco llega en ${Math.ceil(wait / 1000)} s (máximo ${Math.ceil(
                maxWaitMs / 1000,
              )} s)`,
            );
          }
          await sleep(wait);
        }
      } finally {
        queued--;
      }
    },
    tryAcquire: () => {
      if (waitTimeMs() > 0) return false;
      stamps.push(now());
      return true;
    },
    remaining: () => {
      prune();
      const t = now();
      const inHour = stamps.filter((s) => t - s < HOUR_MS).length;
      return {
        perHour: Math.max(0, perHour - inHour),
        perDay: Math.max(0, perDay - stamps.length),
      };
    },
    waitTimeMs,
  };
}
