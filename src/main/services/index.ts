import { registerConnectivity, type ConnectivityService } from './connectivity';
import { registerNotifications, type NotificationsService } from './notifications';
import { registerScheduler, type SchedulerService } from './scheduler';
import { registerSecrets, type SecretsService } from './secrets';
import { registerSettings, type SettingsService } from './settings';
import { registerStorage, type StorageService } from './storage';
import { registerTray, type TrayService } from './tray';

/** Servicios del proceso principal, uno por archivo de `services/`. */
export interface MainServices {
  storage: StorageService;
  secrets: SecretsService;
  settings: SettingsService;
  notifications: NotificationsService;
  tray: TrayService;
  scheduler: SchedulerService;
  connectivity: ConnectivityService;
}

export interface ServiceContext {
  /** Envía un evento a todas las ventanas (renderer). */
  broadcast: (channel: string, payload: unknown) => void;
  /** Se rellena en el orden de registro; úsalo para dependencias entre servicios. */
  services: Partial<MainServices>;
}

/**
 * Registra todos los servicios y sus handlers IPC.
 * El orden importa: cada servicio solo puede depender de los ya registrados
 * en `ctx.services`.
 */
export function initServices(ctx: ServiceContext): MainServices {
  const services = ctx.services;
  services.storage = registerStorage(ctx);
  services.settings = registerSettings(ctx);
  services.secrets = registerSecrets(ctx);
  services.notifications = registerNotifications(ctx);
  services.scheduler = registerScheduler(ctx);
  services.tray = registerTray(ctx);
  services.connectivity = registerConnectivity(ctx);
  return services as MainServices;
}
