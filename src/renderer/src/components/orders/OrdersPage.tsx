import { useEffect, useRef, useState } from 'react';
import type { BrokerOrder, BrokerOrderStatus } from '../../../../shared/broker';
import { BROKER_ORDER_OPEN_STATUSES, BROKER_ORDER_STATUSES } from '../../../../shared/broker';
import { useOrders, useReconciliation } from '../../hooks/useOrders';
import { useStrategies } from '../../hooks/useStrategies';
import { useSystemState } from '../../hooks/useSystemState';
import { ReconcileStatus } from './ReconcileStatus';
import {
  number,
  orderStatuses,
  orderTypes,
  ordersTokenStylesheet,
  price,
  time,
} from './orderPresentation';
import { OrderRow } from './OrderRow';
import './orders.css';
const cancelable = (order: BrokerOrder) =>
  BROKER_ORDER_OPEN_STATUSES.some((status) => status === order.status);
export function OrdersPage() {
  const state = useOrders();
  const reconciliation = useReconciliation();
  const strategies = useStrategies();
  const system = useSystemState();
  const offline = system.connectivity?.status === 'offline';
  const [status, setStatus] = useState<BrokerOrderStatus | ''>('');
  const [strategy, setStrategy] = useState('');
  const [ticker, setTicker] = useState('');
  const [confirmation, setConfirmation] = useState<number | null>(null);
  const [canceling, setCanceling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const keep = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const busy = useRef(false);
  const rows = state.orders
    .filter(
      (row) =>
        (!status || row.status === status) &&
        (!strategy || row.strategyId === Number(strategy)) &&
        row.ticker.toUpperCase().includes(ticker.trim().toUpperCase()),
    )
    .sort((a, b) => b.execution.requestedAt.localeCompare(a.execution.requestedAt) || b.id - a.id);
  const selected = state.orders.find((order) => order.id === confirmation);
  useEffect(() => {
    if (confirmation !== null) keep.current?.focus();
  }, [confirmation]);
  const close = () => {
    setConfirmation(null);
    setCancelError(null);
    trigger.current?.focus();
  };
  const cancel = async () => {
    if (!selected || !cancelable(selected) || busy.current || offline) return;
    busy.current = true;
    setCanceling(true);
    setCancelError(null);
    try {
      const updated = await window.tradia.orders.cancel({ id: selected.id });
      state.update(updated);
      setAnnouncement(
        `Orden ${orderTypes[selected.type].toLowerCase()} de ${selected.ticker}: ${orderStatuses[updated.status].label.toLowerCase()}`,
      );
      close();
    } catch {
      setCancelError('No se pudo cancelar la orden. Comprueba su estado e inténtalo de nuevo.');
    } finally {
      busy.current = false;
      setCanceling(false);
    }
  };
  const clear = () => {
    setStatus('');
    setStrategy('');
    setTicker('');
  };
  const names = new Map(strategies.strategies.map((value) => [value.id, value.name]));
  const groups = new Map<string, BrokerOrder[]>();
  rows.forEach((row) => {
    const key = row.ocoGroupId ? `oco:${row.ocoGroupId}` : `order:${row.id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  });

  return (
    <div className="orders-page orders-surface">
      <style>{ordersTokenStylesheet()}</style>
      <div className="orders-top">
        <header>
          <div className="orders-title">
            <h1>Órdenes</h1>
            <span className="orders-paper">♢ Solo paper · sin dinero real</span>
          </div>
          <p>Ejecuciones simuladas enviadas por Tradia</p>
          {state.updatedAt && (
            <small>
              {offline ? 'Datos congelados desde' : state.error ? 'Datos de' : 'Actualizado'}{' '}
              {time(state.updatedAt)}
            </small>
          )}
        </header>
        <ReconcileStatus state={reconciliation} />
      </div>
      <section className="orders-filters" aria-label="Filtros de órdenes">
        <label>
          Estado
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as BrokerOrderStatus | '')}
          >
            <option value="">Todos los estados</option>
            {BROKER_ORDER_STATUSES.map((value) => (
              <option key={value} value={value}>
                {orderStatuses[value].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Estrategia
          <select value={strategy} onChange={(event) => setStrategy(event.target.value)}>
            <option value="">Todas las estrategias</option>
            {[
              ...new Set([
                ...names.keys(),
                ...state.orders.flatMap((row) => (row.strategyId === null ? [] : [row.strategyId])),
              ]),
            ].map((id) => (
              <option key={id} value={id}>
                {names.get(id) ?? `Estrategia ${id}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          Activo
          <input
            value={ticker}
            onChange={(event) => setTicker(event.target.value)}
            placeholder="Buscar ticker"
          />
        </label>
        <button className="button" onClick={clear}>
          Limpiar filtros
        </button>
      </section>
      {strategies.error && (
        <p role="alert">
          {strategies.error}{' '}
          <button className="button" onClick={() => void strategies.reload()}>
            Reintentar estrategias
          </button>
        </p>
      )}
      {offline && <p role="status">Necesitas conexión para cancelar.</p>}
      <p role="status">{announcement}</p>
      {state.error && (
        <p className="orders-error" role="alert">
          {state.error}{' '}
          <button className="button" onClick={() => void state.reload()}>
            Reintentar órdenes
          </button>
        </p>
      )}
      {selected && (
        <section
          className="orders-confirm"
          aria-labelledby="cancel-order-title"
          onKeyDown={(event) => {
            if (event.key === 'Escape' && !canceling) close();
          }}
        >
          <h2 id="cancel-order-title">
            Cancelar la orden {orderTypes[selected.type].toLowerCase()} de{' '}
            {number(selected.quantity - selected.filledQuantity)} {selected.ticker}
            {selected.execution.requestedPrice !== null
              ? ` a ${price(selected.execution.requestedPrice)}`
              : ''}
          </h2>
          <p>
            El broker puede ejecutarla antes de confirmar la cancelación.
            {selected.ocoGroupId && ' La cancelación afecta a la protección OCO vinculada.'}
          </p>
          {!cancelable(selected) && (
            <p role="status">La orden ya no está pendiente. No se puede cancelar.</p>
          )}
          {cancelError && <p role="alert">{cancelError}</p>}
          <div className="orders-actions">
            <button ref={keep} className="button" disabled={canceling} onClick={close}>
              Mantener orden
            </button>
            <button
              className="button danger"
              disabled={canceling || offline || !cancelable(selected)}
              onClick={() => void cancel()}
            >
              {canceling ? 'Cancelando…' : 'Confirmar cancelación'}
            </button>
          </div>
        </section>
      )}
      <p>
        {status || strategy || ticker
          ? `${rows.length} de ${state.orders.length}`
          : state.orders.length}{' '}
        órdenes · Hora local
      </p>
      <p className="orders-scroll-hint">Desplázate horizontalmente para ver todas las columnas.</p>
      <div
        className="orders-table-wrap"
        role="region"
        aria-label="Órdenes paper, desplazamiento horizontal"
        tabIndex={0}
        aria-busy={state.loading}
      >
        <table className={state.error || offline ? 'orders-frozen' : undefined}>
          <caption className="sr-only">Órdenes paper y precios de ejecución</caption>
          <thead>
            <tr>
              {[
                'Hora',
                'Activo',
                'Tipo',
                'Lado',
                'Cantidad',
                'Precio pedido',
                'Precio ejecutado',
                'Slippage',
                'Estrategia',
                'Estado',
                'Acciones',
              ].map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          {state.loading && state.orders.length === 0 ? (
            <tbody>
              {Array.from({ length: 5 }, (_, index) => (
                <tr key={index}>
                  <td colSpan={11}>
                    {index === 0 ? (
                      <span role="status">Cargando órdenes…</span>
                    ) : (
                      <span aria-hidden="true">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          ) : (
            [...groups.entries()].map(([key, group]) => (
              <tbody
                key={key}
                aria-label={
                  key.startsWith('oco:') ? `Protección OCO de ${group[0]?.ticker}` : undefined
                }
              >
                {key.startsWith('oco:') && (
                  <tr className="orders-oco-parent">
                    <th scope="rowgroup" colSpan={11}>
                      Protección OCO · {group[0]?.ticker} · {number(group[0]?.quantity ?? 0)} ·{' '}
                      {group.length} {group.length === 1 ? 'orden vinculada' : 'órdenes vinculadas'}{' '}
                      ·{' '}
                      {group.some(cancelable)
                        ? 'Activa'
                        : group.some((row) => row.status === 'ejecutada')
                          ? 'Ejecutada'
                          : 'Cerrada'}
                    </th>
                  </tr>
                )}
                {group.map((row) => (
                  <OrderRow
                    key={row.id}
                    order={row}
                    grouped={key.startsWith('oco:')}
                    names={names}
                    offline={offline}
                    canceling={canceling}
                    onCancel={(order, button) => {
                      trigger.current = button;
                      setCancelError(null);
                      setConfirmation(order.id);
                    }}
                  />
                ))}
              </tbody>
            ))
          )}
        </table>
      </div>
      {!state.loading && !state.error && !rows.length && (
        <section className="orders-empty">
          <h2>
            {state.orders.length
              ? 'No hay órdenes con estos filtros'
              : 'Todavía no hay órdenes paper'}
          </h2>
          {state.orders.length ? (
            <button className="button" onClick={clear}>
              Limpiar filtros
            </button>
          ) : (
            <>
              <p>Cuando Riesgo apruebe una señal y la ejecución esté activa, aparecerá aquí.</p>
              <a href="#ajustes">Revisar cuenta paper</a>
            </>
          )}
        </section>
      )}
    </div>
  );
}
