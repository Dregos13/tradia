import { describe, expect, it } from 'vitest';

import {
  expectedSessionsBetween,
  getSession,
  isTradingDay,
  lastExpectedSession,
  nextUpdateAt,
  nySessionDate,
} from './calendar';

/**
 * Cierre regular 16:00 ET + 75 min = 17:15 ET de actualización diaria:
 *  - invierno (EST/UTC-5): 22:15 UTC → 23:15 en Madrid (CET/+01:00).
 *  - verano (EDT/UTC-4): 21:15 UTC → 23:15 en Madrid (CEST/+02:00).
 *  - semanas de desfase (EE. UU. en verano y España en invierno): 21:15 UTC
 *    → 22:15 en Madrid (CET/+01:00).
 */

describe('isTradingDay', () => {
  it('los días laborables normales son sesión', () => {
    expect(isTradingDay('2026-01-14')).toBe(true); // miércoles
    expect(isTradingDay('2026-06-10')).toBe(true);
    expect(isTradingDay('2026-11-27')).toBe(true); // viernes negro: sesión con cierre anticipado
  });

  it('los fines de semana no son sesión', () => {
    expect(isTradingDay('2026-01-17')).toBe(false); // sábado
    expect(isTradingDay('2026-01-18')).toBe(false); // domingo
  });

  it('los festivos de NYSE no son sesión', () => {
    expect(isTradingDay('2025-07-04')).toBe(false); // 4 de julio, viernes
    expect(isTradingDay('2026-11-26')).toBe(false); // Acción de Gracias
    expect(isTradingDay('2026-01-01')).toBe(false); // Año Nuevo
    expect(isTradingDay('2026-01-19')).toBe(false); // Martin Luther King Jr.
    expect(isTradingDay('2026-04-03')).toBe(false); // Viernes Santo
    expect(isTradingDay('2026-06-19')).toBe(false); // Juneteenth
    expect(isTradingDay('2026-12-25')).toBe(false); // Navidad
  });

  it('traslada los festivos que caen en fin de semana', () => {
    expect(isTradingDay('2026-07-03')).toBe(false); // viernes: 4 de julio cae en sábado
    expect(isTradingDay('2027-07-05')).toBe(false); // lunes: 4 de julio cae en domingo
    expect(isTradingDay('2027-06-18')).toBe(false); // viernes: Juneteenth cae en sábado
    expect(isTradingDay('2026-12-24')).toBe(true); // Nochebuena laborable sí hay sesión (anticipada)
    expect(isTradingDay('2027-12-24')).toBe(false); // viernes: Navidad cae en sábado
    expect(isTradingDay('2023-01-02')).toBe(false); // lunes: Año Nuevo cae en domingo
  });

  it('no traslada Año Nuevo cuando cae en sábado (NYSE abre el 31 de diciembre)', () => {
    expect(isTradingDay('2021-12-31')).toBe(true); // viernes: 1-1-2022 fue sábado
  });

  it('incluye el cierre extraordinario del luto por Jimmy Carter', () => {
    expect(isTradingDay('2025-01-09')).toBe(false);
  });

  it('una cadena YYYY-MM-DD se interpreta como día civil de Nueva York', () => {
    // Medianoche UTC del 17 sigue siendo el 16 (viernes) en Nueva York.
    expect(isTradingDay('2026-01-17')).toBe(false); // como fecha NY: sábado
    expect(isTradingDay(new Date('2026-01-17T03:00:00.000Z'))).toBe(true); // 22:00 ET del viernes
    expect(isTradingDay(new Date('2026-01-17T05:00:00.000Z'))).toBe(false); // 00:00 ET del sábado
  });
});

describe('getSession', () => {
  it('devuelve apertura y cierre en UTC de una sesión normal', () => {
    expect(getSession('2026-01-14')).toEqual({
      date: '2026-01-14',
      opensAtUtc: '2026-01-14T14:30:00.000Z', // 9:30 EST
      closesAtUtc: '2026-01-14T21:00:00.000Z', // 16:00 EST
      updateAtUtc: '2026-01-14T22:15:00.000Z', // 17:15 EST
      earlyClose: false,
    });
  });

  it('marca los cierres anticipados a las 13:00 ET', () => {
    const session = getSession('2026-11-27'); // viernes negro
    expect(session).toMatchObject({ earlyClose: true, closesAtUtc: '2026-11-27T18:00:00.000Z' });
    // La actualización sigue programada sobre el cierre regular de las 16:00 ET.
    expect(session?.updateAtUtc).toBe('2026-11-27T22:15:00.000Z');
    expect(getSession('2026-12-24')?.earlyClose).toBe(true);
    expect(getSession('2023-07-03')?.earlyClose).toBe(true);
  });

  it('devuelve null en festivos y fines de semana', () => {
    expect(getSession('2026-11-26')).toBeNull();
    expect(getSession('2026-01-17')).toBeNull();
  });
});

describe('nextUpdateAt', () => {
  it('un día normal de invierno actualiza a las 23:15 en Madrid', () => {
    const next = nextUpdateAt('2026-01-14T12:00:00.000Z'); // 07:00 ET, miércoles
    expect(next.utc).toBe('2026-01-14T22:15:00.000Z');
    expect(next.madrid).toBe('2026-01-14T23:15:00+01:00');
    expect(next.session.date).toBe('2026-01-14');
  });

  it('un día normal de verano también actualiza a las 23:15 en Madrid', () => {
    const next = nextUpdateAt('2026-06-10T12:00:00.000Z'); // 08:00 EDT, miércoles
    expect(next.utc).toBe('2026-06-10T21:15:00.000Z');
    expect(next.madrid).toBe('2026-06-10T23:15:00+02:00');
  });

  it('la semana de desfase de marzo de 2026 adelanta a las 22:15 en Madrid', () => {
    // EE. UU. en horario de verano desde el 8 de marzo; España, aún en invierno.
    const next = nextUpdateAt('2026-03-16T12:00:00.000Z'); // lunes
    expect(next.utc).toBe('2026-03-16T21:15:00.000Z');
    expect(next.madrid).toBe('2026-03-16T22:15:00+01:00');
  });

  it('la semana de desfase de marzo de 2027 adelanta a las 22:15 en Madrid', () => {
    // EE. UU. en verano desde el 14 de marzo de 2027; España cambia el 28.
    const next = nextUpdateAt('2027-03-15T12:00:00.000Z'); // lunes
    expect(next.utc).toBe('2027-03-15T21:15:00.000Z');
    expect(next.madrid).toBe('2027-03-15T22:15:00+01:00');
  });

  it('vuelve a las 23:15 cuando España entra en horario de verano', () => {
    // España cambia el domingo 29 de marzo de 2026.
    const next = nextUpdateAt('2026-03-30T12:00:00.000Z'); // lunes
    expect(next.utc).toBe('2026-03-30T21:15:00.000Z');
    expect(next.madrid).toBe('2026-03-30T23:15:00+02:00');
  });

  it('la semana de desfase de finales de octubre de 2026 adelanta a las 22:15 en Madrid', () => {
    // España vuelve a invierno el 25 de octubre; EE. UU. el 1 de noviembre.
    const next = nextUpdateAt('2026-10-28T12:00:00.000Z'); // miércoles
    expect(next.utc).toBe('2026-10-28T21:15:00.000Z');
    expect(next.madrid).toBe('2026-10-28T22:15:00+01:00');
  });

  it('vuelve a las 23:15 cuando EE. UU. vuelve a invierno', () => {
    const next = nextUpdateAt('2026-11-02T12:00:00.000Z'); // lunes, EE. UU. ya en EST
    expect(next.utc).toBe('2026-11-02T22:15:00.000Z');
    expect(next.madrid).toBe('2026-11-02T23:15:00+01:00');
  });

  it('salta fines de semana y festivos', () => {
    // Sábado por la mañana → próxima sesión el lunes.
    const weekend = nextUpdateAt('2026-06-13T12:00:00.000Z'); // sábado 8:00 ET
    expect(weekend.session.date).toBe('2026-06-15');
    expect(weekend.utc).toBe('2026-06-15T21:15:00.000Z');

    // Viernes 3 de julio de 2026 es festivo (observado) y el 4 es sábado → lunes 6.
    const july4 = nextUpdateAt('2026-07-03T23:00:00.000Z');
    expect(july4.session.date).toBe('2026-07-06');
    expect(july4.utc).toBe('2026-07-06T21:15:00.000Z');
    expect(july4.madrid).toBe('2026-07-06T23:15:00+02:00');

    // Tras la actualización del miércoles 25, el jueves 26 es Acción de Gracias
    // y el viernes 27 hay sesión con cierre anticipado.
    const thanksgiving = nextUpdateAt('2026-11-25T23:00:00.000Z');
    expect(thanksgiving.session).toMatchObject({ date: '2026-11-27', earlyClose: true });
    expect(thanksgiving.utc).toBe('2026-11-27T22:15:00.000Z');
  });

  it('en cierre anticipado la actualización se mantiene sobre el cierre regular', () => {
    // Viernes negro 2026: la sesión cierra a las 13:00 ET pero la descarga EOD
    // se programa sobre las 16:00 ET + 75 min.
    const next = nextUpdateAt('2026-11-27T19:00:00.000Z'); // 14:00 ET
    expect(next.utc).toBe('2026-11-27T22:15:00.000Z');
    expect(next.madrid).toBe('2026-11-27T23:15:00+01:00');
  });

  it('pasada la hora de hoy apunta a la siguiente sesión', () => {
    const next = nextUpdateAt('2026-01-14T22:16:00.000Z'); // un minuto después
    expect(next.session.date).toBe('2026-01-15');
    expect(next.utc).toBe('2026-01-15T22:15:00.000Z');
  });

  it('una cadena YYYY-MM-DD vale como instante (00:00 en Nueva York)', () => {
    const next = nextUpdateAt('2026-01-14');
    expect(next.utc).toBe('2026-01-14T22:15:00.000Z');
    expect(next.madrid).toBe('2026-01-14T23:15:00+01:00');
  });
});

describe('lastExpectedSession', () => {
  it('antes del cierre la última sesión esperada es la anterior', () => {
    // Miércoles 14, 15:59 ET: la sesión de hoy aún no ha cerrado.
    expect(lastExpectedSession('2026-01-14T20:59:00.000Z')?.date).toBe('2026-01-13');
    // Lunes 12, 08:00 ET: antes incluso de la apertura.
    expect(lastExpectedSession('2026-01-12T13:00:00.000Z')?.date).toBe('2026-01-09');
  });

  it('al llegar el cierre ya cuenta la sesión de hoy', () => {
    expect(lastExpectedSession('2026-01-14T21:00:00.000Z')?.date).toBe('2026-01-14'); // 16:00 ET
    expect(lastExpectedSession('2026-01-14T23:30:00.000Z')?.date).toBe('2026-01-14');
  });

  it('usa el cierre anticipado de las 13:00 ET en las sesiones cortas', () => {
    // Viernes negro: 12:59 ET todavía no espera la vela de hoy; a las 13:00 sí.
    expect(lastExpectedSession('2026-11-27T17:59:00.000Z')?.date).toBe('2026-11-25');
    expect(lastExpectedSession('2026-11-27T18:00:00.000Z')?.date).toBe('2026-11-27');
  });

  it('en festivos y fines de semana mira atrás hasta la última sesión', () => {
    expect(lastExpectedSession('2026-11-26T20:00:00.000Z')?.date).toBe('2026-11-25'); // Acción de Gracias
    expect(lastExpectedSession('2026-01-18T12:00:00.000Z')?.date).toBe('2026-01-16'); // domingo
    // Navidad en viernes festivo + fin de semana → jueves 24 (sesión anticipada).
    expect(lastExpectedSession('2026-12-27T12:00:00.000Z')?.date).toBe('2026-12-24');
  });
});

describe('expectedSessionsBetween', () => {
  it('lista solo días de negociación, extremos incluidos', () => {
    const sessions = expectedSessionsBetween('2026-11-23', '2026-11-29');
    expect(sessions.map((s) => s.date)).toEqual([
      '2026-11-23',
      '2026-11-24',
      '2026-11-25',
      // 26 festivo (Acción de Gracias), 27 sesión anticipada, 28-29 fin de semana.
      '2026-11-27',
    ]);
    expect(sessions.at(-1)?.earlyClose).toBe(true);
  });

  it('respeta los festivos trasladados alrededor de Navidad y Año Nuevo', () => {
    const sessions = expectedSessionsBetween('2021-12-23', '2022-01-03');
    expect(sessions.map((s) => s.date)).toEqual([
      '2021-12-23',
      // 24 festivo (Navidad observada), 25-26 fin de semana,
      '2021-12-27',
      '2021-12-28',
      '2021-12-29',
      '2021-12-30',
      '2021-12-31', // abierto: Año Nuevo 2022 cae en sábado y no se traslada
      // 1-2 de enero fin de semana,
      '2022-01-03',
    ]);
  });

  it('devuelve una sesión si el rango es un solo día de negociación', () => {
    const sessions = expectedSessionsBetween('2026-01-14', '2026-01-14');
    expect(sessions.map((s) => s.date)).toEqual(['2026-01-14']);
  });

  it('devuelve vacío en rangos sin sesión o invertidos', () => {
    expect(expectedSessionsBetween('2026-01-17', '2026-01-18')).toEqual([]); // fin de semana
    expect(expectedSessionsBetween('2026-01-15', '2026-01-14')).toEqual([]);
  });

  it('cubre varios años sin saltarse sesiones', () => {
    // Cinco años naturales ≈ 5*252 sesiones; comprueba que el recorrido es completo.
    const sessions = expectedSessionsBetween('2021-01-01', '2025-12-31');
    expect(sessions.length).toBeGreaterThan(1200);
    expect(sessions[0]?.date).toBe('2021-01-04'); // el 1 de enero de 2021 fue festivo
    expect(sessions.some((s) => s.date === '2025-01-09')).toBe(false); // luto Carter
    expect(sessions.at(-1)?.date).toBe('2025-12-31');
  });
});

describe('nySessionDate', () => {
  it('reduce un instante al día civil de Nueva York', () => {
    expect(nySessionDate('2026-01-14T21:30:00.000Z')).toBe('2026-01-14'); // 16:30 ET
    expect(nySessionDate('2026-01-14T04:00:00.000Z')).toBe('2026-01-13'); // 23:00 ET del día anterior
    expect(nySessionDate(new Date('2026-06-15T02:00:00.000Z'))).toBe('2026-06-14'); // 22:00 EDT
  });
});
