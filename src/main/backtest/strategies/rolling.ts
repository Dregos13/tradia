/**
 * Indicadores incrementales para las estrategias clásicas — Fase 2.
 *
 * Reproducen la semántica de `src/shared/indicators.ts` (SMA de ventana
 * completa; RSI y ATR con siembra por media simple de los `period` primeros
 * valores y recurrencia de Wilder después), pero en O(1) por vela: cada
 * estrategia alimenta una única vez cada vela revelada por la `BarWindow` y
 * consulta el último valor. Mantener el coste constante importa porque el
 * mapa de sensibilidad ejecuta el motor decenas de veces.
 *
 * Las funciones por lotes de `src/shared/indicators.ts` siguen siendo el
 * oráculo: `rolling.test.ts` compara ambas salidas vela a vela sobre
 * series pseudoaleatorias.
 */
import type { EngineBar } from '../types';

/** Vela mínima para el ATR (compatible con `EngineBar` y `Candle`). */
type OhlcBar = Pick<EngineBar, 'high' | 'low' | 'close'>;

function assertPeriod(period: number, indicator: string): void {
  if (!Number.isInteger(period) || period < 1) {
    throw new RangeError(`${indicator}: el periodo debe ser un entero >= 1 (${period})`);
  }
}

/** Media simple rodante del cierre: `value` es null hasta tener `period` datos. */
export class RollingSma {
  private readonly window: number[] = [];
  private head = 0;
  private sum = 0;

  constructor(private readonly period: number) {
    assertPeriod(period, 'RollingSma');
  }

  push(close: number): void {
    if (this.window.length < this.period) {
      this.window.push(close);
      this.sum += close;
      return;
    }
    this.sum += close - this.window[this.head]!;
    this.window[this.head] = close;
    this.head = (this.head + 1) % this.period;
  }

  /** Media de los últimos `period` cierres, o null si aún no están todos. */
  get value(): number | null {
    return this.window.length === this.period ? this.sum / this.period : null;
  }
}

/** RSI de Wilder incremental: primer valor tras `period` cambios de precio. */
export class WilderRsi {
  private previousClose: number | null = null;
  private changes = 0;
  private avgGain = 0;
  private avgLoss = 0;
  private current: number | null = null;

  constructor(private readonly period: number) {
    assertPeriod(period, 'WilderRsi');
  }

  push(close: number): void {
    if (this.previousClose === null) {
      this.previousClose = close;
      return;
    }
    const change = close - this.previousClose;
    this.previousClose = close;
    this.changes++;
    if (this.changes <= this.period) {
      this.avgGain += Math.max(change, 0);
      this.avgLoss += Math.max(-change, 0);
      if (this.changes === this.period) {
        this.avgGain /= this.period;
        this.avgLoss /= this.period;
        this.current = rsiValue(this.avgGain, this.avgLoss);
      }
      return;
    }
    this.avgGain = (this.avgGain * (this.period - 1) + Math.max(change, 0)) / this.period;
    this.avgLoss = (this.avgLoss * (this.period - 1) + Math.max(-change, 0)) / this.period;
    this.current = rsiValue(this.avgGain, this.avgLoss);
  }

  get value(): number | null {
    return this.current;
  }
}

/** ATR de Wilder incremental: primer valor tras `period` rangos verdaderos. */
export class WilderAtr {
  private previousClose: number | null = null;
  private seen = 0;
  private sum = 0;
  private current: number | null = null;

  constructor(private readonly period: number) {
    assertPeriod(period, 'WilderAtr');
  }

  push(bar: OhlcBar): void {
    const tr =
      this.previousClose === null
        ? bar.high - bar.low
        : Math.max(
            bar.high - bar.low,
            Math.abs(bar.high - this.previousClose),
            Math.abs(bar.low - this.previousClose),
          );
    this.previousClose = bar.close;
    this.seen++;
    if (this.seen <= this.period) {
      this.sum += tr;
      if (this.seen === this.period) {
        this.current = this.sum / this.period;
      }
      return;
    }
    this.current = (this.current! * (this.period - 1) + tr) / this.period;
  }

  get value(): number | null {
    return this.current;
  }
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) {
    return avgGain === 0 ? 50 : 100;
  }
  return 100 - 100 / (1 + avgGain / avgLoss);
}
