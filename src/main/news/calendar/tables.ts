/**
 * Fechas verificadas del calendario económico — Fase 1b.
 *
 * Tablas con las fechas publicadas por cada organismo, comprobadas contra
 * sus calendarios oficiales en octubre de 2026:
 *
 * - FOMC: calendario de reuniones de la Reserva Federal
 *   (federalreserve.gov/monetarypolicy/fomccalendars.htm). El evento es el
 *   comunicado del segundo día de cada reunión, a las 14:00 ET. Cubre todo
 *   2026 y todo 2027 (el calendario 2027 es tentativo hasta la reunión
 *   previa, como advierte la propia Fed).
 * - IPC (CPI): «Schedule of Releases for the Consumer Price Index» del
 *   BLS, siempre a las 8:30 ET. Publicado solo para 2026; fuera de la
 *   tabla el generador estima por regla (marcado 'regla', no 'oficial').
 * - PCE y PIB (GDP): «Release Schedule» del BEA, a las 8:30 ET salvo la
 *   entrega combinada de enero (10:00 ET). Solo 2026; el calendario 2027
 *   del BEA aún no está publicado y se estima por regla.
 * - OPEP: reuniones ministeriales anunciadas en opec.org (41.ª el
 *   07-06-2026 y 42.ª el 29-11-2026); el resto de revisiones mensuales del
 *   grupo de ajustes voluntarios cae el primer domingo de mes por regla.
 * - NFP (Employment Situation): el BLS publica el primer viernes a las
 *   8:30 ET salvo excepción. `NFP_OVERRIDES` recoge los movimientos ya
 *   confirmados por el BLS para 2026 (enero y febrero arrastrados por el
 *   calendario atípico, mayo adelantado y julio al jueves por el festivo
 *   del 4 de julio observado el viernes 3).
 *
 * Cada entrada es [día civil ET 'YYYY-MM-DD', hora, minuto]; la hora es la
 * oficial de publicación en zona America/New_York y se convierte a UTC con
 * `zonedToUtcMs` al generar el evento.
 */
import type { CalendarEventKind } from '../../../shared/ipc';

/** [fecha 'YYYY-MM-DD', hora ET, minuto ET]. */
export type OfficialRelease = readonly [date: string, hour: number, minute: number];

export interface OfficialTable {
  kind: CalendarEventKind;
  /** País o área ('US'); null en eventos globales (OPEP). */
  country: string | null;
  /** Título por fecha; si falta, se usa `defaultTitle`. */
  titles?: Record<string, string>;
  defaultTitle: string;
  dates: readonly OfficialRelease[];
}

/** Comunicado del FOMC (2.º día de cada reunión), 14:00 ET. Fed, 2026-2027. */
const FOMC: OfficialTable = {
  kind: 'fomc',
  country: 'US',
  defaultTitle: 'Decisión de tipos del FOMC (Fed)',
  dates: [
    ['2026-01-28', 14, 0],
    ['2026-03-18', 14, 0],
    ['2026-04-29', 14, 0],
    ['2026-06-17', 14, 0],
    ['2026-07-29', 14, 0],
    ['2026-09-16', 14, 0],
    ['2026-10-28', 14, 0],
    ['2026-12-09', 14, 0],
    ['2027-01-27', 14, 0],
    ['2027-03-17', 14, 0],
    ['2027-04-28', 14, 0],
    ['2027-06-09', 14, 0],
    ['2027-07-28', 14, 0],
    ['2027-09-15', 14, 0],
    ['2027-10-27', 14, 0],
    ['2027-12-08', 14, 0],
  ],
};

/** IPC (CPI) del BLS, 8:30 ET. Calendario BLS publicado para 2026. */
const IPC: OfficialTable = {
  kind: 'ipc',
  country: 'US',
  defaultTitle: 'IPC de EE. UU. (CPI)',
  dates: [
    ['2026-01-13', 8, 30],
    ['2026-02-13', 8, 30],
    ['2026-03-11', 8, 30],
    ['2026-04-10', 8, 30],
    ['2026-05-12', 8, 30],
    ['2026-06-10', 8, 30],
    ['2026-07-14', 8, 30],
    ['2026-08-12', 8, 30],
    ['2026-09-11', 8, 30],
    ['2026-10-14', 8, 30],
    ['2026-11-10', 8, 30],
    ['2026-12-10', 8, 30],
  ],
};

/**
 * «Personal Income and Outlays» del BEA (deflactor PCE), 8:30 ET. La
 * entrega de enero combina octubre y noviembre de 2025 y salió a las
 * 10:00 ET. Solo 2026; 2027 se estima por regla.
 */
const PCE: OfficialTable = {
  kind: 'pce',
  country: 'US',
  defaultTitle: 'PCE de EE. UU. (ingresos y gasto personal)',
  titles: {
    '2026-01-22': 'PCE de EE. UU. (octubre y noviembre 2025)',
  },
  dates: [
    ['2026-01-22', 10, 0],
    ['2026-02-20', 8, 30],
    ['2026-03-13', 8, 30],
    ['2026-04-09', 8, 30],
    ['2026-04-30', 8, 30],
    ['2026-05-28', 8, 30],
    ['2026-06-25', 8, 30],
    ['2026-07-30', 8, 30],
    ['2026-08-26', 8, 30],
    ['2026-09-30', 8, 30],
    ['2026-10-29', 8, 30],
    ['2026-11-25', 8, 30],
    ['2026-12-23', 8, 30],
  ],
};

/** Publicaciones de PIB del BEA, 8:30 ET (advance/second/third + revisión). */
const PIB: OfficialTable = {
  kind: 'pib',
  country: 'US',
  defaultTitle: 'PIB de EE. UU.',
  titles: {
    '2026-01-22': 'PIB de EE. UU. (estimación revisada, T3 2025)',
    '2026-02-20': 'PIB de EE. UU. (estimación avanzada, T4 2025)',
    '2026-03-13': 'PIB de EE. UU. (segunda estimación, T4 2025)',
    '2026-04-09': 'PIB de EE. UU. (tercera estimación, T4 2025)',
    '2026-04-30': 'PIB de EE. UU. (estimación avanzada, T1 2026)',
    '2026-05-28': 'PIB de EE. UU. (segunda estimación, T1 2026)',
    '2026-06-25': 'PIB de EE. UU. (tercera estimación, T1 2026)',
    '2026-07-30': 'PIB de EE. UU. (estimación avanzada, T2 2026)',
    '2026-08-26': 'PIB de EE. UU. (segunda estimación, T2 2026)',
    '2026-09-30': 'PIB de EE. UU. (tercera estimación, T2 2026)',
    '2026-10-29': 'PIB de EE. UU. (estimación avanzada, T3 2026)',
    '2026-11-25': 'PIB de EE. UU. (segunda estimación, T3 2026)',
    '2026-12-23': 'PIB de EE. UU. (tercera estimación, T3 2026)',
  },
  dates: [
    ['2026-01-22', 8, 30],
    ['2026-02-20', 8, 30],
    ['2026-03-13', 8, 30],
    ['2026-04-09', 8, 30],
    ['2026-04-30', 8, 30],
    ['2026-05-28', 8, 30],
    ['2026-06-25', 8, 30],
    ['2026-07-30', 8, 30],
    ['2026-08-26', 8, 30],
    ['2026-09-30', 8, 30],
    ['2026-10-29', 8, 30],
    ['2026-11-25', 8, 30],
    ['2026-12-23', 8, 30],
  ],
};

/**
 * Reuniones ministeriales OPEP+ anunciadas en opec.org. Las revisiones
 * mensuales del grupo de ajustes voluntarios se generan por regla (primer
 * domingo de mes); las entradas de esta tabla ganan en la deduplicación
 * por clave.
 */
const OPEP: OfficialTable = {
  kind: 'opep',
  country: null,
  defaultTitle: 'Reunión ministerial OPEP+',
  dates: [
    ['2026-06-07', 12, 0],
    ['2026-11-29', 12, 0],
  ],
};

/** Tablas oficiales en el orden en que se insertan en el generador. */
export const OFFICIAL_TABLES: readonly OfficialTable[] = [FOMC, IPC, PCE, PIB, OPEP];

/**
 * «Employment Situation» (NFP) publicado por el BLS, por mes de
 * publicación ('YYYY-MM' → 'YYYY-MM-DD'), siempre a las 8:30 ET. Es la
 * «excepción cuando el BLS lo mueve» de la regla del primer viernes:
 * enero y febrero de 2026 salieron desplazados por el calendario atípico,
 * mayo se movió al segundo viernes y julio cayó al jueves 2 porque el 4
 * de julio se observó el viernes 3. Los meses fuera de la tabla se
 * calculan por regla y se guardan con origen 'regla'.
 */
export const NFP_PUBLISHED: Record<string, string> = {
  '2026-01': '2026-01-09',
  '2026-02': '2026-02-11',
  '2026-03': '2026-03-06',
  '2026-04': '2026-04-03',
  '2026-05': '2026-05-08',
  '2026-06': '2026-06-05',
  '2026-07': '2026-07-02',
  '2026-08': '2026-08-07',
  '2026-09': '2026-09-04',
  '2026-10': '2026-10-02',
  '2026-11': '2026-11-06',
  '2026-12': '2026-12-04',
};

/** Título del evento según la tabla (con el especial de la fecha si existe). */
export function tableTitle(table: OfficialTable, date: string): string {
  return table.titles?.[date] ?? table.defaultTitle;
}
