// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  BrokerOrder,
  ReconcileDiscrepancyEvent,
  ReconcileRun,
} from '../../../../shared/broker';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { OrdersPage } from './OrdersPage';
import { ReconcileBanner } from './ReconcileBanner';
const run: ReconcileRun = {
  id: 1,
  trigger: 'manual',
  startedAt: '2026-10-09T14:00:00Z',
  finishedAt: '2026-10-09T14:01:00Z',
  result: 'ok',
  positionsApp: 1,
  positionsBroker: 1,
  ordersApp: 2,
  ordersBroker: 2,
  discrepancies: 0,
  error: null,
};
const order = (
  id: number,
  status: BrokerOrder['status'] = 'ejecutada',
  slip: number | null = 8,
): BrokerOrder => ({
  id,
  clientOrderId: `tradia-${id}`,
  brokerOrderId: `remote-${id}`,
  signalId: null,
  strategyId: id === 1 ? 1 : 2,
  leg: null,
  ticker: id === 1 ? 'AAPL' : 'SPY',
  type: 'limit',
  side: 'buy',
  quantity: 10,
  filledQuantity: status === 'ejecutada' ? 10 : 0,
  limitPrice: 100,
  stopPrice: null,
  ocoGroupId: null,
  execution: {
    requestedAt: '2026-10-09T14:00:00Z',
    requestedPrice: 100,
    executedAt: status === 'ejecutada' ? '2026-10-09T14:01:00Z' : null,
    executedPrice: status === 'ejecutada' ? 100.08 : null,
    slippageBps: slip,
  },
  status,
  attempts: 1,
  rejectReason: null,
  createdAt: '2026-10-09T14:00:00Z',
  updatedAt: '2026-10-09T14:01:00Z',
});
beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
  vi.spyOn(window.tradia.orders, 'list').mockResolvedValue([
    order(1),
    order(2, 'ejecutada', -3),
    order(3, 'pendiente', null),
    order(4, 'enviada', null),
    order(5, 'parcial', null),
    order(6, 'cancelada', null),
    order(7, 'rechazada', null),
    order(8, 'huerfana', null),
  ]);
  vi.spyOn(window.tradia.reconcile, 'status').mockResolvedValue({
    lastRun: run,
    openDiscrepancies: [],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('muestra signos y texto del slippage y solo permite cancelar órdenes abiertas', async () => {
  render(<OrdersPage />);
  expect(await screen.findByText('+8 pb · desfavorable')).toBeVisible();
  expect(screen.getByText('−3 pb · favorable')).toBeVisible();
  expect(screen.getAllByRole('button', { name: /^Cancelar orden/ })).toHaveLength(3);
  expect(screen.getByText(/Ejecución parcial/, { selector: 'span.orders-status' })).toBeVisible();
});
it('combina filtros de estado, estrategia y activo y permite limpiarlos', async () => {
  const user = userEvent.setup();
  render(<OrdersPage />);
  await screen.findByText('+8 pb · desfavorable');
  await user.selectOptions(screen.getByLabelText('Estado'), 'pendiente');
  expect(screen.getAllByRole('button', { name: /^Cancelar orden/ })).toHaveLength(1);
  await user.selectOptions(screen.getByLabelText('Estrategia'), '1');
  expect(screen.getByText('No hay órdenes con estos filtros')).toBeVisible();
  await user.click(screen.getAllByRole('button', { name: 'Limpiar filtros' })[0]!);
  await user.type(screen.getByLabelText('Ticker'), 'aapl');
  expect(screen.getByText('+8 pb · desfavorable')).toBeVisible();
  expect(screen.queryByText('−3 pb · favorable')).not.toBeInTheDocument();
});
it('confirma cancelación, conserva la orden al fallar y actualiza tras reintentar', async () => {
  const cancel = vi
    .spyOn(window.tradia.orders, 'cancel')
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue(order(3, 'cancelada', null));
  const user = userEvent.setup();
  render(<OrdersPage />);
  await screen.findByText('+8 pb · desfavorable');
  await user.click(screen.getByRole('button', { name: 'Cancelar orden 3 de SPY' }));
  expect(screen.getByRole('button', { name: 'Mantener orden' })).toHaveFocus();
  expect(cancel).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirmar cancelación' }));
  expect(await screen.findByText(/No se pudo cancelar la orden/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Confirmar cancelación' }));
  expect(await screen.findByText('Orden limitada de SPY: cancelada')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Cancelar orden 3 de SPY' })).not.toBeInTheDocument();
  expect(cancel).toHaveBeenLastCalledWith({ id: 3 });
});
it('crea una orden limitada pendiente y la cancela desde la tabla', async () => {
  const user = userEvent.setup();
  await window.tradia.broker.connect({ apiKeyId: 'PKTESTKEY01', apiSecret: 'paper-secret-01' });
  render(<OrdersPage />);
  await screen.findByText('+8 pb · desfavorable');

  await user.click(screen.getByRole('button', { name: 'Crear orden limitada' }));
  await user.type(screen.getByLabelText('Activo'), 'MSFT');
  await user.type(screen.getByLabelText('Cantidad'), '2');
  await user.type(screen.getByLabelText('Precio límite'), '1');
  await user.click(screen.getByRole('button', { name: 'Enviar orden limitada' }));

  const row = screen.getByRole('row', { name: /MSFT/ });
  expect(row).toHaveTextContent('Limitada');
  expect(await within(row).findByText('Enviada')).toBeVisible();
  expect(row).toHaveTextContent('pendiente de ejecución');

  await user.click(within(row).getByRole('button', { name: /Cancelar orden \d+ de MSFT/ }));
  await user.click(screen.getByRole('button', { name: 'Confirmar cancelación' }));
  expect(await within(row).findByText('Cancelada')).toBeVisible();
});

it('avisa si el envío de la orden limitada falla y conserva el formulario', async () => {
  const user = userEvent.setup();
  render(<OrdersPage />);
  await screen.findByText('+8 pb · desfavorable');

  await user.click(screen.getByRole('button', { name: 'Crear orden limitada' }));
  await user.type(screen.getByLabelText('Activo'), 'MSFT');
  await user.type(screen.getByLabelText('Cantidad'), '2');
  await user.type(screen.getByLabelText('Precio límite'), '1');
  await user.click(screen.getByRole('button', { name: 'Enviar orden limitada' }));

  // Sin cuenta conectada el adaptador rechaza la creación.
  expect(await screen.findByRole('alert')).toHaveTextContent(/No se pudo enviar la orden limitada/);
  expect(screen.getByLabelText('Activo')).toHaveValue('MSFT');
});

it('recibe cambios en vivo, conserva foco y se desuscribe', async () => {
  let listener: ((order: BrokerOrder) => void) | undefined;
  const off = vi.fn();
  vi.spyOn(window.tradia.broker, 'onOrderUpdated').mockImplementation((callback) => {
    listener = callback;
    return off;
  });
  const view = render(<OrdersPage />);
  await screen.findByText('+8 pb · desfavorable');
  screen.getByLabelText('Ticker').focus();
  act(() => listener?.(order(1, 'ejecutada', 12)));
  expect(screen.getByText('+12 pb · desfavorable')).toBeVisible();
  expect(screen.getByLabelText('Ticker')).toHaveFocus();
  view.unmount();
  expect(off).toHaveBeenCalledOnce();
});
it('agrupa OCO sin inventar patas y muestra vacío y reintento de error', async () => {
  vi.mocked(window.tradia.orders.list).mockResolvedValue([
    { ...order(1, 'enviada', null), ocoGroupId: 'oco-a', type: 'oco', stopPrice: 90 },
  ]);
  const view = render(<OrdersPage />);
  expect(await screen.findByText(/Protección OCO · AAPL/)).toBeVisible();
  expect(screen.getByText('Objetivo 100 USD · Stop 90 USD')).toBeVisible();
  view.unmount();
  vi.mocked(window.tradia.orders.list)
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue([]);
  render(<OrdersPage />);
  expect(await screen.findByText(/No se pudieron actualizar las órdenes/)).toBeVisible();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Reintentar órdenes' }));
  expect(await screen.findByText('Todavía no hay órdenes paper')).toBeVisible();
});
it('muestra el banner al recibir discrepancy y lo retira al resolver', async () => {
  let listener: ((event: ReconcileDiscrepancyEvent) => void) | undefined;
  const off = vi.fn();
  vi.spyOn(window.tradia.reconcile, 'onDiscrepancy').mockImplementation((callback) => {
    listener = callback;
    return off;
  });
  const view = render(<ReconcileBanner />);
  const discrepancy = {
    id: 1,
    runId: 1,
    type: 'posicion-cantidad' as const,
    ticker: 'AAPL',
    detail: 'Cantidad distinta',
    appValue: '10 acciones',
    brokerValue: '8 acciones',
    status: 'abierta' as const,
    createdAt: run.startedAt,
    resolvedAt: null,
  };
  vi.mocked(window.tradia.reconcile.status).mockResolvedValue({
    lastRun: { ...run, result: 'descuadre' },
    openDiscrepancies: [discrepancy],
  });
  act(() => listener?.({ runId: 1, at: run.startedAt, discrepancies: [discrepancy] }));
  expect(
    within(await screen.findByRole('alert')).getByText(
      /Tradia registra 10 acciones; broker paper, 8 acciones/,
    ),
  ).toBeVisible();
  vi.mocked(window.tradia.reconcile.status).mockResolvedValue({
    lastRun: run,
    openDiscrepancies: [],
  });
  act(() => listener?.({ runId: 2, at: run.finishedAt!, discrepancies: [] }));
  expect(await screen.findByText(/Descuadre resuelto/)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  view.unmount();
  expect(off).toHaveBeenCalledOnce();
});
it('ejecuta la conciliación manual y presenta un error del broker', async () => {
  vi.spyOn(window.tradia.reconcile, 'run').mockResolvedValue({
    ...run,
    result: 'error',
    error: 'Broker no disponible',
  });
  vi.mocked(window.tradia.reconcile.status).mockResolvedValue({
    lastRun: { ...run, result: 'error', error: 'Broker no disponible' },
    openDiscrepancies: [],
  });
  render(<OrdersPage />);
  await screen.findByText('+8 pb · desfavorable');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Conciliar ahora' }));
  expect(window.tradia.reconcile.run).toHaveBeenCalledOnce();
  expect(await screen.findByText('Broker no disponible')).toBeVisible();
});
it('conserva el evento más reciente frente a una lista inicial tardía', async () => {
  let finish: ((rows: BrokerOrder[]) => void) | undefined;
  let listener: ((value: BrokerOrder) => void) | undefined;
  vi.mocked(window.tradia.orders.list).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  vi.spyOn(window.tradia.broker, 'onOrderUpdated').mockImplementation((callback) => {
    listener = callback;
    return () => {};
  });
  render(<OrdersPage />);
  expect(screen.getByText('Cargando órdenes…')).toBeVisible();
  act(() => listener?.(order(1, 'ejecutada', 0)));
  await act(async () => finish?.([order(1, 'enviada', null)]));
  expect(screen.getByText('0 pb · sin desviación')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: 'Cancelar orden 1 de AAPL' }),
  ).not.toBeInTheDocument();
});
it('bloquea cancelación sin conexión y conserva los datos', async () => {
  vi.spyOn(window.tradia.connectivity, 'getState').mockResolvedValue({
    status: 'offline',
    lastCheckedAt: null,
    attempt: 1,
    nextRetryAt: null,
  });
  render(<OrdersPage />);
  await screen.findByText('+8 pb · desfavorable');
  expect(screen.getByRole('button', { name: 'Cancelar orden 3 de SPY' })).toBeDisabled();
  expect(screen.getByText(/Datos congelados desde/)).toBeVisible();
});
