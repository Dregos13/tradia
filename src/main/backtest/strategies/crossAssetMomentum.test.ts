/**
 * Momentum entre activos sobre series sintéticas: tres activos con
 * pendientes distintas hacen evidente el ranking de rentabilidad a
 * `lookbackSessions`, y un cambio de liderazgo a mitad del periodo fuerza
 * una rotación en la primera sesión del mes siguiente.
 */
import { describe, expect, it } from 'vitest';

import { runBacktest } from '../engine';
import type { EngineBar } from '../types';
import {
  createCrossAssetMomentumStrategy,
  CROSS_ASSET_MOMENTUM_SEED,
  ETF_UNIVERSE,
} from './crossAssetMomentum';
import { assertNoLookAhead, NO_COSTS, seriesFromCloses, sessionDates } from './testKit';

const PARAMS = { lookbackSessions: 5, topN: 2 };

// 50 sesiones del 15-ene al 4-mar: dos cambios de mes naturales.
const DATES = sessionDates(50, '2024-01-15');

/** AAA +2 %/día, BBB +1 %/día, CCC plano hasta la sesión 30 y luego +8 %/día. */
function momentumBars(): Record<string, EngineBar[]> {
  const closes: Record<string, number[]> = { AAA: [], BBB: [], CCC: [] };
  for (let i = 0; i < DATES.length; i++) {
    closes['AAA']!.push(100 * Math.pow(1.02, i));
    closes['BBB']!.push(100 * Math.pow(1.01, i));
    closes['CCC']!.push(i < 30 ? 100 : 100 * Math.pow(1.08, i - 30));
  }
  return Object.fromEntries(
    Object.entries(closes).map(([ticker, series]) => [
      ticker,
      seriesFromCloses(DATES, series),
    ]),
  );
}

describe('momentum entre activos (rotación mensual al top N)', () => {
  it('compra los dos mejores por rentabilidad en la primera sesión del mes', () => {
    const result = runBacktest({
      strategy: createCrossAssetMomentumStrategy(),
      params: PARAMS,
      bars: momentumBars(),
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    // Enero: aún no hay historial de 6 velas para puntuar → no se compra.
    // Febrero: AAA (+10,4 % en 5 cierres) y BBB (+5,1 %) ganan a CCC (~0 %).
    const febBuys = result.trades.filter(
      (t) => t.signalDate === '2024-02-01' && t.entryDate === '2024-02-02',
    );
    expect(febBuys.map((t) => t.ticker).sort()).toEqual(['AAA', 'BBB']);
  });

  it('rota la cartera cuando cambia el liderazgo al mes siguiente', () => {
    const result = runBacktest({
      strategy: createCrossAssetMomentumStrategy(),
      params: PARAMS,
      bars: momentumBars(),
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    // Marzo: CCC (+46,9 % en 5 cierres tras su arranque) y AAA forman el
    // top 2; BBB sale de la cartera.
    const bbb = result.trades.find((t) => t.ticker === 'BBB')!;
    expect(bbb.exitReason).toBe('signal');
    expect(bbb.exitDate).toBe('2024-03-02');

    const ccc = result.trades.find((t) => t.ticker === 'CCC')!;
    expect(ccc.signalDate).toBe('2024-03-01');
    expect(ccc.entryDate).toBe('2024-03-02');

    // AAA sigue clasificado: se mantiene hasta el final de los datos.
    const aaa = result.trades.find((t) => t.ticker === 'AAA')!;
    expect(aaa.exitReason).toBe('end-of-data');
  });

  it('solo opera en la primera sesión de cada mes', () => {
    const result = runBacktest({
      strategy: createCrossAssetMomentumStrategy(),
      params: PARAMS,
      bars: momentumBars(),
      initialCash: 10_000,
      costs: NO_COSTS,
    });

    const signalDates = [...new Set(result.trades.map((t) => t.signalDate))].sort();
    expect(signalDates).toEqual(['2024-02-01', '2024-03-01']);
  });

  it('ignora activos sin historial suficiente y no opera en calentamiento', () => {
    // Con lookback 45 > sesiones del primer mes, en febrero nadie puntúa.
    const result = runBacktest({
      strategy: createCrossAssetMomentumStrategy(),
      params: { lookbackSessions: 45, topN: 2 },
      bars: momentumBars(),
      initialCash: 10_000,
      costs: NO_COSTS,
      startDate: '2024-03-01', // enero y febrero son calentamiento
    });
    // El 1 de marzo, con 46 velas ya visibles, sí rota: la primera sesión
    // operable evalúa el ranking aunque el mes no empiece ese día.
    expect(result.trades.length).toBeGreaterThan(0);
    expect(result.trades.every((t) => t.signalDate === '2024-03-01')).toBe(true);
  });

  it('pasa la prueba anti look-ahead del motor', () => {
    const { original, altered } = assertNoLookAhead(
      createCrossAssetMomentumStrategy,
      {
        bars: momentumBars(),
        params: PARAMS,
        initialCash: 10_000,
        costs: NO_COSTS,
      },
      '2024-02-10',
    );
    // Sanity: las entradas de febrero son anteriores al corte…
    expect(original.trades.filter((t) => t.entryDate <= '2024-02-10')).toHaveLength(2);
    // …y la corrupción posterior sí cambia el tramo final de la curva.
    expect(
      altered.equityCurve.filter((p) => p.date > '2024-02-10'),
    ).not.toEqual(original.equityCurve.filter((p) => p.date > '2024-02-10'));
  });

  it('los parámetros de la ficha semilla son los valores por defecto', () => {
    expect(CROSS_ASSET_MOMENTUM_SEED.parameters).toEqual({
      lookbackSessions: 126,
      topN: 3,
    });
    expect(CROSS_ASSET_MOMENTUM_SEED.markets).toEqual(ETF_UNIVERSE);
    expect(() =>
      runBacktest({
        strategy: createCrossAssetMomentumStrategy(),
        params: CROSS_ASSET_MOMENTUM_SEED.parameters,
        bars: { SPY: seriesFromCloses(sessionDates(10), Array(10).fill(100)) },
      }),
    ).not.toThrow();
  });
});
