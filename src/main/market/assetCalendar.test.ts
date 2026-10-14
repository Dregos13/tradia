import { describe, expect, it } from 'vitest';

import {
  calendarForSymbol,
  expectedSessionDateFor,
  FX_SESSIONS_PER_YEAR,
  fxAssetCalendar,
  NYSE_SESSIONS_PER_YEAR,
  nyseAssetCalendar,
  previousSessionDateFor,
  sessionsPerYearFor,
  warmupCalendarFor,
} from './assetCalendar';

describe('calendario por activo', () => {
  it('un par de divisas sigue el 24/5 y una acción NYSE', () => {
    expect(calendarForSymbol('EURUSD')).toBe(fxAssetCalendar);
    expect(calendarForSymbol(' usdjpy ')).toBe(fxAssetCalendar);
    expect(calendarForSymbol('SPY')).toBe(nyseAssetCalendar);
    // Seis letras que no son un par admitido siguen siendo una acción.
    expect(calendarForSymbol('EURGBP')).toBe(nyseAssetCalendar);
  });

  it('el 4 de julio el par espera su vela y la acción se queda en el día 3', () => {
    // Sábado 5 de julio de 2025, 02:00 UTC.
    const now = Date.parse('2025-07-05T02:00:00.000Z');
    expect(expectedSessionDateFor('EURUSD', now)).toBe('2025-07-04');
    expect(expectedSessionDateFor('SPY', now)).toBe('2025-07-03');
  });

  it('la sesión anterior de una vela de lunes es el viernes en ambos calendarios', () => {
    expect(previousSessionDateFor('EURUSD', '2025-07-07')).toBe('2025-07-04');
    // NYSE cerró el viernes 4: su sesión anterior es el jueves 3.
    expect(previousSessionDateFor('SPY', '2025-07-07')).toBe('2025-07-03');
    expect(previousSessionDateFor('EURUSD', 'no-es-fecha')).toBeNull();
  });

  it('anualiza con 260 sesiones si hay algún par y con 252 si todo son acciones', () => {
    expect(FX_SESSIONS_PER_YEAR).toBe(260);
    expect(NYSE_SESSIONS_PER_YEAR).toBe(252);
    expect(sessionsPerYearFor(['SPY', 'QQQ'])).toBe(252);
    expect(sessionsPerYearFor(['EURUSD'])).toBe(260);
    expect(sessionsPerYearFor(['SPY', 'GBPUSD'])).toBe(260);
    expect(sessionsPerYearFor([])).toBe(252);
  });

  it('260 se acerca a las sesiones 24/5 reales de un año', () => {
    const sessions = fxAssetCalendar.expectedSessionsBetween('2025-01-01', '2025-12-31');
    expect(Math.abs(sessions.length - FX_SESSIONS_PER_YEAR)).toBeLessThanOrEqual(2);
    const nyse = nyseAssetCalendar.expectedSessionsBetween('2025-01-01', '2025-12-31');
    expect(Math.abs(nyse.length - NYSE_SESSIONS_PER_YEAR)).toBeLessThanOrEqual(2);
  });

  it('el calentamiento usa NYSE en cuanto hay una acción y el 24/5 si todo son pares', () => {
    expect(warmupCalendarFor(['EURUSD', 'GBPUSD'])).toBe(fxAssetCalendar);
    expect(warmupCalendarFor(['EURUSD', 'SPY'])).toBe(nyseAssetCalendar);
    expect(warmupCalendarFor([])).toBe(nyseAssetCalendar);
    expect(fxAssetCalendar.isSessionDay('2025-07-04')).toBe(true);
    expect(nyseAssetCalendar.isSessionDay('2025-07-04')).toBe(false);
    expect(fxAssetCalendar.isSessionDay('2025-07-05')).toBe(false);
  });
});
