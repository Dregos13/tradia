import type { SystemState } from '../hooks/useSystemState';

export function heartbeatTime(at: string | null | undefined): string {
  if (!at) return 'Pendiente';
  const date = new Date(at);
  return Number.isNaN(date.getTime())
    ? 'No disponible'
    : date.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ConnectionStatus({ state }: { state: SystemState }) {
  const status = state.connectivity?.status;
  const label = state.connectionError
    ? 'Conexión no disponible'
    : status === 'online'
      ? 'En línea'
      : status === 'offline'
        ? 'Sin conexión'
        : status === 'checking'
          ? 'Comprobando conexión'
          : 'Cargando conexión…';
  return (
    <span className={`state ${state.connectionError ? 'offline' : (status ?? '')}`}>
      <span className="symbol" aria-hidden="true" />
      {label}
    </span>
  );
}

export function AgentsStatus({ state }: { state: SystemState }) {
  const label = state.agentsError
    ? 'Agentes no disponibles'
    : !state.agents
      ? 'Cargando agentes…'
      : state.agents.paused
        ? 'Agentes en pausa'
        : 'Agentes activos';
  return (
    <span
      className={`state ${state.agentsError ? 'offline' : state.agents?.paused ? 'paused' : state.agents ? 'online' : ''}`}
    >
      <span className="symbol" aria-hidden="true" />
      {label}
    </span>
  );
}

export function StatusBar({ state }: { state: SystemState }) {
  return (
    <footer className="statusbar" aria-label="Estado del sistema">
      <div role="status" aria-live="polite">
        <ConnectionStatus state={state} />
        <AgentsStatus state={state} />
      </div>
      <span className="numeric">
        Último latido{' '}
        <time dateTime={state.agents?.lastHeartbeatAt ?? undefined}>
          {state.agentsError ? 'No disponible' : heartbeatTime(state.agents?.lastHeartbeatAt)}
        </time>
      </span>
    </footer>
  );
}
