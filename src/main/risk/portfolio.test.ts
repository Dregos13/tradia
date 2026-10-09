import { describe, expect, it } from 'vitest';

import {
  CORRELATION_MIN_SAMPLES,
  TRADIA_UNIVERSE_SECTORS,
  UNKNOWN_SECTOR,
  alignedCorrelation,
  drawdownPct,
  equityAtInstant,
  exposurePctBy,
  grossNotional,
  lossPctSince,
  pearsonCorrelation,
  periodStartUtc,
  positionCurrency,
  positionNotional,
  positionSector,
  resolveInstrument,
  type EquityHistoryPoint,
  type PortfolioSnapshot,
} from './portfolio';

const NOW = '2026-10-09T15:00:00.000Z'; // viernes

function makeSnapshot(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    now: NOW,
    equity: 100_000,
    positions: [],
    equityHistory: [],
    instruments: {},
    dailyReturns: {},
    ...overrides,
  };
}

describe('TRADIA_UNIVERSE_SECTORS', () => {
  it('cubre los 25 tickers del universo de docs/alcance.md', () => {
    expect(Object.keys(TRADIA_UNIVERSE_SECTORS).sort()).toEqual(
      [
        'AAPL',
        'AMD',
        'AMZN',
        'AVGO',
        'DIA',
        'GOOGL',
        'HD',
        'IWM',
        'JNJ',
        'JPM',
        'KO',
        'META',
        'MSFT',
        'NVDA',
        'PG',
        'QQQ',
        'SPY',
        'TLT',
        'V',
        'VTI',
        'XLE',
        'XLF',
        'XLK',
        'XLV',
        'XOM',
      ].sort(),
    );
  });
});

describe('periodStartUtc', () => {
  it('el día empieza a medianoche UTC', () => {
    expect(periodStartUtc(NOW, 'day')?.toISOString()).toBe('2026-10-09T00:00:00.000Z');
  });

  it('la semana ISO empieza el lunes a medianoche UTC', () => {
    expect(periodStartUtc(NOW, 'week')?.toISOString()).toBe('2026-10-05T00:00:00.000Z');
    // Un domingo pertenece a la semana que empezó el lunes anterior.
    expect(periodStartUtc('2026-10-11T12:00:00.000Z', 'week')?.toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    );
  });

  it('el mes empieza el día 1 a medianoche UTC', () => {
    expect(periodStartUtc(NOW, 'month')?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('devuelve null con una fecha no parseable', () => {
    expect(periodStartUtc('no-es-fecha', 'day')).toBeNull();
  });
});

describe('equityAtInstant', () => {
  const history: EquityHistoryPoint[] = [
    { at: '2026-10-01T00:00:00.000Z', equity: 90_000 },
    { at: '2026-10-08T00:00:00.000Z', equity: 98_000 },
  ];

  it('usa el último punto en el instante o anterior', () => {
    expect(equityAtInstant(history, '2026-10-09T00:00:00.000Z')).toBe(98_000);
    expect(equityAtInstant(history, '2026-10-05T00:00:00.000Z')).toBe(90_000);
  });

  it('sin punto previo usa el más antiguo disponible', () => {
    expect(equityAtInstant(history, '2026-09-15T00:00:00.000Z')).toBe(90_000);
  });

  it('devuelve null con la curva vacía', () => {
    expect(equityAtInstant([], NOW)).toBeNull();
  });
});

describe('lossPctSince', () => {
  it('mide la caída en % desde el capital de referencia', () => {
    const history: EquityHistoryPoint[] = [{ at: '2026-10-08T00:00:00.000Z', equity: 100_000 }];
    expect(lossPctSince(history, 97_900, '2026-10-09T00:00:00.000Z')).toBeCloseTo(2.1, 5);
  });

  it('devuelve 0 cuando el capital no cayó o no hay referencia', () => {
    const history: EquityHistoryPoint[] = [{ at: '2026-10-08T00:00:00.000Z', equity: 100_000 }];
    expect(lossPctSince(history, 101_000, '2026-10-09T00:00:00.000Z')).toBe(0);
    expect(lossPctSince([], 99_000, '2026-10-09T00:00:00.000Z')).toBe(0);
  });
});

describe('drawdownPct', () => {
  it('mide la caída desde el máximo histórico', () => {
    const history: EquityHistoryPoint[] = [
      { at: '2026-08-01T00:00:00.000Z', equity: 110_000 },
      { at: '2026-10-01T00:00:00.000Z', equity: 98_900 },
    ];
    expect(drawdownPct(history, 98_900)).toBeCloseTo(10.0909, 3);
  });

  it('devuelve 0 en máximo o sin historia', () => {
    expect(drawdownPct([], 100_000)).toBe(0);
    expect(drawdownPct([{ at: '2026-08-01T00:00:00.000Z', equity: 90_000 }], 100_000)).toBe(0);
  });
});

describe('nominal y exposición', () => {
  it('positionNotional usa el precio de mercado si lo hay y la entrada si no', () => {
    const pos = { ticker: 'AAPL', direction: 'largo' as const, entry: 100, size: 10 };
    expect(positionNotional(pos)).toBe(1_000);
    expect(positionNotional({ ...pos, markPrice: 110 })).toBe(1_100);
  });

  it('grossNotional suma nominales brutos (el corto expone como el largo)', () => {
    const snapshotPositions = [
      { ticker: 'AAPL', direction: 'largo' as const, entry: 100, size: 10 },
      { ticker: 'MSFT', direction: 'corto' as const, entry: 200, size: 5 },
    ];
    expect(grossNotional(snapshotPositions)).toBe(2_000);
  });

  it('exposurePctBy agrupa por clave en % del capital', () => {
    const snapshot = makeSnapshot({
      positions: [
        { ticker: 'AAPL', direction: 'largo', entry: 100, size: 100 },
        { ticker: 'MSFT', direction: 'largo', entry: 100, size: 50 },
      ],
    });
    const byTicker = exposurePctBy(snapshot, (p) => p.ticker);
    expect(byTicker.get('AAPL')).toBeCloseTo(10, 5);
    expect(byTicker.get('MSFT')).toBeCloseTo(5, 5);
  });
});

describe('metadatos de instrumento', () => {
  it('resolveInstrument prefiere la instantánea, luego el universo y por último neutros', () => {
    const snapshot = makeSnapshot({
      instruments: {
        AAPL: { sector: 'salud', currency: 'EUR', avgDailyVolume20d: 123 },
      },
    });
    expect(resolveInstrument(snapshot, 'AAPL')).toEqual({
      sector: 'salud',
      currency: 'EUR',
      avgDailyVolume20d: 123,
    });
    // Ticker del universo sin metadatos: sector de la tabla local y USD.
    expect(resolveInstrument(snapshot, 'JPM')).toEqual({
      sector: 'finanzas',
      currency: 'USD',
      avgDailyVolume20d: null,
    });
    // Ticker fuera del universo: sector desconocido, USD.
    expect(resolveInstrument(snapshot, 'FOO')).toEqual({
      sector: null,
      currency: 'USD',
      avgDailyVolume20d: null,
    });
  });

  it('positionSector y positionCurrency respetan lo declarado en la posición', () => {
    const snapshot = makeSnapshot();
    const explicit = {
      ticker: 'FOO',
      direction: 'largo' as const,
      entry: 1,
      size: 1,
      sector: 'energia',
      currency: 'GBP',
    };
    expect(positionSector(snapshot, explicit)).toBe('energia');
    expect(positionCurrency(snapshot, explicit)).toBe('GBP');
    const bare = { ticker: 'FOO', direction: 'largo' as const, entry: 1, size: 1 };
    expect(positionSector(snapshot, bare)).toBe(UNKNOWN_SECTOR);
    expect(positionCurrency(snapshot, bare)).toBe('USD');
    // AAPL sin metadatos explícitos toma el sector del universo.
    const aapl = { ticker: 'AAPL', direction: 'largo' as const, entry: 1, size: 1 };
    expect(positionSector(snapshot, aapl)).toBe('tecnologia');
  });
});

describe('pearsonCorrelation', () => {
  const sample = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

  it('devuelve 1 para series idénticas y -1 para opuestas', () => {
    const a = sample(60, (i) => i * 0.5 - 7);
    expect(pearsonCorrelation(a, a)).toBeCloseTo(1, 10);
    expect(
      pearsonCorrelation(
        a,
        a.map((v) => -v),
      ),
    ).toBeCloseTo(-1, 10);
  });

  it('devuelve ~0 para series independientes', () => {
    const a = sample(60, (i) => (i % 2 === 0 ? 1 : -1));
    const b = sample(60, (i) => (i % 4 < 2 ? 1 : -1));
    expect(pearsonCorrelation(a, b)).toBeCloseTo(0, 10);
  });

  it('usa solo la cola de la ventana (los valores más recientes)', () => {
    // 60 valores correlados al final; los 40 primeros no cuentan con ventana 60.
    const tail = sample(60, (i) => i);
    const a = [...sample(40, () => 999), ...tail];
    const b = [...sample(40, () => -999), ...tail];
    expect(pearsonCorrelation(a, b)).toBeCloseTo(1, 10);
  });

  it('devuelve null sin muestras suficientes o con varianza cero', () => {
    const few = sample(CORRELATION_MIN_SAMPLES - 1, (i) => i);
    expect(pearsonCorrelation(few, few)).toBeNull();
    const flat = sample(60, () => 3);
    const varied = sample(60, (i) => i);
    expect(pearsonCorrelation(flat, varied)).toBeNull();
  });
});

describe('alignedCorrelation', () => {
  it('misma dirección mantiene el signo y dirección opuesta lo invierte', () => {
    const returns = Array.from({ length: 60 }, (_, i) => i * 0.1);
    const snapshot = makeSnapshot({
      dailyReturns: { AAPL: returns, MSFT: returns },
    });
    const long = { ticker: 'MSFT', direction: 'largo' as const, entry: 1, size: 1 };
    const short = { ...long, direction: 'corto' as const };
    expect(alignedCorrelation(snapshot, 'AAPL', 'largo', long)).toBeCloseTo(1, 10);
    expect(alignedCorrelation(snapshot, 'AAPL', 'largo', short)).toBeCloseTo(-1, 10);
  });

  it('devuelve null sin series de rendimientos', () => {
    const snapshot = makeSnapshot();
    const pos = { ticker: 'MSFT', direction: 'largo' as const, entry: 1, size: 1 };
    expect(alignedCorrelation(snapshot, 'AAPL', 'largo', pos)).toBeNull();
  });
});
