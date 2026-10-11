// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  LIVE_DECLARATION_REQUIREMENTS,
  LIVE_DECLARATION_TEXTS,
  LIVE_REQUIREMENTS,
  LIVE_REQUIREMENT_TITLES,
  liveConfirmationPhrase,
  type LiveChecklist,
  type LiveLimits,
} from '../../../../shared/live';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { ChecklistPage } from './ChecklistPage';

let adapter: ReturnType<typeof createSimulatedAdapter>;
const limits: LiveLimits = { capitalUsd: 500, orderUsd: 100, dailyLossUsd: 10, openPositions: 1 };
beforeEach(() => {
  adapter = createSimulatedAdapter();
  window.tradia = adapter.api;
  adapter.emitConnectivity({
    status: 'online',
    lastCheckedAt: null,
    nextRetryAt: null,
    attempt: 0,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function mount() {
  await act(async () => {
    render(<ChecklistPage />);
  });
}
async function complete() {
  await adapter.api.live.testKillSwitch();
  await adapter.api.delivery.test({ channel: 'telegram' });
  for (const requirement of LIVE_DECLARATION_REQUIREMENTS)
    await adapter.api.live.declare({ requirement, confirmed: true, detail: 'Documento revisado' });
  await adapter.api.live.connect({ apiKeyId: 'AKTESTKEY', apiSecret: 'test-secret' });
  await adapter.api.live.setLimits(limits);
}
async function openDialog() {
  await userEvent.click(screen.getByRole('button', { name: 'Activar dinero real' }));
  return screen.findByRole('alertdialog');
}
function fillLimits(values: LiveLimits = limits) {
  for (const [label, key] of [
    ['Capital total en real', 'capitalUsd'],
    ['Máximo por orden', 'orderUsd'],
    ['Pérdida diaria máxima', 'dailyLossUsd'],
    ['Posiciones abiertas simultáneas', 'openPositions'],
  ] as const)
    fireEvent.change(screen.getByLabelText(label), { target: { value: String(values[key]) } });
}

it('lista evidencia, fecha y cada motivo pendiente, con activación bloqueada', async () => {
  const activate = vi.spyOn(adapter.api.live, 'activate');
  await mount();
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
  const reasons = within(screen.getByRole('region', { name: 'No se puede activar todavía' }));
  for (const requirement of [
    'parada-probada',
    'alertas-activas',
    ...LIVE_DECLARATION_REQUIREMENTS,
  ] as const)
    expect(reasons.getByRole('list')).toHaveTextContent(LIVE_REQUIREMENT_TITLES[requirement]);
  expect(
    screen.getByText('3,2 meses de paper continuo · 36 operaciones · desviación −4 %.'),
  ).toBeInTheDocument();
  expect(screen.getAllByText('Verificación automática')).toHaveLength(4);
  expect(screen.getAllByRole('checkbox')).toHaveLength(3);
  expect(screen.getAllByText(/Sin evidencia guardada/)).toHaveLength(3);
  expect(activate).not.toHaveBeenCalled();
});

it('obtiene evidencia de parada y alerta por sus canales reales, sin declaraciones automáticas', async () => {
  const stop = vi.spyOn(adapter.api.live, 'testKillSwitch');
  const alert = vi.spyOn(adapter.api.delivery, 'test');
  const declare = vi.spyOn(adapter.api.live, 'declare');
  await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Probar parada' }));
  expect(stop).toHaveBeenCalledOnce();
  expect(
    await screen.findByText('Parada probada: se activó y se reanudó en paper.'),
  ).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByLabelText('Canal de prueba'), 'correo');
  await userEvent.click(screen.getByRole('button', { name: 'Enviar alerta de prueba' }));
  expect(alert).toHaveBeenCalledWith({ channel: 'correo' });
  expect(await screen.findByText('Alerta de prueba enviada correctamente.')).toBeInTheDocument();
  expect(declare).not.toHaveBeenCalled();
  expect(screen.getAllByText('Cumplido')).toHaveLength(4);
});

it('muestra los fallos seguros de las pruebas sin completar requisitos', async () => {
  vi.spyOn(adapter.api.live, 'testKillSwitch').mockResolvedValue({
    ok: false,
    error: 'La parada ya está activa.',
    testedAt: null,
  });
  vi.spyOn(adapter.api.delivery, 'test').mockResolvedValue({
    ok: false,
    error: 'Configura primero el correo.',
    latencyMs: null,
  });
  await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Probar parada' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('La parada ya está activa.');
  await userEvent.click(screen.getByRole('button', { name: 'Enviar alerta de prueba' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Configura primero el correo.');
  expect(screen.getAllByText('Cumplido')).toHaveLength(2);
});

it('las declaraciones se guardan con texto contractual y el plan exige detalle y ofrece plantilla', async () => {
  const declare = vi.spyOn(adapter.api.live, 'declare');
  await mount();
  const checkbox = screen.getByLabelText(LIVE_DECLARATION_TEXTS['plan-contingencia']);
  const form = checkbox.closest('form')!;
  await userEvent.click(checkbox);
  await userEvent.click(within(form).getByRole('button', { name: 'Guardar declaración' }));
  const detail = screen.getByLabelText('Plan de contingencia o ruta local');
  expect(detail).toHaveAttribute('aria-invalid', 'true');
  expect(detail).toHaveAccessibleDescription(/Documenta el plan/);
  expect(declare).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Usar plantilla de contingencia' }));
  expect((detail as HTMLTextAreaElement).value).toContain('Caída del broker');
  await userEvent.click(within(form).getByRole('button', { name: 'Guardar declaración' }));
  expect(declare).toHaveBeenCalledWith({
    requirement: 'plan-contingencia',
    confirmed: true,
    detail: expect.stringContaining('Caída de internet'),
  });
  expect(await screen.findByText('Declaración guardada con fecha.')).toBeInTheDocument();
  expect(screen.getByLabelText(LIVE_DECLARATION_TEXTS['plan-contingencia'])).toBeChecked();
});

it('retirar una declaración suspende las órdenes reales y bloquea una nueva activación', async () => {
  await complete();
  await adapter.api.live.activate({ phrase: liveConfirmationPhrase(limits) });
  const declare = vi.spyOn(adapter.api.live, 'declare');
  await mount();
  const checkbox = screen.getByLabelText(LIVE_DECLARATION_TEXTS['revision-legal']);
  await userEvent.click(checkbox);
  await userEvent.click(
    within(checkbox.closest('form')!).getByRole('button', {
      name: 'Guardar retirada de declaración',
    }),
  );
  expect(declare).toHaveBeenCalledWith({
    requirement: 'revision-legal',
    confirmed: false,
    detail: 'Documento revisado',
  });
  expect(
    await screen.findByText('Dinero real suspendido · no se enviarán órdenes nuevas.'),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
});

it.each([
  ['Capital total en real', '1001', /1.000,00 USD/],
  ['Máximo por orden', '201', /200,00 USD/],
  ['Pérdida diaria máxima', '21', /20,00 USD/],
  ['Posiciones abiertas simultáneas', '3', /2 posiciones/],
  ['Posiciones abiertas simultáneas', '1.5', /número entero/],
  ['Capital total en real', '0', /mayor que cero/],
  ['Máximo por orden', '-1', /mayor que cero/],
])('valida %s con error accesible junto al campo', async (label, value, expected) => {
  const save = vi.spyOn(adapter.api.live, 'setLimits');
  await mount();
  fillLimits();
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAccessibleDescription(expected);
  expect(screen.getByRole('button', { name: 'Guardar límites' })).toBeDisabled();
  expect(save).not.toHaveBeenCalled();
});

it('guarda límites, invalida la frase al editar y exige guardar los nuevos valores', async () => {
  await complete();
  await mount();
  fireEvent.change(screen.getByLabelText('Máximo por orden'), { target: { value: '80' } });
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
  const save = vi.spyOn(adapter.api.live, 'setLimits');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar límites' }));
  expect(save).toHaveBeenCalledWith({ ...limits, orderUsd: 80 });
  expect(screen.getByText(liveConfirmationPhrase({ ...limits, orderUsd: 80 }))).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeEnabled();
});

it('abre con foco seguro, frase exacta accesible y activa solo tras confirmar los límites', async () => {
  await complete();
  const activate = vi.spyOn(adapter.api.live, 'activate');
  await mount();
  const dialog = await openDialog();
  expect(within(dialog).getByRole('button', { name: 'Cancelar y seguir en paper' })).toHaveFocus();
  const confirm = within(dialog).getByRole('button', {
    name: 'Activar dinero real con estos límites',
  });
  expect(confirm).toBeDisabled();
  expect(activate).not.toHaveBeenCalled();
  const phrase = screen.getByLabelText('Escribe exactamente esta frase para confirmar');
  fireEvent.change(phrase, { target: { value: liveConfirmationPhrase(limits).toLowerCase() } });
  expect(phrase).toHaveAttribute('aria-invalid', 'true');
  expect(phrase).toHaveAccessibleDescription(/La frase no coincide/);
  expect(confirm).toBeDisabled();
  fireEvent.change(phrase, { target: { value: `  ${liveConfirmationPhrase(limits)}  ` } });
  expect(confirm).toBeEnabled();
  await userEvent.click(confirm);
  expect(activate).toHaveBeenCalledWith({ phrase: `  ${liveConfirmationPhrase(limits)}  ` });
  expect(
    await screen.findByText('Dinero real activado con los límites confirmados.'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('Dinero real activo')).toHaveFocus());
});

it('conserva la respuesta de guardar cuando main solo expone límites confirmados en live:state', async () => {
  await complete();
  const current = await adapter.api.live.state();
  vi.spyOn(adapter.api.live, 'state').mockResolvedValue({ ...current, limits: null });
  await mount();
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
  fillLimits();
  await userEvent.click(screen.getByRole('button', { name: 'Guardar límites' }));
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeEnabled();
  const dialog = await openDialog();
  expect(dialog).toHaveTextContent(liveConfirmationPhrase(limits));
});

it('Escape cancela, devuelve foco y Tab queda dentro del diálogo', async () => {
  await complete();
  await mount();
  const activate = vi.spyOn(adapter.api.live, 'activate');
  const dialog = await openDialog();
  await userEvent.tab({ shift: true });
  expect(within(dialog).getByRole('textbox')).toHaveFocus();
  await userEvent.tab();
  expect(screen.getByRole('button', { name: 'Cancelar y seguir en paper' })).toHaveFocus();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toHaveFocus();
  expect(activate).not.toHaveBeenCalled();
});

it('revalida antes del diálogo y bloquea si la evidencia cambió', async () => {
  await complete();
  await mount();
  const next = await adapter.api.live.checklist();
  next.items[1]!.state = 'pendiente';
  next.items[1]!.evidence = 'Solo hay 24 de 30 operaciones requeridas.';
  next.allComplete = false;
  next.completedCount--;
  vi.spyOn(adapter.api.live, 'checklist').mockResolvedValue(next);
  await userEvent.click(screen.getByRole('button', { name: 'Activar dinero real' }));
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'No se puede activar todavía' })).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
});

it('un rechazo del proceso principal muestra todos sus motivos y mueve el foco a la lista', async () => {
  await complete();
  await mount();
  const state = await adapter.api.live.state();
  vi.spyOn(adapter.api.live, 'activate').mockResolvedValue({
    activated: false,
    reasons: ['Solo hay 24 de 30 operaciones requeridas.', 'La prueba de parada ha vencido.'],
    pendingRequirements: ['paper-continuo', 'parada-probada'],
    state,
  });
  await openDialog();
  fireEvent.change(screen.getByLabelText('Escribe exactamente esta frase para confirmar'), {
    target: { value: liveConfirmationPhrase(limits) },
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Activar dinero real con estos límites' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Activación rechazada');
  const reasons = screen.getByRole('region', { name: 'No se puede activar todavía' });
  expect(reasons).toHaveTextContent('Solo hay 24 de 30 operaciones requeridas.');
  expect(reasons).toHaveTextContent('La prueba de parada ha vencido.');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'No se puede activar todavía' })).toHaveFocus(),
  );
});

it('descarta una comprobación en curso si llega un cambio de requisitos', async () => {
  await complete();
  await mount();
  const current = await adapter.api.live.checklist();
  let resolve!: (checklist: LiveChecklist) => void;
  vi.spyOn(adapter.api.live, 'checklist').mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Activar dinero real' }));
  await act(async () => {
    adapter.emitLiveChanged();
    resolve(current);
  });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Los requisitos cambiaron durante la comprobación',
  );
});

it('un error IPC de activación conserva el bloqueo y ofrece reintentar la verificación', async () => {
  await complete();
  await mount();
  vi.spyOn(adapter.api.live, 'activate').mockRejectedValue(new Error('fallo interno'));
  await openDialog();
  fireEvent.change(screen.getByLabelText('Escribe exactamente esta frase para confirmar'), {
    target: { value: liveConfirmationPhrase(limits) },
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Activar dinero real con estos límites' }),
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo activar dinero real');
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Reintentar verificación' })).toBeEnabled();
});

it('cierra el diálogo y bloquea inmediatamente al perder conexión o activar parada', async () => {
  await complete();
  await mount();
  await openDialog();
  await act(async () => {
    adapter.emitConnectivity({
      status: 'offline',
      lastCheckedAt: null,
      nextRetryAt: null,
      attempt: 1,
    });
  });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Probar parada' })).toBeDisabled();
  await act(async () => {
    adapter.emitConnectivity({
      status: 'online',
      lastCheckedAt: null,
      nextRetryAt: null,
      attempt: 0,
    });
  });
  await openDialog();
  await act(async () => {
    await adapter.api.risk.activateKillSwitch();
  });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
  expect(screen.getByRole('region', { name: 'No se puede activar todavía' })).toHaveTextContent(
    'La parada de emergencia está activa',
  );
});

it('no habilita por caché durante carga o error y conserva la evidencia anterior', async () => {
  await complete();
  await mount();
  let resolve!: (checklist: LiveChecklist) => void;
  const current = await adapter.api.live.checklist();
  vi.spyOn(adapter.api.live, 'checklist').mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar verificación' }));
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
  expect(
    screen.getByText('Comprobando requisitos en el proceso principal…', { selector: 'p' }),
  ).toBeInTheDocument();
  await act(async () => {
    resolve(current);
  });
  vi.mocked(adapter.api.live.checklist).mockRejectedValue(new Error('lectura'));
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar verificación' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo verificar la lista');
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
  expect(screen.getAllByText('Cumplido')).toHaveLength(7);
});

it('el vacío permanece bloqueado y todas las suscripciones se limpian al desmontar', async () => {
  vi.spyOn(adapter.api.live, 'checklist').mockResolvedValue({
    items: [],
    allComplete: false,
    total: 7,
    completedCount: 0,
    limits: { limits: null, confirmationPhrase: null, confirmed: false, savedAt: null },
    evaluatedAt: null,
  });
  const initial = adapter.listenerCount();
  await mount();
  expect(screen.getByText('No hay estrategias seleccionadas para dinero real')).toBeInTheDocument();
  const reasons = screen.getByRole('region', { name: 'No se puede activar todavía' });
  for (const requirement of LIVE_REQUIREMENTS)
    expect(reasons).toHaveTextContent(LIVE_REQUIREMENT_TITLES[requirement]);
  cleanup();
  expect(adapter.listenerCount()).toBe(initial);
});
