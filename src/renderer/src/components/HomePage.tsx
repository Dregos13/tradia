import type { SystemState } from '../hooks/useSystemState';
import { Dashboard } from './dashboard/Dashboard';
export function HomePage({ state }: { state: SystemState }) {
  return <Dashboard system={state} />;
}
