import type { BrokerOrder } from '../../../../shared/broker';
import { LiveIcon } from '../live/presentation';

/** The historical mode must come from the order, never the current app mode. */
export function orderMode(order: BrokerOrder): 'paper' | 'live' | null {
  // Older IPC snapshots do not carry the order's environment. Fail visibly rather
  // than labeling an unverified order as paper. Main must persist this field.
  if ('mode' in order && (order.mode === 'paper' || order.mode === 'live')) return order.mode;
  return null;
}
export function OrderModeBadge({ order }: { order: BrokerOrder }) {
  const mode = orderMode(order);
  return mode === 'live' ? (
    <span className="orders-mode orders-mode-live">
      <LiveIcon />
      DINERO REAL
    </span>
  ) : mode === 'paper' ? (
    <span className="orders-mode orders-paper">Paper · sin dinero real</span>
  ) : (
    <span className="orders-mode orders-mode-unknown">Modo no disponible</span>
  );
}
