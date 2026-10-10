import type { BrokerOrder } from '../../../../shared/broker';
import { BROKER_ORDER_OPEN_STATUSES } from '../../../../shared/broker';
import { number, orderStatuses, orderTypes, price, slippage, time } from './orderPresentation';
const cancelable = (order: BrokerOrder) =>
  BROKER_ORDER_OPEN_STATUSES.some((status) => status === order.status);
function Status({ order }: { order: BrokerOrder }) {
  const status = orderStatuses[order.status];
  return (
    <>
      <span className={`orders-status orders-${status.token}`}>
        <span aria-hidden="true">{status.icon}</span> {status.label}
      </span>
      {order.status === 'parcial' && (
        <small>
          {number(order.filledQuantity)} de {number(order.quantity)} ejecutadas
        </small>
      )}
      {order.rejectReason && <small>{order.rejectReason}</small>}
      {order.status === 'huerfana' && <small>Sin correspondencia entre app y broker</small>}
    </>
  );
}
export function OrderRow({
  order,
  grouped,
  names,
  offline,
  canceling,
  onCancel,
}: {
  order: BrokerOrder;
  grouped: boolean;
  names: Map<number, string>;
  offline: boolean;
  canceling: boolean;
  onCancel: (order: BrokerOrder, trigger: HTMLButtonElement) => void;
}) {
  return (
    <tr key={order.id} className={grouped ? 'orders-oco-child' : ''}>
      <td>
        <time title={order.execution.requestedAt} dateTime={order.execution.requestedAt}>
          {time(order.execution.requestedAt)}
        </time>
        {order.execution.executedAt && <small>Ejecutada: {time(order.execution.executedAt)}</small>}
      </td>
      <td>
        <strong>{order.ticker}</strong>
      </td>
      <td>
        {grouped && order.type !== 'oco'
          ? `OCO · ${order.type === 'stop' ? 'stop' : 'objetivo'}`
          : orderTypes[order.type]}
        {order.type === 'oco' && (
          <small>
            Objetivo {price(order.limitPrice)} · Stop {price(order.stopPrice)}
          </small>
        )}
      </td>
      <td>
        <span aria-hidden="true">{order.side === 'buy' ? '↑' : '↓'}</span>{' '}
        {order.side === 'buy' ? 'Compra' : 'Venta'}
      </td>
      <td className="orders-number">{number(order.quantity)}</td>
      <td className="orders-number">{price(order.execution.requestedPrice)}</td>
      <td className="orders-number">
        {price(order.execution.executedPrice)}
        {order.execution.executedPrice === null && <small>Aún no ejecutada</small>}
      </td>
      <td
        className={`orders-number ${order.execution.slippageBps === null ? '' : order.execution.slippageBps > 0 ? 'orders-adverse' : order.execution.slippageBps < 0 ? 'orders-favorable' : ''}`}
      >
        {slippage(order.execution.slippageBps)}
      </td>
      <td>
        {order.strategyId === null
          ? 'Sin estrategia'
          : (names.get(order.strategyId) ?? `Estrategia ${order.strategyId}`)}
      </td>
      <td>
        <Status order={order} />
      </td>
      <td>
        {cancelable(order) ? (
          <button
            className="button danger"
            aria-label={`Cancelar orden ${order.id} de ${order.ticker}`}
            disabled={offline || canceling}
            title={offline ? 'Necesitas conexión para cancelar' : undefined}
            onClick={(event) => {
              onCancel(order, event.currentTarget);
            }}
          >
            Cancelar
            <span className="sr-only">
              {' '}
              orden {order.id} de {order.ticker}
            </span>
          </button>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}
