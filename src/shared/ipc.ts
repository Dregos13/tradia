/**
 * Contrato IPC de Tradia — Fase 0-1.
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
  },
  macro: {
    getSeries: 'macro:get-series',
  },
  dataStatus: {
    get: 'data-status:get',
    /** Evento main → renderer: cambió la salud de un dato. */
    changed: 'data-status:changed',
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

export interface NotificationPayload {
  level: NotificationLevel;
  title: string;
  body: string;
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
  /** Herramientas de simulación; solo presentes si `isE2eEnabled` (ver abajo). */
  testing?: {
    simulateOffline(offline: boolean): Promise<ConnectivityState>;
    getContextIsolation(): boolean;
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

export function isNotificationPayload(value: unknown): value is NotificationPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return isNotificationLevel(v.level) && isNonEmptyString(v.title) && typeof v.body === 'string';
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
