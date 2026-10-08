import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import { IPC_CHANNELS } from '../shared/ipc';
import type {
  AgentsState,
  ConnectivityState,
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
  ...(process.env.TRADIA_E2E === '1'
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
