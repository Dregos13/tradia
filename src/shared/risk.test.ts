import { describe, expect, it } from 'vitest';

import {
  CAUTION_EFFECTS,
  CAUTION_HIGH_IMPACT_WINDOW_MINUTES,
  CAUTION_OPENING_MINUTES,
  CAUTION_REDUCED_SIZE_FACTOR,
  CAUTION_VIX_BLOCK,
  CAUTION_VIX_REDUCE,
  CORRELATION_WINDOW_DAYS,
  KILL_SWITCH_CAUSES,
  KILL_SWITCH_CAUSE_MESSAGES,
  KILL_SWITCH_DAILY_LOSS_FACTOR,
  KILL_SWITCH_OFFLINE_SECONDS,
  LIQUIDITY_AVG_VOLUME_DAYS,
  RISK_BOUNDS,
  RISK_DECISION_STATUSES,
  RISK_DEFAULTS,
  riskLimitViolations,
  SIGNAL_DIRECTIONS,
  SIGNAL_ORIGINS,
  VETO_REASON_CODES,
  VETO_REASON_MESSAGES,
} from './risk';
import type { RiskLimits } from './risk';

describe('contrato del motor de riesgo', () => {
  it('los valores por defecto son prudentes y respetan sus márgenes', () => {
    expect(riskLimitViolations(RISK_DEFAULTS)).toEqual([]);
    // Los de docs/alcance.md §4: 0,5 % por operación, máx. 5 posiciones,
    // drawdown del 10 % y ratio mínimo 1:2.
    expect(RISK_DEFAULTS.riskPerTradePct).toBe(0.5);
    expect(RISK_DEFAULTS.maxOpenPositions).toBe(5);
    expect(RISK_DEFAULTS.maxDrawdownPct).toBe(10);
    expect(RISK_DEFAULTS.minRewardRiskRatio).toBe(2);
  });

  it('los márgenes duros cubren todos los límites y son coherentes', () => {
    expect(Object.keys(RISK_BOUNDS).sort()).toEqual(Object.keys(RISK_DEFAULTS).sort());
    for (const bound of Object.values(RISK_BOUNDS)) {
      expect(bound.min).toBeLessThanOrEqual(bound.max);
    }
    // Los márgenes de los supuestos: 0,5–2 % por operación, ratio mínimo
    // de 2 que no se puede bajar y apalancamiento fijo 1x.
    expect(RISK_BOUNDS.riskPerTradePct).toEqual({ min: 0.5, max: 2 });
    expect(RISK_BOUNDS.minRewardRiskRatio.min).toBe(2);
    expect(RISK_BOUNDS.maxLeverage).toEqual({ min: 1, max: 1 });
  });

  it('detecta cada límite fuera de sus márgenes duros', () => {
    const fuera: RiskLimits = {
      ...RISK_DEFAULTS,
      riskPerTradePct: 3,
      minRewardRiskRatio: 1.5,
      maxLeverage: 2,
    };
    expect(riskLimitViolations(fuera)).toEqual([
      { key: 'riskPerTradePct', value: 3, min: 0.5, max: 2 },
      { key: 'minRewardRiskRatio', value: 1.5, min: 2, max: 10 },
      { key: 'maxLeverage', value: 2, min: 1, max: 1 },
    ]);
    expect(riskLimitViolations({ ...RISK_DEFAULTS, riskPerTradePct: 0.5 })).toEqual([]);
    expect(riskLimitViolations({ ...RISK_DEFAULTS, maxDailyLossPct: Number.NaN })).toHaveLength(1);
  });

  it('cada código de veto tiene su mensaje en español', () => {
    expect(new Set(VETO_REASON_CODES).size).toBe(VETO_REASON_CODES.length);
    for (const code of VETO_REASON_CODES) {
      const message = VETO_REASON_MESSAGES[code];
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
    }
    // Los motivos literales de los criterios de aceptación.
    expect(VETO_REASON_MESSAGES.KILL_SWITCH_ACTIVE).toBe('Parada activa');
    expect(VETO_REASON_MESSAGES.CAUTION_MODE).toBe('Modo cautela');
  });

  it('los códigos cubren las reglas por operación y los 11 límites', () => {
    for (const code of ['STOP_MISSING', 'STOP_WRONG_SIDE', 'RR_TOO_LOW', 'SIZE_ZERO'] as const) {
      expect(VETO_REASON_CODES).toContain(code);
    }
    for (const code of [
      'DAILY_LOSS',
      'WEEKLY_LOSS',
      'MONTHLY_LOSS',
      'MAX_DRAWDOWN',
      'MAX_POSITIONS',
      'ASSET_EXPOSURE',
      'SECTOR_EXPOSURE',
      'CURRENCY_EXPOSURE',
      'CORRELATION',
      'LEVERAGE',
      'LIQUIDITY',
    ] as const) {
      expect(VETO_REASON_CODES).toContain(code);
    }
  });

  it('las causas de la parada cubren la manual y las cuatro automáticas', () => {
    expect(KILL_SWITCH_CAUSES).toEqual([
      'manual',
      'perdida-anomala',
      'dato-anomalo',
      'sin-conexion',
      'modelo-erratico',
    ]);
    for (const cause of KILL_SWITCH_CAUSES) {
      expect(KILL_SWITCH_CAUSE_MESSAGES[cause].length).toBeGreaterThan(0);
    }
  });

  it('los umbrales de cautela y de parada son los de los supuestos', () => {
    expect(CAUTION_HIGH_IMPACT_WINDOW_MINUTES).toBe(30);
    expect(CAUTION_REDUCED_SIZE_FACTOR).toBe(0.5);
    expect(CAUTION_VIX_REDUCE).toBeLessThan(CAUTION_VIX_BLOCK);
    expect(CAUTION_VIX_REDUCE).toBe(30);
    expect(CAUTION_VIX_BLOCK).toBe(40);
    expect(CAUTION_OPENING_MINUTES).toBe(15);
    expect(KILL_SWITCH_DAILY_LOSS_FACTOR).toBe(1.5);
    expect(KILL_SWITCH_OFFLINE_SECONDS).toBe(60);
    expect(CORRELATION_WINDOW_DAYS).toBe(60);
    expect(LIQUIDITY_AVG_VOLUME_DAYS).toBe(20);
  });

  it('los catálogos de la señal y de la decisión son cerrados', () => {
    expect(SIGNAL_DIRECTIONS).toEqual(['largo', 'corto']);
    expect(SIGNAL_ORIGINS).toEqual(['estrategia', 'probador', 'e2e']);
    expect(RISK_DECISION_STATUSES).toEqual(['aprobada', 'reducida', 'vetada']);
    expect(CAUTION_EFFECTS).toEqual(['ninguno', 'reducir', 'bloquear']);
  });
});
