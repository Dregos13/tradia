import { describe, expect, it } from 'vitest';

import { EXCHANGE_SESSIONS, formatDuration, sessionState, zonedToUtc } from './sessions';

const byId = (id: string) => EXCHANGE_SESSIONS.find((s) => s.id === id)!;

describe('sesiones de las bolsas', () => {
  it('convierte la hora local de la bolsa a UTC respetando el horario de verano', () => {
    // 9:30 en Nueva York: 14:30 UTC en invierno, 13:30 UTC en verano.
    expect(new Date(zonedToUtc('2026-11-23', 570, 'America/New_York')).toISOString()).toBe(
      '2026-11-23T14:30:00.000Z',
    );
    expect(new Date(zonedToUtc('2026-07-01', 570, 'America/New_York')).toISOString()).toBe(
      '2026-07-01T13:30:00.000Z',
    );
  });

  it('lunes 23 nov 2026 a las 14:30 de Madrid: Londres abierta, Tokio cerrada, NY abre en 1 h', () => {
    const now = Date.parse('2026-11-23T13:30:00Z');
    const london = sessionState(byId('londres'), now);
    expect(london.open).toBe(true);
    expect(new Date(london.nextChange).toISOString()).toBe('2026-11-23T16:30:00.000Z');
    const tokyo = sessionState(byId('tokio'), now);
    expect(tokyo.open).toBe(false);
    // Martes 9:00 en Tokio = lunes 00:00 UTC.
    expect(new Date(tokyo.nextChange).toISOString()).toBe('2026-11-24T00:00:00.000Z');
    const ny = sessionState(byId('nueva-york'), now);
    expect(ny.open).toBe(false);
    expect(formatDuration(ny.nextChange - now)).toBe('1 h 0 min');
  });

  it('el fin de semana todas cerradas y Tokio abre el lunes', () => {
    const now = Date.parse('2026-11-21T12:00:00Z'); // sábado
    for (const session of EXCHANGE_SESSIONS) expect(sessionState(session, now).open).toBe(false);
    expect(new Date(sessionState(byId('tokio'), now).nextChange).toISOString()).toBe(
      '2026-11-23T00:00:00.000Z',
    );
  });
});
