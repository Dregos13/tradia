import { describe, expect, it } from 'vitest';

import { earningsToEvent, generateCalendarEvents } from './generate';

const findByClave = (desde: string, hasta: string, clave: string) =>
  generateCalendarEvents(desde, hasta).find((e) => e.clave === clave);

describe('generateCalendarEvents — instantes UTC', () => {
  it('NFP de noviembre de 2026: viernes 6 a las 8:30 ET → 13:30 UTC (EST)', () => {
    const event = findByClave('2026-11-01', '2026-11-30', 'nfp:2026-11-06');
    expect(event).toMatchObject({
      kind: 'nfp',
      dateUtc: '2026-11-06T13:30:00.000Z',
      impact: 'alto',
      country: 'US',
      origin: 'oficial',
    });
  });

  it('triple witching del 18-12-2026: 9:30 ET → 14:30 UTC (EST)', () => {
    const event = findByClave('2026-12-01', '2026-12-31', 'vencimiento:2026-12-18');
    expect(event).toMatchObject({
      kind: 'vencimiento',
      dateUtc: '2026-12-18T14:30:00.000Z',
      impact: 'alto',
      country: null,
      origin: 'regla',
    });
    expect(event!.title).toContain('triple witching');
  });

  it('EIA en semana con festivo: jueves 28-05-2026 a las 12:00 ET → 16:00 UTC (EDT)', () => {
    const event = findByClave('2026-05-25', '2026-05-31', 'eia:2026-05-28');
    expect(event).toMatchObject({
      kind: 'eia',
      dateUtc: '2026-05-28T16:00:00.000Z',
      impact: 'medio',
      origin: 'regla',
    });
  });

  it('EIA en semana normal: miércoles 07-10-2026 a las 10:30 ET → 14:30 UTC (EDT)', () => {
    const event = findByClave('2026-10-05', '2026-10-11', 'eia:2026-10-07');
    expect(event).toMatchObject({ dateUtc: '2026-10-07T14:30:00.000Z', impact: 'medio' });
  });

  it('FOMC del 28-10-2026: 14:00 ET → 18:00 UTC (EDT), origen oficial', () => {
    const event = findByClave('2026-10-26', '2026-11-01', 'fomc:2026-10-28');
    expect(event).toMatchObject({
      kind: 'fomc',
      dateUtc: '2026-10-28T18:00:00.000Z',
      impact: 'alto',
      origin: 'oficial',
    });
  });

  it('FOMC 2027 también está en la tabla oficial', () => {
    expect(findByClave('2027-01-01', '2027-01-31', 'fomc:2027-01-27')).toMatchObject({
      dateUtc: '2027-01-27T19:00:00.000Z',
      origin: 'oficial',
    });
  });

  it('IPC, PCE y PIB publicados salen con origen oficial e impacto alto', () => {
    for (const [desde, hasta, clave] of [
      ['2026-10-01', '2026-10-31', 'ipc:2026-10-14'],
      ['2026-10-01', '2026-10-31', 'pce:2026-10-29'],
      ['2026-10-01', '2026-10-31', 'pib:2026-10-29'],
    ] as const) {
      const event = findByClave(desde, hasta, clave);
      expect(event, clave).toMatchObject({ impact: 'alto', origin: 'oficial', country: 'US' });
    }
  });

  it('la reunión ministerial OPEP+ publicada gana a la regla mensual (dedupe)', () => {
    const events = generateCalendarEvents('2026-06-01', '2026-06-30');
    const opep = events.filter((e) => e.kind === 'opep');
    expect(opep).toHaveLength(1);
    expect(opep[0]).toMatchObject({
      clave: 'opep:2026-06-07',
      origin: 'oficial',
      title: 'Reunión ministerial OPEP+',
    });
  });

  it('estimaciones de 2027 salen con origen regla, no oficial', () => {
    const ipc = findByClave('2027-01-01', '2027-01-31', 'ipc:2027-01-13');
    expect(ipc).toMatchObject({ origin: 'regla', impact: 'alto' });
    const pib = findByClave('2027-01-01', '2027-01-31', 'pib:2027-01-28');
    expect(pib).toMatchObject({ origin: 'regla', impact: 'alto' });
  });

  it('devuelve los eventos ordenados por instante UTC', () => {
    const events = generateCalendarEvents('2026-10-01', '2026-10-31');
    const instants = events.map((e) => e.dateUtc);
    expect([...instants].sort()).toEqual(instants);
  });
});

describe('earningsToEvent (resultados de activos seguidos)', () => {
  it('BMO → apertura 9:30 ET, AMC → cierre 16:00 ET, con clave por activo', () => {
    const bmo = earningsToEvent(
      { symbol: 'aapl', date: '2026-10-22', session: 'bmo', epsEstimate: 1.6 },
      'finnhub',
    );
    expect(bmo).toMatchObject({
      clave: 'resultados:AAPL:2026-10-22',
      kind: 'resultados',
      dateUtc: '2026-10-22T13:30:00.000Z',
      impact: 'medio',
      asset: 'AAPL',
      origin: 'finnhub',
    });
    expect(bmo.title).toContain('AAPL');
    expect(bmo.title).toContain('antes de la apertura');
    expect(bmo.title).toContain('1.6');

    const amc = earningsToEvent(
      { symbol: 'MSFT', date: '2026-10-22', session: 'amc', epsEstimate: null },
      'finnhub',
    );
    expect(amc.dateUtc).toBe('2026-10-22T20:00:00.000Z');
    expect(amc.title).toContain('tras el cierre');
  });

  it('sesión desconocida cae a mediodía ET', () => {
    const event = earningsToEvent(
      { symbol: 'IBM', date: '2026-10-22', session: 'other', epsEstimate: null },
      'simulado',
    );
    expect(event.dateUtc).toBe('2026-10-22T16:00:00.000Z');
    expect(event.origin).toBe('simulado');
  });
});
