/**
 * Sesiones de las bolsas principales para la Mesa: cuándo abren y cierran
 * en la hora local del usuario, cuál está abierta ahora y cuánto falta
 * para el próximo cambio.
 *
 * Horario regular en la hora de cada bolsa, de lunes a viernes. No tiene
 * en cuenta festivos ni la pausa de mediodía de Tokio: es una guía visual,
 * no el calendario de operación (ese vive en `main/market/calendar.ts`).
 */

export interface ExchangeSession {
  id: 'tokio' | 'londres' | 'nueva-york';
  name: string;
  city: string;
  timeZone: string;
  /** Apertura y cierre en minutos desde medianoche, hora de la bolsa. */
  openMin: number;
  closeMin: number;
  /** Activos de la Mesa más ligados a esta sesión. */
  focus: string;
}

export const EXCHANGE_SESSIONS: readonly ExchangeSession[] = [
  {
    id: 'tokio',
    name: 'Tokio',
    city: 'Tokio',
    timeZone: 'Asia/Tokyo',
    openMin: 9 * 60,
    closeMin: 15 * 60 + 30,
    focus: 'Japón, yen',
  },
  {
    id: 'londres',
    name: 'Londres',
    city: 'Londres',
    timeZone: 'Europe/London',
    openMin: 8 * 60,
    closeMin: 16 * 60 + 30,
    focus: 'Euro/dólar, oro, petróleo Brent',
  },
  {
    id: 'nueva-york',
    name: 'Nueva York',
    city: 'Nueva York',
    timeZone: 'America/New_York',
    openMin: 9 * 60 + 30,
    closeMin: 16 * 60,
    focus: 'S&P 500, Nasdaq, Nvidia, petróleo WTI',
  },
];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Fecha, día de la semana y minutos del día en una zona horaria. */
export function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    weekday,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/** Instante UTC de una hora local de una zona (fecha 'YYYY-MM-DD' + minutos). */
export function zonedToUtc(date: string, minutes: number, timeZone: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  // Desfase de la zona en ese instante (dos pasadas por si cruza un cambio de hora).
  let utc = guess;
  for (let i = 0; i < 2; i++) {
    const p = zonedParts(utc, timeZone);
    const [py, pm, pd] = p.date.split('-').map(Number) as [number, number, number];
    const shown = Date.UTC(py, pm - 1, pd, Math.floor(p.minutes / 60), p.minutes % 60);
    utc += guess - shown;
  }
  return utc;
}

export interface SessionWindow {
  start: number;
  end: number;
}

/** Ventanas (UTC ms) de una sesión que tocan el intervalo [from, to). */
export function sessionWindows(
  session: ExchangeSession,
  from: number,
  to: number,
): SessionWindow[] {
  const windows: SessionWindow[] = [];
  for (let t = from - DAY; t < to + DAY; t += DAY) {
    const { date, weekday } = zonedParts(t, session.timeZone);
    if (weekday === 0 || weekday === 6) continue;
    const start = zonedToUtc(date, session.openMin, session.timeZone);
    const end = zonedToUtc(date, session.closeMin, session.timeZone);
    if (end > from && start < to && !windows.some((w) => w.start === start)) {
      windows.push({ start, end });
    }
  }
  return windows.sort((a, b) => a.start - b.start);
}

export interface SessionState {
  session: ExchangeSession;
  open: boolean;
  /** Próximo cambio: cierre si está abierta, apertura si no (UTC ms). */
  nextChange: number;
}

export function sessionState(session: ExchangeSession, now: number): SessionState {
  const windows = sessionWindows(session, now - DAY, now + 5 * DAY);
  const current = windows.find((w) => w.start <= now && now < w.end);
  if (current) return { session, open: true, nextChange: current.end };
  const next = windows.find((w) => w.start > now);
  return { session, open: false, nextChange: next?.start ?? now };
}

/** «2 h 15 min», «45 min». */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / MINUTE));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h >= 24) return `${Math.floor(h / 24)} d ${h % 24} h`;
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}
