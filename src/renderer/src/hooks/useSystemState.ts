import { useEffect, useState } from 'react';
import type { AgentsState, ConnectivityState } from '../../../shared/ipc';

export interface SystemState {
  connectivity: ConnectivityState | null;
  agents: AgentsState | null;
  connectionError: boolean;
  agentsError: boolean;
}

export function useSystemState(): SystemState {
  const [state, setState] = useState<SystemState>({
    connectivity: null,
    agents: null,
    connectionError: false,
    agentsError: false,
  });
  useEffect(() => {
    let active = true;
    let connectionEvent = false;
    let agentsEvent = false;
    let heartbeat: string | null = null;
    const update = (patch: Partial<SystemState>) => {
      if (active) setState((previous) => ({ ...previous, ...patch }));
    };
    const api = window.tradia;
    if (!api) {
      update({ connectionError: true, agentsError: true });
      return;
    }
    const offConnection = api.connectivity.onChanged((connectivity) => {
      connectionEvent = true;
      update({ connectivity, connectionError: false });
    });
    const offAgents = api.agents.onChanged((agents) => {
      agentsEvent = true;
      update({
        agents: heartbeat ? { ...agents, lastHeartbeatAt: heartbeat } : agents,
        agentsError: false,
      });
    });
    const offHeartbeat = api.agents.onHeartbeat((at) => {
      heartbeat = at;
      if (active)
        setState((previous) => ({
          ...previous,
          agents: previous.agents ? { ...previous.agents, lastHeartbeatAt: at } : previous.agents,
        }));
    });
    void api.connectivity
      .getState()
      .then((connectivity) => {
        if (!connectionEvent) update({ connectivity });
      })
      .catch(() => {
        if (!connectionEvent) update({ connectionError: true });
      });
    void api.agents
      .getState()
      .then((agents) => {
        if (!agentsEvent)
          update({ agents: heartbeat ? { ...agents, lastHeartbeatAt: heartbeat } : agents });
      })
      .catch(() => {
        if (!agentsEvent) update({ agentsError: true });
      });
    return () => {
      active = false;
      offConnection();
      offAgents();
      offHeartbeat();
    };
  }, []);
  return state;
}
