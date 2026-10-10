import { useEffect, useState } from 'react';
import type { ConnectivityState } from '../../../../shared/ipc';
import type { KillSwitchState } from '../../../../shared/risk';

/** Unknown safety state blocks money-moving actions until main answers. */
export function useLiveSafety() {
  const [connection, setConnection] = useState<ConnectivityState | null>(null);
  const [stop, setStop] = useState<KillSwitchState | null>(null);
  useEffect(() => {
    let mounted = true;
    let connectionEvent = false;
    let stopEvent = false;
    const offConnection = window.tradia.connectivity.onChanged((next) => {
      connectionEvent = true;
      if (mounted) setConnection(next);
    });
    const offStop = window.tradia.risk.onChanged((next) => {
      stopEvent = true;
      if (mounted) setStop(next.killSwitch);
    });
    void window.tradia.connectivity.getState().then((next) => {
      if (mounted && !connectionEvent) setConnection(next);
    }).catch(() => { /* Remain blocked until a verified event arrives. */ });
    void window.tradia.risk.getKillSwitch().then((next) => {
      if (mounted && !stopEvent) setStop(next);
    }).catch(() => { /* Remain blocked until a verified event arrives. */ });
    return () => {
      mounted = false;
      offConnection();
      offStop();
    };
  }, []);
  return { connection, stop, online: connection?.status === 'online' };
}
