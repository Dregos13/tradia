import { useBroker } from '../hooks/useBroker';
import type { SystemState } from '../hooks/useSystemState';
import { Dashboard } from './dashboard/Dashboard';
export function HomePage({ state }: { state: SystemState }) {
  const broker = useBroker();
  return (
    <Dashboard
      system={state}
      paperConnected={broker.status?.state === 'conectada' && Boolean(broker.status.account?.paper)}
    />
  );
}
