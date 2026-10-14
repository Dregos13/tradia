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

/**
 * Dato horario de la barra de estado. Por debajo de 1200 px se muestra la
 * etiqueta corta para que la barra quepa en una línea; la larga sigue en el
 * árbol accesible y en el title.
 */
function StatusTime({
  label,
  short,
  value,
  text,
}: {
  label: string;
  short: string;
  value: string | null | undefined;
  text: string;
}) {
  return (
    <span className="numeric statusbar-time" title={`${label} ${text}`}>
      <span className="statusbar-label">{label}</span>
      <span className="statusbar-label-short" aria-hidden="true">
        {short}
      </span>{' '}
      <time dateTime={value ?? undefined}>{text}</time>
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
      <StatusTime
        label="Última comprobación"
        short="Comprobado"
        value={state.connectivity?.lastCheckedAt}
        text={
          state.connectionError ? 'No disponible' : heartbeatTime(state.connectivity?.lastCheckedAt)
        }
      />
      <StatusTime
        label="Próximo reintento"
        short="Reintento"
        value={state.connectivity?.nextRetryAt}
        text={
          state.connectionError
            ? 'No disponible'
            : state.connectivity?.nextRetryAt
              ? heartbeatTime(state.connectivity.nextRetryAt)
              : '—'
        }
      />
      <StatusTime
        label="Último latido"
        short="Latido"
        value={state.agents?.lastHeartbeatAt}
        text={state.agentsError ? 'No disponible' : heartbeatTime(state.agents?.lastHeartbeatAt)}
      />
    </footer>
  );
}
