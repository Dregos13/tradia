import { describe, expect, it } from 'vitest';

import { generateCalendarEvents } from '../news/calendar/generate';
import {
  cautionCandidates,
  createCautionContextSource,
  evaluateCaution,
  type CautionContext,
  type CautionEvent,
} from './caution';

/**
 * Jueves 2026-10-15: sesión regular de NYSE con EE. UU. en verano (EDT,
 * UTC-4) — apertura 9:30 ET = 13:30 UTC, cierre 16:00 ET = 20:00 UTC.
 * Medias sesiones usadas abajo: 16:00 UTC = 12:00 ET.
 */
const MID_SESSION = '2026-10-15T16:00:00.000Z';

const ctx = (overrides: Partial<CautionContext> = {}): CautionContext => ({
  events: [],
  portfolioTickers: [],
  vix: null,
  ...overrides,
});

const ipc = (dateUtc: string): CautionEvent => ({
  kind: 'ipc',
  title: 'IPC de EE. UU. (CPI)',
  dateUtc,
  impact: 'alto',
});

const earnings = (asset: string, dateUtc: string): CautionEvent => ({
  kind: 'resultados',
  title: `Resultados de ${asset} (antes de la apertura)`,
  dateUtc,
  impact: 'medio',
  asset,
});

describe('evaluateCaution', () => {
  it('un día laborable sin eventos devuelve cautela inactiva', () => {
    expect(evaluateCaution(MID_SESSION, ctx())).toEqual({
      active: false,
      effect: 'ninguno',
      sizeFactor: 1,
      cause: null,
      eventTitle: null,
      until: null,
    });
  });

  it('bloquea un dato de alto impacto que llega 10 minutos más tarde', () => {
    const state = evaluateCaution(MID_SESSION, ctx({ events: [ipc('2026-10-15T16:10:00.000Z')] }));
    expect(state).toMatchObject({
      active: true,
      effect: 'bloquear',
      sizeFactor: 0,
      cause: 'alto-impacto',
      eventTitle: 'IPC de EE. UU. (CPI)',
      until: '2026-10-15T16:40:00.000Z',
    });
  });

  it('la ventana de ±30 minutos es inclusiva en el borde y se cierra fuera', () => {
    const upcoming = ipc('2026-10-15T16:30:00.000Z');
    expect(evaluateCaution(MID_SESSION, ctx({ events: [upcoming] })).cause).toBe('alto-impacto');
    expect(evaluateCaution('2026-10-15T15:59:00.000Z', ctx({ events: [upcoming] })).effect).toBe(
      'ninguno',
    );
    const past = ipc('2026-10-15T15:30:00.000Z');
    expect(evaluateCaution(MID_SESSION, ctx({ events: [past] })).effect).toBe('bloquear');
    expect(evaluateCaution('2026-10-15T16:00:01.000Z', ctx({ events: [past] })).effect).toBe(
      'ninguno',
    );
  });

  it('con varios datos de alto impacto informa del más cercano', () => {
    const context = ctx({
      events: [ipc('2026-10-15T16:05:00.000Z'), ipc('2026-10-15T15:25:00.000Z')],
    });
    const state = evaluateCaution(MID_SESSION, context);
    expect(state.cause).toBe('alto-impacto');
    expect(state.until).toBe('2026-10-15T16:35:00.000Z');
  });

  it('un evento de impacto medio o bajo no bloquea', () => {
    const pmi: CautionEvent = {
      kind: 'pmi',
      title: 'PMI manufacturero ISM de EE. UU.',
      dateUtc: '2026-10-15T16:10:00.000Z',
      impact: 'medio',
    };
    expect(evaluateCaution(MID_SESSION, ctx({ events: [pmi] })).effect).toBe('ninguno');
  });

  it('bloquea los primeros 15 minutos tras la apertura de NY', () => {
    const state = evaluateCaution('2026-10-15T13:35:00.000Z', ctx()); // apertura + 5 min
    expect(state).toMatchObject({
      active: true,
      effect: 'bloquear',
      cause: 'apertura',
      until: '2026-10-15T13:45:00.000Z',
    });
    expect(evaluateCaution('2026-10-15T13:29:00.000Z', ctx()).effect).toBe('ninguno');
    expect(evaluateCaution('2026-10-15T13:45:00.000Z', ctx()).effect).toBe('ninguno');
  });

  it('reduce el tamaño con VIX por encima de 30 y bloquea por encima de 40', () => {
    expect(evaluateCaution(MID_SESSION, ctx({ vix: 35 }))).toMatchObject({
      effect: 'reducir',
      cause: 'vix',
      sizeFactor: 0.5,
      eventTitle: 'VIX 35',
    });
    expect(evaluateCaution(MID_SESSION, ctx({ vix: 41 }))).toMatchObject({
      effect: 'bloquear',
      cause: 'vix',
      sizeFactor: 0,
    });
  });

  it('en los umbrales exactos no aplica: VIX 30 sin efecto y VIX 40 solo reduce', () => {
    expect(evaluateCaution(MID_SESSION, ctx({ vix: 30 })).effect).toBe('ninguno');
    expect(evaluateCaution(MID_SESSION, ctx({ vix: 40 })).effect).toBe('reducir');
    expect(evaluateCaution(MID_SESSION, ctx({ vix: null })).effect).toBe('ninguno');
  });

  it('bloquea en festivos de NYSE y en fin de semana', () => {
    // Acción de Gracias 2026-11-26 (jueves, sin sesión).
    expect(evaluateCaution('2026-11-26T17:00:00.000Z', ctx())).toMatchObject({
      effect: 'bloquear',
      cause: 'festivo',
      eventTitle: 'Festivo de NYSE (mercado cerrado)',
    });
    const weekend = evaluateCaution('2026-10-17T15:00:00.000Z', ctx()); // sábado
    expect(weekend).toMatchObject({ effect: 'bloquear', cause: 'festivo' });
    expect(weekend.eventTitle).toContain('Fin de semana');
  });

  it('reduce el tamaño en sesiones de cierre anticipado', () => {
    // Viernes negro 2026-11-27: sesión con cierre a las 13:00 ET.
    expect(evaluateCaution('2026-11-27T17:00:00.000Z', ctx())).toMatchObject({
      effect: 'reducir',
      cause: 'sesion-corta',
      sizeFactor: 0.5,
    });
  });

  it('reduce el tamaño el día del tercer viernes (vencimiento)', () => {
    // El evento real que genera el calendario económico para el tercer
    // viernes de octubre de 2026 (2026-10-16, a las 16:00 ET).
    const events = generateCalendarEvents('2026-10-16', '2026-10-16');
    expect(events.some((e) => e.kind === 'vencimiento')).toBe(true);
    expect(evaluateCaution('2026-10-16T16:00:00.000Z', ctx({ events }))).toMatchObject({
      effect: 'reducir',
      cause: 'vencimiento',
      sizeFactor: 0.5,
    });
  });

  it('bloquea entradas en un activo de cartera el día de sus resultados', () => {
    const context = ctx({
      events: [earnings('AAPL', '2026-10-15T13:30:00.000Z')],
      portfolioTickers: ['AAPL'],
    });
    expect(evaluateCaution(MID_SESSION, context, 'AAPL')).toMatchObject({
      effect: 'bloquear',
      cause: 'resultados',
      eventTitle: 'Resultados de AAPL (antes de la apertura)',
    });
    // Otra señal sobre un activo que no publica hoy no se ve afectada.
    expect(evaluateCaution(MID_SESSION, context, 'MSFT').effect).toBe('ninguno');
  });

  it('no bloquea resultados de un activo que no está en cartera', () => {
    const context = ctx({
      events: [earnings('AAPL', '2026-10-15T13:30:00.000Z')],
      portfolioTickers: [],
    });
    expect(evaluateCaution(MID_SESSION, context, 'AAPL').effect).toBe('ninguno');
  });

  it('en la vista global informa de resultados de cualquier activo de cartera', () => {
    const context = ctx({
      events: [earnings('AAPL', '2026-10-15T13:30:00.000Z')],
      portfolioTickers: ['aapl'],
    });
    expect(evaluateCaution(MID_SESSION, context)).toMatchObject({
      effect: 'bloquear',
      cause: 'resultados',
    });
  });

  it('los resultados de otro día de sesión no aplican', () => {
    const context = ctx({
      events: [earnings('AAPL', '2026-10-16T13:30:00.000Z')],
      portfolioTickers: ['AAPL'],
    });
    expect(evaluateCaution(MID_SESSION, context, 'AAPL').effect).toBe('ninguno');
  });

  it('cuando varias causas bloquean informa del evento con nombre', () => {
    // Apertura +5 min e IPC a los 10 minutos de abrir: gana 'alto-impacto'.
    const context = ctx({ events: [ipc('2026-10-15T13:40:00.000Z')] });
    const state = evaluateCaution('2026-10-15T13:35:00.000Z', context);
    expect(state.cause).toBe('alto-impacto');
    expect(state.eventTitle).toContain('IPC');
  });

  it('el bloqueo gana a la reducción cuando coinciden', () => {
    // Tercer viernes con VIX 45: reduce por vencimiento, bloquea por VIX.
    const events = generateCalendarEvents('2026-10-16', '2026-10-16');
    const state = evaluateCaution('2026-10-16T16:00:00.000Z', ctx({ events, vix: 45 }));
    expect(state).toMatchObject({ effect: 'bloquear', cause: 'vix' });
  });

  it('resuelve la apertura en hora de Madrid en semanas de desfase de horario', () => {
    // Semana de desfase de marzo de 2026: EE. UU. ya en verano (EDT,
    // UTC-4) y España aún en invierno (CET, UTC+1) — solo 5 h entre
    // Madrid y Nueva York. La apertura 9:30 ET son las 14:30 en Madrid.
    expect(evaluateCaution('2026-03-16T14:35:00+01:00', ctx()).cause).toBe('apertura');
    // A las 15:35 de Madrid ese día ya son las 10:35 ET: fuera de la ventana.
    expect(evaluateCaution('2026-03-16T15:35:00+01:00', ctx()).effect).toBe('ninguno');
    // En enero (horario alineado) las 15:35 de Madrid sí son las 9:35 ET.
    expect(evaluateCaution('2026-01-14T15:35:00+01:00', ctx()).cause).toBe('apertura');
    // Y en la semana de desfase de octubre (Europa ya en invierno,
    // EE. UU. aún en verano) la apertura también cae a las 14:30.
    expect(evaluateCaution('2026-10-26T14:35:00+01:00', ctx()).cause).toBe('apertura');
  });

  it('una fecha sin hora se interpreta como día civil de Nueva York', () => {
    expect(evaluateCaution('2026-11-26', ctx()).cause).toBe('festivo');
    // El mismo día laborable a las 00:00 ET está antes de la apertura: sin efecto.
    expect(evaluateCaution('2026-10-15', ctx()).effect).toBe('ninguno');
  });
});

describe('cautionCandidates', () => {
  it('devuelve todas las causas que aplican para el «+n causas» del banner', () => {
    // Tercer viernes con VIX alto: reducen vencimiento y vix.
    const events = generateCalendarEvents('2026-10-16', '2026-10-16');
    const candidates = cautionCandidates('2026-10-16T16:00:00.000Z', ctx({ events, vix: 35 }));
    expect(candidates.map((c) => c.cause).sort()).toEqual(['vencimiento', 'vix']);
  });
});

describe('createCautionContextSource', () => {
  it('reúne el contexto de las fuentes inyectadas (día UTC ± 1)', () => {
    const calls: Array<[string, string]> = [];
    const source = createCautionContextSource({
      listEvents: (desde, hasta) => {
        calls.push([desde, hasta]);
        return [ipc('2026-10-15T16:10:00.000Z')];
      },
      getPortfolioTickers: () => ['AAPL'],
      getVix: () => 35,
    });
    const context = source.context(Date.parse(MID_SESSION));
    expect(calls).toEqual([['2026-10-14', '2026-10-16']]);
    expect(context.events).toHaveLength(1);
    expect(context.portfolioTickers).toEqual(['AAPL']);
    expect(context.vix).toBe(35);
  });

  it('los eventos simulados se evalúan con los reales y se pueden purgar', () => {
    const source = createCautionContextSource({ listEvents: () => [] });
    source.addSimulatedEvent({ ...ipc('2026-10-15T16:10:00.000Z') });
    expect(source.evaluate(MID_SESSION)).toMatchObject({
      effect: 'bloquear',
      cause: 'alto-impacto',
      eventTitle: 'IPC de EE. UU. (CPI)',
    });
    source.clearSimulatedEvents();
    expect(source.evaluate(MID_SESSION).effect).toBe('ninguno');
  });

  it('sin las fuentes opcionales el contexto queda vacío', () => {
    const source = createCautionContextSource({ listEvents: () => [] });
    const context = source.context(Date.parse(MID_SESSION));
    expect(context.portfolioTickers).toEqual([]);
    expect(context.vix).toBeNull();
    expect(source.evaluate(MID_SESSION).effect).toBe('ninguno');
  });
});
