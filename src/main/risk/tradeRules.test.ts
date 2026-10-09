import { describe, expect, it } from 'vitest';

import {
  RISK_BOUNDS,
  RISK_DEFAULTS,
  VETO_REASON_MESSAGES,
  type RiskLimits,
  type SignalIntent,
} from '../../shared/risk';
import {
  effectiveMinRewardRiskRatio,
  effectiveRiskPct,
  evaluateTradeRules,
  positionSize,
  rewardRiskRatio,
} from './tradeRules';

/** Señal válida de base: largo 100, stop 95 (riesgo 5), objetivo 110 (ratio 1:2). */
const signal = (overrides: Partial<SignalIntent> = {}): SignalIntent => ({
  ticker: 'AAPL',
  direction: 'largo',
  entry: 100,
  stop: 95,
  target: 110,
  confidence: 0.8,
  origin: 'estrategia',
  ...overrides,
});

const limits = (overrides: Partial<RiskLimits> = {}): RiskLimits => ({
  ...RISK_DEFAULTS,
  ...overrides,
});

const codes = (result: ReturnType<typeof evaluateTradeRules>) => result.reasons.map((r) => r.code);

describe('reglas por operación del motor de riesgo', () => {
  describe('stop obligatorio', () => {
    it('veta una señal sin stop con STOP_MISSING', () => {
      const result = evaluateTradeRules(signal({ stop: null }), 100_000, limits());
      expect(codes(result)).toContain('STOP_MISSING');
      const reason = result.reasons.find((r) => r.code === 'STOP_MISSING');
      expect(reason?.message).toBe(VETO_REASON_MESSAGES.STOP_MISSING);
      expect(result.size).toBe(0);
      expect(result.riskAmount).toBe(0);
      expect(result.notional).toBe(0);
    });

    it('veta el stop del lado contrario en largo y en corto (STOP_WRONG_SIDE)', () => {
      // Largo con el stop por encima de la entrada: no protege nada.
      const long = evaluateTradeRules(signal({ stop: 105 }), 100_000, limits());
      expect(codes(long)).toContain('STOP_WRONG_SIDE');
      // Corto con el stop por debajo de la entrada.
      const short = evaluateTradeRules(
        signal({ direction: 'corto', stop: 95, target: 90 }),
        100_000,
        limits(),
      );
      expect(codes(short)).toContain('STOP_WRONG_SIDE');
      const reason = long.reasons.find((r) => r.code === 'STOP_WRONG_SIDE');
      expect(reason?.details).toMatchObject({ entrada: 100, stop: 105 });
    });

    it('un stop a nivel de la entrada también es STOP_WRONG_SIDE', () => {
      const result = evaluateTradeRules(signal({ stop: 100 }), 100_000, limits());
      expect(codes(result)).toContain('STOP_WRONG_SIDE');
    });
  });

  describe('ratio beneficio/riesgo', () => {
    it('veta un ratio 1:1,5 con RR_TOO_LOW y muestra el ratio real', () => {
      // Riesgo 5, beneficio 7,5 → ratio 1,5 < 2.
      const result = evaluateTradeRules(signal({ target: 107.5 }), 100_000, limits());
      expect(codes(result)).toContain('RR_TOO_LOW');
      const reason = result.reasons.find((r) => r.code === 'RR_TOO_LOW');
      expect(reason?.details).toMatchObject({ ratio: 1.5, minimo: 2 });
    });

    it('veta una señal sin objetivo con RR_TOO_LOW', () => {
      const result = evaluateTradeRules(signal({ target: null }), 100_000, limits());
      const reason = result.reasons.find((r) => r.code === 'RR_TOO_LOW');
      expect(reason?.details).toMatchObject({ ratio: 'sin objetivo', minimo: 2 });
    });

    it('un objetivo del lado que pierde da ratio negativo y veta', () => {
      // Largo con objetivo por debajo de la entrada: beneficio −10.
      const result = evaluateTradeRules(signal({ target: 90 }), 100_000, limits());
      const reason = result.reasons.find((r) => r.code === 'RR_TOO_LOW');
      expect(reason?.details.ratio).toBe(-2);
    });

    it('admite el ratio justo en el mínimo configurado', () => {
      const result = evaluateTradeRules(signal(), 100_000, limits({ minRewardRiskRatio: 2 }));
      expect(result.reasons).toEqual([]);
      expect(result.size).toBeGreaterThan(0);
    });

    it('nunca baja de 2 aunque el límite configurado fuera menor', () => {
      // Unos límites corruptos con mínimo 1,5 no relajan la regla.
      const result = evaluateTradeRules(
        signal({ target: 107.5 }),
        100_000,
        limits({ minRewardRiskRatio: 1.5 }),
      );
      expect(codes(result)).toContain('RR_TOO_LOW');
      expect(effectiveMinRewardRiskRatio(limits({ minRewardRiskRatio: 1.5 }))).toBe(2);
    });
  });

  describe('tamaño de la posición', () => {
    it('sale de la distancia al stop: capital × riesgo% / |entrada − stop|', () => {
      // 100 000 × 0,5 % = 500 arriesgados; distancia 5 → 100 unidades.
      const result = evaluateTradeRules(signal(), 100_000, limits());
      expect(result).toMatchObject({
        reasons: [],
        size: 100,
        riskAmount: 500,
        notional: 10_000,
      });
    });

    it('redondea hacia abajo a unidades enteras', () => {
      // Distancia 3 → 500 / 3 = 166,67 → 166 unidades.
      const result = evaluateTradeRules(signal({ stop: 97 }), 100_000, limits());
      expect(result.size).toBe(166);
      expect(result.riskAmount).toBe(166 * 3);
      expect(positionSize(100_000, 0.5, 3)).toBe(166);
    });

    it('el mismo cálculo vale en corto con la distancia simétrica', () => {
      const result = evaluateTradeRules(
        signal({ direction: 'corto', stop: 105, target: 90 }),
        100_000,
        limits(),
      );
      expect(result).toMatchObject({ reasons: [], size: 100, riskAmount: 500 });
    });

    it('veta con SIZE_ZERO cuando la distancia al stop deja el tamaño en 0', () => {
      // 500 × 0,5 % = 2,5 arriesgados; distancia 5 → 0,5 unidades → 0.
      const result = evaluateTradeRules(signal(), 500, limits());
      expect(codes(result)).toEqual(['SIZE_ZERO']);
      const reason = result.reasons[0];
      expect(reason?.details).toMatchObject({ capital: 500, riesgoPct: 0.5, distancia: 5 });
    });
  });

  describe('márgenes duros del riesgo por operación', () => {
    it('recorta un riesgo por encima del 2 % aunque llegue en los límites', () => {
      // Límites corruptos al 3 %: el tamaño se calcula con el tope del 2 %.
      // 100 000 × 2 % = 2 000; distancia 5 → 400 unidades (no 600).
      const result = evaluateTradeRules(signal(), 100_000, limits({ riskPerTradePct: 3 }));
      expect(result.size).toBe(400);
      expect(result.riskAmount).toBe(2_000);
      expect(effectiveRiskPct(limits({ riskPerTradePct: 3 }))).toBe(2);
    });

    it('recorta un riesgo por debajo del 0,5 %', () => {
      // 0,1 % llegado de fuera → se aplica el suelo 0,5 %.
      expect(effectiveRiskPct(limits({ riskPerTradePct: 0.1 }))).toBe(0.5);
      expect(effectiveRiskPct(limits())).toBe(RISK_DEFAULTS.riskPerTradePct);
    });
  });

  describe('defensa de la entrada', () => {
    it('veta con SIGNAL_INVALID un precio no finito', () => {
      const result = evaluateTradeRules(signal({ entry: Number.NaN }), 100_000, limits());
      expect(codes(result)).toEqual(['SIGNAL_INVALID']);
    });

    it('veta con SIGNAL_INVALID un capital no positivo', () => {
      expect(codes(evaluateTradeRules(signal(), 0, limits()))).toEqual(['SIGNAL_INVALID']);
      expect(codes(evaluateTradeRules(signal(), Number.NaN, limits()))).toEqual(['SIGNAL_INVALID']);
    });

    it('acumula los motivos cuando la señal incumple varias reglas', () => {
      const result = evaluateTradeRules(signal({ stop: null, target: null }), 100_000, limits());
      expect(codes(result)).toEqual(['STOP_MISSING', 'RR_TOO_LOW']);
    });
  });

  describe('los límites son de solo lectura', () => {
    it('mutar los límites congelados lanza y la evaluación no los toca', () => {
      const frozen = Object.freeze(limits());
      expect(() => {
        (frozen as RiskLimits).riskPerTradePct = 3;
      }).toThrow(TypeError);
      expect(frozen.riskPerTradePct).toBe(RISK_DEFAULTS.riskPerTradePct);

      // La evaluación con límites congelados funciona y no los modifica.
      const result = evaluateTradeRules(signal(), 100_000, frozen);
      expect(result.size).toBe(100);
      expect(frozen).toEqual(RISK_DEFAULTS);
    });

    it('la evaluación tampoco muta unos límites sin congelar', () => {
      const unfrozen = limits();
      evaluateTradeRules(signal(), 100_000, unfrozen);
      expect(unfrozen).toEqual(RISK_DEFAULTS);
    });
  });

  describe('helpers expuestos a la pasarela', () => {
    it('rewardRiskRatio es null sin objetivo, sin stop o con stop invertido', () => {
      expect(rewardRiskRatio(signal({ target: null }))).toBeNull();
      expect(rewardRiskRatio(signal({ stop: null }))).toBeNull();
      expect(rewardRiskRatio(signal({ stop: 105 }))).toBeNull();
      expect(rewardRiskRatio(signal())).toBe(2);
    });

    it('los márgenes duros del contrato son los que se aplican', () => {
      expect(RISK_BOUNDS.riskPerTradePct).toEqual({ min: 0.5, max: 2 });
      expect(RISK_BOUNDS.minRewardRiskRatio.min).toBe(2);
    });
  });
});
