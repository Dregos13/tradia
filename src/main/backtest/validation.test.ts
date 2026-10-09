import { describe, expect, it } from 'vitest';

import { runBacktest } from './engine';
import type { EngineBar, Strategy } from './types';
import {
  buildWalkForwardWindows,
  evaluateOverfitting,
  expandParamGrid,
  expandRange,
  FinalTestLockedError,
  finalTestStatus,
  runFinalTest,
  runMonteCarlo,
  runSensitivityMap,
  runWalkForward,
  splitTimeline,
  unionDates,
  type MonteCarloResult,
  type SensitivityMap,
} from './validation';

/** Vela plana (OHLC idénticos). */
const flat = (date: string, price: number): EngineBar => ({
  date,
  open: price,
  high: price,
  low: price,
  close: price,
});

const NO_COSTS = { commissionPct: 0, commissionMin: 0, slippageBp: 0, spreadBp: 0 };

/** n fechas diarias consecutivas desde `start` (YYYY-MM-DD). */
const makeDates = (n: number, start = '2024-01-01'): string[] => {
  const epoch = Date.parse(start);
  return Array.from({ length: n }, (_, i) =>
    new Date(epoch + i * 86_400_000).toISOString().slice(0, 10),
  );
};

/**
 * Serie sintética con cota diaria +1,5 % en las sesiones con
 * `i % 7 === bigResidue(i)` y -0,3 % en el resto. La estrategia
 * `createPatternTrader` puede «afinar» el parámetro `offset` a ese
 * patrón: compra en i ≡ offset y vende al día siguiente, así que captura
 * el retorno de la sesión i+2 (mejor offset = residuo − 2).
 */
const patternedBars = (
  dates: readonly string[],
  bigResidue: (i: number) => number,
): EngineBar[] => {
  let price = 100;
  return dates.map((date, i) => {
    if (i > 0) price *= 1 + (i % 7 === bigResidue(i) ? 0.015 : -0.003);
    return flat(date, price);
  });
};

const createPatternTrader = (): Strategy => {
  let mod = 7;
  let offset = 0;
  return {
    init: (p) => {
      mod = p.mod ?? 7;
      offset = p.offset ?? 0;
    },
    onBar: (ctx) => {
      if (ctx.position('AAA') === null) {
        if (ctx.index % mod === offset) ctx.buy('AAA');
      } else {
        ctx.sell('AAA');
      }
    },
  };
};

/**
 * Serie en tendencia suave (+0,4 % tres de cada cuatro días, −0,2 % en el
 * resto) y estrategia robusta: compra cuando el cierre supera la media de
 * `period` días durante `confirm` sesiones seguidas y mantiene. Cualquier
 * combinación del rango produce el mismo resultado, sin afinado al ruido.
 */
const trendingBars = (dates: readonly string[]): EngineBar[] => {
  let price = 100;
  return dates.map((date, i) => {
    if (i > 0) price *= 1 + (i % 4 === 0 ? -0.002 : 0.004);
    return flat(date, price);
  });
};

const createTrendFollower = (): Strategy => {
  let period = 10;
  let confirm = 1;
  let streak = 0;
  return {
    init: (p) => {
      period = Math.max(1, Math.round(p.period ?? 10));
      confirm = Math.max(1, Math.round(p.confirm ?? 1));
      streak = 0;
    },
    onBar: (ctx) => {
      const w = ctx.bars('AAA');
      if (w.length < period) return;
      let sum = 0;
      for (let k = 0; k < period; k++) sum += w.back(k).close;
      const above = w.last().close > sum / period;
      streak = above ? streak + 1 : 0;
      const pos = ctx.position('AAA');
      if (pos === null && streak >= confirm) ctx.buy('AAA');
      else if (pos !== null && !above) ctx.sell('AAA');
    },
  };
};

// ---------------------------------------------------------------------------
// División 60/20/20
// ---------------------------------------------------------------------------

describe('splitTimeline 60/20/20', () => {
  const dates = makeDates(150);

  it('unionDates une y ordena las fechas de todos los activos', () => {
    const bars = {
      AAA: [flat('2024-01-03', 10), flat('2024-01-05', 10)],
      ZZZ: [flat('2024-01-02', 20), flat('2024-01-05', 20), flat('2024-01-08', 20)],
    };
    expect(unionDates(bars)).toEqual(['2024-01-02', '2024-01-03', '2024-01-05', '2024-01-08']);
  });

  it('reparte 60 % entrenamiento, 20 % validación y 20 % prueba final', () => {
    const split = splitTimeline(dates);
    expect(split.counts).toEqual({ train: 90, validation: 30, test: 30 });
    expect(split.sessionCount).toBe(150);
  });

  it('los segmentos son disjuntos, consecutivos y cubren toda la serie', () => {
    const split = splitTimeline(dates);
    expect(split.train.startDate).toBe(dates[0]);
    expect(split.train.endDate).toBe(dates[89]);
    expect(split.validation.startDate).toBe(dates[90]);
    expect(split.validation.endDate).toBe(dates[119]);
    expect(split.test.startDate).toBe(dates[120]);
    expect(split.test.endDate).toBe(dates[149]);
    // Nunca se solapan: cada segmento empieza después de que acabe el anterior.
    expect(split.train.endDate < split.validation.startDate).toBe(true);
    expect(split.validation.endDate < split.test.startDate).toBe(true);
  });

  it('respeta proporciones personalizadas y garantiza un mínimo por segmento', () => {
    const custom = splitTimeline(makeDates(100), { train: 0.5, validation: 0.3, test: 0.2 });
    expect(custom.counts).toEqual({ train: 50, validation: 30, test: 20 });

    const tiny = splitTimeline(makeDates(3));
    expect(tiny.counts).toEqual({ train: 1, validation: 1, test: 1 });
  });

  it('rechaza series de menos de 3 sesiones y proporciones inválidas', () => {
    expect(() => splitTimeline(makeDates(2))).toThrow(RangeError);
    expect(() => splitTimeline(dates, { train: 0.6, validation: 0.3, test: 0.2 })).toThrow(
      RangeError,
    );
    expect(() => splitTimeline(dates, { train: 0, validation: 0.5, test: 0.5 })).toThrow(
      RangeError,
    );
    expect(() => splitTimeline(['no-es-fecha', '2024-01-02', '2024-01-03'])).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Ventanas walk-forward
// ---------------------------------------------------------------------------

describe('ventanas walk-forward', () => {
  const dates = makeDates(150);

  it('entrenamiento y prueba nunca se solapan; la prueba siempre va después', () => {
    const windows = buildWalkForwardWindows(dates, { trainSize: 30, testSize: 15 });
    expect(windows.length).toBe(8); // 0,15,…,105: el último cubre la prueba parcial
    for (const w of windows) {
      expect(w.train.endDate < w.test.startDate).toBe(true);
      expect(w.test.endDate <= '2024-05-29').toBe(true);
    }
    // Con paso = testSize las pruebas tampoco se solapan entre sí.
    for (let i = 1; i < windows.length; i++) {
      expect(windows[i]!.test.startDate > windows[i - 1]!.test.endDate).toBe(true);
    }
    // La última prueba llega al final de la serie (ventana parcial permitida).
    expect(windows.at(-1)!.test.endDate).toBe(dates[149]);
  });

  it('con paso menor las pruebas pueden solaparse, pero nunca con su entrenamiento', () => {
    const windows = buildWalkForwardWindows(dates, { trainSize: 20, testSize: 10, step: 5 });
    expect(windows.length).toBeGreaterThan(8);
    for (const w of windows) {
      expect(w.train.endDate < w.test.startDate).toBe(true);
    }
  });

  it('devuelve vacío si no cabe ni un ciclo y valida los tamaños', () => {
    expect(buildWalkForwardWindows(makeDates(20), { trainSize: 20 })).toEqual([]);
    expect(() => buildWalkForwardWindows(dates, { trainSize: 0 })).toThrow(RangeError);
    expect(() => buildWalkForwardWindows(dates, { trainSize: 10, step: 0 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Walk-forward completo: optimiza en muestra, evalúa fuera de muestra
// ---------------------------------------------------------------------------

describe('runWalkForward', () => {
  it('optimiza la rejilla en la ventana de entrenamiento y la evalúa en la siguiente', () => {
    // Patrón estable: los días buenos son siempre ≡3 (mod 7), así que el
    // mejor offset es 1 (captura el retorno de i+2) dentro y fuera de muestra.
    const dates = makeDates(120);
    const bars = { AAA: patternedBars(dates, () => 3) };

    const result = runWalkForward({
      strategy: createPatternTrader,
      bars,
      params: { mod: 7 },
      grid: { offset: { min: 0, max: 6, step: 1 } },
      window: { trainSize: 60, testSize: 20 },
      objective: 'sharpe',
      costs: NO_COSTS,
    });

    expect(result.windows).toHaveLength(3); // arranques 0, 20 y 40; en 60 ya no cabe el entrenamiento
    for (const w of result.windows) {
      expect(w.params.offset).toBe(1);
      expect(w.candidates).toBe(7);
      expect(w.train.endDate < w.test.startDate).toBe(true);
      expect(w.inSampleMetric).not.toBeNull();
      expect(w.outOfSampleMetric).not.toBeNull();
      expect(w.outOfSampleMetrics.tradeCount).toBeGreaterThan(0);
    }
    expect(result.outOfSampleTrades.length).toBe(
      result.windows.reduce((acc, w) => acc + w.outOfSampleMetrics.tradeCount, 0),
    );
  });

  it('acepta una rejilla vacía (un solo candidato) y es determinista', () => {
    const dates = makeDates(80);
    const bars = { AAA: trendingBars(dates) };
    const run = () =>
      runWalkForward({
        strategy: createTrendFollower,
        bars,
        params: { period: 10 },
        window: { trainSize: 40, testSize: 20 },
        costs: NO_COSTS,
      });
    const a = run();
    const b = run();
    expect(a.windows).toHaveLength(2);
    expect(a.windows[0]!.candidates).toBe(1);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Rejillas de parámetros
// ---------------------------------------------------------------------------

describe('rejillas de parámetros', () => {
  it('expandRange incluye los extremos y compensa la aritmética binaria', () => {
    expect(expandRange({ min: 0, max: 0.3, step: 0.1 })).toEqual([0, 0.1, 0.2, 0.3]);
    expect(expandRange({ min: 5, max: 5, step: 1 })).toEqual([5]);
    expect(() => expandRange({ min: 0, max: 1, step: 0 })).toThrow(RangeError);
    expect(() => expandRange({ min: 2, max: 1, step: 1 })).toThrow(RangeError);
  });

  it('expandParamGrid hace el producto cartesiano sobre los parámetros base', () => {
    const combos = expandParamGrid(
      { fixed: 7 },
      { b: { min: 0, max: 1, step: 1 }, a: { min: 10, max: 20, step: 10 } },
    );
    expect(combos).toHaveLength(4);
    // Orden determinista: claves ordenadas (a, b), valores ascendentes.
    expect(combos).toEqual([
      { fixed: 7, a: 10, b: 0 },
      { fixed: 7, a: 10, b: 1 },
      { fixed: 7, a: 20, b: 0 },
      { fixed: 7, a: 20, b: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Mapa de sensibilidad
// ---------------------------------------------------------------------------

describe('mapa de sensibilidad', () => {
  const dates = makeDates(90);
  const bars = { AAA: patternedBars(dates, () => 3) };

  it('barre la rejilla 2D y marca la celda base más cercana a los parámetros', () => {
    const map = runSensitivityMap({
      strategy: createPatternTrader,
      bars,
      params: { mod: 7, offset: 1 },
      x: { param: 'offset', range: { min: 0, max: 6, step: 1 } },
      y: { param: 'mod', range: { min: 6, max: 8, step: 1 } },
      metric: 'sharpe',
      costs: NO_COSTS,
    });

    expect(map.xValues).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(map.yValues).toEqual([6, 7, 8]);
    expect(map.cells).toHaveLength(3);
    expect(map.cells[0]).toHaveLength(7);
    expect(map.baseCell).toEqual({ x: 1, y: 1 }); // offset 1, mod 7
    // La celda base es claramente la mejor: solo ella captura los días buenos.
    expect(map.baseValue).not.toBeNull();
    const others = map.cells.flat().filter((_, i) => i !== 1 * 7 + 1);
    for (const v of others) {
      if (v !== null) expect(v).toBeLessThan(map.baseValue!);
    }
  });

  it('rechaza ejes con el mismo parámetro', () => {
    expect(() =>
      runSensitivityMap({
        strategy: createPatternTrader,
        bars,
        params: { mod: 7, offset: 1 },
        x: { param: 'offset', range: { min: 0, max: 6, step: 1 } },
        y: { param: 'offset', range: { min: 0, max: 6, step: 1 } },
        costs: NO_COSTS,
      }),
    ).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Monte Carlo del orden de las operaciones
// ---------------------------------------------------------------------------

describe('Monte Carlo', () => {
  const trades = [150, -80, 40, -30, 200, -60, 10, -120].map((pnl, i) => ({
    pnl,
    entryDate: `2024-01-${String(2 + i * 2).padStart(2, '0')}`,
    exitDate: `2024-01-${String(3 + i * 2).padStart(2, '0')}`,
  }));
  const totalPnl = trades.reduce((acc, t) => acc + t.pnl, 0); // 110

  it('es determinista con la semilla y no depende del orden de entrada', () => {
    const a = runMonteCarlo({ trades, seed: 42, simulations: 200 });
    const b = runMonteCarlo({ trades, seed: 42, simulations: 200 });
    expect(a).toEqual(b);

    const shuffled = [...trades].reverse();
    const c = runMonteCarlo({ trades: shuffled, seed: 42, simulations: 200 });
    expect(c).toEqual(a);

    const other = runMonteCarlo({ trades, seed: 43, simulations: 200 });
    expect(other.distribution).not.toEqual(a.distribution);
  });

  it('la permutación conserva la suma de PnL en cada simulación', () => {
    const result = runMonteCarlo({ trades, seed: 7, simulations: 300 });
    expect(result.tradeCount).toBe(8);
    // Como solo se reordena el orden, la rentabilidad final es siempre la
    // observada: los tres percentiles coinciden con ella.
    for (const sample of result.distribution) {
      expect(sample.totalReturn * result.initialCash).toBeCloseTo(totalPnl, 8);
    }
    expect(result.returnPercentiles.p5).toBeCloseTo(totalPnl / 10_000, 10);
    expect(result.returnPercentiles.p5).toBe(result.returnPercentiles.p95);
  });

  it('el remuestreo (bootstrap) dispersa la rentabilidad', () => {
    const result = runMonteCarlo({
      trades,
      seed: 7,
      simulations: 400,
      method: 'bootstrap',
    });
    expect(result.method).toBe('bootstrap');
    const returns = new Set(result.distribution.map((d) => d.totalReturn));
    expect(returns.size).toBeGreaterThan(10); // combinaciones distintas
    expect(result.returnPercentiles.p5).toBeLessThanOrEqual(result.returnPercentiles.p50);
    expect(result.returnPercentiles.p50).toBeLessThanOrEqual(result.returnPercentiles.p95);
  });

  it('los percentiles van ordenados y el drawdown es un tanto por uno positivo', () => {
    const result = runMonteCarlo({ trades, seed: 5 });
    expect(result.simulations).toBe(1000);
    const p = result.drawdownPercentiles;
    expect(p.p5).toBeLessThanOrEqual(p.p50);
    expect(p.p50).toBeLessThanOrEqual(p.p95);
    expect(p.p5).toBeGreaterThanOrEqual(0);
    expect(p.p95).toBeLessThanOrEqual(1);
  });

  it('sin operaciones devuelve simulaciones planas y valida la entrada', () => {
    const result = runMonteCarlo({ trades: [], seed: 1, simulations: 10 });
    expect(result.distribution).toHaveLength(10);
    expect(result.returnPercentiles).toEqual({ p5: 0, p50: 0, p95: 0 });
    expect(result.drawdownPercentiles).toEqual({ p5: 0, p50: 0, p95: 0 });

    expect(() => runMonteCarlo({ trades, simulations: 0 })).toThrow(RangeError);
    expect(() => runMonteCarlo({ trades: [{ pnl: Number.NaN }] })).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// Prueba final bloqueada
// ---------------------------------------------------------------------------

describe('prueba final bloqueada', () => {
  const buy: Strategy = {
    init: () => {},
    onBar: (ctx) => {
      if (ctx.index === 0) ctx.buy('AAA');
    },
  };
  const input = {
    strategy: buy,
    bars: { AAA: [flat('2024-01-02', 100), flat('2024-01-03', 101), flat('2024-01-04', 102)] },
    initialCash: 10_000,
    costs: NO_COSTS,
  } as const;

  it('ejecuta una vez y devuelve la bandera a persistir con las métricas', () => {
    const first = runFinalTest(input);
    expect(first.executed).toBe(true);
    expect(first.result.trades).toHaveLength(1);
    expect(first.metrics.tradeCount).toBe(1);
    expect(finalTestStatus(first.executed)).toBe('ejecutada');
  });

  it('la prueba final no se puede ejecutar dos veces por versión', () => {
    expect(() => runFinalTest({ ...input, alreadyExecuted: true })).toThrow(FinalTestLockedError);
    expect(() => runFinalTest({ ...input, alreadyExecuted: true })).toThrow(/versión nueva/);
    expect(finalTestStatus(false)).toBe('disponible');
  });

  it('un backtest normal no queda bloqueado por la bandera', () => {
    const plain = runBacktest(input);
    expect(plain.trades).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Avisos de sobreajuste — reglas unitarias
// ---------------------------------------------------------------------------

describe('reglas de aviso de sobreajuste', () => {
  const fakeMap = (base: number, neighbors: (number | null)[]): SensitivityMap => {
    // Mapa 3×3: base en el centro, vecinos en el orden dado.
    const cells: (number | null)[][] = [
      [neighbors[0] ?? null, neighbors[1] ?? null, neighbors[2] ?? null],
      [neighbors[3] ?? null, base, neighbors[4] ?? null],
      [neighbors[5] ?? null, neighbors[6] ?? null, neighbors[7] ?? null],
    ];
    return {
      metric: 'sharpe',
      xParam: 'a',
      xValues: [0, 1, 2],
      yParam: 'b',
      yValues: [0, 1, 2],
      cells,
      baseCell: { x: 1, y: 1 },
      baseValue: base,
    };
  };

  it('Sharpe fuera de muestra < 50 % del de entrenamiento', () => {
    const hit = evaluateOverfitting({ inSampleSharpe: 1.2, outOfSampleSharpe: 0.5 });
    expect(hit.map((w) => w.rule)).toEqual(['oos-sharpe-decay']);
    expect(hit[0]!.message).toContain('Posible sobreajuste');
    expect(hit[0]!.message).toContain('0.50');
    expect(hit[0]!.message).toContain('1.20');

    expect(evaluateOverfitting({ inSampleSharpe: 1.2, outOfSampleSharpe: 0.7 })).toEqual([]);
    expect(evaluateOverfitting({ inSampleSharpe: 1.2, outOfSampleSharpe: null })).toEqual([]);
    expect(evaluateOverfitting({ inSampleSharpe: Infinity, outOfSampleSharpe: 0.1 })).toEqual([]);
    expect(evaluateOverfitting({})).toEqual([]);
  });

  it('más de la mitad de los vecinos pierden más del 50 % del resultado', () => {
    // Base 1.0 con 5 de 8 vecinos por debajo de 0.5.
    const collapsed = fakeMap(1, [0.1, 0.2, 0.9, 0.3, 0.8, 0.4, 0.2, 0.6]);
    const warnings = evaluateOverfitting({ sensitivity: collapsed });
    expect(warnings.map((w) => w.rule)).toEqual(['sensitivity-collapse']);
    expect(warnings[0]!.message).toContain('5 de 8');

    // Solo 4 de 8 colapsados: no es más de la mitad.
    const borderline = fakeMap(1, [0.1, 0.2, 0.9, 0.3, 0.8, 0.6, 0.7, 0.6]);
    expect(evaluateOverfitting({ sensitivity: borderline })).toEqual([]);

    // Sin base positiva o sin vecinos definidos, la regla no se evalúa.
    expect(evaluateOverfitting({ sensitivity: fakeMap(0, [0, 0, 0, 0, 0, 0, 0, 0]) })).toEqual([]);
    const allNull = fakeMap(1, Array(8).fill(null));
    expect(evaluateOverfitting({ sensitivity: allNull })).toEqual([]);
  });

  it('percentil 5 con rentabilidad negativa y drawdown > 10 %', () => {
    const mc = (p5r: number, p5d: number): MonteCarloResult => ({
      method: 'permutation',
      seed: 1,
      simulations: 10,
      tradeCount: 3,
      initialCash: 10_000,
      returnPercentiles: { p5: p5r, p50: 0, p95: 0 },
      drawdownPercentiles: { p5: p5d, p50: 0, p95: 0 },
      distribution: [],
    });

    const hit = evaluateOverfitting({ monteCarlo: mc(-0.03, 0.14) });
    expect(hit.map((w) => w.rule)).toEqual(['monte-carlo-tail']);
    expect(hit[0]!.message).toContain('-3.0 %');
    expect(hit[0]!.message).toContain('14.0 %');

    // Drawdown alto pero rentabilidad positiva: no avisa.
    expect(evaluateOverfitting({ monteCarlo: mc(0.02, 0.4) })).toEqual([]);
    // Rentabilidad negativa pero drawdown ≤ 10 %: no avisa.
    expect(evaluateOverfitting({ monteCarlo: mc(-0.03, 0.1) })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Caso completo: estrategia sobreajustada vs robusta
// ---------------------------------------------------------------------------

describe('sobreajuste de extremo a extremo', () => {
  const dates = makeDates(150);

  /**
   * Flujo del informe: split 60/20/20; walk-forward sobre el tramo
   * entrenamiento+validación (la prueba queda bloqueada) y las reglas se
   * evalúan con la media de Sharpe dentro y fuera de muestra.
   */
  const evaluate = (bars: EngineBar[], strategy: () => Strategy, extra?: object) => {
    const split = splitTimeline(dates);
    const trainValidation = dates.filter((d) => d <= split.validation.endDate);
    const wf = runWalkForward({
      strategy,
      bars: { AAA: bars },
      window: {
        trainSize: split.counts.train,
        testSize: split.counts.validation,
        step: split.counts.validation,
      },
      dates: trainValidation,
      costs: NO_COSTS,
      ...extra,
    });
    return { split, wf };
  };

  it('una estrategia afinada al ruido dispara el aviso', () => {
    // Los días buenos son ≡3 (mod 7) en las primeras 90 sesiones y ≡5 en el
    // resto: el «mejor» offset del entrenamiento pierde siempre fuera de
    // muestra — la firma exacta de un parámetro afinado al ruido.
    const bars = patternedBars(dates, (i) => (i < 90 ? 3 : 5));
    const { wf } = evaluate(bars, createPatternTrader, {
      params: { mod: 7 },
      grid: { offset: { min: 0, max: 6, step: 1 } },
    });

    expect(wf.windows).toHaveLength(1);
    const window = wf.windows[0]!;
    // El optimizador afina al ruido del tramo de entrenamiento (offset 1).
    expect(window.params.offset).toBe(1);
    expect(window.inSampleMetric).toBeGreaterThan(0);
    expect(window.outOfSampleMetric).toBeLessThan(0);

    const warnings = evaluateOverfitting({
      inSampleSharpe: wf.meanInSampleMetric,
      outOfSampleSharpe: wf.meanOutOfSampleMetric,
      monteCarlo: runMonteCarlo({ trades: wf.outOfSampleTrades, seed: 1, simulations: 100 }),
    });
    expect(warnings.map((w) => w.rule)).toContain('oos-sharpe-decay');
    expect(warnings.every((w) => w.message.includes('Posible sobreajuste'))).toBe(true);
  });

  it('una estrategia robusta no dispara ningún aviso', () => {
    const bars = trendingBars(dates);
    const { wf } = evaluate(bars, createTrendFollower, {
      params: { period: 10, confirm: 1 },
      grid: { period: { min: 4, max: 12, step: 4 }, confirm: { min: 1, max: 3, step: 1 } },
    });

    expect(wf.windows).toHaveLength(1);
    const window = wf.windows[0]!;
    expect(window.outOfSampleMetrics.tradeCount).toBeGreaterThan(0);

    const sensitivity = runSensitivityMap({
      strategy: createTrendFollower,
      bars: { AAA: bars },
      params: { period: 10, confirm: 1 },
      x: { param: 'period', range: { min: 4, max: 12, step: 4 } },
      y: { param: 'confirm', range: { min: 1, max: 3, step: 1 } },
      startDate: splitTrainStart(wf),
      endDate: window.train.endDate,
      costs: NO_COSTS,
    });
    const warnings = evaluateOverfitting({
      inSampleSharpe: wf.meanInSampleMetric,
      outOfSampleSharpe: wf.meanOutOfSampleMetric,
      sensitivity,
      monteCarlo: runMonteCarlo({ trades: wf.outOfSampleTrades, seed: 1, simulations: 100 }),
    });
    expect(warnings).toEqual([]);
  });

  function splitTrainStart(wf: { windows: { train: { startDate: string } }[] }): string {
    return wf.windows[0]!.train.startDate;
  }
});
