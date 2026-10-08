import type { ServiceContext } from './index';

/**
 * Bandeja del sistema — stub.
 *
 * La tarea «tray-background» lo implementa: Tray con icono por estado
 * (en línea / sin conexión / pausado), menú Abrir / Pausar agentes /
 * Iniciar con el sistema / Salir, ocultar al cerrar la ventana y
 * setLoginItemSettings (o .desktop en Linux).
 */
export interface TrayService {
  /** Redibuja icono, tooltip y menú según el estado actual. */
  refresh(): void;
  destroy(): void;
}

export function registerTray(_ctx: ServiceContext): TrayService {
  return {
    refresh() {
      // TODO(tray-background): actualizar icono, tooltip y menú.
    },
    destroy() {
      // TODO(tray-background): destruir el Tray.
    },
  };
}
