/**
 * Calendario económico y de resultados — Fase 1b.
 *
 * - `rules.ts`: reglas de fecha puras (NFP con sus excepciones, EIA
 *   semanal con festivo federal, ISM/PMI, vencimientos y triple witching,
 *   OPEP mensual y estimaciones de los años sin calendario publicado).
 * - `tables.ts`: fechas verificadas 2026-2027 (FOMC, IPC, PCE, PIB, OPEP y
 *   el Employment Situation del BLS).
 * - `generate.ts`: monta los eventos con su instante UTC (zonas del
 *   calendario de mercado), su impacto (`impactOf`) y deduplicación por
 *   clave.
 * - `earnings.ts`: resultados de los activos seguidos desde Finnhub si hay
 *   clave, con proveedor simulado para TRADIA_E2E.
 * - `service.ts`: persistencia en `calendar_events`, refresco diario y al
 *   cambiar la watchlist, `calendar:list` y `calendar:updated`.
 */
export {
  createCalendarRepository,
  createCalendarService,
  registerCalendar,
  CALENDAR_FUTURE_DAYS,
  CALENDAR_PAST_DAYS,
  type CalendarPowerMonitorLike,
  type CalendarRefreshResult,
  type CalendarRepository,
  type CalendarService,
  type CalendarServiceDeps,
} from './service';
export {
  createFinnhubEarnings,
  createSimulatedEarnings,
  FINNHUB_SECRETS_KEY,
  FINNHUB_TIMEOUT_MS,
  type EarningsProvider,
  type FinnhubEarningsDeps,
} from './earnings';
export {
  earningsToEvent,
  generateCalendarEvents,
  type CalendarEventOrigin,
  type EarningsEntry,
  type EarningsSession,
  type GeneratedCalendarEvent,
} from './generate';
export {
  addDays,
  dayOfWeek,
  eiaReleases,
  expirationReleases,
  ismReleases,
  isUsFederalHoliday,
  lastWeekdayOfMonth,
  nfpReleases,
  nthWeekdayOfMonth,
  opecReleases,
  type ScheduledRelease,
} from './rules';
export {
  NFP_PUBLISHED,
  OFFICIAL_TABLES,
  tableTitle,
  type OfficialRelease,
  type OfficialTable,
} from './tables';
