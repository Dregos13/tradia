import { describe, expect, it } from 'vitest';

import { FX_DEFAULT_LIMITS, fxCredentialsProblem, fxLimitsProblems } from '../../shared/fxBroker';
import {
  accountToEur,
  checkFxOrder,
  eurPerQuoteOf,
  notionalEurPerUnitOf,
  type FxGuardInput,
} from './guard';

const EURUSD = 1.0845;
const USDJPY = 151.2;

const base = (over: Partial<FxGuardInput> = {}): FxGuardInput => ({
  environment: 'practice',
  instrument: 'EURUSD',
  side: 'buy',
  size: { units: 100 },
  entryPrice: 1.0846,
  stopPrice: 1.0826,
  targetPrice: 1.0886,
  eurPerQuote: eurPerQuoteOf('EURUSD', EURUSD, USDJPY),
  notionalEurPerUnit: 1,
  limits: FX_DEFAULT_LIMITS,
  liveGateOpen: false,
  liveConfirmed: false,
  killSwitchActive: false,
  online: true,
  marginUsedEur: 0,
  navEur: 100,
  dayStartNavEur: 100,
  openInstruments: [],
  ...over,
});

describe('checkFxOrder', () => {
  it('aprueba una orden pequeña con su riesgo y margen en euros', () => {
    const result = checkFxOrder(base());
    expect(result).toEqual({ ok: true, units: 100, riskEur: 0.18, marginEur: 3.33 });
  });

  it('calcula las unidades desde los euros de riesgo sin pasar del límite del usuario', () => {
    const result = checkFxOrder(base({ size: { riskEur: 50 } }));
    // El límite por orden es 1 €: con 20 pips caben 542 unidades.
    expect(result).toMatchObject({ ok: true, units: 542 });
  });

  it('explica cuando ni 1 unidad cabe en el riesgo', () => {
    const result = checkFxOrder(
      base({
        instrument: 'XAUUSD',
        entryPrice: 2650.5,
        stopPrice: 2640,
        targetPrice: 2680,
        size: { riskEur: 1 },
        eurPerQuote: eurPerQuoteOf('XAUUSD', EURUSD, USDJPY),
      }),
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reasons[0]).toContain('1 unidad ya arriesga 9,68 €');
  });

  it('exige el stop y el objetivo en el lado correcto', () => {
    const buy = checkFxOrder(base({ stopPrice: 1.09, targetPrice: 1.08 }));
    expect(!buy.ok && buy.reasons).toEqual([
      'En una compra el stop va por debajo del precio actual.',
      'En una compra el objetivo va por encima del precio actual.',
    ]);
    const sell = checkFxOrder(base({ side: 'sell', stopPrice: 1.0866, targetPrice: 1.0806 }));
    expect(sell.ok).toBe(true);
  });

  it('bloquea con la parada, sin conexión y en la cuenta real sin lista ni frase', () => {
    expect(checkFxOrder(base({ killSwitchActive: true })).ok).toBe(false);
    expect(checkFxOrder(base({ online: false })).ok).toBe(false);
    const live = checkFxOrder(base({ environment: 'live' }));
    expect(!live.ok && live.reasons).toHaveLength(2);
    expect(
      checkFxOrder(base({ environment: 'live', liveGateOpen: true, liveConfirmed: true })).ok,
    ).toBe(true);
  });

  it('respeta posiciones, margen y pérdida diaria', () => {
    expect(checkFxOrder(base({ openInstruments: ['GBPUSD'] })).ok).toBe(false);
    const margin = checkFxOrder(base({ marginUsedEur: 48 }));
    expect(!margin.ok && margin.reasons[0]).toContain('tu capital es 50 €');
    const daily = checkFxOrder(base({ navEur: 96.5 }));
    expect(!daily.ok && daily.reasons[0]).toContain('límite diario es 3 €');
  });
});

describe('conversiones a euros', () => {
  it('convierte la moneda cotizada y el nominal', () => {
    expect(eurPerQuoteOf('USDJPY', EURUSD, USDJPY)).toBeCloseTo(1 / (USDJPY * EURUSD), 12);
    expect(notionalEurPerUnitOf('USDJPY', USDJPY, EURUSD, USDJPY)).toBeCloseTo(1 / EURUSD, 12);
    expect(notionalEurPerUnitOf('XAUUSD', 2650, EURUSD, USDJPY)).toBeCloseTo(2650 / EURUSD, 9);
    expect(accountToEur(108.45, 'USD', EURUSD)).toBeCloseTo(100, 9);
    expect(accountToEur(1, 'GBP', EURUSD)).toBeNull();
  });
});

describe('validaciones compartidas', () => {
  it('límites dentro de los techos (desde 50 €)', () => {
    expect(fxLimitsProblems(FX_DEFAULT_LIMITS)).toEqual([]);
    expect(fxLimitsProblems({ ...FX_DEFAULT_LIMITS, capitalEur: 40 })[0]).toContain(
      'entre 50 € y 500 €',
    );
    expect(fxLimitsProblems({ ...FX_DEFAULT_LIMITS, riskPerOrderEur: 6 })).toHaveLength(1);
    expect(
      fxLimitsProblems({ ...FX_DEFAULT_LIMITS, riskPerOrderEur: 4, dailyLossEur: 3 })[0],
    ).toContain('no puede ser mayor');
  });

  it('credenciales: forma del token y entorno por el prefijo de la cuenta', () => {
    const token = 'a'.repeat(32) + '-' + 'b'.repeat(32);
    expect(
      fxCredentialsProblem({ environment: 'practice', token, accountId: '101-004-1-001' }),
    ).toBeNull();
    expect(
      fxCredentialsProblem({ environment: 'practice', token: 'abc', accountId: '101-004-1-001' }),
    ).toContain('token');
    expect(
      fxCredentialsProblem({ environment: 'live', token, accountId: '101-004-1-001' }),
    ).toContain('cuenta es de práctica');
  });
});
