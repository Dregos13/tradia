import { useEffect, useState } from 'react';

import type { AgentsState, AppSettings, ConnectivityState } from '../../shared/ipc';

/**
 * Pantalla provisional del esqueleto.
 * La tarea «renderer-shell» (frontend) construye aquí la maquetación real
 * con los tokens del sistema de diseño.
 */
export default function App() {
  const [connectivity, setConnectivity] = useState<ConnectivityState | null>(null);
  const [agents, setAgents] = useState<AgentsState | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  useEffect(() => {
    if (!window.tradia) return;
    window.tradia.connectivity.getState().then(setConnectivity).catch(console.error);
    window.tradia.agents.getState().then(setAgents).catch(console.error);
    window.tradia.settings.get().then(setSettings).catch(console.error);
    const offConnectivity = window.tradia.connectivity.onChanged(setConnectivity);
    const offAgents = window.tradia.agents.onChanged(setAgents);
    const offHeartbeat = window.tradia.agents.onHeartbeat((at) =>
      setAgents((prev) => (prev ? { ...prev, lastHeartbeatAt: at } : prev)),
    );
    return () => {
      offConnectivity();
      offAgents();
      offHeartbeat();
    };
  }, []);

  const online = connectivity?.status !== 'offline';
  const disclaimerAccepted = settings?.disclaimerAcceptedVersion != null;

  return (
    <main className="app">
      <header>
        <h1>Tradia</h1>
        <p className="subtitle">Agentes de trading — señales y paper trading</p>
      </header>
      <section className="panel">
        <h2>Estado</h2>
        <ul>
          <li>Conexión: {online ? 'En línea' : 'Sin conexión'}</li>
          <li>
            Agentes: {agents?.paused ? `En pausa (${agents.pauseReason ?? 'manual'})` : 'Activos'}
          </li>
          <li>
            Último latido:{' '}
            {agents?.lastHeartbeatAt ? new Date(agents.lastHeartbeatAt).toLocaleTimeString() : '—'}
          </li>
          <li>Aviso de riesgo: {disclaimerAccepted ? 'Aceptado' : 'Pendiente'}</li>
        </ul>
      </section>
      <footer className="statusbar" aria-live="polite">
        {online ? 'En línea' : 'Sin conexión'} · Tradia se ejecuta en segundo plano
      </footer>
    </main>
  );
}
