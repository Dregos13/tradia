import { useRef, useState } from 'react';
import { LiveIcon, liveTokens, usd } from './presentation';
import { LiveDeactivationButton } from './LiveDeactivationButton';
import { LiveNavigation } from './LiveNavigation';
import { useLiveState } from './useLiveState';
import { useLiveSafety } from './useLiveSafety';
import './checklist.css';
import './live.css';

export interface LiveBannerProps {
  live?: ReturnType<typeof useLiveState>;
  onOpenLimits?: () => void;
  onOpenStop?: () => void;
  onOpenConnection?: () => void;
}
export function LiveBanner(props: LiveBannerProps = {}) {
  return props.live ? (
    <LiveBannerContent {...props} live={props.live} />
  ) : (
    <ConnectedLiveBanner {...props} />
  );
}

function ConnectedLiveBanner(props: LiveBannerProps) {
  const live = useLiveState();
  return <LiveBannerContent {...props} live={live} />;
}

function LiveBannerContent({
  live,
  onOpenLimits,
  onOpenStop,
  onOpenConnection,
}: LiveBannerProps & { live: ReturnType<typeof useLiveState> }) {
  const safety = useLiveSafety();
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState('');
  const locked = useRef(false);
  const state = live.state;
  if (!state || (state.mode !== 'activo' && state.mode !== 'suspendido')) return null;
  const suspended = state.mode === 'suspendido';
  const stopped = safety.stop?.active || state.suspension?.reason === 'parada-emergencia';
  const disconnected =
    safety.connection?.status === 'offline' || state.suspension?.reason === 'sin-conexion';
  const stop = async () => {
    if (locked.current) return;
    locked.current = true;
    setStopping(true);
    setStopError('');
    try {
      await window.tradia.risk.activateKillSwitch();
    } catch {
      setStopError('No se pudo activar la parada. Reintenta o revisa la cuenta en el broker.');
    } finally {
      locked.current = false;
      setStopping(false);
    }
  };
  return (
    <aside className="live-surface live-banner" aria-label="Aviso de dinero real">
      <style>{liveTokens()}</style>
      <div className="live-banner-heading" role="alert">
        <LiveIcon />
        <div>
          <strong>{suspended ? 'DINERO REAL SUSPENDIDO' : 'DINERO REAL'}</strong>
          <span>
            {suspended
              ? stopped
                ? ' · Parada de emergencia activa'
                : disconnected
                  ? ' · Sin conexión · No se enviarán órdenes nuevas'
                  : ` · ${state.suspension?.detail ?? 'No se enviarán órdenes nuevas'}`
              : ` · Capital en riesgo · Alpaca Live ${state.accountMasked ?? 'Cuenta pendiente de verificar'}`}
          </span>
        </div>
      </div>
      <div className="live-banner-limits">
        {state.limits ? (
          <span>
            Capital {usd(state.limits.capitalUsd)} · Orden {usd(state.limits.orderUsd)} · Pérdida
            diaria {usd(state.limits.dailyLossUsd)} · {state.limits.openPositions}{' '}
            {state.limits.openPositions === 1 ? 'posición' : 'posiciones'}
          </span>
        ) : (
          <span>Límites no disponibles · revisa Dinero real</span>
        )}
        <LiveNavigation label="Ver límites" href="#dinero-real" onOpen={onOpenLimits} />
        <LiveDeactivationButton onDeactivated={live.accept} />
        {stopped ? (
          <LiveNavigation label="Ver parada" href="#riesgo" onOpen={onOpenStop} />
        ) : (
          <button className="button" type="button" disabled={stopping} onClick={() => void stop()}>
            {stopping ? 'Activando parada…' : 'Parada'}
          </button>
        )}
        {disconnected && (
          <LiveNavigation label="Ver conexión" href="#ajustes" onOpen={onOpenConnection} />
        )}
      </div>
      {(stopError || live.error) && (
        <p role="alert">
          {stopError || live.error}{' '}
          {live.error && (
            <button className="button" onClick={() => void live.reload()}>
              Reintentar estado
            </button>
          )}
        </p>
      )}
    </aside>
  );
}
