// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  LIVE_DECLARATION_REQUIREMENTS,
  type LiveState,
  type LiveSmokeTestResult,
  type LiveScalingStatus,
} from '../../../../shared/live';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { LiveBanner } from './LiveBanner';
import { LiveBrokerSettings } from './LiveBrokerSettings';
import { SmokeTestPanel } from './SmokeTestPanel';
import { ScalingStatus } from './ScalingStatus';

let adapter: ReturnType<typeof createSimulatedAdapter>;
let emit: (state: LiveState) => void;
let initial: LiveState;
const limits = { capitalUsd: 500, orderUsd: 100, dailyLossUsd: 10, openPositions: 1 };
const at = '2026-10-10T14:01:00Z';
const smoke: LiveSmokeTestResult = {
  state: 'cerrada-conciliada',
  steps: [
    { step: 'compra-enviada', at },
    { step: 'posicion-cerrada', at },
    { step: 'conciliacion-ok', at },
  ],
  ticker: 'SPY',
  notionalUsd: 1,
  requestedPrice: null,
  buyExecutedPrice: 673.42,
  sellExecutedPrice: 673.39,
  slippageBps: 4,
  reconcileRunId: 3,
  discrepancies: 0,
  failedStep: null,
  error: null,
  startedAt: at,
  finishedAt: at,
};
const active = (): LiveState => ({
  ...initial,
  mode: 'activo',
  limits,
  hasCredentials: true,
  accountMasked: '•••• 4821',
  activatedAt: at,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(async () => {
  adapter = createSimulatedAdapter();
  window.tradia = adapter.api;
  adapter.emitConnectivity({ status: 'online', lastCheckedAt: at, nextRetryAt: null, attempt: 0 });
  initial = await adapter.api.live.state();
  vi.spyOn(adapter.api.live, 'onChanged').mockImplementation((listener) => {
    emit = listener;
    return vi.fn();
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function completeChecklist() {
  await adapter.api.live.testKillSwitch();
  await adapter.api.delivery.test({ channel: 'telegram' });
  for (const requirement of LIVE_DECLARATION_REQUIREMENTS)
    await adapter.api.live.declare({ requirement, confirmed: true });
}
async function activePanel() {
  vi.spyOn(adapter.api.live, 'state').mockResolvedValue(active());
  render(<SmokeTestPanel />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Ejecutar prueba de 1,00 USD' })).toBeEnabled(),
  );
}
async function runSmoke() {
  await userEvent.click(screen.getByRole('button', { name: 'Ejecutar prueba de 1,00 USD' }));
  expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar prueba de 1,00 USD' }));
}

it('la franja responde a eventos, mantiene suspensión y desaparece al volver a paper', async () => {
  const stop = vi.spyOn(adapter.api.risk, 'activateKillSwitch');
  const limitsAction = vi.fn();
  const stopAction = vi.fn();
  render(<LiveBanner onOpenLimits={limitsAction} onOpenStop={stopAction} />);
  expect(screen.queryByLabelText('Aviso de dinero real')).not.toBeInTheDocument();
  act(() => emit(active()));
  const banner = screen.getByRole('complementary', { name: 'Aviso de dinero real' });
  expect(banner).toHaveTextContent('DINERO REAL');
  expect(banner).toHaveTextContent('Capital 500,00 USD');
  expect(banner).toHaveTextContent('Orden 100,00 USD');
  expect(banner).toHaveTextContent('Pérdida diaria 10,00 USD');
  expect(banner).toHaveTextContent('1 posición');
  await userEvent.click(screen.getByRole('button', { name: 'Ver límites' }));
  expect(limitsAction).toHaveBeenCalledOnce();
  await userEvent.click(screen.getByRole('button', { name: 'Parada' }));
  expect(stop).toHaveBeenCalledOnce();
  act(() =>
    emit({
      ...active(),
      mode: 'suspendido',
      suspension: { reason: 'parada-emergencia', detail: 'Parada' },
    }),
  );
  expect(banner).toHaveTextContent('DINERO REAL SUSPENDIDO');
  await userEvent.click(screen.getByRole('button', { name: 'Ver parada' }));
  expect(stopAction).toHaveBeenCalledOnce();
  act(() => emit(initial));
  expect(screen.queryByLabelText('Aviso de dinero real')).not.toBeInTheDocument();
});
it('un snapshot inicial tardío nunca tapa un evento de activación', async () => {
  const pending = deferred<LiveState>();
  vi.spyOn(adapter.api.live, 'state').mockReturnValue(pending.promise);
  render(<LiveBanner />);
  act(() => emit(active()));
  await act(async () => pending.resolve(initial));
  expect(screen.getByText('DINERO REAL')).toBeVisible();
});
it('conserva la franja si falla actualizar el estado y permite reintentar', async () => {
  vi.spyOn(adapter.api.live, 'state')
    .mockResolvedValueOnce(active())
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(active());
  render(<LiveBanner />);
  await screen.findByText('DINERO REAL');
  fireEvent(window, new Event('focus'));
  expect(await screen.findByRole('button', { name: 'Reintentar estado' })).toBeVisible();
  expect(screen.getByText('DINERO REAL')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar estado' }));
  await waitFor(() => expect(screen.queryByText(/No se pudo consultar/)).not.toBeInTheDocument());
});
it('la suspensión por conexión conserva límites y acceso a la conexión', async () => {
  vi.spyOn(adapter.api.live, 'state').mockResolvedValue({
    ...active(),
    mode: 'suspendido',
    suspension: { reason: 'sin-conexion', detail: 'Desconexión' },
  });
  render(<LiveBanner />);
  expect(await screen.findByText(/Sin conexión · No se enviarán/)).toBeVisible();
  expect(screen.getByRole('link', { name: 'Ver conexión' })).toHaveAttribute('href', '#ajustes');
  expect(screen.getByText(/Capital 500/)).toBeVisible();
});
it('la parada se ejecuta sin confirmación y muestra el fallo sin esconder dinero real', async () => {
  vi.spyOn(adapter.api.live, 'state').mockResolvedValue(active());
  vi.spyOn(adapter.api.risk, 'activateKillSwitch').mockRejectedValue(new Error('offline'));
  render(<LiveBanner />);
  await screen.findByText('DINERO REAL');
  await userEvent.click(screen.getByRole('button', { name: 'Parada' }));
  expect(await screen.findByText(/No se pudo activar la parada/)).toBeVisible();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
});
it('elimina suscripciones al desmontar', async () => {
  const off = vi.fn();
  vi.mocked(adapter.api.live.onChanged).mockReturnValue(off);
  const view = render(<LiveBanner />);
  view.unmount();
  expect(off).toHaveBeenCalledOnce();
});

it('bloquea claves y lista todos los requisitos pendientes sin enviar credenciales', async () => {
  const connect = vi.spyOn(adapter.api.live, 'connect');
  render(<LiveBrokerSettings />);
  const blocked = await screen.findByRole('region', { name: 'Claves live bloqueadas' });
  expect(blocked).toHaveTextContent('Plan de contingencia documentado');
  expect(screen.queryByLabelText('Clave de API live')).not.toBeInTheDocument();
  expect(connect).not.toHaveBeenCalled();
});
it('solo guarda claves live válidas con la lista cumplida y nunca las muestra de vuelta', async () => {
  await completeChecklist();
  const connect = vi.spyOn(adapter.api.live, 'connect');
  render(<LiveBrokerSettings />);
  const key = await screen.findByLabelText('Clave de API live');
  const secret = screen.getByLabelText('Secreto de API live');
  expect(key).toHaveAttribute('type', 'password');
  await userEvent.type(key, 'PKPAPER123');
  await userEvent.type(secret, 'private-secret');
  await userEvent.click(screen.getByRole('button', { name: 'Verificar y guardar claves live' }));
  expect(key).toHaveAttribute('aria-invalid', 'true');
  expect(connect).not.toHaveBeenCalled();
  await userEvent.clear(key);
  await userEvent.type(key, 'AKTESTKEY123');
  await userEvent.click(screen.getByRole('button', { name: 'Verificar y guardar claves live' }));
  expect(await screen.findByText(/Cuenta live verificada/)).toBeVisible();
  expect(connect).toHaveBeenCalledWith({ apiKeyId: 'AKTESTKEY123', apiSecret: 'private-secret' });
  expect(screen.queryByDisplayValue('private-secret')).not.toBeInTheDocument();
  expect(screen.queryByText('private-secret')).not.toBeInTheDocument();
  expect((await adapter.api.live.state()).mode).not.toBe('activo');
});
it('revalida la lista justo antes de enviar y bloquea si ha cambiado', async () => {
  await completeChecklist();
  const snapshot = await adapter.api.live.checklist();
  const checklist = vi
    .spyOn(adapter.api.live, 'checklist')
    .mockResolvedValueOnce(snapshot)
    .mockResolvedValue({
      ...snapshot,
      allComplete: false,
      items: snapshot.items.map((item) =>
        item.requirement === 'revision-legal' ? { ...item, state: 'pendiente' } : item,
      ),
    });
  const connect = vi.spyOn(adapter.api.live, 'connect');
  render(<LiveBrokerSettings />);
  await userEvent.type(await screen.findByLabelText('Clave de API live'), 'AKTESTKEY123');
  await userEvent.type(screen.getByLabelText('Secreto de API live'), 'private-secret');
  await userEvent.click(screen.getByRole('button', { name: 'Verificar y guardar claves live' }));
  expect(await screen.findByRole('region', { name: 'Claves live bloqueadas' })).toBeVisible();
  expect(checklist).toHaveBeenCalledTimes(2);
  expect(connect).not.toHaveBeenCalled();
});
it('sanea errores que contienen credenciales y limpia ambos campos al fallar', async () => {
  await completeChecklist();
  vi.spyOn(adapter.api.live, 'connect').mockRejectedValue(
    new Error('safeStorage: AKTESTKEY123 private-secret'),
  );
  render(<LiveBrokerSettings />);
  const key = await screen.findByLabelText('Clave de API live');
  const secret = screen.getByLabelText('Secreto de API live');
  await userEvent.type(key, 'AKTESTKEY123');
  await userEvent.type(secret, 'private-secret');
  await userEvent.click(screen.getByRole('button', { name: 'Verificar y guardar claves live' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('safeStorage: [oculto] [oculto]');
  expect(key).toHaveValue('');
  expect(secret).toHaveValue('');
});
it('conserva solo el resumen enmascarado y no permite reemplazar claves operando en real', async () => {
  await completeChecklist();
  vi.spyOn(adapter.api.live, 'state').mockResolvedValue(active());
  render(<LiveBrokerSettings />);
  expect(await screen.findByText(/Claves live guardadas/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Reemplazar claves live' })).toBeDisabled();
  expect(screen.queryByLabelText('Secreto de API live')).not.toBeInTheDocument();
});
it('un error de checklist permite reintentar y no habilita las claves', async () => {
  await completeChecklist();
  const snapshot = await adapter.api.live.checklist();
  vi.spyOn(adapter.api.live, 'checklist')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(snapshot);
  render(<LiveBrokerSettings />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo verificar la lista');
  expect(screen.queryByLabelText('Clave de API live')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar cuenta live' }));
  expect(await screen.findByLabelText('Clave de API live')).toBeVisible();
});

it('la prueba se bloquea en paper y muestra cuatro pasos pendientes', async () => {
  const send = vi.spyOn(adapter.api.live, 'smokeTest');
  render(<SmokeTestPanel />);
  expect(await screen.findByText('El modo real debe estar activo.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Ejecutar prueba de 1,00 USD' })).toBeDisabled();
  expect(
    within(screen.getByRole('list', { name: 'Pasos de la prueba de humo' })).getAllByRole(
      'listitem',
    ),
  ).toHaveLength(4);
  expect(send).not.toHaveBeenCalled();
});
it('confirmación segura, escape y foco devuelto sin enviar una orden', async () => {
  const send = vi.spyOn(adapter.api.live, 'smokeTest');
  await activePanel();
  const trigger = screen.getByRole('button', { name: 'Ejecutar prueba de 1,00 USD' });
  await userEvent.click(trigger);
  expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(screen.getByRole('button', { name: 'Confirmar prueba de 1,00 USD' })).toHaveFocus();
  await userEvent.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  expect(send).not.toHaveBeenCalled();
});
it('envía una sola prueba y muestra ejecución, cierre, conciliación y datos recibidos', async () => {
  const pending = deferred<LiveSmokeTestResult>();
  const send = vi.spyOn(adapter.api.live, 'smokeTest').mockReturnValue(pending.promise);
  await activePanel();
  await runSmoke();
  expect(screen.getByRole('button', { name: 'Prueba en curso…' })).toBeDisabled();
  expect(send).toHaveBeenCalledExactlyOnceWith({ confirm: true });
  act(() =>
    emit({
      ...active(),
      smokeTest: {
        ...smoke,
        state: 'en-curso',
        steps: [
          { step: 'compra-enviada', at },
          { step: 'posicion-cerrada', at: null },
          { step: 'conciliacion-ok', at: null },
        ],
        sellExecutedPrice: null,
        finishedAt: null,
        discrepancies: null,
      },
    }),
  );
  const steps = within(
    screen.getByRole('list', { name: 'Pasos de la prueba de humo' }),
  ).getAllByRole('listitem');
  expect(steps[0]).toHaveTextContent('Completado');
  expect(steps[1]).toHaveTextContent('Completado');
  expect(steps[2]).toHaveTextContent('En curso');
  expect(screen.getByText('Prueba en curso · Posición cerrada')).toHaveAttribute('role', 'status');
  expect(screen.getByRole('region', { name: 'Prueba de humo · 1,00 USD reales' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  await act(async () => pending.resolve(smoke));
  expect(await screen.findByText('Cerrada y conciliada')).toBeVisible();
  expect(screen.getByText('673,42 USD')).toBeVisible();
  expect(screen.getByText('+4 pb · desfavorable')).toBeVisible();
  expect(screen.getByText('Sin diferencias')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Ver entrada en Diario' })).toBeVisible();
});
it.each(['compra-enviada', 'posicion-cerrada', 'conciliacion-ok'] as const)(
  'nombra el paso fallido %s y conserva la posición real si la hay',
  async (failedStep) => {
    const failed: LiveSmokeTestResult = {
      ...smoke,
      state: failedStep === 'compra-enviada' ? 'fallida-sin-posicion' : 'fallida-posicion-abierta',
      failedStep,
      error: 'Fallo del broker',
      discrepancies: failedStep === 'conciliacion-ok' ? 1 : null,
      steps: smoke.steps.map((row) => ({
        ...row,
        at: row.step === failedStep || row.step === 'conciliacion-ok' ? null : row.at,
      })),
      buyExecutedPrice: failedStep === 'compra-enviada' ? null : smoke.buyExecutedPrice,
    };
    vi.spyOn(adapter.api.live, 'state').mockResolvedValue({ ...active(), smokeTest: failed });
    render(<SmokeTestPanel />);
    expect(await screen.findByText(/Paso fallido:/)).toHaveTextContent('Fallo del broker');
    expect(screen.getByText('Fallido')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Ejecutar prueba de 1,00 USD' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Ver orden y cierre' })).toBeVisible();
    if (failedStep !== 'compra-enviada')
      expect(screen.getByText(/Queda una posición real abierta/)).toBeVisible();
    if (failedStep === 'conciliacion-ok') expect(screen.getByText('1 descuadres')).toBeVisible();
  },
);
it('al perder conexión conserva el progreso recibido y cierra una confirmación pendiente', async () => {
  await activePanel();
  await userEvent.click(screen.getByRole('button', { name: 'Ejecutar prueba de 1,00 USD' }));
  act(() =>
    adapter.emitConnectivity({
      status: 'offline',
      lastCheckedAt: at,
      nextRetryAt: null,
      attempt: 1,
    }),
  );
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  act(() =>
    emit({
      ...active(),
      mode: 'suspendido',
      suspension: { reason: 'sin-conexion', detail: 'offline' },
      smokeTest: {
        ...smoke,
        state: 'en-curso',
        steps: [{ step: 'compra-enviada', at }],
        buyExecutedPrice: null,
        sellExecutedPrice: null,
        discrepancies: null,
      },
    }),
  );
  expect(await screen.findByText(/último paso conservado/)).toBeVisible();
  expect(
    within(screen.getByRole('list', { name: 'Pasos de la prueba de humo' })).getAllByText(
      'Completado',
    ),
  ).toHaveLength(1);
});
it.each(['compra-enviada', null] as const)(
  'muestra el motivo de cordura incluso sin paso fallido (%s) y bloquea repetir',
  async (failedStep) => {
    const error = 'Slippage de −8278 pb fuera del margen de cordura de 300 pb.';
    vi.spyOn(adapter.api.live, 'state').mockResolvedValue({
      ...active(),
      mode: 'suspendido',
      smokeTest: {
        ...smoke,
        state: 'fallida-posicion-abierta',
        failedStep,
        error,
        slippageBps: -8278,
        sellExecutedPrice: null,
        discrepancies: null,
        steps: [{ step: 'compra-enviada', at }],
      },
    });
    render(<SmokeTestPanel />);
    expect(await screen.findByText(/fuera del margen de cordura/)).toHaveAttribute('role', 'alert');
    expect(screen.getByText(/Queda una posición real abierta/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Ejecutar prueba de 1,00 USD' })).toBeDisabled();
    expect(screen.queryByText('Cerrada y conciliada')).not.toBeInTheDocument();
  },
);
it('rechazos IPC se muestran y nunca se reenvía automáticamente la prueba', async () => {
  const send = vi
    .spyOn(adapter.api.live, 'smokeTest')
    .mockRejectedValue(new Error('Mercado cerrado. Reintenta en horario compatible.'));
  await activePanel();
  await runSmoke();
  expect(await screen.findByText(/Mercado cerrado/)).toBeVisible();
  expect(send).toHaveBeenCalledOnce();
  expect(screen.getByRole('link', { name: 'Revisar conciliación' })).toBeVisible();
});
it('historial inaccesible permite reintentar sin habilitar la prueba', async () => {
  vi.spyOn(adapter.api.live, 'state')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(active());
  render(<SmokeTestPanel />);
  expect(await screen.findByRole('button', { name: 'Reintentar historial' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Ejecutar prueba de 1,00 USD' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar historial' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Ejecutar prueba de 1,00 USD' })).toBeEnabled(),
  );
});
it('bloquea si los límites escritos no permiten el mínimo de la prueba', async () => {
  vi.spyOn(adapter.api.live, 'state').mockResolvedValue({
    ...active(),
    limits: { ...limits, orderUsd: 0.5 },
  });
  render(<SmokeTestPanel />);
  expect(await screen.findByText(/Los límites confirmados deben/)).toBeVisible();
  expect(screen.getByRole('button', { name: 'Ejecutar prueba de 1,00 USD' })).toBeDisabled();
});

it.each(['bloqueado', 'en-evidencia', 'elegible'] as const)(
  'el escalado %s muestra evidencia y motivo sin controles de subida',
  async (state) => {
    const status: LiveScalingStatus = {
      state,
      liveWeeks: 4,
      liveTrades: 8,
      weeksInMargin: 3,
      deviationPct: -11,
      drawdownPct: -1.2,
      reason: 'Todavía falta muestra real conciliada.',
      evaluatedAt: at,
    };
    vi.spyOn(adapter.api.live, 'scaling').mockResolvedValue(status);
    render(<ScalingStatus />);
    expect(await screen.findByText(status.reason)).toBeVisible();
    expect(screen.getByText('8 de 30')).toBeVisible();
    expect(screen.getByText('4 de 8 semanas')).toBeVisible();
    expect(screen.getByText('-11 %')).toBeVisible();
    expect(screen.getByText(/no aumenta límites automáticamente/)).toBeVisible();
    expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver evidencia' })).toBeVisible();
  },
);
it('escalado vacío y error conservan el bloqueo y permiten volver a consultar', async () => {
  const snapshot = await adapter.api.live.scaling();
  vi.spyOn(adapter.api.live, 'scaling')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(snapshot);
  render(<ScalingStatus />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cargar la evidencia');
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar evidencia' }));
  expect(await screen.findByText(/Todavía no hay operaciones/)).toBeVisible();
  expect(screen.getAllByText('Sin muestra suficiente')).toHaveLength(2);
});

it('no entrega las claves si se pierde conexión mientras revalida la lista', async () => {
  await completeChecklist();
  const snapshot = await adapter.api.live.checklist();
  const pending = deferred<typeof snapshot>();
  vi.spyOn(adapter.api.live, 'checklist')
    .mockResolvedValueOnce(snapshot)
    .mockReturnValue(pending.promise);
  const connect = vi.spyOn(adapter.api.live, 'connect');
  render(<LiveBrokerSettings />);
  await userEvent.type(await screen.findByLabelText('Clave de API live'), 'AKTESTKEY123');
  await userEvent.type(screen.getByLabelText('Secreto de API live'), 'private-secret');
  await userEvent.click(screen.getByRole('button', { name: 'Verificar y guardar claves live' }));
  act(() =>
    adapter.emitConnectivity({
      status: 'offline',
      lastCheckedAt: at,
      nextRetryAt: null,
      attempt: 1,
    }),
  );
  await act(async () => pending.resolve(snapshot));
  expect(connect).not.toHaveBeenCalled();
  expect(await screen.findByRole('alert')).toHaveTextContent('La conexión o el modo ha cambiado');
});

it('bloquea una segunda prueba después de un error cuyo envío podría haber llegado al broker', async () => {
  vi.spyOn(adapter.api.live, 'smokeTest').mockRejectedValue(new Error('Tiempo de espera agotado.'));
  await activePanel();
  await runSmoke();
  expect(await screen.findByText('Tiempo de espera agotado.')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Ejecutar prueba de 1,00 USD' })).toBeDisabled();
  expect(
    screen.getByText('Revisa la orden y su conciliación antes de repetir una prueba.'),
  ).toBeVisible();
});
