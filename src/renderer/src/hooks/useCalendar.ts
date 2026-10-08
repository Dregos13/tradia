import { useCallback } from 'react';
import type { CalendarListQuery } from '../../../shared/ipc';
import { useIpcList } from './useIpcList';

/** Calendar ranges use UTC dates, matching the IPC contract. */
export function currentCalendarWeek(now = new Date()): CalendarListQuery {
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const sunday = new Date(monday);
  sunday.setUTCDate(sunday.getUTCDate() + 6);
  return { desde: monday.toISOString().slice(0, 10), hasta: sunday.toISOString().slice(0, 10) };
}
const subscribe = (reload: () => void) => window.tradia.calendar.onUpdated(reload);
export function useCalendar(query: CalendarListQuery = currentCalendarWeek()) {
  const { desde, hasta } = query;
  const read = useCallback(() => window.tradia.calendar.list({ desde, hasta }), [desde, hasta]);
  const { items, ...state } = useIpcList(
    read,
    subscribe,
    'No pudimos consultar el calendario. Inténtalo de nuevo.',
  );
  return { ...state, events: items };
}
