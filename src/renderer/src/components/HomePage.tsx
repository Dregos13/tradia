import type { SystemState } from '../hooks/useSystemState';
import { AgentsStatus, ConnectionStatus, heartbeatTime } from './SystemStatus';

export function HomePage({ state }: { state: SystemState }) {
  return (
    <>
      <div className="headline">
        <h2>Todo bajo control, incluso cuando la red no lo está.</h2>
        <p>Tradia mantiene el latido en segundo plano y no decide con datos incompletos.</p>
      </div>
      <section className="ledger" aria-label="Resumen operativo">
        <div className="row">
          <div>
            <h3>Conexión</h3>
            <p>Última comprobación · {heartbeatTime(state.connectivity?.lastCheckedAt)}</p>
          </div>
          <ConnectionStatus state={state} />
          <span className="numeric">
            Próximo intento · {heartbeatTime(state.connectivity?.nextRetryAt)}
          </span>
        </div>
        <div className="row">
          <div>
            <h3>Agentes</h3>
            <p>
              {state.agents?.pauseReason === 'sin-conexion'
                ? 'Pausa automática de seguridad'
                : state.agents?.pauseReason === 'usuario'
                  ? 'Pausa manual'
                  : 'Estado del planificador'}
            </p>
          </div>
          <AgentsStatus state={state} />
          <span className="numeric">Motivo · {state.agents?.pauseReason ?? '—'}</span>
        </div>
        <div className="row">
          <div>
            <h3>Planificador</h3>
            <p>Último latido recibido</p>
          </div>
          <span>
            {state.agentsError
              ? 'No disponible'
              : state.agents?.lastHeartbeatAt
                ? 'Latido recibido'
                : 'Esperando el primer latido'}
          </span>
          <time className="numeric" dateTime={state.agents?.lastHeartbeatAt ?? undefined}>
            {heartbeatTime(state.agents?.lastHeartbeatAt)}
          </time>
        </div>
      </section>
      <section className="empty">
        <h3>Los datos de mercado aún no están disponibles</h3>
        <p>
          Esta fase prepara la aplicación de escritorio. Las fuentes y señales se incorporarán en
          las siguientes fases.
        </p>
      </section>
    </>
  );
}
