/**
 * Reglas de fecha del calendario económico — Fase 1b.
 *
 * Funciones puras que convierten las reglas de publicación de cada
 * organismo en fechas civiles con su hora (siempre hora oficial de
 * America/New_York salvo OPEP, que anuncia desde Viena). La conversión a
 * UTC la hace el generador con `zonedToUtcMs` del calendario de mercado.
 *
 * - NFP: primer viernes del mes, 8:30 ET, con las dos excepciones
 *   documentadas del BLS — un primer viernes festivo de enero se mueve al
 *   segundo (igual que enero de 2027 por Año Nuevo) y el de julio al
 *   jueves anterior cuando el 4 de julio se observa en viernes (igual que
 *   julio de 2026). Las fechas ya publicadas por el BLS salen de
 *   `NFP_PUBLISHED` con marca `official`.
 * - EIA: informe semanal los miércoles a las 10:30 ET; si hay un festivo
 *   federal de EE. UU. entre lunes y miércoles de esa semana se mueve al
 *   jueves a las 12:00 ET (regla publicada por la EIA: Acción de Gracias
 *   en jueves NO lo mueve, un lunes festivo sí). Los festivos son los
 *   federales, no los de NYSE: Columbus Day y Veterans Day también
 *   retrasan el informe aunque la bolsa abra.
 * - ISM/PMI: manufacturero el primer día de negociación del mes y
 *   servicios el tercero, a las 10:00 ET.
 * - Vencimientos: tercer viernes del mes (al cierre, 16:00 ET); si no es
 *   día de negociación se traslada al día de negociación anterior (p. ej.
 *   Viernes Santo). En marzo, junio, septiembre y diciembre es el triple
 *   vencimiento («triple witching») y se marca a la apertura, 9:30 ET.
 * - Estimaciones por regla para los años sin calendario publicado (el
 *   BLS y el BEA solo publican el año en curso): IPC el segundo miércoles
 *   del mes, PCE el último día laborable y PIB avanzada el último jueves
 *   del mes siguiente al trimestre. Salen con marca `official: false`.
 * - OPEP: revisión mensual del grupo de ajustes voluntarios el primer
 *   domingo de mes (patrón seguido durante 2025-2026), 12:00 Viena.
 */
import { isTradingDay } from '../../market/calendar';
import { NFP_PUBLISHED } from './tables';

/** Fecha civil más hora oficial en la zona del organismo. */
export interface ScheduledRelease {
  /** Día civil 'YYYY-MM-DD'. */
  date: string;
  hour: number;
  minute: number;
  /** Zona IANA de la hora oficial ('America/New_York', 'Europe/Vienna'). */
  zone: string;
  title: string;
  /** true si la fecha sale de una tabla publicada, no de la regla. */
  official: boolean;
}

const DAY_MS = 86_400_000;
const NY_ZONE = 'America/New_York';
const VIENNA_ZONE = 'Europe/Vienna';

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' del día civil UTC `ms` después de `date`. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Día de la semana (0 = domingo) de una fecha civil 'YYYY-MM-DD'. */
export function dayOfWeek(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

const isWeekday = (date: string): boolean => {
  const dow = dayOfWeek(date);
  return dow >= 1 && dow <= 5;
};

const monthKey = (year: number, month: number): string => `${year}-${pad2(month)}`;

/** 'YYYY-MM-DD' del n-ésimo `weekday` (0 = domingo) del mes. */
export function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
  return `${monthKey(year, month)}-${pad2(day)}`;
}

/** 'YYYY-MM-DD' del último `weekday` del mes. */
export function lastWeekdayOfMonth(year: number, month: number, weekday: number): string {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return `${monthKey(year, month)}-${pad2(lastDay - ((last - weekday + 7) % 7))}`;
}

// ---------------------------------------------------------------------------
// Festivos federales de EE. UU. (los que usa la EIA, distintos de los de NYSE)
// ---------------------------------------------------------------------------

/** Festivo fijo observado: sábado → viernes anterior, domingo → lunes siguiente. */
function observedFixed(year: number, month: number, day: number): string {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addDays(`${monthKey(year, month)}-${pad2(day)}`, dow === 6 ? -1 : dow === 0 ? 1 : 0);
}

const federalCache = new Map<number, Set<string>>();

/** Festivos federales observados del año (cierre de las agencias federales). */
function federalHolidaysOfYear(year: number): Set<string> {
  let set = federalCache.get(year);
  if (set) return set;
  set = new Set<string>([
    observedFixed(year, 1, 1), // Año Nuevo
    nthWeekdayOfMonth(year, 1, 1, 3), // Martin Luther King Jr.
    nthWeekdayOfMonth(year, 2, 1, 3), // Presidents' Day
    lastWeekdayOfMonth(year, 5, 1), // Memorial Day
    observedFixed(year, 6, 19), // Juneteenth
    observedFixed(year, 7, 4), // Independence Day
    nthWeekdayOfMonth(year, 9, 1, 1), // Labor Day
    nthWeekdayOfMonth(year, 10, 1, 2), // Columbus Day
    observedFixed(year, 11, 11), // Veterans Day
    nthWeekdayOfMonth(year, 11, 4, 4), // Acción de Gracias
    observedFixed(year, 12, 25), // Navidad
  ]);
  // Si el 1 de enero del año siguiente cae en sábado, se observa el 31 de
  // diciembre de ESTE año (el festivo pertenece a este año civil).
  if (new Date(Date.UTC(year + 1, 0, 1)).getUTCDay() === 6) {
    set.add(`${year}-12-31`);
  }
  federalCache.set(year, set);
  return set;
}

/** true si la fecha civil es festivo federal de EE. UU. (observado). */
export function isUsFederalHoliday(date: string): boolean {
  return federalHolidaysOfYear(Number(date.slice(0, 4))).has(date);
}

// ---------------------------------------------------------------------------
// Iteración del rango
// ---------------------------------------------------------------------------

/** Meses ('YYYY-MM') que tocan el rango [desde, hasta], inclusive. */
function monthsInRange(desde: string, hasta: string): Array<{ year: number; month: number }> {
  const months: Array<{ year: number; month: number }> = [];
  let year = Number(desde.slice(0, 4));
  let month = Number(desde.slice(5, 7));
  const endYear = Number(hasta.slice(0, 4));
  const endMonth = Number(hasta.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    months.push({ year, month });
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

/** Lunes de las semanas que tocan el rango [desde, hasta], inclusive. */
function mondaysInRange(desde: string, hasta: string): string[] {
  // Lunes de la semana de `desde`: resta (dow + 6) % 7 días.
  let monday = addDays(desde, -((dayOfWeek(desde) + 6) % 7));
  const mondays: string[] = [];
  while (monday <= hasta) {
    mondays.push(monday);
    monday = addDays(monday, 7);
  }
  return mondays;
}

// ---------------------------------------------------------------------------
// NFP (Employment Situation, BLS)
// ---------------------------------------------------------------------------

/**
 * NFP de cada mes del rango. Con fecha publicada por el BLS (tabla 2026)
 * sale `official`; si no, primer viernes con la excepción documentada:
 * primer viernes festivo → jueves anterior en julio (4 de julio observado
 * en viernes), segundo viernes en cualquier otro caso (Año Nuevo 2027).
 */
export function nfpReleases(desde: string, hasta: string): ScheduledRelease[] {
  const releases: ScheduledRelease[] = [];
  for (const { year, month } of monthsInRange(desde, hasta)) {
    const published = NFP_PUBLISHED[monthKey(year, month)];
    let date: string;
    if (published) {
      date = published;
    } else {
      date = nthWeekdayOfMonth(year, month, 5, 1);
      if (isUsFederalHoliday(date)) {
        date = month === 7 ? addDays(date, -1) : addDays(date, 7);
      }
    }
    if (date < desde || date > hasta) continue;
    releases.push({
      date,
      hour: 8,
      minute: 30,
      zone: NY_ZONE,
      title: 'Nóminas no agrícolas de EE. UU. (NFP)',
      official: published !== undefined,
    });
  }
  return releases;
}

// ---------------------------------------------------------------------------
// EIA (Weekly Petroleum Status Report)
// ---------------------------------------------------------------------------

/**
 * Informe semanal de la EIA por cada semana del rango. Miércoles 10:30 ET
 * salvo que un festivo federal caiga de lunes a miércoles: entonces jueves
 * 12:00 ET (y viernes si el jueves también es festivo federal).
 */
export function eiaReleases(desde: string, hasta: string): ScheduledRelease[] {
  const releases: ScheduledRelease[] = [];
  for (const monday of mondaysInRange(desde, hasta)) {
    const wednesday = addDays(monday, 2);
    const holidayBeforeRelease = [monday, addDays(monday, 1), wednesday].some(isUsFederalHoliday);
    let date = wednesday;
    let hour = 10;
    let minute = 30;
    if (holidayBeforeRelease) {
      date = addDays(monday, 3);
      if (isUsFederalHoliday(date)) date = addDays(monday, 4);
      hour = 12;
      minute = 0;
    }
    if (date < desde || date > hasta) continue;
    releases.push({
      date,
      hour,
      minute,
      zone: NY_ZONE,
      title: 'Inventarios semanales de petróleo (EIA)',
      official: false,
    });
  }
  return releases;
}

// ---------------------------------------------------------------------------
// ISM/PMI
// ---------------------------------------------------------------------------

/** Días de negociación del mes según el calendario de sesiones NYSE. */
function tradingDaysOfMonth(year: number, month: number): string[] {
  const days: string[] = [];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  for (let day = 1; day <= lastDay; day += 1) {
    const date = `${monthKey(year, month)}-${pad2(day)}`;
    if (isTradingDay(date)) days.push(date);
  }
  return days;
}

/**
 * PMI manufacturero (1.er día de negociación) y de servicios (3.er) del
 * ISM, a las 10:00 ET. Se usa el calendario NYSE: el ISM publica en día
 * de negociación bursátil.
 */
export function ismReleases(desde: string, hasta: string): ScheduledRelease[] {
  const releases: ScheduledRelease[] = [];
  for (const { year, month } of monthsInRange(desde, hasta)) {
    const days = tradingDaysOfMonth(year, month);
    const slots: Array<[date: string | undefined, title: string]> = [
      [days[0], 'PMI manufacturero ISM de EE. UU.'],
      [days[2], 'PMI de servicios ISM de EE. UU.'],
    ];
    for (const [date, title] of slots) {
      if (!date || date < desde || date > hasta) continue;
      releases.push({ date, hour: 10, minute: 0, zone: NY_ZONE, title, official: false });
    }
  }
  return releases;
}

// ---------------------------------------------------------------------------
// Vencimientos de derivados
// ---------------------------------------------------------------------------

const TRIPLE_WITCHING_MONTHS = new Set([3, 6, 9, 12]);

/**
 * Vencimiento mensual de opciones: tercer viernes al cierre (16:00 ET), o
 * el día de negociación anterior si el viernes no lo es (Viernes Santo).
 * En marzo, junio, septiembre y diciembre es el triple vencimiento y se
 * marca a la apertura (9:30 ET).
 */
export function expirationReleases(desde: string, hasta: string): ScheduledRelease[] {
  const releases: ScheduledRelease[] = [];
  for (const { year, month } of monthsInRange(desde, hasta)) {
    let date = nthWeekdayOfMonth(year, month, 5, 3);
    while (!isTradingDay(date)) date = addDays(date, -1);
    if (date < desde || date > hasta) continue;
    const triple = TRIPLE_WITCHING_MONTHS.has(month);
    releases.push({
      date,
      hour: triple ? 9 : 16,
      minute: triple ? 30 : 0,
      zone: NY_ZONE,
      title: triple
        ? 'Vencimiento triple de derivados (triple witching)'
        : 'Vencimiento mensual de opciones',
      official: false,
    });
  }
  return releases;
}

// ---------------------------------------------------------------------------
// Estimaciones por regla para años sin calendario publicado
// ---------------------------------------------------------------------------

/**
 * IPC estimado cuando el BLS aún no publicó su calendario (2027+): segundo
 * miércoles del mes a las 8:30 ET, marcado `official: false`. Los meses
 * con fecha publicada no entran aquí (los filtra el generador).
 */
export function cpiEstimateReleases(
  desde: string,
  hasta: string,
  coveredMonths: ReadonlySet<string>,
): ScheduledRelease[] {
  const releases: ScheduledRelease[] = [];
  for (const { year, month } of monthsInRange(desde, hasta)) {
    if (coveredMonths.has(monthKey(year, month))) continue;
    const date = nthWeekdayOfMonth(year, month, 3, 2);
    if (date < desde || date > hasta) continue;
    releases.push({
      date,
      hour: 8,
      minute: 30,
      zone: NY_ZONE,
      title: 'IPC de EE. UU. (CPI, fecha estimada)',
      official: false,
    });
  }
  return releases;
}

/** PCE estimado para meses sin fecha BEA: último día laborable, 8:30 ET. */
export function pceEstimateReleases(
  desde: string,
  hasta: string,
  coveredMonths: ReadonlySet<string>,
): ScheduledRelease[] {
  const releases: ScheduledRelease[] = [];
  for (const { year, month } of monthsInRange(desde, hasta)) {
    if (coveredMonths.has(monthKey(year, month))) continue;
    let date = `${monthKey(year, month)}-${pad2(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
    while (!isWeekday(date)) date = addDays(date, -1);
    if (date < desde || date > hasta) continue;
    releases.push({
      date,
      hour: 8,
      minute: 30,
      zone: NY_ZONE,
      title: 'PCE de EE. UU. (fecha estimada)',
      official: false,
    });
  }
  return releases;
}

/** Meses con estimación avanzada de PIB (los siguientes a cada trimestre). */
const GDP_ADVANCE_MONTHS = new Set([1, 4, 7, 10]);
const QUARTER_OF_ADVANCE_MONTH: Record<number, string> = {
  1: 'T4',
  4: 'T1',
  7: 'T2',
  10: 'T3',
};

/**
 * PIB avanzado estimado para trimestres sin fecha BEA: último jueves del
 * mes siguiente al cierre del trimestre (enero, abril, julio y octubre),
 * 8:30 ET. Solo la avanzada: es la lectura de mayor impacto.
 */
export function gdpEstimateReleases(
  desde: string,
  hasta: string,
  coveredMonths: ReadonlySet<string>,
): ScheduledRelease[] {
  const releases: ScheduledRelease[] = [];
  for (const { year, month } of monthsInRange(desde, hasta)) {
    if (!GDP_ADVANCE_MONTHS.has(month) || coveredMonths.has(monthKey(year, month))) continue;
    const date = lastWeekdayOfMonth(year, month, 4);
    if (date < desde || date > hasta) continue;
    const quarter = QUARTER_OF_ADVANCE_MONTH[month];
    const refYear = month === 1 ? year - 1 : year;
    releases.push({
      date,
      hour: 8,
      minute: 30,
      zone: NY_ZONE,
      title: `PIB de EE. UU. (estimación avanzada estimada, ${quarter} ${refYear})`,
      official: false,
    });
  }
  return releases;
}

// ---------------------------------------------------------------------------
// OPEP
// ---------------------------------------------------------------------------

/**
 * Revisión mensual del grupo OPEP+ de ajustes voluntarios: primer domingo
 * de mes a las 12:00 de Viena (patrón seguido en 2025-2026). Las reuniones
 * ministeriales anunciadas están en la tabla oficial y deduplican por clave.
 */
export function opecReleases(desde: string, hasta: string): ScheduledRelease[] {
  const releases: ScheduledRelease[] = [];
  for (const { year, month } of monthsInRange(desde, hasta)) {
    const date = nthWeekdayOfMonth(year, month, 0, 1);
    if (date < desde || date > hasta) continue;
    releases.push({
      date,
      hour: 12,
      minute: 0,
      zone: VIENNA_ZONE,
      title: 'Reunión mensual OPEP+',
      official: false,
    });
  }
  return releases;
}
