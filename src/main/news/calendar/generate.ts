/**
 * Generación de eventos del calendario económico — Fase 1b.
 *
 * `generateCalendarEvents` produce todos los eventos macro de un rango de
 * fechas civiles ('YYYY-MM-DD', inclusive): las fechas publicadas por los
 * organismos (tablas verificadas, origen 'oficial'), las calculadas por
 * regla (origen 'regla') y las estimaciones para los años sin calendario
 * publicado. Cada evento lleva su instante UTC calculado con la zona IANA
 * oficial vía `zonedToUtcMs` (así la hora local de Nueva York se convierte
 * bien en semanas de cambio de horario) y su impacto según `impactOf`.
 *
 * La deduplicación es por `clave` (`{tipo}:{fecha}`): si un evento llega
 * por regla y por tabla oficial en la misma fecha gana 'oficial' (p. ej.
 * la reunión OPEP+ del 07-06-2026). Los resultados empresariales llegan
 * del proveedor de earnings (Finnhub o simulado) y se funden igual.
 */
import type { CalendarEventKind, ImpactLevel } from '../../../shared/ipc';
import { zonedToUtcMs } from '../../market/calendar';
import { impactOf } from '../priority';
import {
  cpiEstimateReleases,
  eiaReleases,
  expirationReleases,
  gdpEstimateReleases,
  ismReleases,
  nfpReleases,
  opecReleases,
  pceEstimateReleases,
  type ScheduledRelease,
} from './rules';
import { OFFICIAL_TABLES, tableTitle } from './tables';

/** Procedencia de un evento generado (columna `origen` de calendar_events). */
export type CalendarEventOrigin = 'regla' | 'oficial' | 'finnhub' | 'simulado';

/** Evento listo para guardar, antes de tener `id` en `calendar_events`. */
export interface GeneratedCalendarEvent {
  clave: string;
  kind: CalendarEventKind;
  title: string;
  /** Instante UTC (ISO 8601). */
  dateUtc: string;
  impact: ImpactLevel;
  country: string | null;
  asset: string | null;
  origin: CalendarEventOrigin;
}

const ORIGIN_PRIORITY: Record<CalendarEventOrigin, number> = {
  oficial: 3,
  finnhub: 2,
  regla: 1,
  simulado: 0,
};

/** Clave de deduplicación de un evento macro: tipo + día civil de su zona. */
const macroKey = (kind: CalendarEventKind, date: string): string => `${kind}:${date}`;

/** Convierte una publicación civil a ISO 8601 UTC con la zona oficial. */
function releaseToUtc(release: ScheduledRelease): string {
  const [year, month, day] = release.date.split('-').map(Number) as [number, number, number];
  return new Date(
    zonedToUtcMs(year, month, day, release.hour, release.minute, release.zone),
  ).toISOString();
}

function toGenerated(
  release: ScheduledRelease,
  kind: CalendarEventKind,
  country: string | null,
  origin: CalendarEventOrigin,
): GeneratedCalendarEvent {
  return {
    clave: macroKey(kind, release.date),
    kind,
    title: release.title,
    dateUtc: releaseToUtc(release),
    impact: impactOf(kind),
    country,
    asset: null,
    origin,
  };
}

/** Inserta en el mapa ganando el origen de mayor prioridad a clave igual. */
function put(map: Map<string, GeneratedCalendarEvent>, event: GeneratedCalendarEvent): void {
  const existing = map.get(event.clave);
  if (!existing || ORIGIN_PRIORITY[event.origin] >= ORIGIN_PRIORITY[existing.origin]) {
    map.set(event.clave, event);
  }
}

/** Meses ('YYYY-MM') cubiertos por alguna fecha de la tabla oficial `kind`. */
function coveredMonthsOf(kind: CalendarEventKind): ReadonlySet<string> {
  const table = OFFICIAL_TABLES.find((t) => t.kind === kind);
  const months = new Set<string>();
  for (const [date] of table?.dates ?? []) months.add(date.slice(0, 7));
  return months;
}

/**
 * Todos los eventos macro del rango [desde, hasta] ('YYYY-MM-DD',
 * inclusive): tablas oficiales, reglas y estimaciones, deduplicados por
 * clave y ordenados por instante UTC.
 */
export function generateCalendarEvents(desde: string, hasta: string): GeneratedCalendarEvent[] {
  const events = new Map<string, GeneratedCalendarEvent>();

  // 1. Fechas publicadas por los organismos (origen 'oficial').
  for (const table of OFFICIAL_TABLES) {
    for (const [date, hour, minute] of table.dates) {
      if (date < desde || date > hasta) continue;
      const release: ScheduledRelease = {
        date,
        hour,
        minute,
        zone: 'America/New_York',
        title: tableTitle(table, date),
        official: true,
      };
      put(events, toGenerated(release, table.kind, table.country, 'oficial'));
    }
  }

  // 2. Reglas de fecha (origen 'regla'; NFP ya trae su marca oficial).
  const byRule: Array<
    readonly [releases: ScheduledRelease[], kind: CalendarEventKind, country: string | null]
  > = [
    [nfpReleases(desde, hasta), 'nfp', 'US'],
    [eiaReleases(desde, hasta), 'eia', 'US'],
    [ismReleases(desde, hasta), 'pmi', 'US'],
    [expirationReleases(desde, hasta), 'vencimiento', null],
    [opecReleases(desde, hasta), 'opep', null],
  ];
  for (const [releases, kind, country] of byRule) {
    for (const release of releases) {
      put(events, toGenerated(release, kind, country, release.official ? 'oficial' : 'regla'));
    }
  }

  // 3. Estimaciones por regla en los meses sin fecha publicada.
  const estimates: Array<
    readonly [releases: ScheduledRelease[], kind: CalendarEventKind, country: string | null]
  > = [
    [cpiEstimateReleases(desde, hasta, coveredMonthsOf('ipc')), 'ipc', 'US'],
    [pceEstimateReleases(desde, hasta, coveredMonthsOf('pce')), 'pce', 'US'],
    [gdpEstimateReleases(desde, hasta, coveredMonthsOf('pib')), 'pib', 'US'],
  ];
  for (const [releases, kind, country] of estimates) {
    for (const release of releases) {
      put(events, toGenerated(release, kind, country, 'regla'));
    }
  }

  return [...events.values()].sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
}

/** Sesión de la presentación de resultados según el proveedor. */
export type EarningsSession = 'bmo' | 'amc' | 'other';

/** Una presentación de resultados tal como llega del proveedor. */
export interface EarningsEntry {
  symbol: string;
  /** Día civil 'YYYY-MM-DD' de la presentación. */
  date: string;
  /** 'bmo' antes de la apertura, 'amc' tras el cierre, otro valor = indeterminado. */
  session: EarningsSession;
  /** BPA estimado si el proveedor lo da; null en caso contrario. */
  epsEstimate: number | null;
}

const SESSION_LABEL: Record<EarningsSession, string> = {
  bmo: 'antes de la apertura',
  amc: 'tras el cierre',
  other: 'sesión por confirmar',
};

/** Hora ET asignada a cada sesión (apertura 9:30, cierre 16:00, mediodía si se desconoce). */
const SESSION_TIME: Record<EarningsSession, readonly [number, number]> = {
  bmo: [9, 30],
  amc: [16, 0],
  other: [12, 0],
};

/**
 * Convierte una entrada del calendario de resultados en evento. La clave
 * incluye el activo: `resultados:AAPL:2026-10-22`.
 */
export function earningsToEvent(
  entry: EarningsEntry,
  origin: 'finnhub' | 'simulado',
): GeneratedCalendarEvent {
  const ticker = entry.symbol.trim().toUpperCase();
  const [hour, minute] = SESSION_TIME[entry.session];
  const eps = entry.epsEstimate === null ? '' : ` · BPA est. ${entry.epsEstimate}`;
  return {
    clave: `resultados:${ticker}:${entry.date}`,
    kind: 'resultados',
    title: `Resultados de ${ticker} (${SESSION_LABEL[entry.session]})${eps}`,
    dateUtc: releaseToUtc({
      date: entry.date,
      hour,
      minute,
      zone: 'America/New_York',
      title: '',
      official: false,
    }),
    impact: impactOf('resultados'),
    country: null,
    asset: ticker,
    origin,
  };
}
