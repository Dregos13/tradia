import { describe, expect, it } from 'vitest';

import {
  cpiEstimateReleases,
  dayOfWeek,
  eiaReleases,
  expirationReleases,
  gdpEstimateReleases,
  ismReleases,
  isUsFederalHoliday,
  lastWeekdayOfMonth,
  nfpReleases,
  nthWeekdayOfMonth,
  opecReleases,
  pceEstimateReleases,
  type ScheduledRelease,
} from './rules';

const addDaysLocal = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

const only = (releases: ScheduledRelease[]): ScheduledRelease => {
  expect(releases).toHaveLength(1);
  return releases[0]!;
};

describe('nfpReleases (nóminas no agrícolas)', () => {
  it.each([
    // NFP publicado por el BLS en 2026 (tabla oficial).
    ['2026-11-01', '2026-11-30', '2026-11-06', 'primer viernes de noviembre de 2026'],
    ['2026-10-01', '2026-10-31', '2026-10-02', 'primer viernes de octubre de 2026'],
    ['2026-01-01', '2026-01-31', '2026-01-09', 'enero 2026, movido por el BLS al segundo viernes'],
    ['2026-02-01', '2026-02-28', '2026-02-11', 'febrero 2026, movido por el BLS al miércoles'],
    ['2026-05-01', '2026-05-31', '2026-05-08', 'mayo 2026, movido por el BLS'],
    ['2026-07-01', '2026-07-31', '2026-07-02', 'julio 2026, jueves por el 4 de julio observado'],
    // Por regla fuera de la tabla (2027, calendario BLS sin publicar).
    ['2027-01-01', '2027-01-31', '2027-01-08', 'enero 2027, primer viernes festivo → segundo'],
    ['2027-03-01', '2027-03-31', '2027-03-05', 'marzo 2027, primer viernes'],
    [
      '2027-07-01',
      '2027-07-31',
      '2027-07-02',
      'julio 2027, primer viernes (festivo es el lunes 5)',
    ],
  ])('%s → %s (%s)', (desde, hasta, esperada) => {
    const release = only(nfpReleases(desde, hasta));
    expect(release.date).toBe(esperada);
    expect(release.hour).toBe(8);
    expect(release.minute).toBe(30);
  });

  it('marca oficial las fechas publicadas por el BLS y regla las calculadas', () => {
    expect(only(nfpReleases('2026-11-01', '2026-11-30')).official).toBe(true);
    expect(only(nfpReleases('2027-03-01', '2027-03-31')).official).toBe(false);
  });
});

describe('eiaReleases (informe semanal de inventarios)', () => {
  it('sale los miércoles a las 10:30 en una semana normal', () => {
    const release = only(eiaReleases('2026-10-07', '2026-10-07'));
    expect(release.date).toBe('2026-10-07');
    expect(dayOfWeek(release.date)).toBe(3);
    expect([release.hour, release.minute]).toEqual([10, 30]);
  });

  it.each([
    // Semana con festivo federal de lunes a miércoles → jueves 12:00.
    ['2026-05-25', 'Memorial Day (lunes)', '2026-05-28'],
    ['2026-09-07', 'Labor Day (lunes)', '2026-09-10'],
    ['2026-10-12', 'Columbus Day (lunes, festivo federal pero no NYSE)', '2026-10-15'],
    ['2026-11-09', 'Veterans Day (miércoles, festivo federal pero no NYSE)', '2026-11-12'],
    ['2026-02-16', 'Presidents Day (lunes)', '2026-02-19'],
    // Festivos a partir del jueves NO mueven el informe (Acción de Gracias).
    ['2026-11-23', 'Acción de Gracias (jueves)', '2026-11-25'],
    ['2026-06-15', 'Juneteenth (viernes)', '2026-06-17'],
    ['2026-12-21', 'Navidad (viernes)', '2026-12-23'],
  ])('semana del %s → %s', (monday, _motivo, esperada) => {
    const release = only(eiaReleases(monday, addDaysLocal(monday, 4)));
    expect(release.date).toBe(esperada);
    if (esperada !== addDaysLocal(monday, 2)) {
      expect([release.hour, release.minute]).toEqual([12, 0]);
    }
  });
});

describe('ismReleases (PMI del ISM)', () => {
  it('manufacturero el primer día de negociación y servicios el tercero, 10:00', () => {
    const releases = ismReleases('2026-10-01', '2026-10-31');
    expect(releases.map((r) => r.date)).toEqual(['2026-10-01', '2026-10-05']);
    expect(releases[0]!.title).toContain('manufacturero');
    expect(releases[1]!.title).toContain('servicios');
    expect(releases.every((r) => r.hour === 10 && r.minute === 0)).toBe(true);
  });
});

describe('expirationReleases (vencimientos)', () => {
  it('tercer viernes al cierre en un mes normal', () => {
    const release = only(expirationReleases('2026-10-16', '2026-10-16'));
    expect(release.date).toBe('2026-10-16');
    expect(dayOfWeek(release.date)).toBe(5);
    expect([release.hour, release.minute]).toEqual([16, 0]);
    expect(release.title).not.toContain('triple');
  });

  it('triple witching de diciembre de 2026: viernes 18 a la apertura', () => {
    const release = only(expirationReleases('2026-12-14', '2026-12-20'));
    expect(release.date).toBe('2026-12-18');
    expect([release.hour, release.minute]).toEqual([9, 30]);
    expect(release.title).toContain('triple witching');
  });

  it('triple witching de junio de 2026 cae al jueves 18 (Juneteenth es viernes)', () => {
    const release = only(expirationReleases('2026-06-15', '2026-06-21'));
    expect(release.date).toBe('2026-06-18');
    expect(dayOfWeek(release.date)).toBe(4);
  });

  it.each([
    ['2026-03-20', 'marzo'],
    ['2026-06-18', 'junio (movido por festivo)'],
    ['2026-09-18', 'septiembre'],
    ['2026-12-18', 'diciembre'],
  ])('triple witching %s (%s)', (esperada) => {
    const releases = expirationReleases('2026-01-01', '2026-12-31');
    const triple = releases.filter((r) => r.title.includes('triple'));
    expect(triple.map((r) => r.date)).toContain(esperada);
    expect(triple).toHaveLength(4);
  });
});

describe('opecReleases (revisión mensual OPEP+)', () => {
  it('primer domingo de cada mes a las 12:00 de Viena', () => {
    expect(only(opecReleases('2026-11-01', '2026-11-30')).date).toBe('2026-11-01');
    expect(only(opecReleases('2026-11-01', '2026-11-30')).zone).toBe('Europe/Vienna');
    expect(dayOfWeek('2026-11-01')).toBe(0);
  });
});

describe('estimaciones por regla (años sin calendario publicado)', () => {
  it('IPC: segundo miércoles solo en meses sin fecha BLS', () => {
    const covered = new Set(['2026-10']);
    expect(cpiEstimateReleases('2026-10-01', '2026-10-31', covered)).toHaveLength(0);
    expect(only(cpiEstimateReleases('2027-01-01', '2027-01-31', covered)).date).toBe('2027-01-13');
  });

  it('PCE: último día laborable del mes en meses sin fecha BEA', () => {
    // 31 de enero de 2027 es domingo → viernes 29.
    expect(only(pceEstimateReleases('2027-01-01', '2027-01-31', new Set())).date).toBe(
      '2027-01-29',
    );
  });

  it('PIB avanzado: último jueves de ene/abr/jul/oct para trimestres sin fecha', () => {
    const release = only(gdpEstimateReleases('2027-01-01', '2027-01-31', new Set()));
    expect(release.date).toBe('2027-01-28');
    expect(release.title).toContain('T4 2026');
    // Febrero no es mes de avanzada.
    expect(gdpEstimateReleases('2027-02-01', '2027-02-28', new Set())).toHaveLength(0);
  });
});

describe('utilidades de fechas', () => {
  it('nthWeekdayOfMonth y lastWeekdayOfMonth', () => {
    expect(nthWeekdayOfMonth(2026, 11, 5, 1)).toBe('2026-11-06');
    expect(nthWeekdayOfMonth(2026, 10, 0, 1)).toBe('2026-10-04');
    expect(lastWeekdayOfMonth(2026, 10, 4)).toBe('2026-10-29');
  });

  it('isUsFederalHoliday cubre los federales, no solo los de bolsa', () => {
    expect(isUsFederalHoliday('2026-11-26')).toBe(true); // Acción de Gracias
    expect(isUsFederalHoliday('2026-10-12')).toBe(true); // Columbus Day (NYSE abre)
    expect(isUsFederalHoliday('2026-11-11')).toBe(true); // Veterans Day (NYSE abre)
    expect(isUsFederalHoliday('2026-06-19')).toBe(true); // Juneteenth
    expect(isUsFederalHoliday('2026-07-03')).toBe(true); // 4 de julio observado
    expect(isUsFederalHoliday('2026-10-07')).toBe(false);
    // 1-1-2022 cayó en sábado: se observó el 31-12-2021.
    expect(isUsFederalHoliday('2021-12-31')).toBe(true);
  });
});
