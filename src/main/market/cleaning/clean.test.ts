import { describe, expect, it } from 'vitest';

import { expectedSessionsBetween } from '../calendar';
import type { Bar, CorporateAction } from '../providers/types';
import {
  cleanBars,
  deriveCorporateActions,
  type CleanBarsResult,
  type SessionCalendar,
} from './index';

const bar = (date: string, over: Partial<Bar> = {}): Bar => ({
  date,
  open: 100,
  high: 101,
  low: 99,
  close: 100,
  volume: 1_000_000,
  adjClose: 100,
  splitFactor: 1,
  dividend: 0,
  ...over,
});

const split = (date: string, factor: number): CorporateAction => ({
  ticker: 'TEST',
  date,
  kind: 'split',
  value: factor,
});

const dividend = (date: string, amount: number): CorporateAction => ({
  ticker: 'TEST',
  date,
  kind: 'dividend',
  value: amount,
});

const findBar = (result: CleanBarsResult, date: string) => result.bars.find((b) => b.date === date);

/** Calendario de juguete: todos los laborables son sesión. */
const weekdayCalendar: SessionCalendar = {
  expectedSessionsBetween(desde, hasta) {
    const sessions = [];
    const cursor = new Date(`${desde}T00:00:00.000Z`);
    const end = new Date(`${hasta}T00:00:00.000Z`);
    while (cursor <= end) {
      const day = cursor.getUTCDay();
      if (day >= 1 && day <= 5) {
        sessions.push({
          date: cursor.toISOString().slice(0, 10),
          opensAtUtc: '',
          closesAtUtc: '',
          updateAtUtc: '',
          earlyClose: false,
        });
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return sessions;
  },
};

const realCalendar: SessionCalendar = { expectedSessionsBetween };

describe('ajuste hacia atrás por splits', () => {
  it('AAPL 4:1 del 31-08-2020 divide precios y multiplica el volumen anteriores', () => {
    // Cierres reales: 499,23 el 28-08 (pre-split) y 129,04 el 31-08 (fecha ex).
    const result = cleanBars({
      ticker: 'AAPL',
      bars: [
        bar('2020-08-27', {
          open: 505.82,
          high: 515.14,
          low: 499.61,
          close: 500.04,
          volume: 87_600_000,
        }),
        bar('2020-08-28', {
          open: 505.55,
          high: 505.82,
          low: 493.55,
          close: 499.23,
          volume: 96_000_000,
        }),
        bar('2020-08-31', {
          open: 127.58,
          high: 131.0,
          low: 126.0,
          close: 129.04,
          volume: 225_700_000,
        }),
      ],
      corporateActions: [split('2020-08-31', 4)],
    });

    const before = findBar(result, '2020-08-28')!;
    const exDay = findBar(result, '2020-08-31')!;

    // Precios crudos conservados; ajustados = crudo / 4.
    expect(before.close).toBe(499.23);
    expect(before.adjClose).toBeCloseTo(499.23 / 4, 6);
    expect(before.adjOpen).toBeCloseTo(505.55 / 4, 6);
    expect(before.adjHigh).toBeCloseTo(505.82 / 4, 6);
    expect(before.adjLow).toBeCloseTo(493.55 / 4, 6);
    expect(before.adjVolume).toBe(96_000_000 * 4);

    // La vela de la fecha ex ya cotiza post-split: no se ajusta.
    expect(exDay.adjClose).toBe(129.04);
    expect(exDay.adjVolume).toBe(225_700_000);

    // La serie ajustada es continua: la rentabilidad ajustada 28→31 no
    // refleja el salto -75 % del split.
    const adjustedReturn = exDay.adjClose / before.adjClose - 1;
    expect(adjustedReturn).toBeCloseTo(129.04 / (499.23 / 4) - 1, 10);
    expect(adjustedReturn).toBeGreaterThan(0);
    expect(adjustedReturn).toBeLessThan(0.05);

    expect(result.report.reliable).toBe(true);
    expect(result.report.anomalies).toHaveLength(0);
  });

  it('NVDA 10:1 del 10-06-2024 ajusta las velas anteriores por 10', () => {
    // Cierre real del 07-06-2024: 1208,88 (pre-split); el 10-06 cerró a 121,79.
    const result = cleanBars({
      ticker: 'NVDA',
      bars: [
        bar('2024-06-06', { close: 1209.98, volume: 41_000_000 }),
        bar('2024-06-07', { close: 1208.88, volume: 55_000_000 }),
        bar('2024-06-10', { close: 121.79, volume: 265_000_000 }),
      ],
      corporateActions: [split('2024-06-10', 10)],
    });

    expect(findBar(result, '2024-06-07')!.adjClose).toBeCloseTo(120.888, 6);
    expect(findBar(result, '2024-06-07')!.adjVolume).toBe(550_000_000);
    expect(findBar(result, '2024-06-10')!.adjClose).toBe(121.79);
  });

  it('varios splits se acumulan multiplicando', () => {
    const result = cleanBars({
      ticker: 'TEST',
      bars: [bar('2020-01-02', { close: 800 }), bar('2020-06-01'), bar('2021-01-04')],
      corporateActions: [split('2020-06-01', 2), split('2021-01-04', 4)],
    });

    // 800 crudos / (2 × 4) = 100 ajustados.
    expect(findBar(result, '2020-01-02')!.adjClose).toBe(100);
    expect(findBar(result, '2020-06-01')!.adjClose).toBe(25); // 100 / 4
    expect(findBar(result, '2021-01-04')!.adjClose).toBe(100); // sin ajuste
  });

  it('deriva las acciones de splitFactor/dividend de las velas si no se pasan', () => {
    const result = cleanBars({
      ticker: 'AAPL',
      bars: [
        bar('2020-08-28', { close: 499.23 }),
        bar('2020-08-31', { close: 129.04, splitFactor: 4 }),
      ],
    });

    expect(findBar(result, '2020-08-28')!.adjClose).toBeCloseTo(499.23 / 4, 6);
    expect(findBar(result, '2020-08-31')!.adjClose).toBe(129.04);
  });
});

describe('ajuste hacia atrás por dividendos', () => {
  it('un dividendo reduce las velas anteriores por (1 - D/cierre previo)', () => {
    const result = cleanBars({
      ticker: 'TEST',
      bars: [
        bar('2024-03-13', { close: 100, volume: 1_000 }),
        bar('2024-03-14', { close: 101, volume: 1_000 }), // fecha ex, dividendo 1
        bar('2024-03-15', { close: 102, volume: 1_000 }),
      ],
      corporateActions: [dividend('2024-03-14', 1)],
    });

    // Factor 1 - 1/100 = 0,99 solo para velas anteriores a la fecha ex.
    expect(findBar(result, '2024-03-13')!.adjClose).toBeCloseTo(99, 6);
    expect(findBar(result, '2024-03-13')!.adjOpen).toBeCloseTo(99, 6);
    expect(findBar(result, '2024-03-14')!.adjClose).toBe(101);
    expect(findBar(result, '2024-03-15')!.adjClose).toBe(102);
    // El dividendo no toca el volumen.
    expect(findBar(result, '2024-03-13')!.adjVolume).toBe(1_000);
  });

  it('split y dividendo se combinan multiplicativamente', () => {
    const result = cleanBars({
      ticker: 'TEST',
      bars: [bar('2024-01-02', { close: 200 }), bar('2024-02-01'), bar('2024-03-01')],
      corporateActions: [dividend('2024-02-01', 10), split('2024-03-01', 2)],
    });

    // Vela del 02-01: 200 × (1 - 10/200) / 2 = 95.
    expect(findBar(result, '2024-01-02')!.adjClose).toBeCloseTo(95, 6);
    // Vela del 01-02 (fecha ex del dividendo): solo el split posterior → /2.
    expect(findBar(result, '2024-02-01')!.adjClose).toBe(50);
    expect(findBar(result, '2024-03-01')!.adjClose).toBe(100);
  });

  it('un dividendo sin cierre previo no se aplica y deja aviso', () => {
    const result = cleanBars({
      ticker: 'TEST',
      bars: [bar('2024-03-14', { close: 101 })],
      corporateActions: [dividend('2024-03-14', 1)],
    });

    expect(result.bars[0]!.adjClose).toBe(101);
    expect(result.report.warnings.some((w) => w.includes('sin cierre previo'))).toBe(true);
    expect(result.report.reliable).toBe(false);
  });
});

describe('duplicados, huecos y valores anómalos', () => {
  it('de las filas duplicadas se conserva la última recibida', () => {
    const result = cleanBars({
      ticker: 'TEST',
      bars: [
        bar('2024-01-02', { close: 100 }),
        bar('2024-01-03', { close: 101 }),
        bar('2024-01-02', { close: 100.5 }), // corrección del proveedor
      ],
    });

    expect(result.report.received).toBe(3);
    expect(result.report.kept).toBe(2);
    expect(result.report.duplicates).toEqual(['2024-01-02']);
    expect(findBar(result, '2024-01-02')!.close).toBe(100.5);
  });

  it('detecta huecos frente a las sesiones esperadas del calendario', () => {
    const result = cleanBars({
      ticker: 'TEST',
      bars: [bar('2026-01-12'), bar('2026-01-13'), bar('2026-01-15'), bar('2026-01-16')],
      calendar: weekdayCalendar,
    });

    expect(result.report.gaps).toEqual(['2026-01-14']); // falta el miércoles
    expect(result.report.reliable).toBe(false);
  });

  it('usa el calendario real: los festivos de NYSE no son huecos', () => {
    // Semana del MLK 2026: lunes 19 festivo; falta el miércoles 14.
    const result = cleanBars({
      ticker: 'TEST',
      bars: [
        bar('2026-01-12'),
        bar('2026-01-13'),
        bar('2026-01-15'),
        bar('2026-01-16'),
        bar('2026-01-20'),
      ],
      calendar: realCalendar,
    });

    expect(result.report.gaps).toEqual(['2026-01-14']);
  });

  it('marca una vela en día sin sesión como non-session sin descartarla', () => {
    const result = cleanBars({
      ticker: 'TEST',
      bars: [bar('2026-01-16'), bar('2026-01-17')], // sábado
      calendar: weekdayCalendar,
    });

    const anomaly = result.report.anomalies.find((a) => a.kind === 'non-session');
    expect(anomaly?.date).toBe('2026-01-17');
    expect(anomaly?.action).toBe('flagged');
    expect(result.report.kept).toBe(2);
  });

  it('descarta velas estructuralmente inválidas y las registra', () => {
    const result = cleanBars({
      ticker: 'TEST',
      bars: [
        bar('2026-01-12'),
        bar('2026-01-13', { high: 90, low: 99 }), // high < low
        bar('2026-01-14', { close: 0 }), // precio 0
        bar('2026-01-15', { open: -3 }), // precio negativo
        bar('2026-01-16', { volume: -100 }), // volumen negativo
        bar('2026-01-20', { close: Number.NaN }), // no finito
        bar('no-es-fecha'),
      ],
    });

    expect(result.report.kept).toBe(1);
    const kinds = result.report.anomalies.map((a) => a.kind);
    expect(kinds).toContain('high-below-low');
    expect(kinds).toContain('non-positive-price');
    expect(kinds).toContain('negative-volume');
    expect(kinds).toContain('non-numeric');
    expect(kinds).toContain('bad-date');
    expect(result.report.anomalies.every((a) => a.action === 'dropped')).toBe(true);
  });

  it('marca un salto de rentabilidad > 8σ sin acción corporativa', () => {
    // Serie casi plana y una vela que se dispara un +900 % sin explicación.
    const bars = [bar('2026-01-02', { close: 100 })];
    let price = 100;
    for (let i = 1; i < 15; i++) {
      price = price * (i % 2 === 0 ? 1.001 : 0.999);
      bars.push(bar(`2026-01-${String(5 + i).padStart(2, '0')}`, { close: price }));
    }
    bars.push(bar('2026-01-21', { close: price * 10 }));

    const result = cleanBars({ ticker: 'TEST', bars });
    const anomaly = result.report.anomalies.find((a) => a.kind === 'return-outlier');

    expect(anomaly?.date).toBe('2026-01-21');
    expect(anomaly?.action).toBe('flagged');
    // La vela se conserva: puede ser un movimiento real.
    expect(findBar(result, '2026-01-21')).toBeDefined();
  });

  it('un salto con acción corporativa ese día no es anómalo (es el split)', () => {
    const result = cleanBars({
      ticker: 'TEST',
      bars: [
        bar('2026-01-05'),
        ...Array.from({ length: 13 }, (_, i) =>
          bar(`2026-01-${String(6 + i).padStart(2, '0')}`, { close: 100 + (i % 3) * 0.1 }),
        ),
        bar('2026-01-20', { close: 25 }), // -75 % explicado por el split 4:1
      ],
      corporateActions: [split('2026-01-20', 4)],
    });

    expect(result.report.anomalies.filter((a) => a.kind === 'return-outlier')).toHaveLength(0);
  });
});

describe('versión del lote', () => {
  const input = () => ({
    ticker: 'TEST',
    bars: [bar('2024-01-02', { close: 100 }), bar('2024-01-03', { close: 101 })],
  });

  it('el primer lote sale con versión 1 y su hash', () => {
    const result = cleanBars(input());
    expect(result.batch.version).toBe(1);
    expect(result.batch.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('un mismo lote reprocesado conserva la versión y el hash', () => {
    const first = cleanBars(input());
    const again = cleanBars(input(), { previousBatch: first.batch });

    expect(again.batch.hash).toBe(first.batch.hash);
    expect(again.batch.version).toBe(first.batch.version);
  });

  it('un cambio en el contenido incrementa la versión', () => {
    const first = cleanBars(input());
    const changed = cleanBars(
      {
        ticker: 'TEST',
        bars: [bar('2024-01-02', { close: 100 }), bar('2024-01-03', { close: 101.5 })],
      },
      { previousBatch: first.batch },
    );

    expect(changed.batch.hash).not.toBe(first.batch.hash);
    expect(changed.batch.version).toBe(2);
  });

  it('el orden de llegada no cambia el hash del lote', () => {
    const a = cleanBars(input());
    const reversed = cleanBars({ ticker: 'TEST', bars: [...input().bars].reverse() });
    expect(reversed.batch.hash).toBe(a.batch.hash);
  });
});

describe('deriveCorporateActions', () => {
  it('convierte splitFactor y dividend de las velas en acciones', () => {
    const actions = deriveCorporateActions('AAPL', [
      bar('2020-08-28'),
      bar('2020-08-31', { splitFactor: 4, dividend: 0.82 }),
    ]);

    expect(actions).toEqual([
      { ticker: 'AAPL', date: '2020-08-31', kind: 'dividend', value: 0.82 },
      { ticker: 'AAPL', date: '2020-08-31', kind: 'split', value: 4 },
    ]);
  });
});
