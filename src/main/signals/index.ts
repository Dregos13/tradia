import type { ServiceContext } from '../services';

/**
 * Motor de señales programado (fase 4) — esqueleto del contrato compartido.
 *
 * Ya está registrado en `services/index.ts` y se detiene en el `will-quit`
 * de `index.ts`, así la tarea «motor-senales» implementa aquí sin tocar el
 * cableado: evaluación de las estrategias 'activa'/'paper' al cerrarse cada
 * vela, agregación por activo (contradicción ⇒ sin señal, al diario), pase
 * por la pasarela `risk:submit-signal`, persistencia en `signals`
 * (migración 008) y emisión de `signals:new`.
 *
 * Los tipos y canales fijados están en `src/shared/signals.ts` y
 * `src/shared/ipc.ts` (`signals:list`, `signals:get`, `signals:strategies`
 * y el gancho de desarrollo `signals:evaluate-now`).
 */
export interface SignalsService {
  stop(): void;
}

export function registerSignals(_ctx: ServiceContext): SignalsService {
  return {
    stop: () => undefined,
  };
}
