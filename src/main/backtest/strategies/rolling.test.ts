/**
 * Equivalencia entre los indicadores incrementales de las estrategias y las
 * funciones por lotes de `src/shared/indicators.ts`, que actúan de oráculo.
 */
import { describe, expect, it } from 'vitest';

import { atr, rsi, sma, type Candle } from '../../../shared/indicators';
import { RollingSma, WilderAtr, WilderRsi } from './rolling';

/** Serie pseudoaleatoria determinista (LCG) de 300 velas. */
function randomWalk(count: number, seed = 42): Candle[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    return state / 0x1_00_00_00_00;
  };
  const candles: Candle[] = [];
  let close = 100;
  for (let i = 0; i < count; i++) {
    close = Math.max(1, close + (next() - 0.48) * 6);
    const spread = next() * 3;
    const open = close + (next() - 0.5) * 2;
    candles.push({
      open,
      high: Math.max(open, close) + spread,
      low: Math.max(0.5, Math.min(open, close) - spread),
      close,
    });
  }
  return candles;
}

const CANDLES = randomWalk(300);

describe('indicadores incrementales equivalen a los por lotes', () => {
  for (const period of [1, 2, 5, 14, 30]) {
    it(`RollingSma(${period}) coincide con sma() vela a vela`, () => {
      const reference = sma(CANDLES, period);
      const rolling = new RollingSma(period);
      CANDLES.forEach((candle, i) => {
        rolling.push(candle.close);
        const expected = reference[i] ?? null;
        // La suma rodante acumula el redondeo en otro orden que la de lote.
        if (expected === null) {
          expect(rolling.value).toBeNull();
        } else {
          expect(rolling.value).toBeCloseTo(expected, 10);
        }
      });
    });

    it(`WilderRsi(${period}) coincide con rsi() vela a vela`, () => {
      const reference = rsi(CANDLES, period);
      const rolling = new WilderRsi(period);
      CANDLES.forEach((candle, i) => {
        rolling.push(candle.close);
        const expected = reference[i] ?? null;
        if (expected === null) {
          expect(rolling.value).toBeNull();
        } else {
          expect(rolling.value).toBeCloseTo(expected, 12);
        }
      });
    });

    it(`WilderAtr(${period}) coincide con atr() vela a vela`, () => {
      const reference = atr(CANDLES, period);
      const rolling = new WilderAtr(period);
      CANDLES.forEach((candle, i) => {
        rolling.push(candle);
        const expected = reference[i] ?? null;
        if (expected === null) {
          expect(rolling.value).toBeNull();
        } else {
          expect(rolling.value).toBeCloseTo(expected, 12);
        }
      });
    });
  }

  it('rechaza periodos no enteros o < 1', () => {
    expect(() => new RollingSma(0)).toThrow(RangeError);
    expect(() => new WilderRsi(2.5)).toThrow(RangeError);
    expect(() => new WilderAtr(-1)).toThrow(RangeError);
  });
});
