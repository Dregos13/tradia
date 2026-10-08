import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { E2E_FLAG_ARG, IPC_CHANNELS } from '../shared/ipc';
import type {
  AgentsState,
  ConnectivityState,
  DataStatusEntry,
  GetBarsRequest,
  MacroSeriesQuery,
  MarketUpdatedEvent,
  NotificationLevel,
  NotificationPayload,
  NotificationPrefs,
  SettingsPatch,
  TradiaApi,
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
  // El proceso principal solo pasa E2E_FLAG_ARG cuando no está empaquetada
  // y TRADIA_E2E=1: una variable de entorno no basta para exponer api.testing.
  ...(process.argv.includes(E2E_FLAG_ARG)
    ? {
        testing: {
          simulateOffline: (offline: boolean) =>
            ipcRenderer.invoke(IPC_CHANNELS.connectivity.simulateOffline, offline),
          getContextIsolation: () => process.contextIsolated,
        },
      }
    : {}),
};

contextBridge.exposeInMainWorld('tradia', api);
