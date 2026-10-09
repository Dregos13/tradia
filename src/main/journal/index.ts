import type { ServiceContext } from '../services';

/**
 * Diario automático (fase 4) — esqueleto del contrato compartido.
 *
 * Ya está registrado en `services/index.ts` y se detiene en el `will-quit`
 * de `index.ts`, así la tarea «diario-backend» implementa aquí sin tocar el
 * cableado: el repositorio sobre `journal_entries` (migración 008), un
 * `record()` que usan los demás servicios, la consulta paginada con
 * filtros y la exportación a CSV (RFC 4180, UTF-8 con BOM) con diálogo de
 * guardar.
 *
 * Los tipos y canales fijados están en `src/shared/journal.ts` y
 * `src/shared/ipc.ts` (`journal:list`, `journal:get`, `journal:export-csv`
 * y el evento `journal:updated`).
 */
export interface JournalService {
  stop(): void;
}

export function registerJournal(_ctx: ServiceContext): JournalService {
  return {
    stop: () => undefined,
  };
}
