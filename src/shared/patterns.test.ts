import { describe, expect, it } from 'vitest';

import { readMarket, type PatternCandle } from './patterns';

const day = (i: number) =>
  new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const flat = (count: number, price = 100): PatternCandle[] =>
  Array.from({ length: count }, (_, i) => ({
    date: day(i),
    open: price,
    high: price + 1,
    low: price - 1,
    close: price + (i % 2 === 0 ? 0.2 : -0.2),
  }));
const asset = { ticker: 'GLD', name: 'Oro' };
const ids = (c: PatternCandle[]) => readMarket(c, asset).patterns.map((p) => p.id);

describe('readMarket', () => {
  it('detecta la ruptura de máximos de 20 días y la idea nombra el activo', () => {
    const candles = [...flat(30), { date: day(30), open: 100, high: 106, low: 99.5, close: 105 }];
    const reading = readMarket(candles, asset);
    const breakout = reading.patterns.find((p) => p.id === 'ruptura-alcista');
    expect(breakout?.idea).toContain('Oro (GLD)');
    expect(reading.trend.change).toBeCloseTo(105 / 99.8 - 1, 6);
  });

  it('detecta la ruptura bajista', () => {
    expect(
      ids([...flat(30), { date: day(30), open: 100, high: 100.5, low: 93, close: 94 }]),
    ).toContain('ruptura-bajista');
  });

  it('detecta envolventes', () => {
    const base = flat(10);
    expect(
      ids([
        ...base,
        { date: day(10), open: 101, high: 101.5, low: 99, close: 99.5 },
        { date: day(11), open: 99.2, high: 102.5, low: 99, close: 101.8 },
      ]),
    ).toContain('envolvente-alcista');
    expect(
      ids([
        ...base,
        { date: day(10), open: 99.5, high: 101.5, low: 99, close: 101 },
        { date: day(11), open: 101.2, high: 101.5, low: 98.5, close: 99.2 },
      ]),
    ).toContain('envolvente-bajista');
  });

  it('detecta vela interior y huecos', () => {
    const base = flat(10);
    expect(
      ids([...base, { date: day(10), open: 100, high: 100.5, low: 99.6, close: 100.1 }]),
    ).toContain('vela-interior');
    expect(
      ids([...base, { date: day(10), open: 103, high: 104, low: 102.5, close: 103.5 }]),
    ).toContain('hueco-alcista');
    expect(ids([...base, { date: day(10), open: 97, high: 97.5, low: 96, close: 96.5 }])).toContain(
      'hueco-bajista',
    );
  });

  it('detecta el cruce dorado reciente y la tendencia alcista', () => {
    // 220 sesiones bajando y luego subiendo con fuerza: la de 50 cruza a la de 200.
    const candles: PatternCandle[] = [];
    let price = 200;
    for (let i = 0; i < 400; i++) {
      price *= i < 220 ? 0.998 : 1.012;
      candles.push({
        date: day(i),
        open: price,
        high: price * 1.01,
        low: price * 0.99,
        close: price,
      });
      const reading = readMarket(candles, asset);
      if (reading.patterns.some((p) => p.id === 'cruce-dorado')) {
        expect(reading.trend.label).toBe('Tendencia alcista');
        return;
      }
    }
    throw new Error('no se detectó el cruce dorado');
  });

  it('con pocas velas no inventa patrones', () => {
    expect(readMarket(flat(1), asset).patterns).toEqual([]);
    expect(readMarket([], asset).trend.label).toBe('Sin datos suficientes');
  });
});
