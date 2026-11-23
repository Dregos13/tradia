import { describe, expect, it, vi } from 'vitest';

import { simulatedIntradayBars } from '../../shared/intraday';
import { openDatabase } from '../db/database';
import { createIntradayService } from './intraday';
import { MarketDataError, type MarketDataProvider } from './providers/types';

const NOW = Date.parse('2026-11-23T15:00:00Z');
const DAY = 86_400_000;

/** Proveedor que, como Tiingo, recorta cada respuesta a los últimos 20 días del rango. */
function fakeProvider(maxDays = 20) {
  const calls: Array<[number, number]> = [];
  const getIntradayBars = vi.fn(async (ticker: string, from: number, to: number) => {
    calls.push([from, to]);
    return simulatedIntradayBars(ticker, Math.max(from, to - maxDays * DAY), to);
  });
  const provider = { id: 'tiingo', getIntradayBars } as unknown as MarketDataProvider;
  return { provider, calls, getIntradayBars };
}

describe('servicio de velas de 1 hora', () => {
  it('descarga hacia atrás por tramos hasta cubrir lo pedido y después usa lo guardado', async () => {
    const db = openDatabase(':memory:');
    const { provider, calls } = fakeProvider();
    let now = NOW;
    const service = createIntradayService({
      db,
      resolveProvider: async () => provider,
      now: () => now,
    });

    const first = await service.get({ ticker: 'EURUSD', days: 60 });
    expect(first.error).toBeNull();
    expect(first.source).toBe('tiingo');
    expect(Date.parse(first.bars[0]!.time)).toBeLessThan(NOW - 57 * DAY);
    expect(Date.parse(first.bars.at(-1)!.time)).toBeGreaterThan(NOW - 2 * 3_600_000 - DAY);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.length).toBeLessThanOrEqual(8);

    // Dentro de los 15 min no se vuelve a preguntar.
    const before = calls.length;
    await service.get({ ticker: 'EURUSD', days: 60 });
    expect(calls.length).toBe(before);

    // Más tarde solo pide lo nuevo, desde la última vela guardada.
    now = NOW + 3 * 3_600_000;
    await service.get({ ticker: 'EURUSD', days: 60 });
    const [from] = calls.at(-1)!;
    expect(from).toBeGreaterThan(NOW - 2 * DAY);
  });

  it('si el proveedor falla devuelve lo guardado con un motivo claro', async () => {
    const db = openDatabase(':memory:');
    const { provider, getIntradayBars } = fakeProvider();
    let now = NOW;
    const service = createIntradayService({
      db,
      resolveProvider: async () => provider,
      now: () => now,
    });
    const ok = await service.get({ ticker: 'USDJPY', days: 10 });
    getIntradayBars.mockRejectedValueOnce(
      new MarketDataError('rate-limit', 'cuota', { provider: 'tiingo' }),
    );
    now = NOW + DAY;
    const failed = await service.get({ ticker: 'USDJPY', days: 10 });
    expect(failed.error).toMatch(/cupo/);
    expect(failed.bars.length).toBeGreaterThan(0);
    expect(failed.bars.length).toBeLessThanOrEqual(ok.bars.length);
  });

  it('sin proveedor pide la clave de Tiingo', async () => {
    const service = createIntradayService({
      db: openDatabase(':memory:'),
      resolveProvider: async () => null,
    });
    expect((await service.get({ ticker: 'EURUSD' })).error).toMatch(/clave de Tiingo/);
  });
});

describe('velas simuladas de 1 hora', () => {
  it('son deterministas y las divisas no cotizan el sábado', () => {
    const from = Date.parse('2026-11-20T00:00:00Z');
    const to = Date.parse('2026-11-23T12:00:00Z');
    const a = simulatedIntradayBars('EURUSD', from, to);
    expect(a).toEqual(simulatedIntradayBars('EURUSD', from, to));
    expect(a.some((b) => new Date(b.time).getUTCDay() === 6)).toBe(false);
    expect(
      a.every((b) => b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close)),
    ).toBe(true);
  });
});
