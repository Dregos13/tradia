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
import { registerAlerts, type NewsAlertsService } from '../news/alerts';
import { registerMacro, type MacroService } from '../market/macro';
import {
  createMarketClock,
  registerMarket,
  type MarketIngestionService,
} from '../market/ingestion';
import { registerHealth, type DataHealthService } from '../market/health';
import { registerStrategies } from '../strategies/service';
import type { StrategiesRepository } from '../strategies/repository';
import { registerBacktest, type BacktestService } from '../backtest/service';
import { registerKillSwitch, type KillSwitchService } from '../risk/killSwitch';

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
  /** Parada de emergencia (fase 3): veto total, disparadores automáticos. */
  killSwitch: KillSwitchService;
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
  /** Avisos (fase 1b): evento previo, noticia crítica y alerts:get/set-prefs. */
  alerts: NewsAlertsService;
  /** Biblioteca de estrategias (fase 2): fichas versionadas y registro. */
  strategies: StrategiesRepository;
  /** Backtests (fase 2): ejecución, informes persistidos, estrés y semilla. */
  backtest: BacktestService;
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
 * `killSwitch` va después de `health` por el mismo motivo: su envoltura de
 * `ctx.broadcast` tiene que estar instalada antes de que `macro` y `market`
 * lo capturen para que la parada vea cada `data-status:changed`.
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
  // Fase 3: la parada necesita scheduler (pausa), notifications (aviso
  // crítico), connectivity (sondeo), tray (repintado) y storage (historial
  // de kill_switch_events); envuelve ctx.broadcast antes de macro/market.
  services.killSwitch = registerKillSwitch(ctx);
  services.macro = registerMacro(ctx);
  services.market = registerMarket(ctx, { clock: marketClock });
  // Tras secrets: los conectores piden sus claves por getApiKey. La app
  // real siembra las fuentes oficiales predefinidas (una vez por conector).
  services.sources = registerSources(ctx, { seedOfficial: true });
  // Tras sources, market (watchlist) y connectivity: los necesita el lector.
  services.poller = registerNews(ctx);
  // Tras market (watchlist), secrets (clave Finnhub) y poller (news:advance-clock).
  services.calendar = registerCalendar(ctx);
  // Fase 2: la biblioteca de estrategias solo necesita storage.
  services.strategies = registerStrategies(ctx);
  // Fase 2: el servicio de backtest necesita strategies (fichas y métricas
  // resumen) y secrets (clave de Tiingo); siembra las clásicas al registrar.
  services.backtest = registerBacktest(ctx);
  // El último: consume notifications, settings, poller (onItemsStored y el
  // reloj de desarrollo), calendar (su evento updated) y market (watchlist).
  services.alerts = registerAlerts(ctx);
  return services as MainServices;
}
