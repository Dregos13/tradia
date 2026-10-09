import type { ServiceContext } from '../services';

/**
 * Canales de entrega (fase 4) — esqueleto del contrato compartido.
 *
 * Ya está registrado en `services/index.ts` y se detiene en el `will-quit`
 * de `index.ts`, así la tarea «canales-notificacion» implementa aquí sin
 * tocar el cableado: notificación de escritorio por señal aprobada, vetada
 * y límite alcanzado (sobre `notifications.notify`), Telegram por la Bot
 * API y correo SMTP, con «Enviar prueba», reintentos con espera creciente
 * y credenciales solo en el almacén de secretos (`DELIVERY_SECRET_KEYS`).
 *
 * Los tipos y canales fijados están en `src/shared/journal.ts` y
 * `src/shared/ipc.ts` (`delivery:get-config`, `delivery:set-config` y
 * `delivery:test`).
 */
export interface DeliveryService {
  stop(): void;
}

export function registerDelivery(_ctx: ServiceContext): DeliveryService {
  return {
    stop: () => undefined,
  };
}
