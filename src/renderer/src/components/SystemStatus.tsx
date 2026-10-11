import { KILL_SWITCH_CAUSE_MESSAGES, type KillSwitchState } from '../../../shared/risk';
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

export function AgentsStatus({
  state,
  killSwitch,
}: {
  state: SystemState;
  killSwitch?: KillSwitchState | null;
}) {
  const label = state.agentsError
    ? 'Agentes no disponibles'
    : !state.agents
      ? 'Cargando agentes…'
      : state.agents.paused
        ? 'Agentes en pausa'
        : 'Agentes activos';
  // Motivo de la pausa: una parada activa manda sobre la pausa del
  // planificador, así la barra nunca dice «Pausa manual» cuando quien
  // detiene a los agentes es la parada (p. ej. por pérdida de conexión).
  const pauseReason = killSwitch?.active
    ? killSwitch.cause === 'manual' || killSwitch.cause === null
      ? 'Pausa manual'
      : KILL_SWITCH_CAUSE_MESSAGES[killSwitch.cause]
    : state.agents?.pauseReason === 'sin-conexion'
      ? 'Sin conexión'
      : state.agents?.pauseReason === 'usuario'
        ? 'Pausa manual'
        : 'Motivo no disponible';
  return (
    <span
      className={`state ${state.agentsError ? 'offline' : state.agents?.paused ? 'paused' : state.agents ? 'online' : ''}`}
    >
      <span className="symbol" aria-hidden="true" />
      <span>{label}</span>
      {state.agents?.paused && !state.agentsError && <span>· {pauseReason}</span>}
    </span>
  );
}

export function StatusBar({
  state,
  killSwitch,
}: {
  state: SystemState;
  killSwitch?: KillSwitchState | null;
}) {
  return (
    <footer className="statusbar" aria-label="Estado del sistema">
      <div role="status" aria-live="polite">
        <ConnectionStatus state={state} />
        <AgentsStatus state={state} killSwitch={killSwitch} />
      </div>
      <span className="numeric">
        Última comprobación{' '}
        <time dateTime={state.connectivity?.lastCheckedAt ?? undefined}>
          {state.connectionError
            ? 'No disponible'
            : heartbeatTime(state.connectivity?.lastCheckedAt)}
        </time>
      </span>
      <span className="numeric">
        Próximo reintento{' '}
        <time dateTime={state.connectivity?.nextRetryAt ?? undefined}>
          {state.connectionError
            ? 'No disponible'
            : state.connectivity?.nextRetryAt
              ? heartbeatTime(state.connectivity.nextRetryAt)
              : '—'}
        </time>
      </span>
      <span className="numeric">
        Último latido{' '}
        <time dateTime={state.agents?.lastHeartbeatAt ?? undefined}>
          {state.agentsError ? 'No disponible' : heartbeatTime(state.agents?.lastHeartbeatAt)}
        </time>
      </span>
    </footer>
  );
}
