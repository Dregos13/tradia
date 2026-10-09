import { describe, expect, it } from 'vitest';

import {
  RISK_DEFAULTS,
  VETO_REASON_MESSAGES,
  type CautionState,
  type KillSwitchState,
  type SignalIntent,
} from '../../shared/ipc';
import type { PortfolioSnapshot } from './portfolio';
import { createRiskEngine, type RiskEngineDeps } from './engine';
import type { RiskVetoRecord } from './repository';

const NOW = Date.parse('2026-10-09T15:00:00.000Z'); // viernes, NYSE abierta

const signal = (patch: Partial<SignalIntent> = {}): SignalIntent => ({
  ticker: 'AAPL',
  direction: 'largo',
  entry: 100,
  stop: 95,
  target: 115,
  confidence: 0.7,
  origin: 'estrategia',
  ...patch,
});

const killSwitchInactive: KillSwitchState = {
  active: false,
  cause: null,
  actor: null,
  activatedAt: null,
  detail: null,
};

const cautionOff: CautionState = {
  active: false,
  effect: 'ninguno',
  sizeFactor: 1,
  cause: null,
  eventTitle: null,
  until: null,
};

const snapshot = (patch: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot => ({
  now: new Date(NOW).toISOString(),
  equity: 100_000,
  positions: [],
  equityHistory: [{ at: '2026-10-09T00:00:00.000Z', equity: 100_000 }],
  instruments: { AAPL: { sector: null, currency: 'USD', avgDailyVolume20d: 5_000_000 } },
  dailyReturns: {},
  ...patch,
});

interface Fixture {
  engine: ReturnType<typeof createRiskEngine>;
  vetoes: RiskVetoRecord[];
  observed: {
    signals: SignalIntent[];
    dailyLoss: number[];
    drawdown: number[];
    priceJumps: [string, number][];
  };
  killSwitchStates: KillSwitchState[];
}

const fixture = (overrides: Partial<RiskEngineDeps> = {}): Fixture => {
  const vetoes: RiskVetoRecord[] = [];
  const observed: Fixture['observed'] = {
    signals: [],
    dailyLoss: [],
    drawdown: [],
    priceJumps: [],
  };
  const killSwitchStates: KillSwitchState[] = [{ ...killSwitchInactive }];
  const deps: RiskEngineDeps = {
    getLimits: () => ({ ...RISK_DEFAULTS }),
    getKillSwitchState: () => killSwitchStates[killSwitchStates.length - 1]!,
    observeSignal: (s) => observed.signals.push(s),
    observeDailyLoss: (l) => observed.dailyLoss.push(l),
    observeDrawdown: (d) => observed.drawdown.push(d),
    observePriceJump: (t, c) => observed.priceJumps.push([t, c]),
    getSnapshot: () => snapshot(),
    evaluateCaution: () => cautionOff,
    recordVeto: (record) => {
      vetoes.push(record);
      return {
        id: vetoes.length,
        signal: record.signal,
        ticker: record.signal.ticker,
        decision: record.decision,
        code: record.reason.code,
        message: record.reason.message,
        details: record.reason.details,
        size: record.size,
        createdAt: new Date(NOW).toISOString(),
      };
    },
    emitVetoed: () => undefined,
    now: () => NOW,
    ...overrides,
  };
  return {
    engine: createRiskEngine(deps),
    vetoes,
    observed,
    killSwitchStates,
  };
};

describe('pasarela del motor de riesgo (engine)', () => {
  it('con la parada activa veta de inmediato sin evaluar reglas ni cartera', () => {
    const f = fixture({
      getKillSwitchState: () => ({ ...killSwitchInactive, active: true, cause: 'manual' }),
    });
    const decision = f.engine.submitSignal(signal());

    expect(decision.status).toBe('vetada');
    expect(decision.reasons).toEqual([
      { code: 'KILL_SWITCH_ACTIVE', message: 'Parada activa', details: { causa: 'manual' } },
    ]);
    expect(f.vetoes.map((v) => v.reason.code)).toEqual(['KILL_SWITCH_ACTIVE']);
    // La señal alimentó la detección de modelo errático antes del veto.
    expect(f.observed.signals).toHaveLength(1);
    // Sin instantánea de cartera: los observadores de pérdida no se llaman.
    expect(f.observed.dailyLoss).toHaveLength(0);
  });

  it('una confianza fuera de 0–1 queda vetada SIGNAL_INVALID aunque la parada no esté activa', () => {
    const f = fixture();
    const decision = f.engine.submitSignal(signal({ confidence: 1.4 }));

    expect(decision.status).toBe('vetada');
    expect(decision.reasons.map((r) => r.code)).toEqual(['SIGNAL_INVALID']);
    expect(decision.reasons[0]?.details['confianza']).toBe(1.4);
  });

  it('veta por límite de cartera (pérdida diaria) con los valores reales', () => {
    const f = fixture({
      getSnapshot: () => snapshot({ equity: 97_900 }), // -2,1 % ≥ 2 %
    });
    const decision = f.engine.submitSignal(signal());

    expect(decision.status).toBe('vetada');
    expect(decision.reasons[0]?.code).toBe('DAILY_LOSS');
    expect(decision.reasons[0]?.details['perdida']).toBeCloseTo(2.1, 5);
    expect(f.observed.dailyLoss[0]).toBeCloseTo(2.1, 5);
  });

  it('la parada que se dispara en mitad de la evaluación también veta la señal', () => {
    // Primer getState (entrada): inactiva; tras observar la instantánea: activa.
    const states = [
      { ...killSwitchInactive },
      { ...killSwitchInactive, active: true, cause: 'perdida-anomala' as const },
    ];
    let calls = 0;
    const f = fixture({
      getKillSwitchState: () => states[Math.min(calls++, states.length - 1)]!,
    });
    const decision = f.engine.submitSignal(signal());

    expect(decision.status).toBe('vetada');
    expect(decision.reasons[0]?.code).toBe('KILL_SWITCH_ACTIVE');
    expect(decision.reasons[0]?.details['causa']).toBe('perdida-anomala');
  });

  it('cautela bloquear → vetada CAUTION_MODE; reducir → reducida con factor', () => {
    const blocking: CautionState = {
      active: true,
      effect: 'bloquear',
      sizeFactor: 0,
      cause: 'alto-impacto',
      eventTitle: 'IPC de EE. UU.',
      until: '2026-10-09T15:30:00.000Z',
    };
    const f1 = fixture({ evaluateCaution: () => blocking });
    const blocked = f1.engine.submitSignal(signal());
    expect(blocked.status).toBe('vetada');
    expect(blocked.reasons[0]?.code).toBe('CAUTION_MODE');
    expect(blocked.reasons[0]?.details['evento']).toBe('IPC de EE. UU.');

    const reducing: CautionState = {
      ...blocking,
      effect: 'reducir',
      sizeFactor: 0.5,
      cause: 'vix',
      eventTitle: 'VIX 35',
    };
    const f2 = fixture({ evaluateCaution: () => reducing });
    const reduced = f2.engine.submitSignal(signal());
    expect(reduced.status).toBe('reducida');
    expect(reduced.size).toBe(50); // 100 × 0,5
    expect(reduced.sizeFactor).toBe(0.5);
    expect(f2.vetoes[0]?.decision).toBe('reducida');
  });

  it('aprobada no persiste vetos y devuelve tamaño, riesgo y nominal', () => {
    const f = fixture();
    const decision = f.engine.submitSignal(signal());

    expect(decision).toMatchObject({
      status: 'aprobada',
      size: 100,
      sizeFactor: 1,
      riskAmount: 500,
      notional: 10_000,
      reasons: [],
      decidedAt: new Date(NOW).toISOString(),
    });
    expect(f.vetoes).toHaveLength(0);
  });

  it('alimenta los saltos de precio de cada ticker con dato diario', () => {
    const f = fixture({
      getSnapshot: () => snapshot({ dailyReturns: { AAPL: [0.01, 0.22], MSFT: [0.005, -0.01] } }),
    });
    f.engine.submitSignal(signal());
    expect(f.observed.priceJumps).toEqual([
      ['AAPL', 22],
      ['MSFT', -1],
    ]);
  });

  it('los motivos de veto son los mensajes del contrato compartido', () => {
    const f = fixture({
      getKillSwitchState: () => ({ ...killSwitchInactive, active: true, cause: 'manual' }),
    });
    const decision = f.engine.submitSignal(signal());
    for (const r of decision.reasons) {
      expect(r.message).toBe(VETO_REASON_MESSAGES[r.code]);
    }
  });
});
