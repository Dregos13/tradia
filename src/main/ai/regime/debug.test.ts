import { describe, it } from 'vitest';
import type { Candle } from '../../../shared/indicators';
import { adx, classifyRegime, realizedVolatilitySeries } from './classifier';

function seriesFromReturns(n: number, ret: (i: number) => number, wick = 0.001): Candle[] {
  const candles: Candle[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const next = close * (1 + ret(i));
    const open = close;
    const high = Math.max(open, next) * (1 + wick);
    const low = Math.min(open, next) * (1 - wick);
    candles.push({ open, high, low, close: next });
    close = next;
  }
  return candles;
}

describe('debug series laterales', () => {
  it('seno, ruido determinista y zigzag con deriva', () => {
    const N = 340;
    const candidates: [string, Candle[]][] = [
      ['sine0.004 w0.7', seriesFromReturns(N, (i) => 0.004 * Math.sin(i * 0.7))],
      ['sine0.03 w0.7', seriesFromReturns(N, (i) => 0.03 * Math.sin(i * 0.7))],
      ['sine0.002+0.0005', seriesFromReturns(N, (i) => 0.002 * Math.sin(i * 0.7) + 0.0005 * Math.sin(i * 2.3))],
      [
        'sine calm→hot',
        seriesFromReturns(N, (i) => (i < N - 40 ? 0.002 * Math.sin(i * 0.7) : 0.03 * Math.sin(i * 0.7))),
      ],
      [
        'sine hot→calm',
        seriesFromReturns(N, (i) => (i < N - 40 ? 0.03 * Math.sin(i * 0.7) : 0.002 * Math.sin(i * 0.7))),
      ],
      [
        'trend+hot sine',
        seriesFromReturns(N, (i) => (i < N - 40 ? 0.0045 : 0.006 + 0.025 * Math.sin(i * 0.9))),
      ],
      [
        'trend calm',
        seriesFromReturns(N, () => 0.0045),
      ],
    ];
    for (const [name, candles] of candidates) {
      const c = classifyRegime(candles);
      const a = adx(candles);
      console.log(
        name.padEnd(22),
        'adx=', c.metrics.adx?.toFixed(2),
        'slope=', c.metrics.smaSlope?.toPrecision(3),
        'vol=', c.metrics.realizedVolatility?.toPrecision(3),
        'med=', c.metrics.volatilityMedian?.toPrecision(3),
        '→', c.direction, c.volatility,
        '| adx last20:', a.slice(-1)[0]?.toFixed(1),
      );
    }
  });
});
