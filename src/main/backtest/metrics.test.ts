import { describe, expect, it } from 'vitest';

import {
  computeMetrics,
  formatProfitFactor,
  type EquityCurvePoint,
  type MetricTrade,
} from './metrics';

/**
 * Caso manual — los valores de cada prueba están desarrollados a mano aquí
 * y en docs/qa/metricas-caso-manual.md.
 *
 * Curva de capital de 10 días (2024-01-01 a 2024-01-10) construida para que
 * los rendimientos diarios sean porcentajes exactos:
 *
 *   fecha        equity        rendimiento diario
 *   2024-01-01   10000,0000    —
 *   2024-01-02   10200,0000    +2 %
 *   2024-01-03   10098,0000    -1 %
 *   2024-01-04   10098,0000     0 %
 *   2024-01-05   10198,9800    +1 %
 *   2024-01-06   10096,9902    -1 %
 *   2024-01-07   10298,9300    +2 %
 *   2024-01-08   10195,9407    -1 %
 *   2024-01-09   10195,9407     0 %
 *   2024-01-10   10297,9001    +1 %
 *
 * Rendimientos (%): [2, -1, 0, 1, -1, 2, -1, 0, 1]; n = 9.
 *
 * Rentabilidad total: 10297,9001109996 / 10000 - 1 = 0,0297900111 (2,979 %).
 * Rentabilidad anualizada: (1,0297900111)^(252/9) - 1 = 1,0297900111^28 - 1
 *   ≈ 1,2749 (127,49 %).
 *
 * Sharpe (rf = 0): media = 3 % / 9 = 1/3 %. Varianza muestral:
 *   Σ(r - m)² = Σr² - (Σr)²/n = 13 - 9/9 = 12 (en %²); 12/8 = 1,5 %²;
 *   desviación = √1,5 % ≈ 1,224745 %. Sharpe = (1/3)/√1,5 · √252 = √(56/3)
 *   ≈ 4,320494.
 * Sharpe con rf = 2,52 %: rf diaria = 0,0252/252 = 0,0001 = 0,01 %; exceso
 *   medio = 1/3 % - 0,01 % = 0,323333 %; Sharpe ≈ 4,190879.
 *
 * Drawdown máximo: el máximo 10200 (01-02) no se supera hasta 01-07. La
 *   caída más profunda es en 01-06: 1 - (0,99·1,01·0,99) = 1 - 0,989901 =
 *   0,010099 (1,0099 %). Episodio: máximo 01-02 → mínimo 01-06 →
 *   recuperación 01-07 = 5 días. (En 01-08 cae 1 % exacto, menos.)
 *
 * Operaciones (6): pnl = [+150, -80, +220, -120, -60, +90].
 *   Beneficio bruto = 460; pérdida bruta = 260; factor de beneficio =
 *   460/260 = 23/13 ≈ 1,769231. Acierto = 3/6 = 0,5. Expectativa =
 *   (460-260)/6 = 200/6 ≈ 33,3333. Rachas: W L W L L W → máx. 2.
 */

const CASE_CURVE: EquityCurvePoint[] = [
  { date: '2024-01-01', equity: 10000 },
  { date: '2024-01-02', equity: 10200 },
  { date: '2024-01-03', equity: 10098 },
  { date: '2024-01-04', equity: 10098 },
  { date: '2024-01-05', equity: 10198.98 },
  { date: '2024-01-06', equity: 10096.9902 },
  { date: '2024-01-07', equity: 10298.930004 },
  { date: '2024-01-08', equity: 10195.94070396 },
  { date: '2024-01-09', equity: 10195.94070396 },
  { date: '2024-01-10', equity: 10297.9001109996 },
];

const CASE_TRADES: MetricTrade[] = [
  { pnl: 150, entryDate: '2024-01-01', exitDate: '2024-01-02' },
  { pnl: -80, entryDate: '2024-01-02', exitDate: '2024-01-03' },
  { pnl: 220, entryDate: '2024-01-03', exitDate: '2024-01-05' },
  { pnl: -120, entryDate: '2024-01-05', exitDate: '2024-01-06' },
  { pnl: -60, entryDate: '2024-01-06', exitDate: '2024-01-08' },
  { pnl: 90, entryDate: '2024-01-08', exitDate: '2024-01-10' },
];

describe('computeMetrics — caso manual', () => {
  const metrics = computeMetrics(CASE_CURVE, CASE_TRADES);

  it('rentabilidad total = último/primero - 1 = 2,979 %', () => {
    // 10297,9001109996 / 10000 - 1 = 0,0297900111
    expect(metrics.totalReturn).toBeCloseTo(0.0297900111, 10);
  });

  it('rentabilidad anualizada = (1+r)^28 - 1 ≈ 127,49 %', () => {
    // 9 rendimientos diarios → exponente 252/9 = 28
    expect(metrics.annualizedReturn).toBeCloseTo(1.2749030695, 9);
  });

  it('drawdown máximo 1,0099 %, del 01-02 al 01-06, recupera el 01-07 (5 días)', () => {
    // Caída: 1 - 0,99·1,01·0,99 = 0,010099 exacto (ver cabecera)
    expect(metrics.maxDrawdown).not.toBeNull();
    expect(metrics.maxDrawdown!.pct).toBeCloseTo(0.010099, 10);
    expect(metrics.maxDrawdown!.peakDate).toBe('2024-01-02');
    expect(metrics.maxDrawdown!.troughDate).toBe('2024-01-06');
    expect(metrics.maxDrawdown!.recoveryDate).toBe('2024-01-07');
    expect(metrics.maxDrawdown!.durationDays).toBe(5);
  });

  it('Sharpe = √(56/3) ≈ 4,320494 con rf = 0', () => {
    expect(metrics.sharpe).toBeCloseTo(Math.sqrt(56 / 3), 10);
  });

  it('Sharpe con tasa libre de riesgo 2,52 % anual ≈ 4,190879', () => {
    // rf diaria = 0,0252/252 = 0,0001; exceso medio = 0,0033333 - 0,0001
    const withRf = computeMetrics(CASE_CURVE, CASE_TRADES, { riskFreeRate: 0.0252 });
    expect(withRf.sharpe).toBeCloseTo(4.190878985, 8);
  });

  it('factor de beneficio = 460/260 = 23/13', () => {
    expect(metrics.profitFactor).toBeCloseTo(23 / 13, 12);
  });

  it('tasa de acierto = 3/6 y expectativa = 200/6', () => {
    expect(metrics.winRate).toBe(0.5);
    expect(metrics.expectancy).toBeCloseTo(100 / 3, 12);
  });

  it('racha perdedora máxima = 2 y número de operaciones = 6', () => {
    expect(metrics.maxLosingStreak).toBe(2);
    expect(metrics.tradeCount).toBe(6);
    expect(metrics.winningTrades).toBe(3);
    expect(metrics.losingTrades).toBe(3);
    expect(metrics.grossProfit).toBe(460);
    expect(metrics.grossLoss).toBe(260);
  });
});

describe('computeMetrics — casos límite', () => {
  it('curva vacía: métricas de capital a null y las de operaciones siguen', () => {
    const m = computeMetrics([], CASE_TRADES);
    expect(m.totalReturn).toBeNull();
    expect(m.annualizedReturn).toBeNull();
    expect(m.maxDrawdown).toBeNull();
    expect(m.sharpe).toBeNull();
    expect(m.tradeCount).toBe(6);
  });

  it('un solo punto: rentabilidad 0 y ni anualizada ni Sharpe', () => {
    const m = computeMetrics([{ date: '2024-01-01', equity: 10000 }], []);
    expect(m.totalReturn).toBe(0);
    expect(m.annualizedReturn).toBeNull();
    expect(m.maxDrawdown).toBeNull();
    expect(m.sharpe).toBeNull();
  });

  it('sin operaciones: factor, acierto y expectativa a null, racha 0', () => {
    const m = computeMetrics(CASE_CURVE, []);
    expect(m.profitFactor).toBeNull();
    expect(m.winRate).toBeNull();
    expect(m.expectancy).toBeNull();
    expect(m.maxLosingStreak).toBe(0);
    expect(m.tradeCount).toBe(0);
  });

  it('sin pérdidas: factor de beneficio infinito y formato «∞»', () => {
    const winners: MetricTrade[] = [
      { pnl: 100, entryDate: '2024-01-01', exitDate: '2024-01-02' },
      { pnl: 50, entryDate: '2024-01-02', exitDate: '2024-01-03' },
    ];
    const m = computeMetrics(CASE_CURVE, winners);
    expect(m.profitFactor).toBe(Infinity);
    expect(m.winRate).toBe(1);
    expect(formatProfitFactor(m.profitFactor)).toBe('∞');
  });

  it('formatProfitFactor: «—» sin operaciones, «∞» infinito, 2 decimales', () => {
    expect(formatProfitFactor(null)).toBe('—');
    expect(formatProfitFactor(Infinity)).toBe('∞');
    expect(formatProfitFactor(23 / 13)).toBe('1.77');
  });

  it('operaciones solo a cero: factor de beneficio indefinido (null)', () => {
    const flats: MetricTrade[] = [{ pnl: 0, entryDate: '2024-01-01', exitDate: '2024-01-02' }];
    const m = computeMetrics(CASE_CURVE, flats);
    expect(m.profitFactor).toBeNull();
    expect(m.winRate).toBe(0);
    expect(m.expectancy).toBe(0);
  });

  it('varianza cero: capital plano → Sharpe null; +1 % diario → +∞; -1 % → -∞', () => {
    const flat = CASE_CURVE.map((p) => ({ ...p, equity: 5000 }));
    expect(computeMetrics(flat, []).sharpe).toBeNull();

    const up: EquityCurvePoint[] = [];
    const down: EquityCurvePoint[] = [];
    for (let i = 0; i < 5; i++) {
      const date = `2024-01-0${i + 1}`;
      up.push({ date, equity: 10000 * Math.pow(1.01, i) });
      down.push({ date, equity: 10000 * Math.pow(0.99, i) });
    }
    expect(computeMetrics(up, []).sharpe).toBe(Infinity);
    expect(computeMetrics(down, []).sharpe).toBe(-Infinity);
  });

  it('un solo rendimiento diario no basta para el Sharpe', () => {
    const m = computeMetrics(
      [
        { date: '2024-01-01', equity: 10000 },
        { date: '2024-01-02', equity: 10100 },
      ],
      [],
    );
    expect(m.sharpe).toBeNull();
  });

  it('drawdown sin recuperar: recoveryDate null y duración hasta el final', () => {
    const m = computeMetrics(
      [
        { date: '2024-01-01', equity: 100 },
        { date: '2024-01-02', equity: 120 },
        { date: '2024-01-03', equity: 90 },
        { date: '2024-01-05', equity: 95 },
      ],
      [],
    );
    // Caída desde 120: 90 es el mínimo → 30/120 = 0,25; nunca vuelve a 120
    expect(m.maxDrawdown!.pct).toBeCloseTo(0.25, 12);
    expect(m.maxDrawdown!.peakDate).toBe('2024-01-02');
    expect(m.maxDrawdown!.troughDate).toBe('2024-01-03');
    expect(m.maxDrawdown!.recoveryDate).toBeNull();
    expect(m.maxDrawdown!.durationDays).toBe(3); // 01-02 → 01-05
  });

  it('la racha perdedora se mide por orden de exitDate, no de llegada', () => {
    const unordered: MetricTrade[] = [
      { pnl: 10, entryDate: '2024-01-09', exitDate: '2024-01-10' }, // W al final
      { pnl: -5, entryDate: '2024-01-01', exitDate: '2024-01-02' }, // L
      { pnl: -5, entryDate: '2024-01-03', exitDate: '2024-01-04' }, // L
      { pnl: 0, entryDate: '2024-01-05', exitDate: '2024-01-06' }, // breakeven corta
      { pnl: -5, entryDate: '2024-01-07', exitDate: '2024-01-08' }, // L
    ];
    const m = computeMetrics([], unordered);
    // Orden real: L L 0 L W → racha máxima 2 (la del principio)
    expect(m.maxLosingStreak).toBe(2);
    expect(m.losingTrades).toBe(3);
  });

  it('curva desordenada o datos no finitos lanzan error', () => {
    const unordered: EquityCurvePoint[] = [
      { date: '2024-01-02', equity: 100 },
      { date: '2024-01-01', equity: 100 },
    ];
    expect(() => computeMetrics(unordered, [])).toThrow(RangeError);

    expect(() => computeMetrics([{ date: '2024-01-01', equity: Number.NaN }], [])).toThrow(
      TypeError,
    );
    expect(() =>
      computeMetrics([], [{ pnl: 10, entryDate: 'no-fecha', exitDate: '2024-01-02' }]),
    ).toThrow(TypeError);
  });
});
