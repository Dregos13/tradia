/**
 * Calendario de sesiones de NYSE y horario de la actualización diaria.
 *
 * Solo funciones puras. El cambio de horario se resuelve con `Intl` y las
 * zonas IANA America/New_York y Europe/Madrid, sin librerías nuevas, así la
 * hora de actualización en Madrid se mueve sola en las semanas en que EE. UU.
 * y Europa no cambian de horario el mismo día (mediados de marzo y finales de
 * octubre).
 *
 * Fechas: una fecha de sesión es el día civil en Nueva York, 'YYYY-MM-DD'.
 * Donde se pide un instante (`ahora`) vale un Date, milisegundos o una cadena
 * ISO; una cadena 'YYYY-MM-DD' sin hora se interpreta siempre como fecha de
 * sesión (Nueva York) —en funciones de instante equivale a las 00:00 de ese
 * día en Nueva York—, nunca como medianoche UTC.
 *
 * Festivos: calculados por reglas (verificados de 2021 a 2027, con el cierre
 * extraordinario del 09-01-2025 por el luto nacional de Jimmy Carter). Las
 * reglas se aplican también fuera de ese rango, pero los cierres
 * extraordinarios futuros no se pueden anticipar.
 */

export const NYSE_ZONE = 'America/New_York';
export const MADRID_ZONE = 'Europe/Madrid';

/** Años con festivos verificados contra el calendario oficial de NYSE. */
export const CALENDAR_MIN_YEAR = 2021;
export const CALENDAR_MAX_YEAR = 2027;

const OPEN_ET = { hour: 9, minute: 30 } as const;
const REGULAR_CLOSE_ET = { hour: 16, minute: 0 } as const;
const EARLY_CLOSE_ET = { hour: 13, minute: 0 } as const;

/** Margen tras el cierre regular (16:00 ET) para que el proveedor EOD publique. */
export const UPDATE_DELAY_MS = 75 * 60_000;

const DAY_MS = 86_400_000;
/** Tope de días hacia atrás/adelante buscando sesión (el hueco real máximo es ≈5 días). */
const MAX_SESSION_SEARCH_DAYS = 62;

export type InstantInput = Date | number | string;

/** Una sesión de negociación de NYSE, en un día civil de Nueva York. */
export interface MarketSession {
  /** Día civil en Nueva York, 'YYYY-MM-DD'. */
  date: string;
  /** Apertura (9:30 ET) como instante UTC, ISO 8601. */
  opensAtUtc: string;
  /** Cierre real (16:00 ET; 13:00 ET si `earlyClose`), instante UTC, ISO 8601. */
  closesAtUtc: string;
  /**
   * Instante de la actualización diaria programada: cierre regular de las
   * 16:00 ET más 75 minutos, también en sesiones de cierre anticipado.
   */
  updateAtUtc: string;
  /** true si la sesión cierra a las 13:00 ET (cierre anticipado). */
  earlyClose: boolean;
}

/** Resultado de `nextUpdateAt`. */
export interface NextUpdate {
  /** Instante de la próxima actualización en UTC, ISO 8601. */
  utc: string;
  /** El mismo instante en hora de Madrid, ISO 8601 con desplazamiento. */
  madrid: string;
  /** Sesión cuyo cierre programa la actualización. */
  session: MarketSession;
}

// --- Aritmética de fechas y zonas ------------------------------------------

const SESSION_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad2 = (n: number): string => String(n).padStart(2, '0');

function isoDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function sessionDateParts(date: string): { year: number; month: number; day: number } | null {
  const m = SESSION_DATE_RE.exec(date);
  if (!m) return null;
  const parts = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31) return null;
  return parts;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const zonedFormatters = new Map<string, Intl.DateTimeFormat>();

function zonedFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = zonedFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    zonedFormatters.set(zone, formatter);
  }
  return formatter;
}

/** Componentes de la hora civil de `instantMs` en `zone`. */
function zonedParts(instantMs: number, zone: string): ZonedParts {
  const parts = zonedFormatter(zone).formatToParts(new Date(instantMs));
  const num = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: num('year'),
    month: num('month'),
    day: num('day'),
    hour: num('hour'),
    minute: num('minute'),
    second: num('second'),
  };
}

/** Desfase en ms de `zone` respecto a UTC en `instantMs`. */
function zoneOffsetMs(instantMs: number, zone: string): number {
  const p = zonedParts(instantMs, zone);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    Math.floor(instantMs / 1_000) * 1_000
  );
}

/** Convierte una hora civil de `zone` al instante UTC en ms (refinado por si roza un cambio DST). */
export function zonedToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  zone: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let utc = guess - zoneOffsetMs(guess, zone);
  const retry = guess - zoneOffsetMs(utc, zone);
  if (retry !== utc) utc = retry;
  return utc;
}

/** Fecha de sesión (día civil en Nueva York) de un instante, 'YYYY-MM-DD'. */
export function nySessionDate(ahora: InstantInput): string {
  const p = zonedParts(toInstantMs(ahora), NYSE_ZONE);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Normaliza un instante; una cadena 'YYYY-MM-DD' equivale a las 00:00 de ese día en Nueva York. */
function toInstantMs(input: InstantInput): number {
  if (input instanceof Date) return input.getTime();
  if (typeof input === 'number') return input;
  const bare = sessionDateParts(input);
  if (bare) return zonedToUtcMs(bare.year, bare.month, bare.day, 0, 0, NYSE_ZONE);
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) throw new TypeError(`Instante no válido: ${input}`);
  return ms;
}

/** Normaliza a fecha de sesión: las cadenas 'YYYY-MM-DD' se toman tal cual y los instantes se reducen al día de Nueva York. */
function toSessionDate(input: InstantInput): string {
  if (typeof input === 'string' && sessionDateParts(input)) return input;
  return nySessionDate(input);
}

// --- Festivos y cierres anticipados de NYSE --------------------------------

/** Domingo de Pascua (algoritmo de Meeus) → [mes, día]. Sirve para el Viernes Santo. */
function easterSunday(year: number): [number, number] {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return [Math.floor(n / 31), (n % 31) + 1];
}

const dayOfWeekUtc = (year: number, month: number, day: number): number =>
  new Date(Date.UTC(year, month - 1, day)).getUTCDay();

/** Día del n-ésimo `weekday` (0 = domingo) del mes. */
function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number {
  const first = dayOfWeekUtc(year, month, 1);
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}

/** Día del último `weekday` del mes. */
function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return lastDay - ((dayOfWeekUtc(year, month, lastDay) - weekday + 7) % 7);
}

/** Fecha observada de un festivo de día fijo: sábado → viernes anterior, domingo → lunes siguiente. */
function observedFixed(year: number, month: number, day: number): string {
  const dow = dayOfWeekUtc(year, month, day);
  const shift = dow === 6 ? -1 : dow === 0 ? 1 : 0;
  return isoDay(Date.UTC(year, month - 1, day + shift));
}

/** Cierres extraordinarios que no salen de las reglas, dentro del rango soportado. */
const EXTRA_CLOSURES = new Set([
  '2025-01-09', // Día de luto nacional por Jimmy Carter.
]);

function holidaysOfYear(year: number): Set<string> {
  const set = new Set<string>();
  const add = (y: number, m: number, d: number): void => {
    set.add(isoDay(Date.UTC(y, m - 1, d)));
  };

  // Año Nuevo: si cae en domingo se traslada al lunes 2; si cae en sábado no se
  // traslada (la bolsa abre el 31 de diciembre, regla específica de NYSE).
  const newYearDow = dayOfWeekUtc(year, 1, 1);
  if (newYearDow === 0) add(year, 1, 2);
  else if (newYearDow !== 6) add(year, 1, 1);

  add(year, 1, nthWeekdayOfMonth(year, 1, 1, 3)); // Martin Luther King Jr.
  add(year, 2, nthWeekdayOfMonth(year, 2, 1, 3)); // Presidents' Day
  const [easterMonth, easterDay] = easterSunday(year);
  add(year, easterMonth, easterDay - 2); // Viernes Santo
  add(year, 5, lastWeekdayOfMonth(year, 5, 1)); // Memorial Day
  if (year >= 2022) set.add(observedFixed(year, 6, 19)); // Juneteenth (desde 2022)
  set.add(observedFixed(year, 7, 4)); // Independence Day
  add(year, 9, nthWeekdayOfMonth(year, 9, 1, 1)); // Labor Day
  add(year, 11, nthWeekdayOfMonth(year, 11, 4, 4)); // Acción de Gracias
  set.add(observedFixed(year, 12, 25)); // Navidad
  return set;
}

/** Sesiones con cierre anticipado (13:00 ET): día tras Acción de Gracias, 3 de julio y Nochebuena si caen en laborable y no son ya festivos. */
function earlyClosesOfYear(year: number, holidays: Set<string>): Set<string> {
  const set = new Set<string>();
  const addIfWeekday = (y: number, m: number, d: number): void => {
    const dow = dayOfWeekUtc(y, m, d);
    const date = isoDay(Date.UTC(y, m - 1, d));
    if (dow >= 1 && dow <= 5 && !holidays.has(date)) set.add(date);
  };

  addIfWeekday(year, 11, nthWeekdayOfMonth(year, 11, 4, 4) + 1); // Viernes negro
  addIfWeekday(year, 7, 3);
  addIfWeekday(year, 12, 24);
  return set;
}

interface YearCalendar {
  holidays: Set<string>;
  earlyCloses: Set<string>;
}

const yearCache = new Map<number, YearCalendar>();

function calendarOfYear(year: number): YearCalendar {
  let calendar = yearCache.get(year);
  if (!calendar) {
    const holidays = holidaysOfYear(year);
    for (const extra of EXTRA_CLOSURES) {
      if (Number(extra.slice(0, 4)) === year) holidays.add(extra);
    }
    calendar = { holidays, earlyCloses: earlyClosesOfYear(year, holidays) };
    yearCache.set(year, calendar);
  }
  return calendar;
}

// --- Sesiones --------------------------------------------------------------

function sessionForDate(date: string): MarketSession | null {
  const parsed = sessionDateParts(date);
  if (!parsed) return null;
  const { year, month, day } = parsed;
  const dow = dayOfWeekUtc(year, month, day);
  if (dow === 0 || dow === 6) return null;
  const calendar = calendarOfYear(year);
  if (calendar.holidays.has(date)) return null;
  const earlyClose = calendar.earlyCloses.has(date);
  const close = earlyClose ? EARLY_CLOSE_ET : REGULAR_CLOSE_ET;
  return {
    date,
    opensAtUtc: new Date(
      zonedToUtcMs(year, month, day, OPEN_ET.hour, OPEN_ET.minute, NYSE_ZONE),
    ).toISOString(),
    closesAtUtc: new Date(
      zonedToUtcMs(year, month, day, close.hour, close.minute, NYSE_ZONE),
    ).toISOString(),
    updateAtUtc: new Date(
      zonedToUtcMs(year, month, day, REGULAR_CLOSE_ET.hour, REGULAR_CLOSE_ET.minute, NYSE_ZONE) +
        UPDATE_DELAY_MS,
    ).toISOString(),
    earlyClose,
  };
}

/** Sesión del día civil de `fecha` en Nueva York, o null si no es día de negociación. */
export function getSession(fecha: InstantInput): MarketSession | null {
  return sessionForDate(toSessionDate(fecha));
}

/** true si el día civil de `fecha` en Nueva York es día de negociación (laborable y no festivo). */
export function isTradingDay(fecha: InstantInput): boolean {
  return sessionForDate(toSessionDate(fecha)) !== null;
}

/**
 * Última sesión cuyo cierre real ya ha ocurrido a las `ahora` (16:00 ET; 13:00
 * ET en cierres anticipados). Devuelve null si no hay ninguna en los
 * MAX_SESSION_SEARCH_DAYS días anteriores.
 */
export function lastExpectedSession(ahora: InstantInput): MarketSession | null {
  const nowMs = toInstantMs(ahora);
  const start = sessionDateParts(nySessionDate(nowMs))!;
  let dayMs = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i < MAX_SESSION_SEARCH_DAYS; i += 1, dayMs -= DAY_MS) {
    const session = sessionForDate(isoDay(dayMs));
    if (session && Date.parse(session.closesAtUtc) <= nowMs) return session;
  }
  return null;
}

/**
 * Próximo instante programado de actualización diaria: cierre regular de las
 * 16:00 ET más 75 minutos de la próxima sesión, devuelto en UTC y en hora de
 * Madrid. Si `ahora` ya pasó la hora programada de hoy (aunque sea por ms), se
 * considera ejecutada y devuelve la de la siguiente sesión; los cierres
 * perdidos se recuperan comparando con `lastExpectedSession`.
 */
export function nextUpdateAt(ahora: InstantInput): NextUpdate {
  const nowMs = toInstantMs(ahora);
  const start = sessionDateParts(nySessionDate(nowMs))!;
  let dayMs = Date.UTC(start.year, start.month - 1, start.day);
  for (let i = 0; i < MAX_SESSION_SEARCH_DAYS; i += 1, dayMs += DAY_MS) {
    const session = sessionForDate(isoDay(dayMs));
    if (!session) continue;
    const updateMs = Date.parse(session.updateAtUtc);
    if (updateMs >= nowMs) {
      return { utc: session.updateAtUtc, madrid: madridIso(updateMs), session };
    }
  }
  throw new RangeError(`No se encontró ninguna sesión tras ${nySessionDate(nowMs)}`);
}

/**
 * Sesiones con fecha entre `desde` y `hasta` (ambas inclusive, día civil de
 * Nueva York). Sirve para detectar huecos: las fechas devueltas son las que
 * deberían tener vela. Devuelve [] si `desde` es posterior a `hasta`.
 */
export function expectedSessionsBetween(desde: InstantInput, hasta: InstantInput): MarketSession[] {
  const from = sessionDateParts(toSessionDate(desde))!;
  const to = sessionDateParts(toSessionDate(hasta))!;
  let dayMs = Date.UTC(from.year, from.month - 1, from.day);
  const endMs = Date.UTC(to.year, to.month - 1, to.day);
  const sessions: MarketSession[] = [];
  for (; dayMs <= endMs; dayMs += DAY_MS) {
    const session = sessionForDate(isoDay(dayMs));
    if (session) sessions.push(session);
  }
  return sessions;
}

/** Instante en hora de Madrid como ISO 8601 con desplazamiento ('+01:00' / '+02:00'). */
function madridIso(instantMs: number): string {
  const p = zonedParts(instantMs, MADRID_ZONE);
  const offsetMin = Math.round(zoneOffsetMs(instantMs, MADRID_ZONE) / 60_000);
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${p.year}-${pad2(p.month)}-${pad2(p.day)}` +
    `T${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}
