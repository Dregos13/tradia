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

/**
 * Media exponencial rodante del cierre: se siembra con la media simple de
 * las `period` primeras velas y luego aplica k = 2 / (period + 1), igual
 * que `ema()` de shared/indicators.
 */
export class RollingEma {
  private readonly k: number;
  private readonly seed: number[] = [];
  private sum = 0;
  private current: number | null = null;

  constructor(private readonly period: number) {
    assertPeriod(period, 'RollingEma');
    this.k = 2 / (period + 1);
  }

  push(close: number): void {
    if (this.current !== null) {
      this.current = close * this.k + this.current * (1 - this.k);
      return;
    }
    this.seed.push(close);
    this.sum += close;
    if (this.seed.length === this.period) {
      this.current = this.sum / this.period;
    }
  }

  /** EMA de los últimos cierres, o null hasta completar la siembra. */
  get value(): number | null {
    return this.current;
  }
}

/**
 * Extremo rodante de las `period` velas ANTERIORES a la última vista —
 * canal tipo Donchian: la vela que se está evaluando no entra en su propio
 * canal, que es lo que convierte el extremo en una ruptura de verdad (la
 * misma convención que `upperChannel`/`lowerChannel` de donchianBreakout).
 *
 * Se implementa con un deque monótono alimentado con una vela de retardo:
 * tras consumir la vela t la ventana cubre los índices [t-period, t-1].
 * `value` es null hasta haber empujado `period` velas retrasadas (es
 * decir, hasta la vela con índice `period`).
 */
abstract class RollingPriorExtreme {
  private items: { index: number; value: number }[] = [];
  private count = 0;
  private pending: number | null = null;

  constructor(
    private readonly period: number,
    label: string,
  ) {
    assertPeriod(period, label);
  }

  /** true si el valor nuevo desplaza a los candidatos anteriores. */
  protected abstract evicts(candidate: number, incoming: number): boolean;

  push(value: number): void {
    const incoming = this.pending;
    this.pending = value;
    if (incoming === null) return;
    while (
      this.items.length > 0 &&
      this.evicts(this.items[this.items.length - 1]!.value, incoming)
    ) {
      this.items.pop();
    }
    this.items.push({ index: this.count, value: incoming });
    const first = this.count - this.period + 1;
    while (this.items.length > 0 && this.items[0]!.index < first) {
      this.items.shift();
    }
    this.count++;
  }

  /** Extremo de las `period` velas anteriores a la actual, o null si no hay. */
  get value(): number | null {
    return this.count >= this.period ? this.items[0]!.value : null;
  }
}

/** Máximo de los `period` máximos anteriores a la vela actual (canal superior). */
export class RollingPriorMax extends RollingPriorExtreme {
  constructor(period: number) {
    super(period, 'RollingPriorMax');
  }

  protected evicts(candidate: number, incoming: number): boolean {
    return candidate <= incoming;
  }
}

/** Mínimo de los `period` mínimos anteriores a la vela actual (canal inferior). */
export class RollingPriorMin extends RollingPriorExtreme {
  constructor(period: number) {
    super(period, 'RollingPriorMin');
  }

  protected evicts(candidate: number, incoming: number): boolean {
    return candidate >= incoming;
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
