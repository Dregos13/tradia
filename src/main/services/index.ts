import { registerConnectivity, type ConnectivityService } from './connectivity';
import { registerNotifications, type NotificationsService } from './notifications';
import { registerScheduler, type SchedulerService } from './scheduler';
import { registerSecrets, type SecretsService } from './secrets';
import { registerSettings, type SettingsService } from './settings';
import { registerStorage, type StorageService } from './storage';
import { registerTray, type TrayService } from './tray';
import { registerSources, type SourcesService } from '../news/sources';
import { registerCalendar, type CalendarService } from '../news/calendar';
import { registerNews, type NewsPollerService } from '../news/poller';
import { registerMacro, type MacroService } from '../market/macro';
import {
  createMarketClock,
  registerMarket,
  type MarketIngestionService,
} from '../market/ingestion';
import { registerHealth, type DataHealthService } from '../market/health';

/** Servicios del proceso principal, uno por archivo de `services/`. */
export interface MainServices {
  storage: StorageService;
  secrets: SecretsService;
  settings: SettingsService;
  notifications: NotificationsService;
  tray: TrayService;
  scheduler: SchedulerService;
  connectivity: ConnectivityService;
  /** Vigilancia de datos caducados/no fiables: data-status:get y avisos. */
  health: DataHealthService;
  /** Series macro (FRED/VIX): refresco diario programado y `macro:get-series`. */
  macro: MacroService;
  /** Ingesta de velas: histórico, actualización diaria y watchlist/getBars. */
  market: MarketIngestionService;
  /** Fuentes de noticias (fase 1b): alta/baja/edición y «probar conexión». */
  sources: SourcesService;
  /** Lector de noticias (fase 1b): pasadas programadas, deduplicación y feed. */
  poller: NewsPollerService;
  /** Calendario económico (fase 1b): calendar:list y refresco diario. */
  calendar: CalendarService;
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
 * en `ctx.services`. `health` va antes de `macro` y `market` porque envuelve
 * `ctx.broadcast` para observar sus `data-status:changed` al instante, y
 * comparte con `market` el reloj adelantable por el gancho de desarrollo.
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
  const marketClock = createMarketClock();
  services.health = registerHealth(ctx, { clock: marketClock });
  services.macro = registerMacro(ctx);
  services.market = registerMarket(ctx, { clock: marketClock });
  // Tras secrets: los conectores piden sus claves por getApiKey. La app
  // real siembra las fuentes oficiales predefinidas (una vez por conector).
  services.sources = registerSources(ctx, { seedOfficial: true });
  // Tras sources, market (watchlist) y connectivity: los necesita el lector.
  services.poller = registerNews(ctx);
  // Tras market (watchlist), secrets (clave Finnhub) y poller (news:advance-clock).
  services.calendar = registerCalendar(ctx);
  return services as MainServices;
}
