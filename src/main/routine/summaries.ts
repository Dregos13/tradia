/**
 * Textos de los tres avisos de la rutina diaria (fase 4) — funciones puras.
 *
 * Siguen la tabla «Texto de notificaciones» de `docs/diseno-fase-4.md`:
 * la fecha es el día de mercado ('YYYY-MM-DD', America/New_York), la marca
 * de retraso es « Enviado con retraso.» cuando el envío perdió su hora, y
 * todo aviso termina con la línea de exención `DELIVERY_DISCLAIMER`.
 * Los plurales se resuelven en español (1 señal / 2 señales).
 */

import type { DeliveryMessage } from '../delivery';
import { DELIVERY_DISCLAIMER } from '../delivery/format';

/** Marca «con retraso» del diseño (vacía cuando el envío fue a su hora). */
export const routineLateMark = (late: boolean): string => (late ? ' Enviado con retraso.' : '');

const plural = (n: number, singular: string, pluralForm: string): string =>
  `${n} ${n === 1 ? singular : pluralForm}`;

const pct = (value: number): string => String(Math.round(value * 100) / 100);

// ---------------------------------------------------------------------------
// Resumen previo a la apertura (08:30 ET por defecto)
// ---------------------------------------------------------------------------

export interface OvernightNewsStat {
  /** Titulares de la noche ya clasificados ('maxima', 'media', 'activo', 'baja'). */
  total: number;
  /** Los que no son 'baja': lo que el aviso cuenta como «relevantes». */
  relevantes: number;
  porPrioridad: Record<string, number>;
  /** Hasta 5 titulares relevantes para el detalle del diario. */
  titulares: { titulo: string; prioridad: string; activos: string[] }[];
}

export interface CalendarDayStat {
  total: number;
  /** Los de impacto 'alto' del día, para el detalle del diario. */
  destacados: { titulo: string; impacto: string; dateUtc: string }[];
}

export interface GapWatch {
  ticker: string;
  /** (apertura última sesión − cierre anterior) / cierre anterior, en %. */
  gapPct: number;
  lastOpen: number;
  prevClose: number;
  /** Fecha de la última vela usada ('YYYY-MM-DD'). */
  barDate: string;
}

export function preMarketText(
  dia: string,
  stat: { news: OvernightNewsStat; events: CalendarDayStat; gaps: readonly GapWatch[] },
  late: boolean,
): DeliveryMessage {
  const sentence =
    `${plural(stat.news.relevantes, 'noticia relevante', 'noticias relevantes')}, ` +
    `${plural(stat.events.total, 'evento de calendario', 'eventos de calendario')} y ` +
    `${plural(stat.gaps.length, 'hueco en seguimiento', 'huecos en seguimiento')}.`;
  return {
    title: `Resumen previo a la apertura · ${dia}`,
    body: `${sentence}${routineLateMark(late)} ${DELIVERY_DISCLAIMER}`,
    navigateTo: 'inicio',
  };
}

// ---------------------------------------------------------------------------
// Revisión al cierre (16:15 ET por defecto)
// ---------------------------------------------------------------------------

export interface CloseStat {
  /** Señales del día aprobadas o reducidas por la pasarela. */
  senales: number;
  /** Señales del día vetadas por la pasarela. */
  vetos: number;
  /** Entradas 'veto' del diario del día (una por regla incumplida). */
  vetosDiario: number;
  posicionesAbiertas: number;
  posicionesCerradasHoy: number;
  drawdownPct: number;
  dailyLossPct: number;
  equity: number;
}

export function closeReviewText(dia: string, stat: CloseStat, late: boolean): DeliveryMessage {
  const sentence =
    `${plural(stat.senales, 'señal', 'señales')}, ` +
    `${plural(stat.vetos, 'veto', 'vetos')} y ` +
    `${plural(stat.posicionesAbiertas, 'posición simulada', 'posiciones simuladas')}. ` +
    `Drawdown: ${pct(stat.drawdownPct)} %.`;
  return {
    title: `Revisión al cierre · ${dia}`,
    body: `${sentence}${routineLateMark(late)} ${DELIVERY_DISCLAIMER}`,
    navigateTo: 'inicio',
  };
}

// ---------------------------------------------------------------------------
// Conciliación (17:30 ET por defecto)
// ---------------------------------------------------------------------------

export function reconcileText(dia: string, discrepancies: number, late: boolean): DeliveryMessage {
  const outcome =
    discrepancies === 0
      ? 'Sin discrepancias'
      : plural(discrepancies, 'discrepancia detectada', 'discrepancias detectadas');
  return {
    title: `Conciliación completada · ${dia}`,
    body:
      `${outcome}. Cartera simulada y diario revisados.` +
      `${routineLateMark(late)} ${DELIVERY_DISCLAIMER}`,
    navigateTo: 'diario',
  };
}
