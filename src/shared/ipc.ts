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

import {
  STRATEGY_MARKET_MAX_LENGTH,
  STRATEGY_MAX_MARKETS,
  STRATEGY_MAX_PARAMETERS,
  STRATEGY_NAME_MAX_LENGTH,
  STRATEGY_NOTE_MAX_LENGTH,
  STRATEGY_REGIME_MAX_LENGTH,
  STRATEGY_STATUSES,
  STRATEGY_TEXT_MAX_LENGTH,
} from './strategy';
import type {
  CreateStrategyRequest,
  GetStrategyRequest,
  SetStrategyStatusRequest,
  Strategy,
  StrategyChangelogEntry,
  StrategyCosts,
  StrategyParameterRange,
  StrategyPeriod,
  StrategyRules,
  StrategyStatus,
  StrategySummary,
  UpdateStrategyRequest,
} from './strategy';
import {
  BACKTEST_MAX_INITIAL_CASH,
  BACKTEST_MAX_LIMIT,
  BACKTEST_MAX_POSITIONS,
  BACKTEST_MAX_RISK_PER_TRADE,
  BACKTEST_MAX_UNIVERSE,
  BACKTEST_MIN_INITIAL_CASH,
  BACKTEST_MIN_RISK_PER_TRADE,
  MONTE_CARLO_MAX_SIMULATIONS,
  MONTE_CARLO_METHODS,
  OBJECTIVE_METRIC_NAMES,
} from './backtest';
import type {
  BacktestFinalTestRequest,
  BacktestListQuery,
  BacktestProgressEvent,
  BacktestReport,
  BacktestRunRequest,
  BacktestRunSummary,
  StressRequest,
  StressResultDto,
} from './backtest';
import {
  KILL_SWITCH_CAUSES,
  RISK_BOUNDS,
  RISK_DECISION_STATUSES,
  RISK_VETOES_MAX_LIMIT,
  SIGNAL_DIRECTIONS,
  SIGNAL_ORIGINS,
  VETO_REASON_CODES,
} from './risk';
import type {
  CautionState,
  KillSwitchCause,
  KillSwitchState,
  LoggedRiskDecision,
  RiskDecision,
  RiskDecisionStatus,
  RiskLimits,
  RiskOverview,
  RiskVeto,
  SignalDirection,
  SignalIntent,
  VetoReasonCode,
} from './risk';
import { SIGNALS_LIST_MAX_LIMIT } from './signals';
import type {
  PaperPortfolioOverview,
  Signal,
  SignalEngineRunResult,
  SignalNewEvent,
  SignalStrategyState,
  SignalsListQuery,
} from './signals';
import {
  BROKER_E2E_DISCREPANCIES,
  BROKER_E2E_FAILURES,
  BROKER_ORDERS_MAX_LIMIT,
  BROKER_ORDER_SIDES,
  BROKER_ORDER_STATUSES,
  DEVIATION_MARGIN_PP_BOUNDS,
  DEVIATION_PERIODS,
  DEVIATION_SLIPPAGE_BPS_BOUNDS,
} from './broker';
import type {
  BrokerConnectRequest,
  BrokerCredentials,
  BrokerDiscrepancyRequest,
  BrokerDiscrepancyResult,
  BrokerE2eDiscrepancy,
  BrokerE2eFailure,
  BrokerFailNextRequest,
  BrokerFailNextResult,
  BrokerOrder,
  BrokerOrdersQuery,
  BrokerOrderStatus,
  BrokerSeedWeeksRequest,
  BrokerSeedWeeksResult,
  BrokerStatus,
  BrokerTestRequest,
  BrokerTestResult,
  CancelOrderRequest,
  CreateOrderRequest,
  DeviationPeriod,
  DeviationReport,
  DeviationReportQuery,
  ReconcileDiscrepancyEvent,
  ReconcileRun,
  ReconcileStatusResult,
} from './broker';
import {
  BACKUP_FILE_PATTERN,
  DELIVERY_ADDRESS_MAX_LENGTH,
  DELIVERY_CHAT_ID_MAX_LENGTH,
  DELIVERY_EVENT_KINDS,
  DELIVERY_HOST_MAX_LENGTH,
  DELIVERY_TESTABLE_CHANNELS,
  HHMM_PATTERN,
  JOURNAL_ENTRY_TYPES,
  JOURNAL_LIST_MAX_LIMIT,
  JOURNAL_RESULTS,
  SMTP_SECURITY_MODES,
} from './journal';
import type {
  BackupInfo,
  BackupRestoreRequest,
  BackupRestoreResult,
  DeliveryConfig,
  DeliveryConfigInput,
  DeliveryEventKind,
  DeliveryTestRequest,
  DeliveryTestResult,
  JournalEntry,
  JournalEntryType,
  JournalExportRequest,
  JournalExportResult,
  JournalListQuery,
  JournalPage,
  JournalResult,
  JournalUpdatedEvent,
  OpenFolderResult,
  RoutineClockAdvanceResult,
  RoutineConfig,
} from './journal';

// El dominio de estrategias y el de backtest (fase 2) viven en ./strategy y
// ./backtest; se reexportan aquí para que el renderer y el preload sigan
// importando de un solo sitio. El dominio de riesgo (fase 3) vive en ./risk.
// El de señales, diario y configuración operativa (fase 4) vive en
// ./signals y ./journal. El del broker en modo paper (fase 5) vive en
// ./broker.
export * from './strategy';
export * from './backtest';
export * from './risk';
export * from './signals';
export * from './journal';
export * from './broker';

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
  strategies: {
    list: 'strategies:list',
    /** `{ id, version? }`: la versión vigente por defecto o una concreta. */
    get: 'strategies:get',
    create: 'strategies:create',
    /** Edición versionada: exige `note` y crea la versión N+1. */
    update: 'strategies:update',
    /** Cambio de estado: anota el registro sin crear versión nueva. */
    setStatus: 'strategies:set-status',
    /** Registro de cambios de una estrategia, más reciente primero. */
    history: 'strategies:history',
  },
  backtest: {
    /** Lanza la ejecución completa (métricas, walk-forward, sensibilidad, MC). */
    run: 'backtest:run',
    /** Ejecuciones guardadas, más recientes primero (`{strategyId?, version?, limit?}`). */
    list: 'backtest:list',
    /** Informe completo de una ejecución por id. */
    get: 'backtest:get',
    /**
     * Ejecuta el tramo de prueba bloqueado de la versión: una sola vez.
     * La segunda llamada para la misma versión se rechaza.
     */
    runFinalTest: 'backtest:run-final-test',
    /** Evento main → renderer: progreso de una ejecución en curso. */
    progress: 'backtest:progress',
  },
  stress: {
    /** Pruebas de estrés guardadas de una estrategia (`{strategyId, version?}`). */
    get: 'stress:get',
    /** Ejecuta de nuevo las tres crisis y las guarda en la ficha. */
    run: 'stress:run',
  },
  risk: {
    getLimits: 'risk:get-limits',
    /** Sustituye los límites; el proceso principal exige RISK_BOUNDS. */
    setLimits: 'risk:set-limits',
    /** Registro de vetos (`{rule?, limit?, offset?}`), más reciente primero. */
    listVetoes: 'risk:list-vetoes',
    /** Pasarela única: toda señal u orden entra por aquí. */
    submitSignal: 'risk:submit-signal',
    /**
     * Cartera simulada para el panel (fase 4): posiciones con marca,
     * drawdown frente a su límite y exposición por activo y sector.
     */
    getPortfolio: 'risk:get-portfolio',
    getKillSwitch: 'risk:get-kill-switch',
    /** Activa la parada de emergencia al instante, sin confirmación. */
    activateKillSwitch: 'risk:activate-kill-switch',
    /** Reanuda solo con `{confirm: true}`; nunca automática. */
    resumeKillSwitch: 'risk:resume-kill-switch',
    getCaution: 'risk:get-caution',
    /**
     * Solo desarrollo (TRADIA_E2E y sin empaquetar): activa la parada como
     * si la hubiera disparado la causa automática dada.
     */
    simulateCause: 'risk:simulate-cause',
    /**
     * Solo desarrollo (TRADIA_E2E y sin empaquetar): inyecta un evento del
     * calendario para que el modo cautela lo evalúe al instante.
     */
    simulateCalendarEvent: 'risk:simulate-calendar-event',
    /**
     * Solo desarrollo (TRADIA_E2E y sin empaquetar): siembra la cartera
     * simulada (posiciones y curva de capital) para las pruebas.
     */
    seedPortfolio: 'risk:seed-portfolio',
    /** Evento main → renderer: cambió cualquier estado de riesgo (RiskOverview). */
    changed: 'risk:changed',
    /** Evento main → renderer: una señal quedó vetada o reducida (RiskVeto). */
    vetoed: 'risk:vetoed',
  },
  signals: {
    /** Señales emitidas, más recientes primero (SignalsListQuery). */
    list: 'signals:list',
    /** Detalle de una señal por id. */
    get: 'signals:get',
    /** Estado de evaluación por estrategia (bloque «Estrategias» del panel). */
    strategies: 'signals:strategies',
    /**
     * Solo desarrollo (TRADIA_E2E y sin empaquetar): fuerza una evaluación
     * inmediata al cierre simulado, sin esperar a una vela nueva.
     */
    evaluateNow: 'signals:evaluate-now',
    /** Evento main → renderer: se emitió una señal nueva (SignalNewEvent). */
    new: 'signals:new',
  },
  journal: {
    /** Diario paginado con filtros (JournalListQuery) y recuento total. */
    list: 'journal:list',
    /** Entrada completa por id (detalle del diario). */
    get: 'journal:get',
    /**
     * Exporta el conjunto filtrado a CSV (RFC 4180, UTF-8 con BOM). Abre el
     * diálogo de guardar; en modo E2E escribe en la ruta indicada.
     */
    exportCsv: 'journal:export-csv',
    /** Evento main → renderer: se añadió una entrada (JournalUpdatedEvent). */
    updated: 'journal:updated',
  },
  delivery: {
    /** Config de canales externos (sin secretos: solo «guardado»). */
    getConfig: 'delivery:get-config',
    /** Sustituye la config de canales; los secretos van por `secrets:*`. */
    setConfig: 'delivery:set-config',
    /** «Enviar prueba» por un canal externo (`{channel}`). */
    test: 'delivery:test',
  },
  routine: {
    /** Horarios de la rutina diaria ('HH:MM', America/New_York). */
    getConfig: 'routine:get-config',
    setConfig: 'routine:set-config',
    /**
     * Solo desarrollo (TRADIA_E2E y sin empaquetar): adelanta el reloj de
     * la rutina para recibir los resúmenes sin esperar a la hora real.
     */
    advanceClock: 'routine:advance-clock',
  },
  backup: {
    /** Copias guardadas en userData/backups con su estado de integridad. */
    list: 'backup:list',
    /** Copia manual inmediata de la base local. */
    create: 'backup:create',
    /**
     * Restaura una copia: guarda antes una del estado actual, sustituye la
     * base y reinicia la app. Exige `{fileName, confirm: true}`.
     */
    restore: 'backup:restore',
  },
  broker: {
    /** Guarda las claves cifradas, valida la cuenta paper y conecta. */
    connect: 'broker:connect',
    /** Borra las claves guardadas y desconecta la cuenta paper. */
    disconnect: 'broker:disconnect',
    /** Estado de la conexión: cuenta, saldo paper e interruptor de ejecución. */
    status: 'broker:status',
    /** «Probar conexión»: valida unas claves nuevas o las ya guardadas. */
    test: 'broker:test',
    /**
     * Solo desarrollo (TRADIA_E2E y sin empaquetar): arma un fallo
     * (timeout, 429, 5xx, rechazo o ejecución parcial) para la próxima
     * llamada del broker simulado.
     */
    failNext: 'broker:fail-next',
    /**
     * Solo desarrollo (TRADIA_E2E y sin empaquetar): fabrica a propósito
     * un descuadre app ↔ broker para comprobar la conciliación.
     */
    createDiscrepancy: 'broker:create-discrepancy',
    /**
     * Solo desarrollo (TRADIA_E2E y sin empaquetar): siembra semanas de
     * operaciones paper cerradas para el informe real vs backtest.
     */
    seedWeeks: 'broker:seed-weeks',
    /** Evento main → renderer: una orden cambió (BrokerOrderUpdatedEvent). */
    orderUpdated: 'broker:order-updated',
  },
  orders: {
    /** Órdenes paper registradas, más recientes primero (BrokerOrdersQuery). */
    list: 'orders:list',
    /**
     * Crea una orden limitada manual (`{ticker, side, quantity,
     * limitPrice}`): queda pendiente en el broker hasta ejecutarse o
     * cancelarse. Sin señal ni estrategia asociadas.
     */
    create: 'orders:create',
    /** Cancela una orden abierta por su id local (`{id}`). */
    cancel: 'orders:cancel',
  },
  reconcile: {
    /** «Conciliar ahora»: ejecuta la conciliación con el broker. */
    run: 'reconcile:run',
    /** Última ejecución y descuadres abiertos. */
    status: 'reconcile:status',
    /** Evento main → renderer: la conciliación encontró descuadres. */
    discrepancy: 'reconcile:discrepancy',
  },
  deviation: {
    /** Informe real frente a backtest (`{period: 'semanal'|'mensual'}`). */
    report: 'deviation:report',
  },
  logs: {
    /** Abre la carpeta de registros rotados en el explorador del SO. */
    openFolder: 'logs:open-folder',
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
 * aviso previo de un evento abre Calendario, el de una noticia, Noticias,
 * la crítica de la parada de emergencia, Riesgo, las de señales y
 * resúmenes de la fase 4, el Diario o el panel de Inicio, el descuadre de
 * la conciliación, Órdenes, y la alerta de desviación, Real vs backtest.
 * Son las rutas por hash del renderer (`#noticias`, `#calendario`,
 * `#riesgo`, `#diario`, `#inicio`, `#ordenes`, `#real-vs-backtest`).
 */
export const NOTIFICATION_ROUTES = [
  'noticias',
  'calendario',
  'riesgo',
  'diario',
  'inicio',
  'ordenes',
  'real-vs-backtest',
] as const;
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
  /** Interruptor «Ejecutar señales aprobadas en paper» (fase 5). */
  brokerExecutionEnabled: boolean;
  /** Margen de desviación real vs backtest (± puntos porcentuales). */
  deviationMarginPp: number;
  /** Slippage medio máximo admitido en el informe (puntos básicos). */
  deviationSlippageBps: number;
}

/** Solo estas claves son escribibles desde el renderer. */
export interface SettingsPatch {
  autostart?: boolean;
  disclaimerAcceptedVersion?: string | null;
  brokerExecutionEnabled?: boolean;
  /** Debe quedar dentro de DEVIATION_MARGIN_PP_BOUNDS. */
  deviationMarginPp?: number;
  /** Debe quedar dentro de DEVIATION_SLIPPAGE_BPS_BOUNDS. */
  deviationSlippageBps?: number;
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
// Dominio: motor de riesgo (fase 3)
// ---------------------------------------------------------------------------

/** Filtros de `risk:list-vetoes`; todos opcionales y combinables. */
export interface RiskVetoesQuery {
  /** Filtra por la regla incumplida (código de veto). */
  rule?: VetoReasonCode;
  /** Filtra por el tipo de decisión registrada. */
  decision?: LoggedRiskDecision;
  /** Filtra por el activo de la señal. */
  ticker?: string;
  /** Máximo de resultados; tope `RISK_VETOES_MAX_LIMIT`. */
  limit?: number;
  /** Desplazamiento para paginar (≥ 0). */
  offset?: number;
}

/**
 * Reanudación de la parada de emergencia: exige una confirmación
 * explícita (`confirm: true`); el tipo ya impide el reinicio automático.
 */
export interface KillSwitchResumeRequest {
  /** Confirmación explícita del usuario; tiene que ser true. */
  confirm: true;
  /** Nota opcional que queda registrada en kill_switch_events. */
  note?: string;
}

/**
 * Evento inyectado por el gancho E2E `risk:simulate-calendar-event`:
 * la misma forma que `CalendarEvent` sin los campos que rellena el
 * servicio (id, país y origen, fijado a 'simulado').
 */
export interface SimulateCalendarEventRequest {
  kind: CalendarEventKind;
  title: string;
  /** Instante UTC (ISO 8601). */
  dateUtc: string;
  impact: ImpactLevel;
  /** Ticker relacionado en eventos de resultados. */
  asset?: string;
}

/** Posición con la que sembrar la cartera simulada (gancho E2E). */
export interface SeedRiskPosition {
  ticker: string;
  direction: SignalDirection;
  /** Precio de entrada (> 0). */
  entry: number;
  /** Stop de protección, si lo tiene. */
  stop?: number | null;
  /** Objetivo de beneficio, si lo tiene. */
  target?: number | null;
  /** Tamaño en unidades (> 0). */
  size: number;
  /** Sector y divisa para los límites de exposición (opcionales). */
  sector?: string;
  currency?: string;
  /** Fecha de apertura (ISO 8601); 'ahora' por defecto. */
  openedAt?: string;
  /** Fecha de cierre (ISO 8601); sin ella la posición queda abierta. */
  closedAt?: string;
}

/** Petición del gancho E2E `risk:seed-portfolio`. */
export interface SeedPortfolioRequest {
  /** Capital actual de la cartera (crea un punto de equity «ahora»). */
  equity?: number;
  /** Posiciones con las que arrancar la cartera simulada. */
  positions?: SeedRiskPosition[];
  /** Puntos de la curva de capital (para pérdidas y drawdown). */
  equityHistory?: { at: string; equity: number }[];
}

/** Resultado del gancho `risk:seed-portfolio`. */
export interface SeedPortfolioResult {
  /** Posiciones abiertas tras la siembra. */
  openPositions: number;
  /** Puntos de capital guardados en total. */
  equityPoints: number;
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
  strategies: {
    /** Biblioteca: la versión vigente de cada estrategia. */
    list(): Promise<StrategySummary[]>;
    /** Ficha completa; null si la estrategia o la versión no existen. */
    get(request: GetStrategyRequest): Promise<Strategy | null>;
    /** Alta en estado 'investigacion': crea la versión 1. */
    create(request: CreateStrategyRequest): Promise<Strategy>;
    /** Edición con nota obligatoria: crea la versión N+1 y conserva las demás. */
    update(request: UpdateStrategyRequest): Promise<Strategy>;
    /** Cambio de estado: entrada en el registro, sin versión nueva. */
    setStatus(request: SetStrategyStatusRequest): Promise<Strategy>;
    /** Registro de cambios, más reciente primero. */
    history(id: number): Promise<StrategyChangelogEntry[]>;
  };
  backtest: {
    /**
     * Lanza el pipeline completo y devuelve el informe guardado. El tramo
     * de prueba (último 20 % por defecto) queda bloqueado y no se ejecuta.
     */
    run(request: BacktestRunRequest): Promise<BacktestReport>;
    /** Ejecuciones guardadas, más recientes primero. */
    list(query?: BacktestListQuery): Promise<BacktestRunSummary[]>;
    /** Informe completo de una ejecución; null si no existe. */
    get(id: number): Promise<BacktestReport | null>;
    /**
     * Ejecuta el tramo de prueba bloqueado: una vez por versión. La
     * segunda llamada rechaza (la prueba queda «Ejecutada y bloqueada»).
     */
    runFinalTest(request: BacktestFinalTestRequest): Promise<BacktestReport>;
    /** Progreso de las ejecuciones en curso. */
    onProgress(listener: (event: BacktestProgressEvent) => void): () => void;
  };
  stress: {
    /** Resultados de las crisis 2008/2020/2022 guardados en la ficha. */
    get(request: StressRequest): Promise<StressResultDto[]>;
    /** Ejecuta de nuevo las pruebas de estrés y las guarda. */
    run(request: StressRequest): Promise<StressResultDto[]>;
  };
  risk: {
    /** Límites vigentes (RISK_DEFAULTS si el usuario nunca los cambió). */
    getLimits(): Promise<RiskLimits>;
    /**
     * Sustituye los límites. El proceso principal valida los márgenes
     * duros (RISK_BOUNDS) y rechaza con un error legible los valores
     * fuera de ellos. Devuelve los límites ya guardados.
     */
    setLimits(limits: RiskLimits): Promise<RiskLimits>;
    /** Registro de vetos, más reciente primero. */
    listVetoes(query?: RiskVetoesQuery): Promise<RiskVeto[]>;
    /**
     * Pasarela única del motor de riesgo: evalúa la señal contra la
     * parada, las reglas por operación, los límites de cartera y la
     * cautela, y devuelve la decisión con sus motivos.
     */
    submitSignal(signal: SignalIntent): Promise<RiskDecision>;
    /**
     * Cartera simulada para el panel (fase 4): posiciones abiertas con su
     * marca y resultado, drawdown frente a su límite y exposición por
     * activo y por sector.
     */
    getPortfolio(): Promise<PaperPortfolioOverview>;
    getKillSwitch(): Promise<KillSwitchState>;
    /** Detiene señales y órdenes al instante; no pide confirmación. */
    activateKillSwitch(): Promise<KillSwitchState>;
    /** Reanuda solo con confirmación explícita; queda registrada. */
    resumeKillSwitch(request: KillSwitchResumeRequest): Promise<KillSwitchState>;
    /** Estado actual del modo cautela por calendario/mercado. */
    getCaution(): Promise<CautionState>;
    /** Cambió cualquier estado de riesgo (límites, parada o cautela). */
    onChanged(listener: (overview: RiskOverview) => void): () => void;
    /** Una señal quedó vetada o reducida; llega la entrada del registro. */
    onVetoed(listener: (veto: RiskVeto) => void): () => void;
  };
  signals: {
    /** Señales emitidas, más recientes primero. */
    list(query?: SignalsListQuery): Promise<Signal[]>;
    /** Detalle de una señal; null si no existe. */
    get(id: number): Promise<Signal | null>;
    /** Estado de evaluación por estrategia (bloque «Estrategias»). */
    strategies(): Promise<SignalStrategyState[]>;
    /** El motor emitió una señal nueva (aprobada, reducida o vetada). */
    onNew(listener: (event: SignalNewEvent) => void): () => void;
  };
  journal: {
    /** Diario paginado con filtros y recuento total del conjunto. */
    list(query?: JournalListQuery): Promise<JournalPage>;
    /** Entrada completa; null si no existe. */
    get(id: number): Promise<JournalEntry | null>;
    /**
     * Exporta el conjunto filtrado a CSV (RFC 4180, UTF-8 con BOM). En la
     * app normal abre el diálogo de guardar; `request.path` solo se
     * respeta en modo E2E.
     */
    exportCsv(request?: JournalExportRequest): Promise<JournalExportResult>;
    /** Se añadió una entrada al diario. */
    onUpdated(listener: (event: JournalUpdatedEvent) => void): () => void;
  };
  delivery: {
    /** Config de Telegram y correo; los secretos llegan como «guardado». */
    getConfig(): Promise<DeliveryConfig>;
    /** Sustituye la config de canales. Los secretos van por `secrets:*`. */
    setConfig(config: DeliveryConfigInput): Promise<DeliveryConfig>;
    /** Envía una prueba por un canal externo. */
    test(request: DeliveryTestRequest): Promise<DeliveryTestResult>;
  };
  routine: {
    /** Horarios de la rutina ('HH:MM', America/New_York). */
    getConfig(): Promise<RoutineConfig>;
    setConfig(config: RoutineConfig): Promise<RoutineConfig>;
  };
  backup: {
    /** Copias guardadas con fecha, tamaño, esquema e integridad. */
    list(): Promise<BackupInfo[]>;
    /** Crea una copia ahora y devuelve su ficha. */
    create(): Promise<BackupInfo>;
    /**
     * Restaura una copia: guarda antes una del estado actual, sustituye la
     * base y reinicia la app. La confirmación es obligatoria.
     */
    restore(request: BackupRestoreRequest): Promise<BackupRestoreResult>;
  };
  broker: {
    /**
     * Guarda las claves cifradas (secrets; el renderer nunca las lee),
     * valida la cuenta contra el endpoint paper y conecta. Rechaza con un
     * mensaje claro las claves de una cuenta live.
     */
    connect(request: BrokerConnectRequest): Promise<BrokerStatus>;
    /** Borra las claves y desconecta; la simulación local sigue igual. */
    disconnect(): Promise<BrokerStatus>;
    /** Estado actual: cuenta, saldo paper e interruptor de ejecución. */
    status(): Promise<BrokerStatus>;
    /**
     * «Probar conexión»: valida unas claves nuevas sin guardarlas o, sin
     * campos, las ya guardadas.
     */
    test(request?: BrokerTestRequest): Promise<BrokerTestResult>;
    /** Una orden paper cambió de estado o de ejecución. */
    onOrderUpdated(listener: (event: BrokerOrder) => void): () => void;
  };
  orders: {
    /** Órdenes paper con filtros, más recientes primero. */
    list(query?: BrokerOrdersQuery): Promise<BrokerOrder[]>;
    /**
     * Envía una orden limitada manual a la cuenta paper y devuelve la
     * orden ya registrada (pendiente/enviada/rechazada según el broker).
     */
    create(request: CreateOrderRequest): Promise<BrokerOrder>;
    /**
     * Cancela una orden abierta (pendiente, enviada o parcial) y devuelve
     * la orden ya actualizada.
     */
    cancel(request: CancelOrderRequest): Promise<BrokerOrder>;
  };
  reconcile: {
    /** Ejecuta la conciliación app ↔ broker y devuelve su resultado. */
    run(): Promise<ReconcileRun>;
    /** Última ejecución y los descuadres aún abiertos. */
    status(): Promise<ReconcileStatusResult>;
    /**
     * Tras cada ejecución con descuadres llega el detalle concreto; una
     * ejecución limpia llega con la lista vacía (el aviso se cierra).
     */
    onDiscrepancy(listener: (event: ReconcileDiscrepancyEvent) => void): () => void;
  };
  deviation: {
    /** Informe real frente a backtest por estrategia y periodo cerrado. */
    report(query: DeviationReportQuery): Promise<DeviationReport>;
  };
  logs: {
    /** Abre la carpeta de registros rotados en el explorador del SO. */
    openFolder(): Promise<OpenFolderResult>;
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
    /** Ganchos del motor de riesgo (fase 3). */
    risk: {
      /** Activa la parada como si la hubiera disparado la causa dada. */
      simulateCause(cause: KillSwitchCause): Promise<KillSwitchState>;
      /** Inyecta un evento del calendario y devuelve la cautela resultante. */
      simulateCalendarEvent(event: SimulateCalendarEventRequest): Promise<CautionState>;
      /** Siembra la cartera simulada (posiciones y curva de capital). */
      seedPortfolio(request: SeedPortfolioRequest): Promise<SeedPortfolioResult>;
    };
    /** Adelanta el reloj de la rutina diaria `ms` y reevalúa los envíos. */
    advanceRoutineClock(ms: number): Promise<RoutineClockAdvanceResult>;
    /** Fuerza una evaluación inmediata del motor de señales. */
    evaluateSignalsNow(): Promise<SignalEngineRunResult>;
    /** Ganchos del broker simulado (fase 5). */
    broker: {
      /** Arma un fallo para la próxima llamada del broker simulado. */
      failNext(request: BrokerFailNextRequest): Promise<BrokerFailNextResult>;
      /** Fabrica un descuadre app ↔ broker para probar la conciliación. */
      createDiscrepancy(request: BrokerDiscrepancyRequest): Promise<BrokerDiscrepancyResult>;
      /** Siembra semanas de operaciones paper cerradas. */
      seedWeeks(request?: BrokerSeedWeeksRequest): Promise<BrokerSeedWeeksResult>;
    };
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
  const allowed = [
    'autostart',
    'disclaimerAcceptedVersion',
    'brokerExecutionEnabled',
    'deviationMarginPp',
    'deviationSlippageBps',
  ];
  if (keys.some((k) => !allowed.includes(k))) return false;
  if ('autostart' in v && typeof v.autostart !== 'boolean') return false;
  if (
    'disclaimerAcceptedVersion' in v &&
    v.disclaimerAcceptedVersion !== null &&
    typeof v.disclaimerAcceptedVersion !== 'string'
  ) {
    return false;
  }
  if ('brokerExecutionEnabled' in v && typeof v.brokerExecutionEnabled !== 'boolean') return false;
  if (
    'deviationMarginPp' in v &&
    (typeof v.deviationMarginPp !== 'number' ||
      !Number.isFinite(v.deviationMarginPp) ||
      v.deviationMarginPp < DEVIATION_MARGIN_PP_BOUNDS.min ||
      v.deviationMarginPp > DEVIATION_MARGIN_PP_BOUNDS.max)
  ) {
    return false;
  }
  if (
    'deviationSlippageBps' in v &&
    (typeof v.deviationSlippageBps !== 'number' ||
      !Number.isFinite(v.deviationSlippageBps) ||
      v.deviationSlippageBps < DEVIATION_SLIPPAGE_BPS_BOUNDS.min ||
      v.deviationSlippageBps > DEVIATION_SLIPPAGE_BPS_BOUNDS.max)
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

// ---------------------------------------------------------------------------
// Guardas: estrategias (fase 2)
// ---------------------------------------------------------------------------

export function isStrategyStatus(value: unknown): value is StrategyStatus {
  return typeof value === 'string' && (STRATEGY_STATUSES as readonly string[]).includes(value);
}

/** Id entero positivo de estrategia (clave primaria autoincremental). */
export function isStrategyId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Texto corto requerido (nombre de estrategia). */
export function isStrategyName(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= STRATEGY_NAME_MAX_LENGTH
  );
}

/** Texto largo requerido (hipótesis, reglas): no vacío dentro del tope. */
function isStrategyText(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= STRATEGY_TEXT_MAX_LENGTH
  );
}

/** Nota del registro de cambios: obligatoria en la edición, opcional en el alta. */
export function isStrategyNote(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim().length > 0 && value.length <= STRATEGY_NOTE_MAX_LENGTH
  );
}

export function isStrategyRules(value: unknown): value is StrategyRules {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'entry' && k !== 'exit' && k !== 'stop' && k !== 'target')) {
    return false;
  }
  return (
    isStrategyText(v.entry) &&
    isStrategyText(v.exit) &&
    isStrategyText(v.stop) &&
    isStrategyText(v.target)
  );
}

/** Periodo 'YYYY-MM-DD' con ambos extremos reales y ordenados. */
export function isStrategyPeriod(value: unknown): value is StrategyPeriod {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'desde' && k !== 'hasta')) return false;
  if (!isIsoDate(v.desde) || !isIsoDate(v.hasta)) return false;
  return v.desde <= v.hasta;
}

/** Parámetros ejecutables: mapa nombre → número finito, con topes. */
export function isStrategyParameters(value: unknown): value is Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > STRATEGY_MAX_PARAMETERS) return false;
  return entries.every(
    ([key, val]) =>
      key.trim().length > 0 && key.length <= 64 && typeof val === 'number' && Number.isFinite(val),
  );
}

export function isStrategyParameterRange(value: unknown): value is StrategyParameterRange {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'min' && k !== 'max' && k !== 'step')) return false;
  return (
    typeof v.min === 'number' &&
    Number.isFinite(v.min) &&
    typeof v.max === 'number' &&
    Number.isFinite(v.max) &&
    typeof v.step === 'number' &&
    Number.isFinite(v.step) &&
    v.min <= v.max &&
    v.step > 0
  );
}

/**
 * Rangos para el mapa de sensibilidad: cada rango es válido y, cuando la
 * petición trae `parameters`, su clave tiene que existir en ellos.
 */
export function isStrategyParameterRanges(
  value: unknown,
  parameters?: Record<string, number>,
): value is Record<string, StrategyParameterRange> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > STRATEGY_MAX_PARAMETERS) return false;
  return entries.every(
    ([key, range]) =>
      key.trim().length > 0 &&
      key.length <= 64 &&
      isStrategyParameterRange(range) &&
      (parameters === undefined || key in parameters),
  );
}

/** Mercados de la ficha: 1..64 nombres cortos (tickers o descripciones). */
export function isStrategyMarkets(value: unknown): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > STRATEGY_MAX_MARKETS) {
    return false;
  }
  return value.every(
    (market) =>
      typeof market === 'string' &&
      market.trim().length > 0 &&
      market.length <= STRATEGY_MARKET_MAX_LENGTH,
  );
}

/** Costes asumidos: los cuatro campos, números finitos no negativos. */
export function isStrategyCosts(value: unknown): value is StrategyCosts {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = ['commissionPct', 'commissionMin', 'slippageBps', 'spreadBps'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  return allowed.every(
    (key) => typeof v[key] === 'number' && Number.isFinite(v[key]) && (v[key] as number) >= 0,
  );
}

/** Campos versionables de la ficha, para filtrar claves ajenas en las peticiones. */
const STRATEGY_DRAFT_KEYS = [
  'name',
  'hypothesis',
  'rules',
  'parameters',
  'parameterRanges',
  'markets',
  'trainingPeriod',
  'outOfSamplePeriod',
  'regime',
  'assumedCosts',
] as const;

/** Valida cada campo versionable presente en `v`. Devuelve los presentes. */
function checkStrategyDraftFields(
  v: Record<string, unknown>,
  { requireAll }: { requireAll: boolean },
): string[] | null {
  const required = ['name', 'hypothesis', 'rules', 'parameters', 'markets', 'regime'];
  const present = STRATEGY_DRAFT_KEYS.filter((key) => key in v);
  if (requireAll && required.some((key) => !(key in v))) return null;

  if ('name' in v && !isStrategyName(v.name)) return null;
  if ('hypothesis' in v && !isStrategyText(v.hypothesis)) return null;
  if ('rules' in v && !isStrategyRules(v.rules)) return null;
  if ('parameters' in v && !isStrategyParameters(v.parameters)) return null;
  const parameters = 'parameters' in v ? (v.parameters as Record<string, number>) : undefined;
  if ('parameterRanges' in v && !isStrategyParameterRanges(v.parameterRanges, parameters)) {
    return null;
  }
  if ('markets' in v && !isStrategyMarkets(v.markets)) return null;
  if ('trainingPeriod' in v && v.trainingPeriod !== null && !isStrategyPeriod(v.trainingPeriod)) {
    return null;
  }
  if (
    'outOfSamplePeriod' in v &&
    v.outOfSamplePeriod !== null &&
    !isStrategyPeriod(v.outOfSamplePeriod)
  ) {
    return null;
  }
  if (
    'regime' in v &&
    (typeof v.regime !== 'string' ||
      v.regime.trim().length === 0 ||
      v.regime.length > STRATEGY_REGIME_MAX_LENGTH)
  ) {
    return null;
  }
  if ('assumedCosts' in v && !isStrategyCosts(v.assumedCosts)) return null;
  return present;
}

export function isCreateStrategyRequest(value: unknown): value is CreateStrategyRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => k !== 'note' && !(STRATEGY_DRAFT_KEYS as readonly string[]).includes(k),
    )
  ) {
    return false;
  }
  if (checkStrategyDraftFields(v, { requireAll: true }) === null) return false;
  return !('note' in v) || isStrategyNote(v.note);
}

export function isUpdateStrategyRequest(value: unknown): value is UpdateStrategyRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) => k !== 'id' && k !== 'note' && !(STRATEGY_DRAFT_KEYS as readonly string[]).includes(k),
    )
  ) {
    return false;
  }
  if (!isStrategyId(v.id) || !isStrategyNote(v.note)) return false;
  const present = checkStrategyDraftFields(v, { requireAll: false });
  // La nota sola no basta: una edición tiene que cambiar algo de la ficha.
  return present !== null && present.length > 0;
}

export function isGetStrategyRequest(value: unknown): value is GetStrategyRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'id' && k !== 'version')) return false;
  if (!isStrategyId(v.id)) return false;
  return !('version' in v) || isStrategyId(v.version);
}

export function isSetStrategyStatusRequest(value: unknown): value is SetStrategyStatusRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'id' && k !== 'status' && k !== 'note')) return false;
  if (!isStrategyId(v.id) || !isStrategyStatus(v.status)) return false;
  return !('note' in v) || isStrategyNote(v.note);
}

// ---------------------------------------------------------------------------
// Guardas: backtest y pruebas de estrés (fase 2)
// ---------------------------------------------------------------------------

/** Id entero positivo de una ejecución guardada (`backtest:get`). */
export function isBacktestRunId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/** Costes configurables del run: subconjunto de los de la ficha. */
function isPartialCosts(value: unknown): value is Partial<StrategyCosts> {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = ['commissionPct', 'commissionMin', 'slippageBps', 'spreadBps'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  return Object.values(v).every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0);
}

function isSplitRatiosInput(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = ['train', 'validation', 'test'];
  if (Object.keys(v).some((k) => !keys.includes(k))) return false;
  return Object.values(v).every(
    (n) => typeof n === 'number' && Number.isFinite(n) && (n as number) > 0 && (n as number) < 1,
  );
}

function isWalkForwardOptions(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = ['trainSize', 'testSize', 'step', 'objective'];
  if (Object.keys(v).some((k) => !keys.includes(k))) return false;
  for (const key of ['trainSize', 'testSize', 'step'] as const) {
    if (key in v && (!Number.isInteger(v[key]) || (v[key] as number) < 1)) return false;
  }
  return (
    !('objective' in v) ||
    (typeof v.objective === 'string' &&
      (OBJECTIVE_METRIC_NAMES as readonly string[]).includes(v.objective))
  );
}

function isSensitivityAxes(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'xParam' && k !== 'yParam')) return false;
  return ['xParam', 'yParam'].every((k) => !(k in v) || isNonEmptyString(v[k]));
}

function isMonteCarloOptions(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = ['seed', 'simulations', 'method'];
  if (Object.keys(v).some((k) => !keys.includes(k))) return false;
  if ('seed' in v && (typeof v.seed !== 'number' || !Number.isFinite(v.seed))) return false;
  if (
    'simulations' in v &&
    (!Number.isInteger(v.simulations) ||
      (v.simulations as number) < 1 ||
      (v.simulations as number) > MONTE_CARLO_MAX_SIMULATIONS)
  ) {
    return false;
  }
  return (
    !('method' in v) ||
    (typeof v.method === 'string' && (MONTE_CARLO_METHODS as readonly string[]).includes(v.method))
  );
}

/** Universo del run: lista de tickers válidos (no nombres libres). */
function isUniverse(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= BACKTEST_MAX_UNIVERSE &&
    value.every(isTicker)
  );
}

export function isBacktestRunRequest(value: unknown): value is BacktestRunRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = [
    'strategyId',
    'version',
    'desde',
    'hasta',
    'universe',
    'initialCash',
    'riskPerTrade',
    'maxPositions',
    'costs',
    'params',
    'split',
    'walkForward',
    'sensitivity',
    'monteCarlo',
  ];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if (!isStrategyId(v.strategyId)) return false;
  if ('version' in v && !isStrategyId(v.version)) return false;
  if ('desde' in v && !isIsoDate(v.desde)) return false;
  if ('hasta' in v && !isIsoDate(v.hasta)) return false;
  if (typeof v.desde === 'string' && typeof v.hasta === 'string' && v.desde > v.hasta) {
    return false;
  }
  if ('universe' in v && !isUniverse(v.universe)) return false;
  if (
    'initialCash' in v &&
    (typeof v.initialCash !== 'number' ||
      !Number.isFinite(v.initialCash) ||
      v.initialCash < BACKTEST_MIN_INITIAL_CASH ||
      v.initialCash > BACKTEST_MAX_INITIAL_CASH)
  ) {
    return false;
  }
  if (
    'riskPerTrade' in v &&
    (typeof v.riskPerTrade !== 'number' ||
      v.riskPerTrade < BACKTEST_MIN_RISK_PER_TRADE ||
      v.riskPerTrade > BACKTEST_MAX_RISK_PER_TRADE)
  ) {
    return false;
  }
  if (
    'maxPositions' in v &&
    (!Number.isInteger(v.maxPositions) ||
      (v.maxPositions as number) < 1 ||
      (v.maxPositions as number) > BACKTEST_MAX_POSITIONS)
  ) {
    return false;
  }
  if ('costs' in v && !isPartialCosts(v.costs)) return false;
  if ('params' in v && !isStrategyParameters(v.params)) return false;
  if ('split' in v && !isSplitRatiosInput(v.split)) return false;
  for (const key of ['walkForward', 'sensitivity', 'monteCarlo'] as const) {
    if (!(key in v)) continue;
    const opt = v[key];
    if (opt === false) continue;
    if (key === 'walkForward' && !isWalkForwardOptions(opt)) return false;
    if (key === 'sensitivity' && !isSensitivityAxes(opt)) return false;
    if (key === 'monteCarlo' && !isMonteCarloOptions(opt)) return false;
  }
  return true;
}

export function isBacktestListQuery(value: unknown): value is BacktestListQuery | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'strategyId' && k !== 'version' && k !== 'limit')) {
    return false;
  }
  if ('strategyId' in v && !isStrategyId(v.strategyId)) return false;
  if ('version' in v && !isStrategyId(v.version)) return false;
  if (
    'limit' in v &&
    (!Number.isInteger(v.limit) ||
      (v.limit as number) < 1 ||
      (v.limit as number) > BACKTEST_MAX_LIMIT)
  ) {
    return false;
  }
  return true;
}

export function isBacktestFinalTestRequest(value: unknown): value is BacktestFinalTestRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'strategyId' && k !== 'version')) return false;
  if (!isStrategyId(v.strategyId)) return false;
  return !('version' in v) || isStrategyId(v.version);
}

/** `{strategyId, version?}` para `stress:get` y `stress:run`. */
export function isStressRequest(value: unknown): value is StressRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'strategyId' && k !== 'version')) return false;
  if (!isStrategyId(v.strategyId)) return false;
  return !('version' in v) || isStrategyId(v.version);
}

// ---------------------------------------------------------------------------
// Guardas: motor de riesgo (fase 3)
// ---------------------------------------------------------------------------

export function isSignalDirection(value: unknown): value is SignalIntent['direction'] {
  return typeof value === 'string' && (SIGNAL_DIRECTIONS as readonly string[]).includes(value);
}

export function isSignalOrigin(value: unknown): value is SignalIntent['origin'] {
  return typeof value === 'string' && (SIGNAL_ORIGINS as readonly string[]).includes(value);
}

export function isVetoReasonCode(value: unknown): value is VetoReasonCode {
  return typeof value === 'string' && (VETO_REASON_CODES as readonly string[]).includes(value);
}

export function isKillSwitchCause(value: unknown): value is KillSwitchCause {
  return typeof value === 'string' && (KILL_SWITCH_CAUSES as readonly string[]).includes(value);
}

const isPositivePrice = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const isNullablePrice = (value: unknown): boolean => value === null || isPositivePrice(value);

/**
 * Instante ISO 8601 con hora ('2026-10-09T12:30:00.000Z'); el guarda de
 * fechas `isIsoDate` solo admite el día. `Date.parse` ya rechaza horas
 * imposibles ('…T25:00').
 */
export function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/**
 * Forma de la señal que llega a `risk:submit-signal`. Aquí solo se exige
 * la forma: un stop ausente o una confianza fuera de 0–1 no se rechazan en
 * el borde porque tienen que llegar al motor (veto `STOP_MISSING` /
 * `SIGNAL_INVALID`, y la confianza anómala puede disparar la parada por
 * 'modelo-erratico').
 */
export function isSignalIntent(value: unknown): value is SignalIntent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = ['ticker', 'direction', 'entry', 'stop', 'target', 'confidence', 'origin'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if (!isTicker(v.ticker)) return false;
  if (!isSignalDirection(v.direction)) return false;
  if (!isPositivePrice(v.entry)) return false;
  if (!isNullablePrice(v.stop)) return false;
  if (!isNullablePrice(v.target)) return false;
  // La confianza fuera de 0–1 es una señal anómala del modelo, no una
  // forma inválida: el motor decide el veto y la posible parada.
  if (typeof v.confidence !== 'number' || !Number.isFinite(v.confidence)) return false;
  return isSignalOrigin(v.origin);
}

/**
 * Límites completos dentro de los márgenes duros: `risk:set-limits`
 * sustituye la configuración entera, así que todos los campos son
 * obligatorios y cada uno tiene que respetar su RISK_BOUNDS.
 */
export function isRiskLimits(value: unknown): value is RiskLimits {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(RISK_BOUNDS);
  if (Object.keys(v).some((k) => !keys.includes(k))) return false;
  return (keys as (keyof RiskLimits)[]).every((key) => {
    const bound = RISK_BOUNDS[key];
    const n = v[key];
    return typeof n === 'number' && Number.isFinite(n) && n >= bound.min && n <= bound.max;
  });
}

export function isRiskVetoesQuery(value: unknown): value is RiskVetoesQuery | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = ['rule', 'decision', 'ticker', 'limit', 'offset'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('rule' in v && !isVetoReasonCode(v.rule)) return false;
  if ('decision' in v && v.decision !== 'vetada' && v.decision !== 'reducida') return false;
  if ('ticker' in v && !isTicker(v.ticker)) return false;
  if (
    'limit' in v &&
    (typeof v.limit !== 'number' ||
      !Number.isInteger(v.limit) ||
      v.limit < 1 ||
      v.limit > RISK_VETOES_MAX_LIMIT)
  ) {
    return false;
  }
  if (
    'offset' in v &&
    (typeof v.offset !== 'number' || !Number.isInteger(v.offset) || v.offset < 0)
  ) {
    return false;
  }
  return true;
}

/** `{confirm: true, note?}`: la reanudación exige confirmación explícita. */
export function isResumeKillSwitchRequest(value: unknown): value is KillSwitchResumeRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'confirm' && k !== 'note')) return false;
  if (v.confirm !== true) return false;
  return !('note' in v) || isNonEmptyString(v.note);
}

export function isSimulateCalendarEventRequest(
  value: unknown,
): value is SimulateCalendarEventRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = ['kind', 'title', 'dateUtc', 'impact', 'asset'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if (!isCalendarEventKind(v.kind)) return false;
  if (!isNonEmptyString(v.title) || v.title.length > 120) return false;
  if (!isIsoTimestamp(v.dateUtc)) return false;
  if (!isImpactLevel(v.impact)) return false;
  return !('asset' in v) || isTicker(v.asset);
}

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

function isSeedRiskPosition(value: unknown): value is SeedRiskPosition {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = [
    'ticker',
    'direction',
    'entry',
    'stop',
    'target',
    'size',
    'sector',
    'currency',
    'openedAt',
    'closedAt',
  ];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if (!isTicker(v.ticker)) return false;
  if (!isSignalDirection(v.direction)) return false;
  if (!isPositivePrice(v.entry)) return false;
  if (!isPositivePrice(v.size)) return false;
  if ('stop' in v && !isNullablePrice(v.stop)) return false;
  if ('target' in v && !isNullablePrice(v.target)) return false;
  if ('sector' in v && !(typeof v.sector === 'string' && v.sector.length <= 60)) return false;
  if (
    'currency' in v &&
    !(typeof v.currency === 'string' && CURRENCY_CODE_PATTERN.test(v.currency))
  ) {
    return false;
  }
  if ('openedAt' in v && !isIsoTimestamp(v.openedAt)) return false;
  if ('closedAt' in v && !isIsoTimestamp(v.closedAt)) return false;
  return true;
}

export function isSeedPortfolioRequest(value: unknown): value is SeedPortfolioRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = ['equity', 'positions', 'equityHistory'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('equity' in v && !isPositivePrice(v.equity)) return false;
  if (
    'positions' in v &&
    (!Array.isArray(v.positions) ||
      v.positions.length > 64 ||
      !v.positions.every(isSeedRiskPosition))
  ) {
    return false;
  }
  if ('equityHistory' in v) {
    const history = v.equityHistory;
    if (!Array.isArray(history) || history.length > 400) return false;
    for (const point of history) {
      if (typeof point !== 'object' || point === null) return false;
      const p = point as Record<string, unknown>;
      if (Object.keys(p).some((k) => k !== 'at' && k !== 'equity')) return false;
      if (!isIsoTimestamp(p.at) || !isPositivePrice(p.equity)) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Guardas: señales, diario y operativa (fase 4)
// ---------------------------------------------------------------------------

/** Id entero positivo de una señal (`signals:get`). */
export function isSignalId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isRiskDecisionStatus(value: unknown): value is RiskDecisionStatus {
  return typeof value === 'string' && (RISK_DECISION_STATUSES as readonly string[]).includes(value);
}

export function isSignalsListQuery(value: unknown): value is SignalsListQuery | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = ['ticker', 'decision', 'strategyId', 'desde', 'hasta', 'limit', 'offset'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('ticker' in v && !isTicker(v.ticker)) return false;
  if ('decision' in v && !isRiskDecisionStatus(v.decision)) return false;
  if ('strategyId' in v && !isStrategyId(v.strategyId)) return false;
  if ('desde' in v && !isIsoDate(v.desde)) return false;
  if ('hasta' in v && !isIsoDate(v.hasta)) return false;
  if (typeof v.desde === 'string' && typeof v.hasta === 'string' && v.desde > v.hasta) {
    return false;
  }
  if (
    'limit' in v &&
    (typeof v.limit !== 'number' ||
      !Number.isInteger(v.limit) ||
      v.limit < 1 ||
      v.limit > SIGNALS_LIST_MAX_LIMIT)
  ) {
    return false;
  }
  if (
    'offset' in v &&
    (typeof v.offset !== 'number' || !Number.isInteger(v.offset) || v.offset < 0)
  ) {
    return false;
  }
  return true;
}

/** Id entero positivo de una entrada del diario (`journal:get`). */
export function isJournalEntryId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isJournalEntryType(value: unknown): value is JournalEntryType {
  return typeof value === 'string' && (JOURNAL_ENTRY_TYPES as readonly string[]).includes(value);
}

export function isJournalResult(value: unknown): value is JournalResult {
  return typeof value === 'string' && (JOURNAL_RESULTS as readonly string[]).includes(value);
}

export function isJournalListQuery(value: unknown): value is JournalListQuery | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = ['desde', 'hasta', 'type', 'ticker', 'strategyId', 'result', 'limit', 'offset'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('desde' in v && !isIsoDate(v.desde)) return false;
  if ('hasta' in v && !isIsoDate(v.hasta)) return false;
  if (typeof v.desde === 'string' && typeof v.hasta === 'string' && v.desde > v.hasta) {
    return false;
  }
  if ('type' in v && !isJournalEntryType(v.type)) return false;
  if ('ticker' in v && !isTicker(v.ticker)) return false;
  if ('strategyId' in v && !isStrategyId(v.strategyId)) return false;
  if ('result' in v && !isJournalResult(v.result)) return false;
  if (
    'limit' in v &&
    (typeof v.limit !== 'number' ||
      !Number.isInteger(v.limit) ||
      v.limit < 1 ||
      v.limit > JOURNAL_LIST_MAX_LIMIT)
  ) {
    return false;
  }
  if (
    'offset' in v &&
    (typeof v.offset !== 'number' || !Number.isInteger(v.offset) || v.offset < 0)
  ) {
    return false;
  }
  return true;
}

/**
 * Exportación del diario: `{query?, path?}`. `path` solo se respeta en
 * modo E2E y debe ser una ruta absoluta razonable (el proceso principal
 * además la acota al directorio temporal del entorno de pruebas).
 */
export function isJournalExportRequest(value: unknown): value is JournalExportRequest | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'query' && k !== 'path')) return false;
  if ('query' in v && !isJournalListQuery(v.query)) return false;
  if ('path' in v) {
    const p = v.path;
    if (typeof p !== 'string' || p.length === 0 || p.length > 512) return false;
    // Rutas absolutas POSIX o Windows; nunca relativas ni con traversal.
    if (!/^(\/|[A-Za-z]:[\\/])/.test(p) || p.includes('..')) return false;
  }
  return true;
}

// -- Canales de entrega -----------------------------------------------------

export function isDeliveryEventKind(value: unknown): value is DeliveryEventKind {
  return typeof value === 'string' && (DELIVERY_EVENT_KINDS as readonly string[]).includes(value);
}

/** Lista de eventos por canal: subconjunto de DELIVERY_EVENT_KINDS sin duplicados. */
function isDeliveryEventList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= DELIVERY_EVENT_KINDS.length &&
    value.every(isDeliveryEventKind) &&
    new Set(value).size === value.length
  );
}

export function isDeliveryTestRequest(value: unknown): value is DeliveryTestRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'channel')) return false;
  return (
    typeof v.channel === 'string' &&
    (DELIVERY_TESTABLE_CHANNELS as readonly string[]).includes(v.channel)
  );
}

/** Dirección de correo laxa (local@dominio) dentro del tope del contrato. */
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

function isDeliveryChatId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= DELIVERY_CHAT_ID_MAX_LENGTH &&
    // Id numérico, @canal o nombre corto; sin espacios ni controles.
    /^[^\s]{1,128}$/.test(value)
  );
}

function isDeliveryHost(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= DELIVERY_HOST_MAX_LENGTH &&
    // Host o IPv4 literal; sin espacios, credenciales ni path.
    /^[A-Za-z0-9.-]+$/.test(value)
  );
}

function isTelegramConfigInput(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'enabled' && k !== 'chatId' && k !== 'events')) {
    return false;
  }
  if (typeof v.enabled !== 'boolean') return false;
  // Desactivado admite chatId vacío; activado lo exige válido.
  if (typeof v.chatId !== 'string' || v.chatId.length > DELIVERY_CHAT_ID_MAX_LENGTH) return false;
  if (v.enabled && !isDeliveryChatId(v.chatId)) return false;
  return isDeliveryEventList(v.events);
}

function isEmailConfigInput(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = ['enabled', 'host', 'port', 'security', 'user', 'to', 'events'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if (typeof v.enabled !== 'boolean') return false;
  if (typeof v.host !== 'string' || v.host.length > DELIVERY_HOST_MAX_LENGTH) return false;
  if (typeof v.port !== 'number' || !Number.isInteger(v.port) || v.port < 1 || v.port > 65535) {
    return false;
  }
  if (
    typeof v.security !== 'string' ||
    !(SMTP_SECURITY_MODES as readonly string[]).includes(v.security)
  ) {
    return false;
  }
  if (typeof v.user !== 'string' || v.user.length > DELIVERY_ADDRESS_MAX_LENGTH) return false;
  if (typeof v.to !== 'string' || v.to.length > DELIVERY_ADDRESS_MAX_LENGTH) return false;
  // Activado exige servidor, usuario y destinatario con forma correcta.
  if (v.enabled) {
    if (!isDeliveryHost(v.host) || !isNonEmptyString(v.user)) return false;
    if (!EMAIL_PATTERN.test(v.to)) return false;
  }
  return isDeliveryEventList(v.events);
}

/**
 * Config de canales externos para `delivery:set-config`. Nunca incluye
 * secretos: el token del bot y la contraseña SMTP entran por `secrets:*`
 * con los proveedores de `DELIVERY_SECRET_KEYS`.
 */
export function isDeliveryConfigInput(value: unknown): value is DeliveryConfigInput {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'telegram' && k !== 'email')) return false;
  return isTelegramConfigInput(v.telegram) && isEmailConfigInput(v.email);
}

// -- Rutina diaria ------------------------------------------------------------

/** Horarios de la rutina: las tres horas 'HH:MM' en America/New_York. */
export function isRoutineConfig(value: unknown): value is RoutineConfig {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'preapertura' && k !== 'cierre' && k !== 'conciliacion')) {
    return false;
  }
  return (
    typeof v.preapertura === 'string' &&
    HHMM_PATTERN.test(v.preapertura) &&
    typeof v.cierre === 'string' &&
    HHMM_PATTERN.test(v.cierre) &&
    typeof v.conciliacion === 'string' &&
    HHMM_PATTERN.test(v.conciliacion)
  );
}

// -- Copias de seguridad y registros ------------------------------------------

/** Nombre de archivo de copia: basename '.db' sin separadores ni '..'. */
export function isBackupFileName(value: unknown): value is string {
  return typeof value === 'string' && BACKUP_FILE_PATTERN.test(value) && !value.includes('..');
}

/** `{fileName, confirm: true}`: la restauración exige confirmación explícita. */
export function isBackupRestoreRequest(value: unknown): value is BackupRestoreRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'fileName' && k !== 'confirm')) return false;
  return isBackupFileName(v.fileName) && v.confirm === true;
}

// ---------------------------------------------------------------------------
// Guardas: broker en modo paper (fase 5)
// ---------------------------------------------------------------------------

/**
 * Clave o secreto del broker: alfanumérico con guion, sin espacios ni
 * controles (las claves de Alpaca son 'PK…'/'AK…'/'CK…' + base62). La
 * pertenencia a una cuenta live no se comprueba aquí: la decide la
 * validación contra el endpoint paper al conectar.
 */
const BROKER_KEY_PATTERN = /^[A-Za-z0-9-]{6,256}$/;

export function isBrokerKey(value: unknown): value is string {
  return typeof value === 'string' && BROKER_KEY_PATTERN.test(value);
}

export function isBrokerCredentials(value: unknown): value is BrokerCredentials {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'apiKeyId' && k !== 'apiSecret')) return false;
  return isBrokerKey(v.apiKeyId) && isBrokerKey(v.apiSecret);
}

export function isBrokerConnectRequest(value: unknown): value is BrokerConnectRequest {
  return isBrokerCredentials(value);
}

/**
 * `broker:test`: sin argumento o `{}` prueba las claves guardadas; con
 * `apiKeyId` y `apiSecret` prueba unas nuevas (los dos campos a la vez).
 */
export function isBrokerTestRequest(value: unknown): value is BrokerTestRequest | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'apiKeyId' && k !== 'apiSecret')) return false;
  // O los dos campos válidos o ninguno: media credencial no es una petición.
  const hasId = 'apiKeyId' in v;
  const hasSecret = 'apiSecret' in v;
  if (hasId !== hasSecret) return false;
  return !hasId || (isBrokerKey(v.apiKeyId) && isBrokerKey(v.apiSecret));
}

export function isBrokerOrderStatus(value: unknown): value is BrokerOrderStatus {
  return typeof value === 'string' && (BROKER_ORDER_STATUSES as readonly string[]).includes(value);
}

/** Id entero positivo de una orden local (`broker_orders.id`). */
export function isBrokerOrderId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function isBrokerOrdersQuery(value: unknown): value is BrokerOrdersQuery | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = ['status', 'strategyId', 'ticker', 'limit', 'offset'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if ('status' in v && !isBrokerOrderStatus(v.status)) return false;
  if ('strategyId' in v && !isStrategyId(v.strategyId)) return false;
  if ('ticker' in v && !isTicker(v.ticker)) return false;
  if (
    'limit' in v &&
    (typeof v.limit !== 'number' ||
      !Number.isInteger(v.limit) ||
      v.limit < 1 ||
      v.limit > BROKER_ORDERS_MAX_LIMIT)
  ) {
    return false;
  }
  if (
    'offset' in v &&
    (typeof v.offset !== 'number' || !Number.isInteger(v.offset) || v.offset < 0)
  ) {
    return false;
  }
  return true;
}

export function isCancelOrderRequest(value: unknown): value is CancelOrderRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'id')) return false;
  return isBrokerOrderId(v.id);
}

/**
 * `orders:create`: una limitada manual con activo, lado, cantidad y
 * precio límite positivos. Sin campos extra: el idempotente lo pone el
 * proceso principal.
 */
export function isCreateOrderRequest(value: unknown): value is CreateOrderRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = ['ticker', 'side', 'quantity', 'limitPrice'];
  if (Object.keys(v).some((k) => !allowed.includes(k))) return false;
  if (!isTicker(v.ticker)) return false;
  if (typeof v.side !== 'string' || !(BROKER_ORDER_SIDES as readonly string[]).includes(v.side)) {
    return false;
  }
  const positive = (n: unknown): n is number =>
    typeof n === 'number' && Number.isFinite(n) && n > 0;
  return positive(v.quantity) && positive(v.limitPrice);
}

export function isDeviationPeriod(value: unknown): value is DeviationPeriod {
  return typeof value === 'string' && (DEVIATION_PERIODS as readonly string[]).includes(value);
}

export function isDeviationReportQuery(value: unknown): value is DeviationReportQuery {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'period')) return false;
  return isDeviationPeriod(v.period);
}

// -- Ganchos E2E del broker (solo TRADIA_E2E y sin empaquetar) ----------------

export function isBrokerE2eFailure(value: unknown): value is BrokerE2eFailure {
  return typeof value === 'string' && (BROKER_E2E_FAILURES as readonly string[]).includes(value);
}

export function isBrokerFailNextRequest(value: unknown): value is BrokerFailNextRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'kind')) return false;
  return isBrokerE2eFailure(v.kind);
}

export function isBrokerE2eDiscrepancy(value: unknown): value is BrokerE2eDiscrepancy {
  return (
    typeof value === 'string' && (BROKER_E2E_DISCREPANCIES as readonly string[]).includes(value)
  );
}

export function isBrokerDiscrepancyRequest(value: unknown): value is BrokerDiscrepancyRequest {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'kind')) return false;
  return isBrokerE2eDiscrepancy(v.kind);
}

export function isBrokerSeedWeeksRequest(
  value: unknown,
): value is BrokerSeedWeeksRequest | undefined {
  if (value === undefined) return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some((k) => k !== 'weeks')) return false;
  return (
    !('weeks' in v) ||
    (typeof v.weeks === 'number' && Number.isInteger(v.weeks) && v.weeks >= 1 && v.weeks <= 52)
  );
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
