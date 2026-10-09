/**
 * Pruebas de `stress.ts` — Fase 2.
 *
 * Con el proveedor simulado (historia desde 2000): las tres ventanas de
 * crisis producen resultado para las 4 estrategias clásicas, el
 * calentamiento no genera operaciones ni curva antes del inicio de la
 * ventana y la fuente queda etiquetada. Además: un resultado conocido
 * sobre datos sintéticos (benchmark y curva) y la resolución de la fuente
 * (Tiingo si hay clave, simulado si no).
 */
import { describe, expect, it } from 'vitest';

import { isTradingDay } from '../market/calendar';
import { createSimulatedProvider } from '../market/providers';
import { runBacktest } from './engine';
import { CLASSIC_STRATEGIES } from './strategies';
import { CROSS_ASSET_MOMENTUM_DEFAULTS } from './strategies/crossAssetMomentum';
import { bar, sessionDates } from './strategies/testKit';
import type { EngineBar, Strategy, StrategyContext } from './types';
import {
  costConfigFromAssumed,
  CRISIS_WINDOWS,
  DEFAULT_STRESS_WARMUP_SESSIONS,
  resolveStressSource,
  runStressTests,
  stressSourceFromGetter,
  stressSourceFromProvider,
  warmupStartDate,
  type CrisisWindow,
} from './stress';

/** Reloj fijo para el simulado: todas las crisis ya pasaron. */
const NOW = () => Date.parse('2024-01-02T00:00:00Z');

const simulated = () => createSimulatedProvider({ seed: 'stress-test', now: NOW });

const defOf = (key: string) => CLASSIC_STRATEGIES.find((s) => s.key === key)!;

/** Momentum reparte el capital si maxPositions = topN (documentado en su ficha). */
const maxPositionsFor = (key: string) =>
  key === 'cross-asset-momentum' ? CROSS_ASSET_MOMENTUM_DEFAULTS.topN : undefined;

/**
 * Proveedor simulado con caché por (ticker, desde, hasta): las pruebas
 * reejecutan el motor sobre las mismas velas que pidió `runStressTests` y
 * cada serie se construye una sola vez.
 */
function cachedSimulated() {
  const provider = simulated();
  const cache = new Map<string, EngineBar[]>();
  const getBars = async (ticker: string, desde: string, hasta: string): Promise<EngineBar[]> => {
    const key = `${ticker}|${desde}|${hasta}`;
    let bars = cache.get(key);
    if (bars === undefined) {
      bars = await provider.getBars(ticker, desde, hasta);
      cache.set(key, bars);
    }
    return bars;
  };
  return { getBars, source: stressSourceFromGetter('simulated', 'simulated', getBars) };
}

/**
 * Velas de `markets` con el calentamiento que pide `runStressTests`, para
 * reejecutar el motor sobre una ventana y comprobar sus operaciones.
 */
async function barsForWindow(
  getBars: (ticker: string, desde: string, hasta: string) => Promise<EngineBar[]>,
  markets: readonly string[],
  window: CrisisWindow,
  warmupSessions = DEFAULT_STRESS_WARMUP_SESSIONS,
): Promise<Record<string, EngineBar[]>> {
  const desde = warmupStartDate(window.desde, warmupSessions);
  const bars: Record<string, EngineBar[]> = {};
  for (const ticker of markets) {
    bars[ticker] = await getBars(ticker, desde, window.hasta);
  }
  return bars;
}

// ---------------------------------------------------------------------------
// Las tres ventanas × las cuatro estrategias clásicas
// ---------------------------------------------------------------------------

describe('las tres crisis con las cuatro estrategias clásicas (proveedor simulado)', () => {
  for (const def of CLASSIC_STRATEGIES) {
    it(`${def.key}: produce resultado en 2008, 2020 y 2022, etiquetado simulado`, async () => {
      const run = await runStressTests({
        strategy: def.create,
        params: def.seed.parameters,
        markets: def.seed.markets,
        source: stressSourceFromProvider(simulated()),
        maxPositions: maxPositionsFor(def.key),
      });

      expect(run.dataSource).toBe('simulated');
      expect(run.providerId).toBe('simulated');
      expect(run.benchmarkTicker).toBe('SPY');
      expect(run.results.map((r) => r.crisis.id)).toEqual(['2008', '2020', '2022']);

      for (const result of run.results) {
        expect(result.sessions).toBeGreaterThan(0);
        expect(result.equityCurve.length).toBe(result.sessions);
        expect(result.totalReturn).not.toBeNull();
        expect(Number.isFinite(result.totalReturn)).toBe(true);
        if (result.maxDrawdown !== null) {
          expect(result.maxDrawdown).toBeGreaterThanOrEqual(0);
          expect(result.maxDrawdown).toBeLessThanOrEqual(1);
        }
        expect(Number.isInteger(result.trades)).toBe(true);
        expect(result.trades).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(result.benchmarkReturn)).toBe(true);
        expect(result.dataSource).toBe('simulated');
        expect(result.providerId).toBe('simulated');
      }
    }, 30_000);
  }
});

// ---------------------------------------------------------------------------
// Calentamiento
// ---------------------------------------------------------------------------

describe('calentamiento previo a cada ventana', () => {
  it('warmupStartDate retrocede exactamente N sesiones de mercado', () => {
    const desde = warmupStartDate('2020-02-19', 300);
    expect(desde).toBe('2018-12-07');
    expect(isTradingDay(desde)).toBe(true);
    // Entre la fecha devuelta (inclusive) y el inicio hay justo 300 sesiones.
    let sessions = 0;
    const day = new Date(`${desde}T00:00:00.000Z`);
    while (day.toISOString().slice(0, 10) < '2020-02-19') {
      if (isTradingDay(day.toISOString().slice(0, 10))) sessions++;
      day.setUTCDate(day.getUTCDate() + 1);
    }
    expect(sessions).toBe(300);

    expect(warmupStartDate('2020-02-19', 0)).toBe('2020-02-19');
    expect(() => warmupStartDate('2020-02-19', -1)).toThrow(RangeError);
    expect(() => warmupStartDate('2020-02-19', 2.5)).toThrow(RangeError);
  });

  it('pide las velas desde antes del inicio (calentamiento real)', async () => {
    const calls: { desde: string; hasta: string }[] = [];
    const provider = simulated();
    const source = stressSourceFromGetter('spy-on-simulated', 'simulated', async (t, d, h) => {
      calls.push({ desde: d, hasta: h });
      return provider.getBars(t, d, h);
    });

    await runStressTests({
      strategy: defOf('rsi-mean-reversion').create,
      markets: ['SPY'],
      source,
      warmupSessions: 100,
    });

    // Un mercado + el benchmark ya deduplicado: una llamada por ventana.
    expect(calls).toHaveLength(CRISIS_WINDOWS.length);
    for (const [i, window] of CRISIS_WINDOWS.entries()) {
      expect(calls[i]).toEqual({ desde: warmupStartDate(window.desde, 100), hasta: window.hasta });
      expect(calls[i]!.desde < window.desde).toBe(true);
    }
  });

  it('ninguna operación ni punto de la curva cae antes del inicio de la ventana', async () => {
    const sim = cachedSimulated();
    for (const def of CLASSIC_STRATEGIES) {
      const run = await runStressTests({
        strategy: def.create,
        params: def.seed.parameters,
        markets: def.seed.markets,
        source: sim.source,
        maxPositions: maxPositionsFor(def.key),
      });
      for (const result of run.results) {
        expect(result.equityCurve.length).toBeGreaterThan(0);
        for (const point of result.equityCurve) {
          expect(point.date >= result.crisis.desde).toBe(true);
          expect(point.date <= result.crisis.hasta).toBe(true);
        }
        // Las operaciones brutas del motor confirman que ni la señal ni la
        // ejecución caen en el calentamiento.
        const bt = runBacktest({
          strategy: def.create(),
          params: def.seed.parameters,
          bars: await barsForWindow(sim.getBars, def.seed.markets, result.crisis),
          startDate: result.crisis.desde,
          endDate: result.crisis.hasta,
          maxPositions: maxPositionsFor(def.key),
        });
        expect(bt.trades.length).toBe(result.trades);
        for (const trade of bt.trades) {
          expect(trade.signalDate >= result.crisis.desde).toBe(true);
          expect(trade.entryDate >= result.crisis.desde).toBe(true);
          expect(trade.exitDate <= result.crisis.hasta).toBe(true);
        }
      }
    }
  }, 60_000);

  it('con calentamiento, la primera rotación de momentum llega en el primer mes de la ventana', async () => {
    const def = defOf('cross-asset-momentum');
    const window = CRISIS_WINDOWS[1]!; // 2020
    const bt = runBacktest({
      strategy: def.create(),
      params: def.seed.parameters,
      bars: await barsForWindow(cachedSimulated().getBars, def.seed.markets, window),
      startDate: window.desde,
      endDate: window.hasta,
      maxPositions: CROSS_ASSET_MOMENTUM_DEFAULTS.topN,
    });
    expect(bt.trades.length).toBeGreaterThan(0);
    // Sin las ~300 sesiones de calentamiento el lookback (126) no existiría
    // hasta mucho después: la primera señal cae en el primer mes.
    const firstSignal = bt.trades.reduce(
      (min, t) => (t.signalDate < min ? t.signalDate : min),
      '9999-99-99',
    );
    expect(firstSignal < '2020-03-19').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Resultado conocido sobre datos sintéticos
// ---------------------------------------------------------------------------

describe('resultado conocido sobre datos sintéticos', () => {
  // 10 sesiones sintéticas: 5 de calentamiento + ventana 2024-01-08 → 2024-01-12.
  const dates = sessionDates(10, '2024-01-03');
  const window = { id: 'sintetica', name: 'Sintética', desde: '2024-01-08', hasta: '2024-01-12' };
  // SPY dentro de la ventana: 100 → 90 → 80 → 80 → 80 = −20 %.
  const spyBars = dates.map((d, i) => bar(d, [110, 108, 105, 102, 100, 100, 90, 80, 80, 80][i]!));
  const aaaBars = dates.map((d, i) => bar(d, 50 + i));
  const synthSource = () =>
    stressSourceFromGetter('sintetica', 'simulated', async (ticker, desde, hasta) => {
      const all = ticker === 'SPY' ? spyBars : ticker === 'AAA' ? aaaBars : [];
      return all.filter((b) => b.date >= desde && b.date <= hasta);
    });

  it('calcula el benchmark comprar-y-mantener a partir de los cierres de la ventana', async () => {
    const run = await runStressTests({
      strategy: () => ({ init: () => {}, onBar: () => {} }),
      markets: ['AAA'],
      source: synthSource(),
      windows: [window],
      warmupSessions: 5,
    });
    const r = run.results[0]!;
    expect(r.benchmarkReturn).toBeCloseTo(-0.2, 10);
    // Estrategia en efectivo: rentabilidad 0, sin drawdown ni operaciones.
    expect(r.totalReturn).toBe(0);
    expect(r.maxDrawdown).toBe(0);
    expect(r.trades).toBe(0);
    expect(r.sessions).toBe(5); // 2024-01-08 … 2024-01-12
    expect(r.equityCurve[0]!.date).toBe('2024-01-08');
    expect(r.equityCurve.at(-1)!.date).toBe('2024-01-12');
  });

  it('una operación dentro de la ventana marca la curva y el recuento', async () => {
    let bought = false;
    let sold = false;
    const strategy = (): Strategy => ({
      init: () => {
        bought = false;
        sold = false;
      },
      onBar: (ctx: StrategyContext) => {
        if (ctx.warmup) return;
        if (!bought) {
          ctx.buy('AAA');
          bought = true;
        } else if (!sold && ctx.date === '2024-01-10') {
          ctx.sell('AAA');
          sold = true;
        }
      },
    });
    const run = await runStressTests({
      strategy,
      markets: ['AAA'],
      source: synthSource(),
      windows: [window],
      warmupSessions: 5,
      costs: { commissionPct: 0, commissionMin: 0, slippageBp: 0, spreadBp: 0 },
    });
    const r = run.results[0]!;
    expect(r.trades).toBe(1);
    expect(Number.isFinite(r.totalReturn)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fuente de datos: etiqueta y resolución
// ---------------------------------------------------------------------------

describe('fuente de datos', () => {
  it('stressSourceFromProvider etiqueta simulated y el resto como real', () => {
    expect(stressSourceFromProvider(simulated()).kind).toBe('simulated');
    const fakeReal = stressSourceFromProvider({
      id: 'tiingo',
      rateLimits: { perHour: 50, perDay: 1000 },
      getBars: async () => [],
      getQuote: async () => ({ ticker: 'SPY', date: '2020-01-02', last: 1, volume: 1 }),
      getCorporateActions: async () => [],
    });
    expect(fakeReal.kind).toBe('real');
    expect(fakeReal.id).toBe('tiingo');
  });

  it('los resultados llevan la etiqueta de la fuente usada', async () => {
    const realSource = stressSourceFromGetter('market-repository', 'real', async () => []);
    const run = await runStressTests({
      strategy: defOf('rsi-mean-reversion').create,
      markets: ['SPY'],
      source: realSource,
      windows: [CRISIS_WINDOWS[1]!],
    });
    expect(run.dataSource).toBe('real');
    expect(run.providerId).toBe('market-repository');
    expect(run.results[0]!.dataSource).toBe('real');
    // Sin datos la ventana sigue dando resultado (métricas a null).
    expect(run.results[0]!.sessions).toBe(0);
    expect(run.results[0]!.totalReturn).toBeNull();
  });

  it('resolveStressSource: Tiingo si hay clave en secrets, simulado si no', async () => {
    const withKey = await resolveStressSource({
      secrets: { hasKey: async () => true, getKey: async () => 'clave-secreta' },
      fetch: async () => new Response('[]', { status: 200 }),
      now: NOW,
    });
    expect(withKey.id).toBe('tiingo');
    expect(withKey.kind).toBe('real');

    const withoutKey = await resolveStressSource({
      secrets: { hasKey: async () => false, getKey: async () => null },
      simulated: { seed: 'stress-test', now: NOW },
    });
    expect(withoutKey.id).toBe('simulated');
    expect(withoutKey.kind).toBe('simulated');
    // El simulado resuelto entrega historia para una crisis real.
    const bars = await withoutKey.getBars('SPY', '2007-10-09', '2009-03-09');
    expect(bars.length).toBeGreaterThan(200);

    const noSecrets = await resolveStressSource({ simulated: { now: NOW } });
    expect(noSecrets.kind).toBe('simulated');
  });
});

// ---------------------------------------------------------------------------
// Validación de la entrada y conversión de costes
// ---------------------------------------------------------------------------

describe('validación y costes', () => {
  const source = () => stressSourceFromProvider(simulated());
  const strategy = () => ({ init: () => {}, onBar: () => {} });

  it('rechaza entradas inválidas', async () => {
    await expect(
      runStressTests({ strategy: 'x' as never, markets: ['SPY'], source: source() }),
    ).rejects.toThrow(TypeError);
    await expect(runStressTests({ strategy, markets: [], source: source() })).rejects.toThrow(
      RangeError,
    );
    await expect(
      runStressTests({
        strategy,
        markets: ['SPY'],
        source: source(),
        windows: [{ id: 'x', name: 'x', desde: '2020-05-01', hasta: '2020-01-01' }],
      }),
    ).rejects.toThrow(RangeError);
    await expect(
      runStressTests({ strategy, markets: ['SPY'], source: source(), windows: [] }),
    ).rejects.toThrow(RangeError);
  });

  it('costConfigFromAssumed traduce los costes de la ficha (% → fracción)', () => {
    expect(
      costConfigFromAssumed({
        commissionPct: 0.05,
        commissionMin: 1,
        slippageBps: 5,
        spreadBps: 2,
      }),
    ).toEqual({ commissionPct: 0.0005, commissionMin: 1, slippageBp: 5, spreadBp: 2 });
    expect(costConfigFromAssumed({})).toEqual({});
  });
});
