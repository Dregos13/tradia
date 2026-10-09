import { describe, expect, it } from 'vitest';

import { runBacktest } from './engine';
import {
  LookAheadError,
  type EngineBar,
  type Strategy,
  type StrategyContext,
  type Trade,
} from './types';

/** Vela con OHLC idénticos (precio plano) salvo que se indique otra cosa. */
const flat = (date: string, price: number, over: Partial<EngineBar> = {}): EngineBar => ({
  date,
  open: price,
  high: price,
  low: price,
  close: price,
  ...over,
});

const NO_COSTS = { commissionPct: 0, commissionMin: 0, slippageBp: 0, spreadBp: 0 };

/** Estrategia de script: ejecuta las órdenes programadas por índice de sesión. */
const scripted = (steps: Record<number, (ctx: StrategyContext) => void>): Strategy => ({
  init: () => {},
  onBar: (ctx) => {
    steps[ctx.index]?.(ctx);
  },
});

// ---------------------------------------------------------------------------
// Resultado conocido, calculado a mano
// ---------------------------------------------------------------------------

describe('resultado conocido sobre una serie sintética', () => {
  /*
   * Configuración: capital 10 000, riesgo 1 %, 5 posiciones máx.,
   * comisión 0,1 % sin mínimo, slippage 10 pb, spread 0 → factor 0,001.
   *
   * Velas AAA (plano salvo la apertura del día de salida):
   *   2024-01-02  100  → señal de compra con stop 95
   *   2024-01-03  100  → entrada en la apertura: 100 × 1,001 = 100,10
   *   2024-01-04  100  → señal de venta
   *   2024-01-05  110  → salida en la apertura: 110 × 0,999 = 109,89
   *   2024-01-08  110  → fin
   *
   * Acciones: floor(10 000 × 0,01 / (100,10 − 95)) = floor(19,6078) = 19
   * Entrada: nominal 19 × 100,10 = 1 901,90; comisión 1,9019
   *   efectivo = 10 000 − 1 901,90 − 1,9019 = 8 096,1981
   *   capital al cierre del 03-01 = 8 096,1981 + 19 × 100 = 9 996,1981
   * Salida: 19 × 109,89 = 2 087,91; comisión 2,08791
   *   efectivo = 8 096,1981 + 2 087,91 − 2,08791 = 10 182,02019
   * Operación: grossPnl = 9,79 × 19 = 186,01; pnl = 186,01 − 3,98981 = 182,02019
   *   slippage = (0,10 × 19) + (0,11 × 19) = 1,90 + 2,09 = 3,99
   */
  const bars = {
    AAA: [
      flat('2024-01-02', 100),
      flat('2024-01-03', 100),
      flat('2024-01-04', 100),
      flat('2024-01-05', 110),
      flat('2024-01-08', 110),
    ],
  };

  const strategy = scripted({
    0: (ctx) => ctx.buy('AAA', { stop: 95 }),
    2: (ctx) => ctx.sell('AAA'),
  });

  const result = runBacktest({
    strategy,
    bars,
    initialCash: 10_000,
    riskPerTrade: 0.01,
    costs: { commissionPct: 0.001, commissionMin: 0, slippageBp: 10, spreadBp: 0 },
  });

  it('cierra una única operación con precios, costes y PnL calculados a mano', () => {
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0]!;
    expect(trade.ticker).toBe('AAA');
    expect(trade.signalDate).toBe('2024-01-02');
    expect(trade.entryDate).toBe('2024-01-03');
    expect(trade.entryPrice).toBeCloseTo(100.1, 8);
    expect(trade.exitDate).toBe('2024-01-05');
    expect(trade.exitPrice).toBeCloseTo(109.89, 8);
    expect(trade.shares).toBe(19);
    expect(trade.commission).toBeCloseTo(3.98981, 6);
    expect(trade.slippage).toBeCloseTo(3.99, 6);
    expect(trade.grossPnl).toBeCloseTo(186.01, 6);
    expect(trade.pnl).toBeCloseTo(182.02019, 6);
    expect(trade.exitReason).toBe('signal');
  });

  it('la curva de capital diaria coincide con el cálculo manual', () => {
    expect(result.equityCurve.map((p) => p.date)).toEqual([
      '2024-01-02',
      '2024-01-03',
      '2024-01-04',
      '2024-01-05',
      '2024-01-08',
    ]);
    expect(result.equityCurve[0]!.equity).toBe(10_000);
    expect(result.equityCurve[1]!.equity).toBeCloseTo(9_996.1981, 6);
    expect(result.equityCurve[1]!.positions).toBe(1);
    expect(result.equityCurve[2]!.equity).toBeCloseTo(9_996.1981, 6);
    expect(result.equityCurve[3]!.equity).toBeCloseTo(10_182.02019, 6);
    expect(result.finalEquity).toBeCloseTo(10_182.02019, 6);
  });
});

// ---------------------------------------------------------------------------
// Stop y objetivo intrabarra
// ---------------------------------------------------------------------------

describe('stop y objetivo intrabarra', () => {
  const baseBars = (exitBar: EngineBar): EngineBar[] => [
    flat('2024-01-02', 100), // señal
    flat('2024-01-03', 100), // entrada (sin costes: fill = 100)
    exitBar,
    flat('2024-01-08', 100),
  ];

  it('si la misma vela toca stop y objetivo, cuenta primero el stop', () => {
    const result = runBacktest({
      strategy: scripted({ 0: (ctx) => ctx.buy('AAA', { stop: 90, target: 110 }) }),
      bars: { AAA: baseBars(flat('2024-01-05', 100, { high: 112, low: 89 })) },
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe('stop');
    // min(apertura 100, stop 90) = 90; riesgo/acción = 10 → 10 acciones.
    expect(trade.exitPrice).toBeCloseTo(90, 8);
    expect(trade.shares).toBe(10);
    expect(trade.pnl).toBeCloseTo(-100, 6);
  });

  it('un gap de apertura por debajo del stop ejecuta a la apertura, no al nivel', () => {
    const result = runBacktest({
      strategy: scripted({ 0: (ctx) => ctx.buy('AAA', { stop: 90 }) }),
      bars: { AAA: baseBars(flat('2024-01-05', 85, { high: 100, low: 84, close: 95 })) },
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe('stop');
    expect(trade.exitPrice).toBeCloseTo(85, 8); // peor que el stop: realista
  });

  it('el objetivo llena en su nivel cuando el stop no se toca', () => {
    const result = runBacktest({
      strategy: scripted({ 0: (ctx) => ctx.buy('AAA', { stop: 80, target: 110 }) }),
      bars: { AAA: baseBars(flat('2024-01-05', 100, { high: 115, low: 95, close: 112 })) },
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    const trade = result.trades[0]!;
    expect(trade.exitReason).toBe('target');
    expect(trade.exitPrice).toBeCloseTo(110, 8);
  });
});

// ---------------------------------------------------------------------------
// Barrera anti look-ahead
// ---------------------------------------------------------------------------

describe('barrera anti look-ahead', () => {
  // Serie en zigzag: la estrategia compra tras subida y vende tras bajada,
  // generando varias operaciones antes y después del punto de corte.
  const prices = [100, 102, 99, 104, 103, 106, 101, 108, 107, 110, 105, 112, 111, 114];
  const dates = prices.map((_, i) => `2024-01-${String(2 + i).padStart(2, '0')}`);
  const makeBars = (): EngineBar[] => dates.map((date, i) => flat(date, prices[i]!));

  const zigzag: Strategy = {
    init: () => {},
    onBar: (ctx) => {
      const w = ctx.bars('AAA');
      if (w.length < 2) return;
      const position = ctx.position('AAA');
      if (position === null && w.last().close > w.back(1).close) {
        ctx.buy('AAA', { stop: w.last().close * 0.9 });
      } else if (position !== null && w.last().close < w.back(1).close) {
        ctx.sell('AAA');
      }
    },
  };

  const CUT = '2024-01-10';

  it('corromper las velas posteriores a t no cambia operaciones ni capital hasta t', () => {
    const original = runBacktest({
      strategy: zigzag,
      bars: { AAA: makeBars() },
      initialCash: 10_000,
      costs: NO_COSTS,
    });
    expect(original.trades.length).toBeGreaterThan(2);

    const corrupted = makeBars().map((bar) =>
      bar.date > CUT ? { ...bar, open: 99_999, high: 100_000, low: 99_998, close: 99_999 } : bar,
    );
    const altered = runBacktest({
      strategy: zigzag,
      bars: { AAA: corrupted },
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    // El capital hasta t (inclusive) es idéntico.
    expect(altered.equityCurve.filter((p) => p.date <= CUT)).toEqual(
      original.equityCurve.filter((p) => p.date <= CUT),
    );
    // Las operaciones cerradas hasta t son idénticas, y las que abrieron
    // hasta t tienen la misma entrada (la salida puede caer después de t).
    const openSide = (t: Trade) => ({
      ticker: t.ticker,
      signalDate: t.signalDate,
      entryDate: t.entryDate,
      entryPrice: t.entryPrice,
      shares: t.shares,
    });
    expect(altered.trades.filter((t) => t.exitDate <= CUT)).toEqual(
      original.trades.filter((t) => t.exitDate <= CUT),
    );
    expect(altered.trades.filter((t) => t.entryDate <= CUT).map(openSide)).toEqual(
      original.trades.filter((t) => t.entryDate <= CUT).map(openSide),
    );
    // Sanity check: la corrupción sí alteró el tramo posterior.
    expect(altered.equityCurve.filter((p) => p.date > CUT)).not.toEqual(
      original.equityCurve.filter((p) => p.date > CUT),
    );
  });

  it('una estrategia que intenta leer la vela siguiente lanza LookAheadError', () => {
    const trap: Strategy = {
      init: () => {},
      onBar: (ctx) => {
        ctx.bars('AAA').at(ctx.bars('AAA').length);
      },
    };
    const beyond: Strategy = {
      init: () => {},
      onBar: (ctx) => {
        ctx.bars('AAA').at(999);
      },
    };

    const bars = { AAA: makeBars() };
    expect(() => runBacktest({ strategy: trap, bars })).toThrow(LookAheadError);
    expect(() => runBacktest({ strategy: trap, bars })).toThrow(RangeError);
    expect(() => runBacktest({ strategy: beyond, bars })).toThrow(LookAheadError);
  });

  it('tampoco se puede mirar atrás más allá del historial ni adelante con back()', () => {
    const backwards: Strategy = {
      init: () => {},
      onBar: (ctx) => {
        ctx.bars('AAA').back(ctx.bars('AAA').length); // una más allá de la primera
      },
    };
    const forwards: Strategy = {
      init: () => {},
      onBar: (ctx) => {
        ctx.bars('AAA').back(-1);
      },
    };
    const bars = { AAA: makeBars() };
    expect(() => runBacktest({ strategy: backwards, bars })).toThrow(LookAheadError);
    expect(() => runBacktest({ strategy: forwards, bars })).toThrow(LookAheadError);
  });

  it('la vista nunca expone una fecha posterior a la actual', () => {
    const seen: string[] = [];
    const spy: Strategy = {
      init: () => {},
      onBar: (ctx) => {
        const w = ctx.bars('AAA');
        expect(w.lastDate === null || w.lastDate <= ctx.date).toBe(true);
        expect(w.slice().length).toBe(w.length);
        seen.push(ctx.date);
      },
    };
    runBacktest({ strategy: spy, bars: { AAA: makeBars() } });
    expect(seen).toEqual(dates);
  });
});

// ---------------------------------------------------------------------------
// Universo con fechas de alta y baja (sesgo de supervivencia)
// ---------------------------------------------------------------------------

describe('universo con alta y baja', () => {
  it('un ticker dado de baja cierra su posición y deja de recibir señales', () => {
    const seenTickers: Record<string, string[]> = {};
    const spy: Strategy = {
      init: () => {},
      onBar: (ctx) => {
        seenTickers[ctx.date] = ctx.tickers();
        if (ctx.index === 0) {
          for (const ticker of ctx.tickers()) ctx.buy(ticker);
        }
        // Intenta comprar el activo ya dado de baja: la orden se descarta.
        if (ctx.date === '2024-01-08') ctx.buy('AAA');
      },
    };

    const result = runBacktest({
      strategy: spy,
      bars: {
        AAA: [flat('2024-01-02', 100), flat('2024-01-03', 100), flat('2024-01-04', 100)],
        ZZZ: [
          flat('2024-01-02', 50),
          flat('2024-01-03', 50),
          flat('2024-01-04', 50),
          flat('2024-01-05', 50),
          flat('2024-01-08', 50),
        ],
      },
      universe: [{ ticker: 'AAA', listedUntil: '2024-01-04' }, { ticker: 'ZZZ' }],
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    const aaa = result.trades.find((t) => t.ticker === 'AAA')!;
    // Comprada en la apertura del 03-01 y cerrada en el cierre de su última
    // vela cotizada, antes de que la simulación siga sin el activo.
    expect(aaa.entryDate).toBe('2024-01-03');
    expect(aaa.exitDate).toBe('2024-01-04');
    expect(aaa.exitReason).toBe('delisted');
    expect(aaa.exitPrice).toBeCloseTo(100, 8);

    // Tras la baja ya no aparece en el universo operable ni opera.
    expect(seenTickers['2024-01-05']).toEqual(['ZZZ']);
    expect(seenTickers['2024-01-08']).toEqual(['ZZZ']);
    expect(result.trades.filter((t) => t.ticker === 'AAA')).toHaveLength(1);

    const zzz = result.trades.find((t) => t.ticker === 'ZZZ')!;
    expect(zzz.exitReason).toBe('end-of-data');
    expect(zzz.exitDate).toBe('2024-01-08');
  });

  it('un activo aún no dado de alta no cotiza ni recibe señales', () => {
    const listedByDate: Record<string, boolean> = {};
    const spy: Strategy = {
      init: () => {},
      onBar: (ctx) => {
        // Intenta comprar siempre: solo debe colar cuando cotice.
        ctx.buy('NEW');
        listedByDate[ctx.date] = ctx.isListed('NEW');
      },
    };

    const result = runBacktest({
      strategy: spy,
      bars: {
        NEW: [
          flat('2024-01-02', 40),
          flat('2024-01-03', 40),
          flat('2024-01-04', 40),
          flat('2024-01-05', 40),
          flat('2024-01-08', 40),
        ],
        // ZZZ mantiene la línea temporal con sesiones previas al alta de NEW.
        ZZZ: [
          flat('2024-01-02', 50),
          flat('2024-01-03', 50),
          flat('2024-01-04', 50),
          flat('2024-01-05', 50),
          flat('2024-01-08', 50),
        ],
      },
      universe: [{ ticker: 'NEW', listedFrom: '2024-01-05' }, { ticker: 'ZZZ' }],
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    // Antes del alta el activo no cotiza: la orden se descarta aunque se pida.
    expect(listedByDate['2024-01-02']).toBe(false);
    expect(listedByDate['2024-01-04']).toBe(false);
    expect(listedByDate['2024-01-05']).toBe(true);
    // La primera orden posible se emite al cierre del 05-01 y llena en la
    // apertura del 08-01.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.ticker).toBe('NEW');
    expect(result.trades[0]!.signalDate).toBe('2024-01-05');
    expect(result.trades[0]!.entryDate).toBe('2024-01-08');
  });
});

// ---------------------------------------------------------------------------
// Cartera: máximo de posiciones, comisión mínima y calentamiento
// ---------------------------------------------------------------------------

describe('reglas de cartera', () => {
  it('nunca supera el máximo de posiciones simultáneas', () => {
    const tickers = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
    const bars = Object.fromEntries(
      tickers.map((t) => [
        t,
        [flat('2024-01-02', 10), flat('2024-01-03', 10), flat('2024-01-04', 10)],
      ]),
    );
    const result = runBacktest({
      strategy: scripted({
        0: (ctx) => {
          for (const ticker of ctx.tickers()) ctx.buy(ticker);
        },
      }),
      bars,
      initialCash: 10_000,
      maxPositions: 5,
      costs: NO_COSTS,
    });

    expect(result.equityCurve.every((p) => p.positions <= 5)).toBe(true);
    expect(result.equityCurve[1]!.positions).toBe(5);
    expect(result.trades).toHaveLength(5);
    expect(new Set(result.trades.map((t) => t.ticker)).size).toBe(5);
  });

  it('aplica la comisión mínima por ejecución', () => {
    const result = runBacktest({
      strategy: scripted({
        0: (ctx) => ctx.buy('AAA'),
        1: (ctx) => ctx.sell('AAA'),
      }),
      bars: { AAA: [flat('2024-01-02', 100), flat('2024-01-03', 100), flat('2024-01-04', 100)] },
      initialCash: 10_000,
      costs: { commissionPct: 0, commissionMin: 2, slippageBp: 0, spreadBp: 0 },
    });

    // Sin stop: slot de 10 000/5 = 2 000 → 20 acciones a 100. Comisión 2 por lado.
    const trade = result.trades[0]!;
    expect(trade.shares).toBe(20);
    expect(trade.commission).toBeCloseTo(4, 8);
    expect(trade.pnl).toBeCloseTo(-4, 8);
  });

  it('las velas anteriores a startDate son calentamiento: visibles pero sin operaciones', () => {
    const log: { date: string; warmup: boolean; visible: number }[] = [];
    const spy: Strategy = {
      init: () => {},
      onBar: (ctx) => {
        log.push({ date: ctx.date, warmup: ctx.warmup, visible: ctx.bars('AAA').length });
        // La compra emitida en calentamiento se descarta.
        ctx.buy('AAA');
      },
    };

    const result = runBacktest({
      strategy: spy,
      bars: {
        AAA: [
          flat('2024-01-02', 100),
          flat('2024-01-03', 100),
          flat('2024-01-04', 100),
          flat('2024-01-05', 100),
          flat('2024-01-08', 100),
        ],
      },
      startDate: '2024-01-05',
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    // La estrategia ve las 3 velas de calentamiento (visible crece) sin operar.
    expect(log.map((l) => l.visible)).toEqual([1, 2, 3, 4, 5]);
    expect(log.slice(0, 3).every((l) => l.warmup)).toBe(true);
    expect(log[3]!.warmup).toBe(false);
    // La curva empieza en startDate y la entrada real cae en la primera
    // apertura posterior a la primera orden válida (cierre del 05-01).
    expect(result.equityCurve[0]!.date).toBe('2024-01-05');
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.signalDate).toBe('2024-01-05');
    expect(result.trades[0]!.entryDate).toBe('2024-01-08');
    expect(result.trades[0]!.exitReason).toBe('end-of-data');
  });
});

// ---------------------------------------------------------------------------
// Validación de entrada
// ---------------------------------------------------------------------------

describe('validación de entrada', () => {
  const noop: Strategy = { init: () => {}, onBar: () => {} };

  it('rechaza velas desordenadas, duplicadas o con high < low', () => {
    const bad = [
      flat('2024-01-03', 100),
      flat('2024-01-02', 100), // desordenada
    ];
    expect(() => runBacktest({ strategy: noop, bars: { AAA: bad } })).toThrow(RangeError);

    const dup = [flat('2024-01-02', 100), flat('2024-01-02', 100)];
    expect(() => runBacktest({ strategy: noop, bars: { AAA: dup } })).toThrow(RangeError);

    const inverted = [flat('2024-01-02', 100, { high: 90 })];
    expect(() => runBacktest({ strategy: noop, bars: { AAA: inverted } })).toThrow(RangeError);
  });

  it('rechaza riesgo fuera del rango 0,5–1 % y costes negativos', () => {
    const bars = { AAA: [flat('2024-01-02', 100)] };
    expect(() => runBacktest({ strategy: noop, bars, riskPerTrade: 0.02 })).toThrow(RangeError);
    expect(() => runBacktest({ strategy: noop, bars, riskPerTrade: 0.001 })).toThrow(RangeError);
    expect(() => runBacktest({ strategy: noop, bars, costs: { commissionPct: -0.1 } })).toThrow(
      RangeError,
    );
  });

  it('con una estrategia que no opera devuelve el capital intacto', () => {
    const result = runBacktest({ strategy: noop, bars: { AAA: [flat('2024-01-02', 100)] } });
    expect(result.trades).toHaveLength(0);
    expect(result.finalEquity).toBe(10_000);
    expect(result.equityCurve).toEqual([
      { date: '2024-01-02', cash: 10_000, equity: 10_000, positions: 0 },
    ]);
  });
});
