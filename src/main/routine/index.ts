import type { ServiceContext } from '../services';

/**
 * Rutina diaria de los agentes (fase 4) — esqueleto del contrato
 * compartido.
 *
 * Ya está registrado en `services/index.ts` y se detiene en el `will-quit`
 * de `index.ts`, así la tarea «rutina-diaria» implementa aquí sin tocar el
 * cableado: resumen previo a la apertura, revisión al cierre y
 * conciliación, en horario `America/New_York` configurable (`ROUTINE_*`),
 * sin fines de semana ni festivos, deduplicada por `routine_runs`
 * (migración 008) y con reloj inyectable para pruebas.
 *
 * Los tipos y canales fijados están en `src/shared/journal.ts` y
 * `src/shared/ipc.ts` (`routine:get-config`, `routine:set-config` y el
 * gancho de desarrollo `routine:advance-clock`).
 */
export interface RoutineService {
  stop(): void;
}

export function registerRoutine(_ctx: ServiceContext): RoutineService {
  return {
    stop: () => undefined,
  };
}
