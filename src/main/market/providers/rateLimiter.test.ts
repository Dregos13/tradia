import { describe, expect, it } from 'vitest';

import { createRateLimiter } from './rateLimiter';
import { isMarketDataError } from './types';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Reloj manual: el tiempo solo avanza cuando la prueba lo decide. */
function manualClock() {
  let t = 1_700_000_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    /** Espera que avanza el reloj: simula el paso del tiempo real. */
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    /** Espera que nunca resuelve: deja al llamador encolado para siempre. */
    sleepForever: () => new Promise<void>(() => {}),
    sleeps,
  };
}

describe('rateLimiter por proveedor', () => {
  it('deja pasar peticiones hasta agotar la cuota horaria', async () => {
    const clock = manualClock();
    const limiter = createRateLimiter({
      limits: { perHour: 2, perDay: 100 },
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.remaining()).toEqual({ perHour: 0, perDay: 98 });
    expect(limiter.waitTimeMs()).toBeGreaterThan(0);
    expect(limiter.tryAcquire()).toBe(false);
  });

  it('espera a que expire la ventana horaria en vez de rechazar', async () => {
    const clock = manualClock();
    const limiter = createRateLimiter({
      limits: { perHour: 1, perDay: 100 },
      maxWaitMs: HOUR_MS + 1_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    await limiter.acquire(); // debe esperar ~1 h
    expect(clock.sleeps).toEqual([HOUR_MS]);
    expect(limiter.remaining().perHour).toBe(0);
  });

  it('la cuota diaria se respeta aunque queden huecos en la horaria', async () => {
    const clock = manualClock();
    const limiter = createRateLimiter({
      limits: { perHour: 1000, perDay: 3 },
      maxWaitMs: DAY_MS + 1_000,
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire(); // espera ~1 día
    expect(clock.sleeps).toEqual([DAY_MS]);
  });

  it('rechaza explícitamente cuando la espera supera maxWaitMs', async () => {
    const clock = manualClock();
    const limiter = createRateLimiter({
      limits: { perHour: 1, perDay: 1 },
      maxWaitMs: 60_000,
      now: clock.now,
      sleep: clock.sleep,
      providerId: 'tiingo',
    });

    await limiter.acquire();
    const error = await limiter.acquire().catch((e: unknown) => e);
    expect(isMarketDataError(error, 'rate-limit')).toBe(true);
    expect((error as { retryAfterMs?: number }).retryAfterMs).toBeGreaterThan(0);
    expect((error as { provider?: string }).provider).toBe('tiingo');
    // Un error de rechazo no consume cuota ni deja a nadie encolado.
    expect(limiter.remaining().perDay).toBe(0);
  });

  it('rechaza al instante cuando la cola de espera está llena', async () => {
    const clock = manualClock();
    const limiter = createRateLimiter({
      limits: { perHour: 1, perDay: 100 },
      maxQueued: 1,
      maxWaitMs: DAY_MS,
      now: clock.now,
      sleep: clock.sleepForever, // el primero encolado nunca despierta
    });

    await limiter.acquire(); // ocupa el único hueco horario
    const pending = limiter.acquire(); // queda encolado esperando la hora
    const rejection = limiter.acquire(); // la cola ya está llena → rechazo
    await expect(rejection).rejects.toMatchObject({
      name: 'MarketDataError',
      kind: 'rate-limit',
    });
    void pending.catch(() => {}); // queda pendiente a propósito
  });

  it('los huecos se liberan al avanzar el reloj', async () => {
    const clock = manualClock();
    const limiter = createRateLimiter({
      limits: { perHour: 1, perDay: 2 },
      now: clock.now,
      sleep: clock.sleep,
    });

    await limiter.acquire();
    clock.advance(HOUR_MS + 1);
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.remaining()).toEqual({ perHour: 0, perDay: 0 });

    clock.advance(DAY_MS);
    expect(limiter.remaining()).toEqual({ perHour: 1, perDay: 2 });
  });
});
