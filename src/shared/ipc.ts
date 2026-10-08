/**
 * Contrato IPC de Tradia — Fases 0-1b.
 *
 * Única fuente de verdad para los canales entre el renderer y el proceso
 * principal. El preload (`src/preload/index.ts`) expone solo `window.tradia`
 * con la forma de `TradiaApi`; los handlers viven en `src/main/services/*`.
 *
 * Reglas del contrato:
 * - Todo `invoke` va validado en el proceso principal con los guardas de aquí.
 * - Los eventos (`changed`, `heartbeat`) solo fluyen main → renderer.
 * - `secrets` no tiene lectura: el renderer puede escribir, comprobar y borrar
 *   claves, pero nunca recuperarlas.
 */

export const IPC_CHANNELS = {
  connectivity: {
    getState: 'connectivity:get-state',
    checkNow: 'connectivity:check-now',
    /**
     * Solo desarrollo (la app empaquetada no registra el handler): fuerza el
     * modo simulación de 'sin conexión' para las pruebas manuales.
     */
    simulateOffline: 'connectivity:simulate-offline',
    /** Evento main → renderer: el estado de conexión cambió. */
    changed: 'connectivity:changed',
  },
  notifications: {
    send: 'notifications:send',
    test: 'notifications:test',
    getPrefs: 'notifications:get-prefs',
    setPrefs: 'notifications:set-prefs',
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
  },
  secrets: {
    setKey: 'secrets:set-key',
    hasKey: 'secrets:has-key',
    deleteKey: 'secrets:delete-key',
    // Sin canal de lectura a propósito.
  },
  agents: {
    pause: 'agents:pause',
    resume: 'agents:resume',
    getState: 'agents:get-state',
    /** Evento main → renderer: cambió el estado de los agentes. */
    changed: 'agents:changed',
    /** Evento main → renderer: latido del planificador (ISO 8601). */
    heartbeat: 'agents:heartbeat',
  },
  watchlist: {
    list: 'watchlist:list',
    add: 'watchlist:add',
    remove: 'watchlist:remove',
    /** Añade de golpe el universo inicial de `INITIAL_UNIVERSE_TICKERS`. */
    addUniverse: 'watchlist:add-universe',
  },
  market: {
    getBars: 'market:get-bars',
    /** Fuerza una actualización incremental fuera del horario programado. */
    refreshNow: 'market:refresh-now',
    /** Evento main → renderer: llegaron velas nuevas de un ticker. */
    updated: 'market:updated',
    /**
     * Solo desarrollo (la app empaquetada no registra el handler): adelanta
     * el reloj interno del servicio de mercado para probar la actualización
     * diaria sin esperar al horario real.
     */
    advanceClock: 'market:advance-clock',
  },
  macro: {
    getSeries: 'macro:get-series',
  },
  dataStatus: {
    get: 'data-status:get',
    /**
     * Solo desarrollo (TRADIA_E2E y sin empaquetar): activa o desactiva el
     * fallo persistente de los proveedores simulados y fuerza una pasada.
     */
    simulateProviderFailure: 'data-status:simulate-provider-failure',
    /** Evento main → renderer: cambió la salud de un dato. */
    changed: 'data-status:changed',
  },
  sources: {
    list: 'sources:list',
    add: 'sources:add',
    update: 'sources:update',
    remove: 'sources:remove',
    /** «Probar conexión»: acepta una fuente guardada (`{ id }`) o el borrador del alta. */
    test: 'sources:test',
  },
  news: {
    list: 'news:list',
    /** Evento main → renderer: el feed cambió tras una pasada del programador. */
    updated: 'news:updated',
    /**
     * Solo desarrollo (la app empaquetada no registra el handler): fuerza
     * una pasada inmediata del lector de noticias.
     */
    pollNow: 'news:poll-now',
    /**
     * Solo desarrollo (la app empaquetada no registra el handler): adelanta
     * el reloj del lector de noticias y del calendario para las pruebas E2E.
     */
    advanceClock: 'news:advance-clock',
  },
  calendar: {
    list: 'calendar:list',
    /** Evento main → renderer: el calendario se recalculó o llegaron fechas nuevas. */
    updated: 'calendar:updated',
  },
  alerts: {
    getPrefs: 'alerts:get-prefs',
    setPrefs: 'alerts:set-prefs',
    /** Evento main → renderer: el clic en una notificación pide abrir una vista. */
    navigate: 'alerts:navigate',
  },
} as const;

// ---------------------------------------------------------------------------
// Dominio: conectividad
// ---------------------------------------------------------------------------

export type ConnectivityStatus = 'online' | 'offline' | 'checking';

export interface ConnectivityState {
  status: ConnectivityStatus;
  /** Última comprobación (ISO 8601) o null si todavía no se ha comprobado. */
  lastCheckedAt: string | null;
  /** Próximo reintento (ISO 8601) cuando hay espera exponencial, si aplica. */
  nextRetryAt: string | null;
  /** Número de reintento actual (0 en línea). */
  attempt: number;
}

// ---------------------------------------------------------------------------
// Dominio: notificaciones
// ---------------------------------------------------------------------------

export const NOTIFICATION_LEVELS = ['info', 'alerta', 'critica'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/**
 * Vistas a las que puede llevar el clic de una notificación nativa: el
 * aviso previo de un evento abre Calendario y el de una noticia, Noticias.
 * Son las rutas por hash del renderer (`#noticias`, `#calendario`).
 */
export const NOTIFICATION_ROUTES = ['noticias', 'calendario'] as const;
export type NotificationRoute = (typeof NOTIFICATION_ROUTES)[number];

export interface NotificationPayload {
  level: NotificationLevel;
  title: string;
  body: string;
  /** Vista a abrir al hacer clic; sin ella el clic solo enfoca la ventana. */
  navigateTo?: NotificationRoute;
}

/** Preferencias por nivel; `critica` se muestra siempre salvo desactivación explícita. */
export interface NotificationPrefs {
  info: boolean;
  alerta: boolean;
  critica: boolean;
}

// ---------------------------------------------------------------------------
// Dominio: ajustes
// ---------------------------------------------------------------------------

export interface AppSettings {
  /** Iniciar Tradia con el sistema operativo. */
  autostart: boolean;
  /** Versión del aviso de riesgo aceptada, o null si aún no se ha aceptado. */
  disclaimerAcceptedVersion: string | null;
  /** Fecha ISO 8601 generada por main; el renderer no puede escribirla. */
  disclaimerAcceptedAt: string | null;
}

/** Solo estas claves son escribibles desde el renderer. */
export interface SettingsPatch {
  autostart?: boolean;
  disclaimerAcceptedVersion?: string | null;
}

// ---------------------------------------------------------------------------
// Dominio: agentes / planificador
// ---------------------------------------------------------------------------

export interface AgentsState {
  paused: boolean;
  /** 'usuario' si se pausó a mano, 'sin-conexion' si la pausó el vigilante. */
  pauseReason: 'usuario' | 'sin-conexion' | null;
  /** Último latido del planificador (ISO 8601). */
  lastHeartbeatAt: string | null;
}

// ---------------------------------------------------------------------------
// Dominio: datos de mercado (fase 1)
// ---------------------------------------------------------------------------

/** Máximo de activos simultáneos de la lista (cuota gratuita de Tiingo). */
export const WATCHLIST_MAX_ITEMS = 25;

/**
 * Universo inicial de `docs/alcance.md`: 10 ETF de índice y sector más 15
 * acciones de gran capitalización. `watchlist:add-universe` inserta los que
 * falten hasta el límite de `WATCHLIST_MAX_ITEMS`.
 */
export const INITIAL_UNIVERSE_TICKERS = [
  'SPY',
  'QQQ',
  'DIA',
  'IWM',
  'VTI',
  'XLF',
  'XLK',
  'XLE',
  'XLV',
  'TLT',
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'GOOGL',
  'META',
  'JPM',
  'XOM',
  'JNJ',
  'PG',
  'V',
  'HD',
  'KO',
  'AVGO',
  'AMD',
] as const;

/** Tickers del universo US: letras, dígitos, punto y guion (p. ej. 'BRK.B'). */
export const TICKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]{0,11}$/;

/** Fecha de sesión 'YYYY-MM-DD' real (no '2026-02-30'). */
export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface WatchlistItem {
  ticker: string;
  /** Alta en la lista (ISO 8601). */
  addedAt: string;
  /** Orden de visualización, 0..n-1. */
  position: number;
}

/** Una vela diaria guardada: cruda del proveedor y, si ya se limpió, ajustada. */
export interface MarketBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Ajustados hacia atrás por splits y dividendos; null hasta la limpieza. */
  adjOpen: number | null;
  adjHigh: number | null;
  adjLow: number | null;
  adjClose: number | null;
  adjVolume: number | null;
  /** Lote del que procede la vela (trazabilidad). */
  batchId: number;
}

export interface GetBarsRequest {
  ticker: string;
  /** Rango opcional, ambos inclusive ('YYYY-MM-DD'). */
  desde?: string;
  hasta?: string;
}

export interface MarketBarsResult {
  ticker: string;
  /** Proveedor del que proceden las velas, o null si no hay datos. */
  source: string | null;
  bars: MarketBar[];
}

/** Motivos por los que `market:refresh-now` puede no encolar trabajo. */
export const MARKET_REFRESH_REJECTIONS = [
  'sin-proveedor',
  'sin-activos',
  'sin-conexion',
  'en-curso',
] as const;
export type MarketRefreshRejection = (typeof MARKET_REFRESH_REJECTIONS)[number];

export interface MarketRefreshResult {
  accepted: boolean;
  /** Motivo del rechazo, o null si el refresco quedó encolado. */
  reason: MarketRefreshRejection | null;
}

/** Evento `market:updated`: llegaron velas nuevas de un ticker. */
export interface MarketUpdatedEvent {
  ticker: string;
  source: string;
  /** Fecha de la vela más reciente tras la actualización. */
  lastDate: string | null;
  /** ISO 8601. */
  updatedAt: string;
}

/** Respuesta del gancho de desarrollo `market:advance-clock`. */
export interface MarketClockAdvanceResult {
  /** Instante del reloj interno tras el avance, ISO 8601. */
  now: string;
}

/** Estados de salud del dato, compartidos por main (data_status) y renderer. */
export const DATA_STATUS_STATES = [
  'fiable',
  'actualizando',
  'desactualizado',
  'no-fiable',
] as const;
export type DataStatusState = (typeof DATA_STATUS_STATES)[number];

export interface DataStatusEntry {
  /** 'ticker:AAPL', 'macro:DFF' o 'provider:tiingo' (ver `dataStatusKey`). */
  key: string;
  state: DataStatusState;
  /** Último dato correcto conocido (ISO 8601), o null si nunca lo hubo. */
  lastOkAt: string | null;
  consecutiveFailures: number;
  /** Motivo legible del estado actual, o null. */
  reason: string | null;
  /** Última escritura del estado (ISO 8601). */
  updatedAt: string;
}

/** Claves de `data_status` por tipo de dato, única convención válida. */
export const dataStatusKey = {
  ticker: (ticker: string) => `ticker:${ticker}`,
  macro: (seriesId: string) => `macro:${seriesId}`,
  provider: (providerId: string) => `provider:${providerId}`,
} as const;

export interface MacroObservation {
  date: string;
  value: number;
}

export interface MacroSeriesQuery {
  /** Devuelve solo observaciones desde esta fecha ('YYYY-MM-DD'). */
  desde?: string;
}

/** Serie macro con su histórico reciente para el minigráfico del panel. */
export interface MacroSeriesSnapshot {
  /** Código FRED: 'DFF', 'CPIAUCSL', 'DGS2', 'DGS10', 'T10Y2Y', 'VIXCLS'. */
  id: string;
  name: string;
  unit: string | null;
  frequency: string | null;
  /** Observaciones en orden ascendente de fecha. */
  observations: MacroObservation[];
  /** Salud del dato de esta serie, o null si aún no se ha evaluado. */
  status: DataStatusEntry | null;
}

// ---------------------------------------------------------------------------
// Dominio: noticias, fuentes y calendario (fase 1b)
// ---------------------------------------------------------------------------

/**
 * Tipo lógico de una fuente: feed RSS/Atom, API de noticias, fuente oficial
 * o redes sociales (siempre vía RSS; ver asunciones del plan de fase).
 */
export const SOURCE_KINDS = ['rss', 'api', 'oficial', 'redes'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/**
 * Fiabilidad editorial (regla de calidad de la sección 5.4 del plan). Una
 * noticia solo respaldada por 'redes' nunca se marca como confirmada: hace
 * falta una fuente 'oficial' o 'agencia'.
 */
export const RELIABILITY_LEVELS = ['oficial', 'agencia', 'prensa', 'redes'] as const;
export type Reliability = (typeof RELIABILITY_LEVELS)[number];

/** Prioridades del feed según la sección 6 del plan. */
export const NEWS_PRIORITIES = ['maxima', 'media', 'activo', 'baja'] as const;
export type NewsPriority = (typeof NEWS_PRIORITIES)[number];

/** Impacto de un evento del calendario; 'alto' dispara el aviso previo. */
export const IMPACT_LEVELS = ['alto', 'medio', 'bajo'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

/**
 * Catálogo de tipos de evento del calendario: los de la sección 6 más
 * 'banco-central' (decisiones de BCE, BoE, BoJ distintas del FOMC) y 'otro'.
 * Es la misma lista que el CHECK de `calendar_events.tipo`.
 */
export const CALENDAR_EVENT_KINDS = [
  'fomc',
  'banco-central',
  'nfp',
  'ipc',
  'pce',
  'pib',
  'pmi',
  'eia',
  'opep',
  'vencimiento',
  'resultados',
  'otro',
] as const;
export type CalendarEventKind = (typeof CALENDAR_EVENT_KINDS)[number];

/** Estado de la última lectura o prueba de conexión de una fuente. */
export const SOURCE_STATES = ['pendiente', 'ok', 'error'] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

/** Identificador de conector en minúsculas ('rss', 'finnhub', 'sec-edgar'). */
export const CONNECTOR_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export const SOURCE_MIN_INTERVAL_SECONDS = 60;
export const SOURCE_MAX_INTERVAL_SECONDS = 86_400;
export const SOURCE_NAME_MAX_LENGTH = 120;
export const SOURCE_URL_MAX_LENGTH = 2_048;
/** Tope del parámetro `limit` de `news:list`. */
export const NEWS_LIST_MAX_LIMIT = 500;

/** Una fuente de noticias configurada (fila de `news_sources`). */
export interface NewsSource {
  id: number;
  /** Nombre visible elegido por el usuario o por el catálogo de oficiales. */
  name: string;
  kind: SourceKind;
  /** Conector que la lee ('rss', 'finnhub', 'sec-edgar'...). */
  connector: string;
  url: string | null;
  /** Parámetros del conector (JSON); nunca contiene secretos ni claves. */
  params: Record<string, unknown>;
  reliability: Reliability;
  intervalSeconds: number;
  active: boolean;
  lastStatus: SourceState;
  lastError: string | null;
  /** Última lectura correcta (ISO 8601); null si aún no hubo ninguna. */
  lastFetchedAt: string | null;
  createdAt: string;
}

/**
 * Alta de una fuente. `url` es obligatoria para los tipos 'rss' y 'redes'
 * (ambos se leen por feed); en 'api' y 'oficial' el endpoint lo fija el
 * conector y `url` es opcional.
 */
export interface AddSourceRequest {
  name: string;
  kind: SourceKind;
  connector: string;
  url?: string;
  params?: Record<string, unknown>;
  reliability: Reliability;
  intervalSeconds?: number;
}

/** Cambios sobre una fuente: `id` más al menos un campo a modificar. */
export interface UpdateSourceRequest {
  id: number;
  name?: string;
  url?: string;
  params?: Record<string, unknown>;
  reliability?: Reliability;
  intervalSeconds?: number;
  active?: boolean;
}

/** «Probar conexión»: una fuente guardada por id o el borrador del alta. */
export type TestSourceRequest = { id: number } | AddSourceRequest;

export interface TestSourceResult {
  ok: boolean;
  /** Titulares que devolvió la fuente en la prueba (0 si falló). */
  itemsFound: number;
  /** Latencia de la prueba en ms; null si no se pudo medir. */
  latencyMs: number | null;
  /** Motivo legible del fallo, o null. */
  error: string | null;
}

/** Fuente que trajo un titular deduplicado. */
export interface NewsItemSource {
  id: number;
  name: string;
  reliability: Reliability;
}

/** Titular del feed: la misma noticia por varias fuentes es un solo ítem. */
export interface NewsItem {
  id: number;
  title: string;
  /** URL canónica; null si la fuente no la dio. */
  url: string | null;
  /** Publicación en ISO 8601 UTC. */
  publishedAt: string;
  summary: string | null;
  priority: NewsPriority;
  /** true solo si la respalda una fuente 'oficial' o 'agencia'. */
  confirmed: boolean;
  /** Todas las fuentes que trajeron la noticia. */
  sources: NewsItemSource[];
  /** Tickers relacionados (lista de seguimiento o mencionados). */
  assets: string[];
}

/** Filtros de `news:list`; todos opcionales y combinables. */
export interface NewsListQuery {
  /** Rango de publicación, ambos inclusive ('YYYY-MM-DD'). */
  desde?: string;
  hasta?: string;
  priority?: NewsPriority;
  /** Filtra por la fiabilidad de alguna de las fuentes de la noticia. */
  reliability?: Reliability;
  ticker?: string;
  confirmed?: boolean;
  sourceId?: number;
  /** Máximo de resultados; tope `NEWS_LIST_MAX_LIMIT`. */
  limit?: number;
}

/** Evento `news:updated`: el feed cambió tras una pasada del programador. */
export interface NewsUpdatedEvent {
  /** Titulares nuevos guardados en la última pasada. */
  newItems: number;
  /** ISO 8601. */
  updatedAt: string;
}

/** Un evento del calendario económico o de resultados. */
export interface CalendarEvent {
  id: number;
  kind: CalendarEventKind;
  title: string;
  /** Instante UTC (ISO 8601). */
  dateUtc: string;
  impact: ImpactLevel;
  /** País o área ('US', 'EA', 'ES'); null en eventos globales. */
  country: string | null;
  /** Activo relacionado en resultados; null en eventos macro. */
  asset: string | null;
  /** 'regla' | 'oficial' | 'finnhub' | 'simulado'. */
  origin: string;
}

/** `calendar:list` exige un rango de fechas, ambos inclusive ('YYYY-MM-DD'). */
export interface CalendarListQuery {
  desde: string;
  hasta: string;
}

/** Evento `calendar:updated`: el calendario se recalculó. */
export interface CalendarUpdatedEvent {
  /** ISO 8601. */
  updatedAt: string;
}

/** Respuesta del gancho de desarrollo `news:poll-now`. */
export interface NewsPollResult {
  /** Fuentes activas consultadas en la pasada. */
  sourcesPolled: number;
  /** Titulares nuevos guardados. */
  newItems: number;
  /** ISO 8601. */
  polledAt: string;
}

/** Respuesta del gancho de desarrollo `news:advance-clock`. */
export interface NewsClockAdvanceResult {
  /** Instante del reloj interno tras el avance, ISO 8601. */
  now: string;
}

/**
 * Antelación del aviso previo a eventos de alto impacto, en minutos
 * (opciones del diseño: 15, 30, 45 o 60; 30 por defecto).
 */
export const ALERT_LEAD_MINUTES = [15, 30, 45, 60] as const;
export type AlertLeadMinutes = (typeof ALERT_LEAD_MINUTES)[number];

/** Preferencias de los avisos en segundo plano (`alerts:get-prefs`). */
export interface AlertPrefs {
  /** Minutos antes de un evento de impacto alto para avisar. */
  leadMinutes: AlertLeadMinutes;
}

// ---------------------------------------------------------------------------
// API expuesta al renderer como window.tradia
// ---------------------------------------------------------------------------

export interface TradiaApi {
  connectivity: {
    getState(): Promise<ConnectivityState>;
    checkNow(): Promise<ConnectivityState>;
    onChanged(listener: (state: ConnectivityState) => void): () => void;
  };
  notifications: {
    send(payload: NotificationPayload): Promise<void>;
    test(level: NotificationLevel): Promise<void>;
    getPrefs(): Promise<NotificationPrefs>;
    setPrefs(prefs: NotificationPrefs): Promise<NotificationPrefs>;
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: SettingsPatch): Promise<AppSettings>;
  };
  secrets: {
    setKey(provider: string, apiKey: string): Promise<void>;
    hasKey(provider: string): Promise<boolean>;
    deleteKey(provider: string): Promise<void>;
  };
  agents: {
    pause(): Promise<AgentsState>;
    resume(): Promise<AgentsState>;
    getState(): Promise<AgentsState>;
    onChanged(listener: (state: AgentsState) => void): () => void;
    onHeartbeat(listener: (at: string) => void): () => void;
  };
  watchlist: {
    list(): Promise<WatchlistItem[]>;
    /** Añade un ticker y devuelve la lista completa ya ordenada. */
    add(ticker: string): Promise<WatchlistItem[]>;
    remove(ticker: string): Promise<WatchlistItem[]>;
    /** Añade `INITIAL_UNIVERSE_TICKERS` y devuelve la lista completa. */
    addUniverse(): Promise<WatchlistItem[]>;
  };
  market: {
    getBars(request: GetBarsRequest): Promise<MarketBarsResult>;
    refreshNow(): Promise<MarketRefreshResult>;
    onUpdated(listener: (event: MarketUpdatedEvent) => void): () => void;
  };
  macro: {
    getSeries(query?: MacroSeriesQuery): Promise<MacroSeriesSnapshot[]>;
  };
  dataStatus: {
    get(): Promise<DataStatusEntry[]>;
    onChanged(listener: (entry: DataStatusEntry) => void): () => void;
  };
  sources: {
    list(): Promise<NewsSource[]>;
    /** Da de alta una fuente y la devuelve con su id asignado. */
    add(request: AddSourceRequest): Promise<NewsSource>;
    update(request: UpdateSourceRequest): Promise<NewsSource>;
    /** Quita la fuente y devuelve la lista actualizada. */
    remove(id: number): Promise<NewsSource[]>;
    test(request: TestSourceRequest): Promise<TestSourceResult>;
  };
  news: {
    list(query?: NewsListQuery): Promise<NewsItem[]>;
    onUpdated(listener: (event: NewsUpdatedEvent) => void): () => void;
  };
  calendar: {
    list(query: CalendarListQuery): Promise<CalendarEvent[]>;
    onUpdated(listener: (event: CalendarUpdatedEvent) => void): () => void;
  };
  alerts: {
    getPrefs(): Promise<AlertPrefs>;
    setPrefs(prefs: AlertPrefs): Promise<AlertPrefs>;
    /** El clic en una notificación nativa pide abrir una vista. */
    onNavigate(listener: (route: NotificationRoute) => void): () => void;
  };
  /** Herramientas de simulación; solo presentes si `isE2eEnabled` (ver abajo). */
  testing?: {
    simulateOffline(offline: boolean): Promise<ConnectivityState>;
    getContextIsolation(): boolean;
    /** Adelanta el reloj del servicio de mercado `ms` y reevalúa su trabajo. */
    advanceMarketClock(ms: number): Promise<MarketClockAdvanceResult>;
    /**
     * Activa (`true`) o desactiva (`false`) el fallo de los proveedores
     * simulados y fuerza una pasada; devuelve los estados del dato resultantes.
     */
    simulateProviderFailure(failing: boolean): Promise<DataStatusEntry[]>;
    /** Fuerza una pasada inmediata del lector de noticias. */
    pollNewsNow(): Promise<NewsPollResult>;
    /** Adelanta el reloj del lector de noticias y del calendario `ms`. */
    advanceNewsClock(ms: number): Promise<NewsClockAdvanceResult>;
  };
}

// ---------------------------------------------------------------------------
// Ganchos de prueba E2E (solo ejecuciones no empaquetadas)
// ---------------------------------------------------------------------------

/**
 * Argumento de proceso que activa `api.testing` en el preload. El proceso
 * principal solo lo añade cuando `isE2eEnabled` devuelve true; el preload
 * no puede leer `app.isPackaged` desde el renderer aislado, así que recibe
 * la decisión ya tomada por `process.argv` (`additionalArguments`).
 */
export const E2E_FLAG_ARG = '--tradia-e2e';

/**
 * Los ganchos de prueba (`api.testing`, intervalos acortados, `userData`
 * aislado) solo existen fuera de la app empaquetada: ninguna variable de
 * entorno puede cambiar el comportamiento del build de producción.
 */
export function isE2eEnabled(isPackaged: boolean, e2eEnv: string | undefined): boolean {
  return !isPackaged && e2eEnv === '1';
}

// ---------------------------------------------------------------------------
// Validación de entrada externa (lado main)
// ---------------------------------------------------------------------------

export class IpcValidationError extends Error {
  constructor(channel: string, detail: string) {
    super(`${channel}: entrada inválida (${detail})`);
    this.name = 'IpcValidationError';
  }
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isNotificationLevel(value: unknown): value is NotificationLevel {
  return typeof value === 'string' && (NOTIFICATION_LEVELS as readonly string[]).includes(value);
}

export function isNotificationRoute(value: unknown): value is NotificationRoute {
  return typeof value === 'string' && (NOTIFICATION_ROUTES as readonly string[]).includes(value);
}

export function isNotificationPayload(value: unknown): value is NotificationPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isNotificationLevel(v.level) &&
    isNonEmptyString(v.title) &&
    typeof v.body === 'string' &&
    (!('navigateTo' in v) || isNotificationRoute(v.navigateTo))
  );
}

export function isNotificationPrefs(value: unknown): value is NotificationPrefs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.info === 'boolean' && typeof v.alerta === 'boolean' && typeof v.critica === 'boolean'
  );
}

export function isSettingsPatch(value: unknown): value is SettingsPatch {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.length === 0) return false;
  if (keys.some((k) => k !== 'autostart' && k !== 'disclaimerAcceptedVersion')) return false;
  if ('autostart' in v && typeof v.autostart !== 'boolean') return false;
  if (
    'disclaimerAcceptedVersion' in v &&
    v.disclaimerAcceptedVersion !== null &&
    typeof v.disclaimerAcceptedVersion !== 'string'
  ) {
    return false;
  }
  return true;
}

export function isTicker(value: unknown): value is string {
  return typeof value === 'string' && TICKER_PATTERN.test(value.trim());
}

/**
 * 'YYYY-MM-DD' que además es una fecha real: `Date.parse` hace rollover de
 * fechas imposibles ('2020-02-30' → '2020-03-01'), la ida y vuelta las rechaza.
 */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isGetBarsRequest(value: unknown): value is GetBarsRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v);
  if (keys.some((k) => k !== 'ticker' && k !== 'desde' && k !== 'hasta')) return false;
  if (!isTicker(v.ticker)) return false;
  if ('desde' in v && !isIsoDate(v.desde)) return false;
  if ('hasta' in v && !isIsoDate(v.hasta)) return false;
  if (typeof v.desde === 'string' && typeof v.hasta === 'string' && v.desde > v.hasta) {
    return false;
  }
  return true;
}

export function isMacroSeriesQuery(value: unknown): value is MacroSeriesQuery {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'desde')) return false;
  return !('desde' in v) || isIsoDate(v.desde);
}

export function isDataStatusState(value: unknown): value is DataStatusState {
  return typeof value === 'string' && (DATA_STATUS_STATES as readonly string[]).includes(value);
}

export function isSourceKind(value: unknown): value is SourceKind {
  return typeof value === 'string' && (SOURCE_KINDS as readonly string[]).includes(value);
}

export function isReliability(value: unknown): value is Reliability {
  return typeof value === 'string' && (RELIABILITY_LEVELS as readonly string[]).includes(value);
}

export function isNewsPriority(value: unknown): value is NewsPriority {
  return typeof value === 'string' && (NEWS_PRIORITIES as readonly string[]).includes(value);
}

export function isImpactLevel(value: unknown): value is ImpactLevel {
  return typeof value === 'string' && (IMPACT_LEVELS as readonly string[]).includes(value);
}

export function isCalendarEventKind(value: unknown): value is CalendarEventKind {
  return typeof value === 'string' && (CALENDAR_EVENT_KINDS as readonly string[]).includes(value);
}

export function isSourceState(value: unknown): value is SourceState {
  return typeof value === 'string' && (SOURCE_STATES as readonly string[]).includes(value);
}

/** Id entero positivo (clave primaria autoincremental). */
export function isSourceId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isSourceConnector(value: unknown): value is string {
  return typeof value === 'string' && CONNECTOR_PATTERN.test(value);
}

/** Nombre visible de una fuente: texto no vacío dentro del tope. */
export function isSourceName(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= SOURCE_NAME_MAX_LENGTH
  );
}

/**
 * URL de una fuente: http(s) o file (los feeds locales de las pruebas E2E),
 * dentro del tope de longitud. Rechaza javascript:, data: y compañía.
 */
export function isSourceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > SOURCE_URL_MAX_LENGTH) {
    return false;
  }
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
  } catch {
    return false;
  }
}

/** Escalar JSON admitido en `params` (con tope de longitud en cadenas). */
function isJsonScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && value.length <= 512)
  );
}

/**
 * Parámetros de un conector: objeto plano de escalares o listas cortas de
 * escalares, con topes para no admitir cargas arbitrarias. Las claves de
 * API no viajan aquí: viven cifradas en `secrets`.
 */
export function isSourceParams(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 32) return false;
  for (const [key, val] of entries) {
    if (key.length === 0 || key.length > 64) return false;
    if (Array.isArray(val)) {
      if (val.length > 32 || !val.every(isJsonScalar)) return false;
    } else if (!isJsonScalar(val)) {
      return false;
    }
  }
  return true;
}

export function isSourceInterval(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= SOURCE_MIN_INTERVAL_SECONDS &&
    value <= SOURCE_MAX_INTERVAL_SECONDS
  );
}

export function isAddSourceRequest(value: unknown): value is AddSourceRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = ['name', 'kind', 'connector', 'url', 'params', 'reliability', 'intervalSeconds'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if (!isSourceName(v.name)) return false;
  if (!isSourceKind(v.kind)) return false;
  if (!isSourceConnector(v.connector)) return false;
  if (!isReliability(v.reliability)) return false;
  if ('url' in v && !isSourceUrl(v.url)) return false;
  if ('params' in v && !isSourceParams(v.params)) return false;
  if ('intervalSeconds' in v && !isSourceInterval(v.intervalSeconds)) return false;
  // Los feeds (rss y redes vía RSS) necesitan su URL.
  if ((v.kind === 'rss' || v.kind === 'redes') && !isSourceUrl(v.url)) return false;
  return true;
}

export function isUpdateSourceRequest(value: unknown): value is UpdateSourceRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = ['id', 'name', 'url', 'params', 'reliability', 'intervalSeconds', 'active'];
  const keys = Object.keys(v);
  if (keys.some((k) => !allowed.includes(k))) return false;
  if (!isSourceId(v.id)) return false;
  // Hace falta al menos un campo a modificar además del id.
  if (keys.length === 1) return false;
  if ('name' in v && !isSourceName(v.name)) return false;
  if ('url' in v && !isSourceUrl(v.url)) return false;
  if ('params' in v && !isSourceParams(v.params)) return false;
  if ('reliability' in v && !isReliability(v.reliability)) return false;
  if ('intervalSeconds' in v && !isSourceInterval(v.intervalSeconds)) return false;
  if ('active' in v && typeof v.active !== 'boolean') return false;
  return true;
}

export function isTestSourceRequest(value: unknown): value is TestSourceRequest {
  if (typeof value !== 'object' || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length === 1) {
    // { id } solo: prueba de una fuente ya guardada.
    return keys[0] === 'id' && isSourceId((value as Record<string, unknown>).id);
  }
  return isAddSourceRequest(value);
}

export function isNewsListQuery(value: unknown): value is NewsListQuery {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = [
    'desde',
    'hasta',
    'priority',
    'reliability',
    'ticker',
    'confirmed',
    'sourceId',
    'limit',
  ];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('desde' in v && !isIsoDate(v.desde)) return false;
  if ('hasta' in v && !isIsoDate(v.hasta)) return false;
  if (typeof v.desde === 'string' && typeof v.hasta === 'string' && v.desde > v.hasta) {
    return false;
  }
  if ('priority' in v && !isNewsPriority(v.priority)) return false;
  if ('reliability' in v && !isReliability(v.reliability)) return false;
  if ('ticker' in v && !isTicker(v.ticker)) return false;
  if ('confirmed' in v && typeof v.confirmed !== 'boolean') return false;
  if ('sourceId' in v && !isSourceId(v.sourceId)) return false;
  if (
    'limit' in v &&
    (typeof v.limit !== 'number' ||
      !Number.isInteger(v.limit) ||
      v.limit < 1 ||
      v.limit > NEWS_LIST_MAX_LIMIT)
  ) {
    return false;
  }
  return true;
}

export function isAlertPrefs(value: unknown): value is AlertPrefs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'leadMinutes')) return false;
  return (
    typeof v.leadMinutes === 'number' &&
    (ALERT_LEAD_MINUTES as readonly number[]).includes(v.leadMinutes)
  );
}

export function isCalendarListQuery(value: unknown): value is CalendarListQuery {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'desde' && k !== 'hasta')) return false;
  if (!isIsoDate(v.desde) || !isIsoDate(v.hasta)) return false;
  return v.desde <= v.hasta;
}

/** Lista plana de todos los canales, para pruebas y comprobaciones. */
export function allIpcChannels(): string[] {
  const channels: string[] = [];
  for (const group of Object.values(IPC_CHANNELS)) {
    for (const channel of Object.values(group)) {
      channels.push(channel);
    }
  }
  return channels;
}
