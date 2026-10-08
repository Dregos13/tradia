import { sma, rsi, atr } from '../../../../shared/indicators';
import type { MarketBar } from '../../../../shared/ipc';

/** Never substitute raw prices for missing adjustments or invent missing sessions. */
export function adjustedCandles(bars: MarketBar[]) {
  return bars
    .filter((bar) =>
      [bar.adjOpen, bar.adjHigh, bar.adjLow, bar.adjClose].every(
        (value) => value !== null && Number.isFinite(value),
      ),
    )
    .map((bar) => ({
      time: bar.date,
      open: bar.adjOpen!,
      high: bar.adjHigh!,
      low: bar.adjLow!,
      close: bar.adjClose!,
      volume: bar.adjVolume ?? bar.volume,
    }));
}
export type AdjustedCandle = ReturnType<typeof adjustedCandles>[number];
export function chartData(bars: MarketBar[]) {
  const candles = adjustedCandles(bars);
  const line = (values: (number | null)[]) =>
    values.flatMap((value, index) =>
      value === null ? [] : [{ time: candles[index]!.time, value }],
    );
  return {
    candles,
    sma20: line(sma(candles, 20)),
    sma50: line(sma(candles, 50)),
    sma200: line(sma(candles, 200)),
    rsi: line(rsi(candles, 14)),
    atr: line(atr(candles, 14)),
  };
}
export function rangeStart(lastDate: string, years: number): string {
  const date = new Date(`${lastDate}T00:00:00Z`);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() - years);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}
export const priceFormat = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 2 });
