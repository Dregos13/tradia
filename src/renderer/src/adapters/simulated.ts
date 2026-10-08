import type {
  AgentsState,
  AppSettings,
  ConnectivityState,
  NotificationPrefs,
  TradiaApi,
} from '../../../shared/ipc';

/** Explicit simulation only: never substitutes the production Electron bridge. */
export function createSimulatedAdapter() {
  let connectivity: ConnectivityState = {
    status: 'checking',
    lastCheckedAt: null,
    nextRetryAt: null,
    attempt: 0,
  };
  let agents: AgentsState = { paused: false, pauseReason: null, lastHeartbeatAt: null };
  let settings: AppSettings = { autostart: false, disclaimerAcceptedVersion: null };
  let prefs: NotificationPrefs = { info: true, alerta: true, critica: true };
  const connectionListeners = new Set<(value: ConnectivityState) => void>();
  const agentListeners = new Set<(value: AgentsState) => void>();
  const heartbeatListeners = new Set<(value: string) => void>();
  const subscribe = <T>(listeners: Set<(value: T) => void>, listener: (value: T) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const emitConnectivity = (value: ConnectivityState) => {
    connectivity = value;
    connectionListeners.forEach((listener) => listener(value));
  };
  const emitAgents = (value: AgentsState) => {
    agents = value;
    agentListeners.forEach((listener) => listener(value));
  };
  const unsupported = async () => {
    throw new Error('Operación nativa no disponible en la simulación.');
  };
  const api: TradiaApi = {
    connectivity: {
      getState: async () => connectivity,
      checkNow: async () => connectivity,
      onChanged: (listener) => subscribe(connectionListeners, listener),
    },
    agents: {
      getState: async () => agents,
      pause: async () => {
        emitAgents({ ...agents, paused: true, pauseReason: 'usuario' });
        return agents;
      },
      resume: async () => {
        emitAgents({ ...agents, paused: false, pauseReason: null });
        return agents;
      },
      onChanged: (listener) => subscribe(agentListeners, listener),
      onHeartbeat: (listener) => subscribe(heartbeatListeners, listener),
    },
    settings: {
      get: async () => settings,
      set: async (patch) => {
        settings = { ...settings, ...patch };
        return settings;
      },
    },
    notifications: {
      send: unsupported,
      test: unsupported,
      getPrefs: async () => prefs,
      setPrefs: async (value) => {
        prefs = value;
        return prefs;
      },
    },
    secrets: { setKey: unsupported, hasKey: async () => false, deleteKey: unsupported },
  };
  return {
    api,
    emitConnectivity,
    emitAgents,
    emitHeartbeat(at: string) {
      agents = { ...agents, lastHeartbeatAt: at };
      heartbeatListeners.forEach((listener) => listener(at));
    },
    listenerCount: () => connectionListeners.size + agentListeners.size + heartbeatListeners.size,
  };
}
