import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { E2E_FLAG_ARG, IPC_CHANNELS, isNotificationRoute } from '../shared/ipc';
import type {
  AddSourceRequest,
  AgentsState,
  AlertPrefs,
  BackupInfo,
  BackupRestoreRequest,
  BackupRestoreResult,
  BacktestFinalTestRequest,
  BacktestListQuery,
  BacktestProgressEvent,
  BacktestRunRequest,
  CalendarListQuery,
  CalendarUpdatedEvent,
  ConnectivityState,
  DataStatusEntry,
  DeliveryConfig,
  DeliveryConfigInput,
  DeliveryTestRequest,
  DeliveryTestResult,
  GetBarsRequest,
  JournalEntry,
  JournalExportRequest,
  JournalExportResult,
  JournalListQuery,
  JournalPage,
  JournalUpdatedEvent,
  KillSwitchCause,
  KillSwitchResumeRequest,
  KillSwitchState,
  MacroSeriesQuery,
  MarketUpdatedEvent,
  NewsListQuery,
  NewsUpdatedEvent,
  NotificationLevel,
  NotificationPayload,
  NotificationPrefs,
  NotificationRoute,
  OpenFolderResult,
  PaperPortfolioOverview,
  RiskLimits,
  RiskOverview,
  RiskVeto,
  RiskVetoesQuery,
  RoutineClockAdvanceResult,
  RoutineConfig,
  SeedPortfolioRequest,
  SettingsPatch,
  Signal,
  SignalEngineRunResult,
  SignalIntent,
  SignalNewEvent,
  SignalStrategyState,
  SignalsListQuery,
  SimulateCalendarEventRequest,
  StressRequest,
  TestSourceRequest,
  TradiaApi,
  UpdateSourceRequest,
} from '../shared/ipc';
import type {
  CreateStrategyRequest,
  GetStrategyRequest,
  SetStrategyStatusRequest,
  UpdateStrategyRequest,
} from '../shared/ipc';

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

// Única superficie del renderer: window.tradia (ver el contrato en src/shared/ipc.ts).
const api: TradiaApi = {
  connectivity: {
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.connectivity.getState),
    checkNow: () => ipcRenderer.invoke(IPC_CHANNELS.connectivity.checkNow),
    onChanged: (listener) =>
      subscribe<ConnectivityState>(IPC_CHANNELS.connectivity.changed, listener),
  },
  notifications: {
    send: (payload: NotificationPayload) =>
      ipcRenderer.invoke(IPC_CHANNELS.notifications.send, payload),
    test: (level: NotificationLevel) => ipcRenderer.invoke(IPC_CHANNELS.notifications.test, level),
    getPrefs: () => ipcRenderer.invoke(IPC_CHANNELS.notifications.getPrefs),
    setPrefs: (prefs: NotificationPrefs) =>
      ipcRenderer.invoke(IPC_CHANNELS.notifications.setPrefs, prefs),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settings.get),
    set: (patch: SettingsPatch) => ipcRenderer.invoke(IPC_CHANNELS.settings.set, patch),
  },
  secrets: {
    setKey: (provider: string, apiKey: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.secrets.setKey, provider, apiKey),
    hasKey: (provider: string) => ipcRenderer.invoke(IPC_CHANNELS.secrets.hasKey, provider),
    deleteKey: (provider: string) => ipcRenderer.invoke(IPC_CHANNELS.secrets.deleteKey, provider),
  },
  agents: {
    pause: () => ipcRenderer.invoke(IPC_CHANNELS.agents.pause),
    resume: () => ipcRenderer.invoke(IPC_CHANNELS.agents.resume),
    getState: () => ipcRenderer.invoke(IPC_CHANNELS.agents.getState),
    onChanged: (listener) => subscribe<AgentsState>(IPC_CHANNELS.agents.changed, listener),
    onHeartbeat: (listener) => subscribe<string>(IPC_CHANNELS.agents.heartbeat, listener),
  },
  watchlist: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.watchlist.list),
    add: (ticker: string) => ipcRenderer.invoke(IPC_CHANNELS.watchlist.add, ticker),
    remove: (ticker: string) => ipcRenderer.invoke(IPC_CHANNELS.watchlist.remove, ticker),
    addUniverse: () => ipcRenderer.invoke(IPC_CHANNELS.watchlist.addUniverse),
  },
  market: {
    getBars: (request: GetBarsRequest) => ipcRenderer.invoke(IPC_CHANNELS.market.getBars, request),
    refreshNow: () => ipcRenderer.invoke(IPC_CHANNELS.market.refreshNow),
    onUpdated: (listener) => subscribe<MarketUpdatedEvent>(IPC_CHANNELS.market.updated, listener),
  },
  macro: {
    getSeries: (query?: MacroSeriesQuery) =>
      ipcRenderer.invoke(IPC_CHANNELS.macro.getSeries, query),
  },
  dataStatus: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.dataStatus.get),
    onChanged: (listener) => subscribe<DataStatusEntry>(IPC_CHANNELS.dataStatus.changed, listener),
  },
  sources: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.sources.list),
    add: (request: AddSourceRequest) => ipcRenderer.invoke(IPC_CHANNELS.sources.add, request),
    update: (request: UpdateSourceRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.sources.update, request),
    remove: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.sources.remove, id),
    test: (request: TestSourceRequest) => ipcRenderer.invoke(IPC_CHANNELS.sources.test, request),
  },
  news: {
    list: (query?: NewsListQuery) => ipcRenderer.invoke(IPC_CHANNELS.news.list, query),
    onUpdated: (listener) => subscribe<NewsUpdatedEvent>(IPC_CHANNELS.news.updated, listener),
  },
  calendar: {
    list: (query: CalendarListQuery) => ipcRenderer.invoke(IPC_CHANNELS.calendar.list, query),
    onUpdated: (listener) =>
      subscribe<CalendarUpdatedEvent>(IPC_CHANNELS.calendar.updated, listener),
  },
  alerts: {
    getPrefs: () => ipcRenderer.invoke(IPC_CHANNELS.alerts.getPrefs),
    setPrefs: (prefs: AlertPrefs) => ipcRenderer.invoke(IPC_CHANNELS.alerts.setPrefs, prefs),
    onNavigate: (listener) => subscribe<NotificationRoute>(IPC_CHANNELS.alerts.navigate, listener),
  },
  strategies: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.strategies.list),
    get: (request: GetStrategyRequest) => ipcRenderer.invoke(IPC_CHANNELS.strategies.get, request),
    create: (request: CreateStrategyRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.strategies.create, request),
    update: (request: UpdateStrategyRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.strategies.update, request),
    setStatus: (request: SetStrategyStatusRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.strategies.setStatus, request),
    history: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.strategies.history, id),
  },
  backtest: {
    run: (request: BacktestRunRequest) => ipcRenderer.invoke(IPC_CHANNELS.backtest.run, request),
    list: (query?: BacktestListQuery) => ipcRenderer.invoke(IPC_CHANNELS.backtest.list, query),
    get: (id: number) => ipcRenderer.invoke(IPC_CHANNELS.backtest.get, id),
    runFinalTest: (request: BacktestFinalTestRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.backtest.runFinalTest, request),
    onProgress: (listener: (event: BacktestProgressEvent) => void) =>
      subscribe<BacktestProgressEvent>(IPC_CHANNELS.backtest.progress, listener),
  },
  stress: {
    get: (request: StressRequest) => ipcRenderer.invoke(IPC_CHANNELS.stress.get, request),
    run: (request: StressRequest) => ipcRenderer.invoke(IPC_CHANNELS.stress.run, request),
  },
  risk: {
    getLimits: () => ipcRenderer.invoke(IPC_CHANNELS.risk.getLimits),
    setLimits: (limits: RiskLimits) => ipcRenderer.invoke(IPC_CHANNELS.risk.setLimits, limits),
    listVetoes: (query?: RiskVetoesQuery) =>
      ipcRenderer.invoke(IPC_CHANNELS.risk.listVetoes, query),
    submitSignal: (signal: SignalIntent) =>
      ipcRenderer.invoke(IPC_CHANNELS.risk.submitSignal, signal),
    getPortfolio: (): Promise<PaperPortfolioOverview> =>
      ipcRenderer.invoke(IPC_CHANNELS.risk.getPortfolio),
    getKillSwitch: () => ipcRenderer.invoke(IPC_CHANNELS.risk.getKillSwitch),
    activateKillSwitch: () => ipcRenderer.invoke(IPC_CHANNELS.risk.activateKillSwitch),
    resumeKillSwitch: (request: KillSwitchResumeRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.risk.resumeKillSwitch, request),
    getCaution: () => ipcRenderer.invoke(IPC_CHANNELS.risk.getCaution),
    onChanged: (listener: (overview: RiskOverview) => void) =>
      subscribe<RiskOverview>(IPC_CHANNELS.risk.changed, listener),
    onVetoed: (listener: (veto: RiskVeto) => void) =>
      subscribe<RiskVeto>(IPC_CHANNELS.risk.vetoed, listener),
  },
  signals: {
    list: (query?: SignalsListQuery): Promise<Signal[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.signals.list, query),
    get: (id: number): Promise<Signal | null> => ipcRenderer.invoke(IPC_CHANNELS.signals.get, id),
    strategies: (): Promise<SignalStrategyState[]> =>
      ipcRenderer.invoke(IPC_CHANNELS.signals.strategies),
    onNew: (listener: (event: SignalNewEvent) => void) =>
      subscribe<SignalNewEvent>(IPC_CHANNELS.signals.new, listener),
  },
  journal: {
    list: (query?: JournalListQuery): Promise<JournalPage> =>
      ipcRenderer.invoke(IPC_CHANNELS.journal.list, query),
    get: (id: number): Promise<JournalEntry | null> =>
      ipcRenderer.invoke(IPC_CHANNELS.journal.get, id),
    exportCsv: (request?: JournalExportRequest): Promise<JournalExportResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.journal.exportCsv, request),
    onUpdated: (listener: (event: JournalUpdatedEvent) => void) =>
      subscribe<JournalUpdatedEvent>(IPC_CHANNELS.journal.updated, listener),
  },
  delivery: {
    getConfig: (): Promise<DeliveryConfig> => ipcRenderer.invoke(IPC_CHANNELS.delivery.getConfig),
    setConfig: (config: DeliveryConfigInput): Promise<DeliveryConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.delivery.setConfig, config),
    test: (request: DeliveryTestRequest): Promise<DeliveryTestResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.delivery.test, request),
  },
  routine: {
    getConfig: (): Promise<RoutineConfig> => ipcRenderer.invoke(IPC_CHANNELS.routine.getConfig),
    setConfig: (config: RoutineConfig): Promise<RoutineConfig> =>
      ipcRenderer.invoke(IPC_CHANNELS.routine.setConfig, config),
  },
  backup: {
    list: (): Promise<BackupInfo[]> => ipcRenderer.invoke(IPC_CHANNELS.backup.list),
    create: (): Promise<BackupInfo> => ipcRenderer.invoke(IPC_CHANNELS.backup.create),
    restore: (request: BackupRestoreRequest): Promise<BackupRestoreResult> =>
      ipcRenderer.invoke(IPC_CHANNELS.backup.restore, request),
  },
  logs: {
    openFolder: (): Promise<OpenFolderResult> => ipcRenderer.invoke(IPC_CHANNELS.logs.openFolder),
  },
  // El proceso principal solo pasa E2E_FLAG_ARG cuando no está empaquetada
  // y TRADIA_E2E=1: una variable de entorno no basta para exponer api.testing.
  ...(process.argv.includes(E2E_FLAG_ARG)
    ? {
        testing: {
          simulateOffline: (offline: boolean) =>
            ipcRenderer.invoke(IPC_CHANNELS.connectivity.simulateOffline, offline),
          getContextIsolation: () => process.contextIsolated,
          advanceMarketClock: (ms: number) =>
            ipcRenderer.invoke(IPC_CHANNELS.market.advanceClock, ms),
          simulateProviderFailure: (failing: boolean) =>
            ipcRenderer.invoke(IPC_CHANNELS.dataStatus.simulateProviderFailure, failing),
          pollNewsNow: () => ipcRenderer.invoke(IPC_CHANNELS.news.pollNow),
          advanceNewsClock: (ms: number) => ipcRenderer.invoke(IPC_CHANNELS.news.advanceClock, ms),
          risk: {
            simulateCause: (cause: KillSwitchCause): Promise<KillSwitchState> =>
              ipcRenderer.invoke(IPC_CHANNELS.risk.simulateCause, cause),
            simulateCalendarEvent: (event: SimulateCalendarEventRequest) =>
              ipcRenderer.invoke(IPC_CHANNELS.risk.simulateCalendarEvent, event),
            seedPortfolio: (request: SeedPortfolioRequest) =>
              ipcRenderer.invoke(IPC_CHANNELS.risk.seedPortfolio, request),
          },
          advanceRoutineClock: (ms: number): Promise<RoutineClockAdvanceResult> =>
            ipcRenderer.invoke(IPC_CHANNELS.routine.advanceClock, ms),
          evaluateSignalsNow: (): Promise<SignalEngineRunResult> =>
            ipcRenderer.invoke(IPC_CHANNELS.signals.evaluateNow),
        },
      }
    : {}),
};

contextBridge.exposeInMainWorld('tradia', api);

// Clic en una notificación nativa: el proceso principal emite
// alerts:navigate y la app navega por hash (#noticias / #calendario /
// #riesgo, ver App.tsx). Funciona también con la ventana oculta en la
// bandeja.
ipcRenderer.on(IPC_CHANNELS.alerts.navigate, (_event, route: unknown) => {
  if (isNotificationRoute(route)) {
    window.location.hash = `#${route}`;
  }
});
