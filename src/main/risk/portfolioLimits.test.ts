import { describe, expect, it } from 'vitest';

import {
  RISK_DEFAULTS,
  VETO_REASON_MESSAGES,
  type SignalIntent,
  type VetoReasonCode,
} from '../../shared/risk';
import type { PortfolioPosition, PortfolioSnapshot } from './portfolio';
import { checkPortfolioLimits } from './portfolioLimits';

// Viernes 2026-10-09: la semana ISO empieza el lunes 2026-10-05.
const NOW = '2026-10-09T15:00:00.000Z';
const LIMITS = RISK_DEFAULTS;

function makeSignal(overrides: Partial<SignalIntent> = {}): SignalIntent {
  return {
    ticker: 'AAPL',
    direction: 'largo',
    entry: 200,
    stop: 190,
    target: 220,
    confidence: 0.7,
    origin: 'probador',
    ...overrides,
  };
}

function makePosition(overrides: Partial<PortfolioPosition> = {}): PortfolioPosition {
  return { ticker: 'MSFT', direction: 'largo', entry: 100, size: 10, ...overrides };
}

/**
 * Instantánea limpia: capital 100 000, sin posiciones ni pérdidas, AAPL
 * del sector tecnología en USD con 5 M de volumen medio (el tamaño por
 * defecto, 50 unidades a 200, mueve el 10 % del capital y el 0,001 % del
 * volumen: todas las reglas pasan).
 */
function makeSnapshot(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    now: NOW,
    equity: 100_000,
    positions: [],
    equityHistory: [],
    instruments: {
      AAPL: { sector: 'tecnologia', currency: 'USD', avgDailyVolume20d: 5_000_000 },
    },
    dailyReturns: {},
    ...overrides,
  };
}

function codesOf(snapshot: PortfolioSnapshot, signal = makeSignal(), size = 50): VetoReasonCode[] {
  return checkPortfolioLimits(signal, size, snapshot, LIMITS).map((r) => r.code);
}

describe('checkPortfolioLimits', () => {
  it('aprueba una señal dentro de todos los límites', () => {
    expect(checkPortfolioLimits(makeSignal(), 50, makeSnapshot(), LIMITS)).toEqual([]);
  });

  it('devuelve motivos legibles y valores (límite y real) en cada veto', () => {
    const snapshot = makeSnapshot({
      equity: 97_900,
      equityHistory: [{ at: '2026-10-08T23:00:00.000Z', equity: 100_000 }],
    });
    const [reason] = checkPortfolioLimits(makeSignal(), 50, snapshot, LIMITS);
    expect(reason?.code).toBe('DAILY_LOSS');
    expect(reason?.message).toBe(VETO_REASON_MESSAGES.DAILY_LOSS);
    expect(reason?.details['limite']).toBe(LIMITS.maxDailyLossPct);
    expect(reason?.details['perdida']).toBeCloseTo(2.1, 3);
  });
});

describe('límites de pérdida por periodo', () => {
  it('veta DAILY_LOSS cuando la pérdida del día alcanza el límite', () => {
    const snapshot = makeSnapshot({
      equity: 97_900, // -2,1 % desde el inicio del día
      equityHistory: [{ at: '2026-10-08T23:00:00.000Z', equity: 100_000 }],
    });
    expect(codesOf(snapshot)).toEqual(['DAILY_LOSS']);
  });

  it('no veta DAILY_LOSS por debajo del límite diario', () => {
    const snapshot = makeSnapshot({
      equity: 99_000, // -1 %
      equityHistory: [{ at: '2026-10-08T23:00:00.000Z', equity: 100_000 }],
    });
    expect(codesOf(snapshot)).toEqual([]);
  });

  it('veta WEEKLY_LOSS solo por la pérdida desde el lunes', () => {
    const snapshot = makeSnapshot({
      equity: 95_500, // -4,5 % desde el lunes
      equityHistory: [
        { at: '2026-10-02T00:00:00.000Z', equity: 97_000 }, // base mensual: -1,5 %
        { at: '2026-10-04T00:00:00.000Z', equity: 100_000 }, // base semanal
        { at: '2026-10-08T00:00:00.000Z', equity: 95_500 }, // base diaria: 0 %
      ],
    });
    expect(codesOf(snapshot)).toEqual(['WEEKLY_LOSS']);
  });

  it('no veta WEEKLY_LOSS por debajo del límite semanal', () => {
    const snapshot = makeSnapshot({
      equity: 97_000, // -3 % desde el lunes
      equityHistory: [
        { at: '2026-10-02T00:00:00.000Z', equity: 97_000 },
        { at: '2026-10-04T00:00:00.000Z', equity: 100_000 }, // base semanal
        { at: '2026-10-08T00:00:00.000Z', equity: 96_000 }, // base diaria: sin pérdida
      ],
    });
    expect(codesOf(snapshot)).toEqual([]);
  });

  it('veta MONTHLY_LOSS solo por la pérdida desde el día 1', () => {
    const snapshot = makeSnapshot({
      equity: 93_900, // -6,1 % desde el 1 de octubre
      equityHistory: [
        { at: '2026-09-30T00:00:00.000Z', equity: 100_000 }, // base mensual
        { at: '2026-10-05T00:00:00.000Z', equity: 93_900 }, // base semanal y diaria: 0 %
      ],
    });
    expect(codesOf(snapshot)).toEqual(['MONTHLY_LOSS']);
  });

  it('no veta MONTHLY_LOSS por debajo del límite mensual', () => {
    const snapshot = makeSnapshot({
      equity: 95_000, // -5 % desde el 1 de octubre
      equityHistory: [
        { at: '2026-09-30T00:00:00.000Z', equity: 100_000 },
        { at: '2026-10-05T00:00:00.000Z', equity: 95_000 },
      ],
    });
    expect(codesOf(snapshot)).not.toContain('MONTHLY_LOSS');
  });

  it('veta MAX_DRAWDOWN al alcanzar el drawdown máximo', () => {
    const snapshot = makeSnapshot({
      equity: 98_900, // -10,09 % desde el máximo de 110 000
      equityHistory: [
        { at: '2026-08-01T00:00:00.000Z', equity: 110_000 },
        // Bases recientes de periodo: sin pérdida diaria/semanal/mensual.
        { at: '2026-10-01T00:00:00.000Z', equity: 98_900 },
      ],
    });
    expect(codesOf(snapshot)).toEqual(['MAX_DRAWDOWN']);
  });

  it('no veta MAX_DRAWDOWN por debajo del máximo', () => {
    const snapshot = makeSnapshot({
      equity: 100_000, // -9,09 % desde el máximo
      equityHistory: [
        { at: '2026-08-01T00:00:00.000Z', equity: 110_000 },
        { at: '2026-10-01T00:00:00.000Z', equity: 100_000 },
      ],
    });
    expect(codesOf(snapshot)).not.toContain('MAX_DRAWDOWN');
  });
});

describe('número de posiciones abiertas', () => {
  const smallPositions = (tickers: string[]) =>
    tickers.map((ticker) => makePosition({ ticker, entry: 100, size: 5 }));

  it('veta MAX_POSITIONS con el máximo de posiciones ya abiertas', () => {
    const snapshot = makeSnapshot({
      positions: smallPositions(['MSFT', 'JPM', 'XOM', 'JNJ', 'KO']),
    });
    const reasons = checkPortfolioLimits(makeSignal(), 50, snapshot, LIMITS);
    expect(reasons.map((r) => r.code)).toEqual(['MAX_POSITIONS']);
    expect(reasons[0]?.details).toMatchObject({ limite: 5, abiertas: 5 });
  });

  it('no veta MAX_POSITIONS con hueco para una posición más', () => {
    const snapshot = makeSnapshot({
      positions: smallPositions(['MSFT', 'JPM', 'XOM', 'JNJ']),
    });
    expect(codesOf(snapshot)).toEqual([]);
  });
});

describe('exposición por activo, sector y divisa', () => {
  it('veta ASSET_EXPOSURE cuando el activo supera su exposición máxima', () => {
    const snapshot = makeSnapshot({
      positions: [makePosition({ ticker: 'AAPL', entry: 150, size: 100 })], // 15 000
    });
    const reasons = checkPortfolioLimits(makeSignal(), 50, snapshot, LIMITS);
    expect(reasons.map((r) => r.code)).toEqual(['ASSET_EXPOSURE']);
    expect(reasons[0]?.details).toMatchObject({ limite: 20, exposicion: 25, ticker: 'AAPL' });
  });

  it('no veta ASSET_EXPOSURE dentro del límite por activo', () => {
    const snapshot = makeSnapshot({
      positions: [makePosition({ ticker: 'AAPL', entry: 150, size: 30 })], // 4 500 + 10 000 = 14,5 %
    });
    expect(codesOf(snapshot)).toEqual([]);
  });

  it('veta SECTOR_EXPOSURE cuando el sector supera su exposición máxima', () => {
    const snapshot = makeSnapshot({
      // MSFT toma el sector «tecnologia» de la tabla local del universo.
      positions: [makePosition({ ticker: 'MSFT', entry: 250, size: 100 })], // 25 000
    });
    const reasons = checkPortfolioLimits(makeSignal(), 50, snapshot, LIMITS);
    expect(reasons.map((r) => r.code)).toEqual(['SECTOR_EXPOSURE']);
    expect(reasons[0]?.details).toMatchObject({
      limite: 30,
      exposicion: 35,
      sector: 'tecnologia',
    });
  });

  it('no veta SECTOR_EXPOSURE dentro del límite por sector', () => {
    const snapshot = makeSnapshot({
      positions: [makePosition({ ticker: 'MSFT', entry: 250, size: 60 })], // 15 000 + 10 000 = 25 %
    });
    expect(codesOf(snapshot)).toEqual([]);
  });

  it('veta CURRENCY_EXPOSURE cuando la divisa no USD supera su límite', () => {
    const snapshot = makeSnapshot({
      instruments: {
        AAPL: { sector: 'tecnologia', currency: 'EUR', avgDailyVolume20d: 5_000_000 },
      },
      positions: [
        makePosition({ ticker: 'SAN', currency: 'EUR', entry: 100, size: 200 }), // 20 000
      ],
    });
    const reasons = checkPortfolioLimits(makeSignal(), 50, snapshot, LIMITS);
    expect(reasons.map((r) => r.code)).toEqual(['CURRENCY_EXPOSURE']);
    expect(reasons[0]?.details).toMatchObject({ limite: 25, exposicion: 30, divisa: 'EUR' });
  });

  it('no veta CURRENCY_EXPOSURE con la candidata en USD', () => {
    const snapshot = makeSnapshot({
      positions: [makePosition({ ticker: 'SAN', currency: 'EUR', entry: 100, size: 200 })],
    });
    expect(codesOf(snapshot)).toEqual([]); // 20 % en EUR, por debajo del 25 %
  });
});

describe('correlación entre posiciones', () => {
  const series = Array.from({ length: 60 }, (_, i) => Math.sin(i / 3) + i / 50);

  it('veta CORRELATION con una posición abierta muy correlada en la misma dirección', () => {
    const snapshot = makeSnapshot({
      positions: [makePosition({ ticker: 'MSFT' })],
      dailyReturns: { AAPL: series, MSFT: series },
    });
    const reasons = checkPortfolioLimits(makeSignal(), 50, snapshot, LIMITS);
    expect(reasons.map((r) => r.code)).toEqual(['CORRELATION']);
    expect(reasons[0]?.details).toMatchObject({ limite: 0.7, correlacion: 1, ticker: 'MSFT' });
  });

  it('no veta CORRELATION con rendimientos independientes', () => {
    const snapshot = makeSnapshot({
      positions: [makePosition({ ticker: 'MSFT' })],
      dailyReturns: {
        AAPL: Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 1 : -1)),
        MSFT: Array.from({ length: 60 }, (_, i) => (i % 4 < 2 ? 1 : -1)),
      },
    });
    expect(codesOf(snapshot)).toEqual([]);
  });

  it('no veta CORRELATION si la posición correlada está en dirección contraria', () => {
    const snapshot = makeSnapshot({
      positions: [makePosition({ ticker: 'MSFT', direction: 'corto' })],
      dailyReturns: { AAPL: series, MSFT: series },
    });
    expect(codesOf(snapshot)).toEqual([]); // un corto correlado diversifica, no suma riesgo
  });

  it('no veta CORRELATION sin rendimientos suficientes (no decide sin evidencia)', () => {
    const snapshot = makeSnapshot({
      positions: [makePosition({ ticker: 'MSFT' })],
      dailyReturns: { AAPL: series.slice(0, 5), MSFT: series.slice(0, 5) },
    });
    expect(codesOf(snapshot)).toEqual([]);
  });
});

describe('apalancamiento fijo', () => {
  // Cuatro posiciones en sectores distintos del de la candidata: así solo
  // el nominal bruto decide, sin disparar posiciones ni sector.
  const positionsOf = (notional: number) =>
    ['JPM', 'XOM', 'JNJ', 'KO'].map((ticker) =>
      makePosition({ ticker, entry: notional / 100, size: 100 }),
    );

  it('veta LEVERAGE cuando el nominal bruto supera el capital (1x)', () => {
    const snapshot = makeSnapshot({ positions: positionsOf(24_000) }); // 96 000 + 10 000 = 106 %
    const reasons = checkPortfolioLimits(makeSignal(), 50, snapshot, LIMITS);
    expect(reasons.map((r) => r.code)).toEqual(['LEVERAGE']);
    expect(reasons[0]?.details).toMatchObject({ limite: 1, apalancamiento: 1.06 });
  });

  it('no veta LEVERAGE con el nominal bruto por debajo del capital', () => {
    const snapshot = makeSnapshot({ positions: positionsOf(20_000) }); // 80 000 + 10 000 = 90 %
    expect(codesOf(snapshot)).toEqual([]);
  });
});

describe('control de liquidez', () => {
  it('veta LIQUIDITY cuando la posición supera el 1 % del volumen medio de 20 días', () => {
    const snapshot = makeSnapshot({
      instruments: {
        AAPL: { sector: 'tecnologia', currency: 'USD', avgDailyVolume20d: 1_000_000 },
      },
    });
    // Entrada a 1: nominal 15 000 (15 % del capital), pero 15 000 uds. = 1,5 % del volumen.
    const reasons = checkPortfolioLimits(
      makeSignal({ entry: 1, stop: 0.9, target: 1.2 }),
      15_000,
      snapshot,
      LIMITS,
    );
    expect(reasons.map((r) => r.code)).toEqual(['LIQUIDITY']);
    expect(reasons[0]?.details).toMatchObject({
      limite: 1,
      porcentaje: 1.5,
      volumenMedio20d: 1_000_000,
    });
  });

  it('no veta LIQUIDITY dentro del volumen permitido', () => {
    const snapshot = makeSnapshot({
      instruments: {
        AAPL: { sector: 'tecnologia', currency: 'USD', avgDailyVolume20d: 1_000_000 },
      },
    });
    expect(codesOf(snapshot, makeSignal({ entry: 1, stop: 0.9, target: 1.2 }), 5_000)).toEqual([]);
  });

  it('veta LIQUIDITY cuando el volumen medio es desconocido (cierra en falso)', () => {
    const snapshot = makeSnapshot({
      instruments: { AAPL: { sector: 'tecnologia', currency: 'USD', avgDailyVolume20d: null } },
    });
    const reasons = checkPortfolioLimits(makeSignal(), 50, snapshot, LIMITS);
    expect(reasons.map((r) => r.code)).toEqual(['LIQUIDITY']);
    expect(reasons[0]?.details['motivo']).toContain('volumen medio');
  });
});

describe('orden y combinación de vetos', () => {
  it('devuelve todos los límites incumplidos en el orden estable del contrato', () => {
    const snapshot = makeSnapshot({
      equity: 97_900,
      // Bases que disparan los cuatro límites de pérdida/drawdown a la vez.
      equityHistory: [
        { at: '2026-08-01T00:00:00.000Z', equity: 110_000 }, // máximo: dd 11 %
        { at: '2026-09-25T00:00:00.000Z', equity: 105_000 }, // base mensual y semanal: -6,8 %
        { at: '2026-10-08T20:00:00.000Z', equity: 100_000 }, // base diaria: -2,1 %
      ],
      positions: [
        makePosition({ ticker: 'AAPL', entry: 150, size: 100 }), // activo 15 000
        makePosition({ ticker: 'MSFT', entry: 250, size: 100 }), // sector tec. 25 000
        makePosition({ ticker: 'SAN', currency: 'EUR', entry: 100, size: 300 }), // EUR 30 000
        makePosition({ ticker: 'XOM', entry: 150, size: 100 }), // nominal 15 000
        makePosition({ ticker: 'JNJ', entry: 150, size: 100 }), // nominal 15 000
      ],
      instruments: {
        AAPL: { sector: 'tecnologia', currency: 'USD', avgDailyVolume20d: 1_000 },
      },
      dailyReturns: {
        AAPL: Array.from({ length: 60 }, (_, i) => i),
        MSFT: Array.from({ length: 60 }, (_, i) => i),
      },
    });
    expect(codesOf(snapshot)).toEqual([
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
    ]);
  });
});
