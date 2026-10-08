import { describe, expect, it } from 'vitest';

import { atr, ema, rsi, sma, trueRange, type Candle } from './indicators';

function closes(...values: number[]): Pick<Candle, 'close'>[] {
  return values.map((close) => ({ close }));
}

function candles(...bars: [number, number, number, number][]): Candle[] {
  return bars.map(([open, high, low, close]) => ({ open, high, low, close }));
}

describe('sma', () => {
  it('media simple de los últimos n cierres, null hasta completar la ventana', () => {
    expect(sma(closes(2, 4, 6, 8, 10), 3)).toEqual([null, null, 4, 6, 8]);
  });

  it('la salida tiene la misma longitud que la entrada', () => {
    const out = sma(closes(1, 2, 3, 4, 5, 6, 7), 5);
    expect(out).toHaveLength(7);
    expect(out.slice(0, 4)).toEqual([null, null, null, null]);
    expect(out.at(-1)).toBeCloseTo(5, 10); // media de 3..7
  });

  it('con periodo 1 devuelve los propios cierres', () => {
    expect(sma(closes(3, 1, 4), 1)).toEqual([3, 1, 4]);
  });

  it('una serie más corta que el periodo da todo null', () => {
    expect(sma(closes(10, 20), 5)).toEqual([null, null]);
    expect(sma([], 5)).toEqual([]);
  });
});

describe('ema', () => {
  it('se siembra con la SMA de las primeras n velas y aplica k = 2/(n+1)', () => {
    // k = 0.5: semilla (10+11+12)/3 = 11; luego 12, 13 y 14 a pelo.
    expect(ema(closes(10, 11, 12, 13, 14, 15), 3)).toEqual([null, null, 11, 12, 13, 14]);
  });

  it('suaviza respecto a la SMA con una serie no lineal', () => {
    const out = ema(closes(10, 10, 10, 20, 20, 20), 3);
    expect(out[2]).toBe(10);
    expect(out[3]).toBeCloseTo(15, 10); // 20*0.5 + 10*0.5
    expect(out[4]).toBeCloseTo(17.5, 10); // 20*0.5 + 15*0.5
    expect(out[5]).toBeCloseTo(18.75, 10);
  });

  it('precios constantes dan la constante', () => {
    expect(ema(closes(7, 7, 7, 7), 3)).toEqual([null, null, 7, 7]);
  });

  it('una serie más corta que el periodo da todo null', () => {
    expect(ema(closes(1, 2), 10)).toEqual([null, null]);
  });
});

describe('rsi', () => {
  it('calculado a mano con periodo 2', () => {
    // Cambios: +1, -2, +3.
    // i=2: avgGain=0.5, avgLoss=1 → RS=0.5 → 33.33; i=3: avgGain=1.75,
    // avgLoss=0.5 → RS=3.5 → 77.78.
    const out = rsi(closes(10, 11, 9, 12), 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(33.3333, 4);
    expect(out[3]).toBeCloseTo(77.7778, 4);
  });

  it('reproduce la serie de referencia de Wilder con periodo 14', () => {
    // Cierres del ejemplo clásico de StockCharts; los RSI esperados salen de
    // aplicar la recurrencia de Wilder a mano (primera media simple de 14
    // cambios y suavizado después).
    const out = rsi(
      closes(
        44.3389,
        44.0902,
        44.1497,
        43.6124,
        44.3278,
        44.8264,
        45.0955,
        45.4245,
        45.8433,
        46.0826,
        45.8931,
        46.0328,
        45.614,
        46.282,
        46.282,
        45.996,
        46.0328,
        46.4116,
        46.2221,
        45.6439,
        45.9946,
        46.3816,
        46.3158,
        46.9756,
        47.0114,
        47.363,
        47.2384,
        47.7946,
        47.725,
        47.8543,
      ),
    );
    expect(out).toHaveLength(30);
    // El primer RSI necesita 14 cambios: cae en el índice 14.
    expect(out.slice(0, 14).every((v) => v === null)).toBe(true);
    const esperados = [
      70.5328, 66.2222, 66.5058, 69.3582, 66.3157, 57.9609, 61.1574, 64.3763, 63.4141, 68.4987,
      68.7525, 71.2058, 69.1343, 72.9213, 71.7352, 72.626,
    ];
    esperados.forEach((valor, i) => {
      expect(out[14 + i]).toBeCloseTo(valor, 4);
    });
  });

  it('solo subidas dan 100 y solo bajadas dan 0', () => {
    const sube = rsi(closes(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16));
    expect(sube[14]).toBe(100);
    expect(sube[15]).toBe(100);

    const baja = rsi(closes(16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1));
    expect(baja[14]).toBe(0);
    expect(baja[15]).toBe(0);
  });

  it('precios constantes dan 50: sin fuerza en ninguna dirección', () => {
    const out = rsi(closes(...new Array<number>(20).fill(5)));
    expect(out.slice(14)).toEqual(new Array<number>(6).fill(50));
  });

  it('una serie corta da todo null', () => {
    expect(rsi(closes(1, 2, 3), 14)).toEqual([null, null, null]);
    expect(rsi([], 14)).toEqual([]);
  });
});

describe('trueRange y atr', () => {
  const bars = candles(
    // open, high, low, close — TR calculado a mano:
    [9.2, 10.0, 9.0, 9.5], // TR = 1.0 (primera vela: high - low)
    [9.6, 11.0, 9.8, 10.8], // TR = max(1.2, |11-9.5|=1.5, |9.8-9.5|=0.3) = 1.5
    [10.9, 12.0, 10.5, 11.0], // TR = max(1.5, |12-10.8|=1.2, |10.5-10.8|=0.3) = 1.5
    [11.2, 11.6, 10.9, 11.4], // TR = max(0.7, 0.6, 0.1) = 0.7
    [11.5, 12.3, 11.1, 12.0], // TR = max(1.2, 0.9, 0.3) = 1.2
  );

  it('el rango verdadero usa el hueco con el cierre anterior', () => {
    const tr = trueRange(bars);
    [1, 1.5, 1.5, 0.7, 1.2].forEach((valor, i) => {
      expect(tr[i]).toBeCloseTo(valor, 10);
    });
  });

  it('atr(2) calculado a mano con suavizado de Wilder', () => {
    const out = atr(bars, 2);
    expect(out[0]).toBeNull();
    expect(out[1]).toBeCloseTo(1.25, 10); // (1 + 1.5) / 2
    expect(out[2]).toBeCloseTo(1.375, 10); // (1.25 + 1.5) / 2
    expect(out[3]).toBeCloseTo(1.0375, 10); // (1.375 + 0.7) / 2
    expect(out[4]).toBeCloseTo(1.11875, 10); // (1.0375 + 1.2) / 2
  });

  it('el primer ATR cae en el índice period - 1 y la longitud cuadra', () => {
    const out = atr(bars, 14);
    expect(out).toHaveLength(5);
    expect(out.every((v) => v === null)).toBe(true);
  });

  it('velas constantes dan ATR 0', () => {
    const planas = new Array<Candle>(20).fill({ open: 7, high: 7, low: 7, close: 7 });
    const out = atr(planas);
    expect(out.slice(13)).toEqual(new Array<number>(7).fill(0));
  });

  it('acepta objetos vela con campos extra (p. ej. Bar del proveedor)', () => {
    const conExtras = bars.map((b) => ({ ...b, date: '2026-01-01', volume: 1, adjClose: b.close }));
    expect(atr(conExtras, 2)).toEqual(atr(bars, 2));
    expect(sma(conExtras, 2)).toEqual(sma(bars, 2));
  });
});

describe('sin datos futuros', () => {
  const serie = closes(10, 11, 9, 12, 8, 13, 14, 11, 10, 12, 15, 14, 16, 17, 18, 19, 17, 16);
  const bars = candles(
    ...serie.map(
      ({ close: c }) => [c - 0.5, c + 1, c - 1.2, c] as [number, number, number, number],
    ),
  );

  it('recortar la serie no cambia los valores ya calculados', () => {
    const corte = 12;
    for (const [nombre, completa, prefijo] of [
      ['sma', sma(serie, 5), sma(serie.slice(0, corte), 5)],
      ['ema', ema(serie, 5), ema(serie.slice(0, corte), 5)],
      ['rsi', rsi(serie, 5), rsi(serie.slice(0, corte), 5)],
      ['atr', atr(bars, 5), atr(bars.slice(0, corte), 5)],
    ] as const) {
      expect(prefijo, nombre).toEqual(completa.slice(0, corte));
    }
  });
});

describe('validación de entrada', () => {
  it('rechaza periodos no válidos', () => {
    const serie = closes(1, 2, 3);
    for (const periodo of [0, -1, 1.5, Number.NaN]) {
      expect(() => sma(serie, periodo)).toThrow(RangeError);
      expect(() => ema(serie, periodo)).toThrow(RangeError);
      expect(() => rsi(serie, periodo)).toThrow(RangeError);
      expect(() => atr(candles([1, 2, 0.5, 1.5]), periodo)).toThrow(RangeError);
    }
  });

  it('rechaza precios no finitos', () => {
    expect(() => sma(closes(1, Number.NaN, 3), 2)).toThrow(TypeError);
    expect(() => rsi(closes(1, 2, Number.POSITIVE_INFINITY), 2)).toThrow(TypeError);
    expect(() => atr(candles([1, 2, 0.5, 1.5], [1, Number.NaN, 0.5, 1.5]), 2)).toThrow(TypeError);
    // Campos que no son números (dato corrupto llegado por IPC).
    const corrupta = [{ close: 'diez' }] as unknown as Pick<Candle, 'close'>[];
    expect(() => sma(corrupta, 1)).toThrow(TypeError);
  });
});
