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
  type LiveLimitsInput,
} from '../../../../shared/live';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { ChecklistPage } from './ChecklistPage';
import { evaluateKillSwitchTest } from '../../../../main/live/checklist';

let adapter: ReturnType<typeof createSimulatedAdapter>;
const limits: LiveLimitsInput = {
  capitalUsd: 500,
  orderUsd: 100,
  dailyLossUsd: 10,
  openPositions: 1,
  shortOrderUsd: 0,
  shortExposureUsd: 0,
  shortPositions: 0,
};
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
function fillLimits(values: LiveLimitsInput = limits) {
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
  expect(screen.getAllByText('Verificación automática')).toHaveLength(5);
  expect(screen.getAllByRole('checkbox')).toHaveLength(4);
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
  expect(screen.getAllByText('Cumplido')).toHaveLength(5);
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
  expect(screen.getAllByText('Cumplido')).toHaveLength(3);
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
  ['Máximo por orden en corto', '101', /100,00 USD/],
  ['Exposición corta total máxima', '201', /200,00 USD/],
  ['Posiciones cortas simultáneas', '2', /1 posiciones/],
  ['Posiciones cortas simultáneas', '0.5', /número entero/],
  ['Máximo por orden en corto', '-1', /igual o mayor que cero/],
  ['Capital total en real', '1001', /1.000,00 USD/],
  ['Máximo por orden', '201', /200,00 USD/],
  ['Pérdida diaria máxima', '21', /20,00 USD/],
  ['Posiciones abiertas simultáneas', '3', /2 posiciones/],
  ['Posiciones abiertas simultáneas', '1.5', /número entero/],
  ['Capital total en real', '0', /mayor que cero/],
  ['Máximo por orden', '-1', /mayor que cero/],
])('valida %s con error accesible junto al campo', async (label, value, expected) => {
  const save = vi.spyOn(adapter.api.live, 'setLimits');
  await adapter.api.live.declare({ requirement: 'revision-legal-corto', confirmed: true });
  await adapter.api.live.connect({ apiKeyId: 'AKTESTKEY', apiSecret: 'test-secret' });
  await mount();
  fillLimits();
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAccessibleDescription(expected);
  expect(
    document.getElementById(input.getAttribute('aria-describedby')!.split(' ').at(-1)!),
  ).toHaveAttribute('role', 'alert');
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
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'Cancelar y seguir en paper' }),
    ).toHaveFocus(),
  );
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
  expect(screen.queryByText(/faltan 0 de 7/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Los requisitos cambiaron/)).not.toBeInTheDocument();
  expect(
    screen.getByRole('heading', { name: 'Dinero real está activo con los límites confirmados' }),
  ).toBeVisible();
});

it('recupera límites sin confirmar desde la lista al volver a la pantalla', async () => {
  await complete();
  const current = await adapter.api.live.state();
  vi.spyOn(adapter.api.live, 'state').mockResolvedValue({ ...current, limits: null });
  await mount();
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeEnabled();
  expect(screen.getByLabelText('Capital total en real')).toHaveValue(limits.capitalUsd);
  cleanup();
  await mount();
  expect(screen.getByLabelText('Máximo por orden')).toHaveValue(limits.orderUsd);
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeEnabled();
  const dialog = await openDialog();
  expect(dialog).toHaveTextContent(liveConfirmationPhrase(limits));
});

it('conserva la activación cuando live:changed llega durante su relectura', async () => {
  await complete();
  await mount();
  await openDialog();
  fireEvent.change(screen.getByLabelText('Escribe exactamente esta frase para confirmar'), {
    target: { value: liveConfirmationPhrase(limits) },
  });
  const readChecklist = adapter.api.live.checklist;
  let resolve!: (value: LiveChecklist) => void;
  vi.spyOn(adapter.api.live, 'checklist').mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await userEvent.click(
    screen.getByRole('button', { name: 'Activar dinero real con estos límites' }),
  );
  await act(async () => {
    adapter.emitLiveChanged();
    resolve(await readChecklist());
  });
  expect(
    await screen.findByText('Dinero real activado con los límites confirmados.'),
  ).toBeVisible();
  expect(screen.getByText('Dinero real activo')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
  expect(screen.queryByText(/faltan 0 de 7|Los requisitos cambiaron/)).not.toBeInTheDocument();
});

it('Escape cancela, devuelve foco y Tab queda dentro del diálogo', async () => {
  await complete();
  await mount();
  const activate = vi.spyOn(adapter.api.live, 'activate');
  const dialog = await openDialog();
  await userEvent.tab({ shift: true });
  await waitFor(() => expect(within(dialog).getByRole('textbox')).toHaveFocus());
  await userEvent.tab();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Cancelar y seguir en paper' })).toHaveFocus(),
  );
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Activar dinero real' })).toHaveFocus(),
  );
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
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'No se puede activar todavía' })).toHaveFocus(),
  );
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

it('relee un cambio durante la comprobación y bloquea por la nueva evidencia sin error espurio', async () => {
  await complete();
  await mount();
  const current = await adapter.api.live.checklist();
  let resolve!: (checklist: LiveChecklist) => void;
  const updated: LiveChecklist = {
    ...current,
    allComplete: false,
    completedCount: 6,
    items: current.items.map((item) =>
      item.requirement === 'paper-continuo'
        ? { ...item, state: 'pendiente', evidence: 'Solo hay 24 operaciones.' }
        : item,
    ),
  };
  const checklist = vi.spyOn(adapter.api.live, 'checklist').mockResolvedValue(updated);
  checklist.mockImplementationOnce(
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
  expect(checklist).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('region', { name: 'No se puede activar todavía' })).toHaveTextContent(
    'Solo hay 24 operaciones.',
  );
  expect(screen.queryByText(/Los requisitos cambiaron/)).not.toBeInTheDocument();
});

it('aplica saved.limits aunque live:changed llegue durante la relectura del guardado', async () => {
  await complete();
  const state = await adapter.api.live.state();
  vi.spyOn(adapter.api.live, 'state').mockResolvedValue({ ...state, limits: null });
  await mount();
  fillLimits({ ...limits, orderUsd: 80 });
  const readChecklist = adapter.api.live.checklist;
  let resolve!: (value: LiveChecklist) => void;
  const checklist = vi.spyOn(adapter.api.live, 'checklist').mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Guardar límites' }));
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
  await act(async () => {
    adapter.emitLiveChanged();
    resolve(await readChecklist());
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeEnabled(),
  );
  expect(checklist).toHaveBeenCalledTimes(2);
  expect(screen.getByText(liveConfirmationPhrase({ ...limits, orderUsd: 80 }))).toBeVisible();
  expect(screen.queryByText(/Los requisitos cambiaron/)).not.toBeInTheDocument();
});

it('con siete requisitos y claves pendientes muestra lista completa, nunca faltan 0 de 7', async () => {
  await complete();
  const state = await adapter.api.live.state();
  vi.spyOn(adapter.api.live, 'state').mockResolvedValue({
    ...state,
    mode: 'bloqueado',
    hasCredentials: false,
    accountMasked: null,
  });
  await mount();
  expect(
    screen.getByText('Lista completa · revisa los motivos antes de activar dinero real'),
  ).toBeVisible();
  expect(screen.queryByText(/faltan 0 de 7/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
});

it('conserva saved.limits si falla la lectura posterior al guardado', async () => {
  await complete();
  await mount();
  fillLimits({ ...limits, orderUsd: 80 });
  vi.spyOn(adapter.api.live, 'checklist').mockRejectedValue(new Error('lectura fallida'));
  await userEvent.click(screen.getByRole('button', { name: 'Guardar límites' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo verificar la lista');
  expect(screen.getByText(liveConfirmationPhrase({ ...limits, orderUsd: 80 }))).toBeVisible();
  expect(screen.getByLabelText('Máximo por orden')).toHaveValue(80);
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
});

it('las declaraciones cumplidas muestran texto, fecha y detalle aunque evidence sea null', async () => {
  await complete();
  const checklist = await adapter.api.live.checklist();
  vi.spyOn(adapter.api.live, 'checklist').mockResolvedValue({
    ...checklist,
    items: checklist.items.map((item) =>
      item.kind === 'declaracion' ? { ...item, evidence: null } : item,
    ),
  });
  await mount();
  for (const requirement of LIVE_DECLARATION_REQUIREMENTS) {
    const row = screen
      .getByRole('heading', { name: LIVE_REQUIREMENT_TITLES[requirement] })
      .closest('li')!;
    expect(within(row).queryByText('Sin evidencia guardada.')).not.toBeInTheDocument();
    expect(
      within(row).getByText(LIVE_DECLARATION_TEXTS[requirement], { selector: 'p' }),
    ).toBeVisible();
    expect(row).toHaveTextContent('Declarada');
    expect(within(row).getByText('Documento revisado', { selector: 'p' })).toBeVisible();
  }
});

it.each([0, 1])(
  'la parada usa la fecha civil local para hoy y el día anterior (%s)',
  async (previousDay) => {
    const now = new Date(2026, 9, 11, 0, 46);
    const tested = new Date(2026, 9, 11 - previousDay, previousDay ? 23 : 0, 30);
    const checklist = await adapter.api.live.checklist();
    const verdict = evaluateKillSwitchTest(tested.toISOString(), now.getTime());
    vi.spyOn(adapter.api.live, 'checklist').mockResolvedValue({
      ...checklist,
      items: checklist.items.map((item) =>
        item.requirement === 'parada-probada'
          ? {
              ...item,
              state: verdict.state,
              evidence: verdict.evidence,
              markedAt: tested.toISOString(),
            }
          : item,
      ),
    });
    await mount();
    const row = screen
      .getByRole('heading', { name: LIVE_REQUIREMENT_TITLES['parada-probada'] })
      .closest('li')!;
    expect(row).toHaveTextContent(previousDay ? 'Última prueba hace 1 día' : 'Última prueba hoy');
    expect(row).toHaveTextContent(tested.toLocaleDateString('es-ES', { dateStyle: 'medium' }));
    if (previousDay) expect(row).not.toHaveTextContent('hoy');
  },
);

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
  expect(screen.getAllByText('Cumplido')).toHaveLength(8);
});

it('el vacío permanece bloqueado y todas las suscripciones se limpian al desmontar', async () => {
  vi.spyOn(adapter.api.live, 'checklist').mockResolvedValue({
    items: [],
    allComplete: false,
    total: 7,
    completedCount: 0,
    short: {
      items: [],
      account: {
        state: 'revisar',
        paper: null,
        shortingEnabled: null,
        equityUsd: null,
        minEquityUsd: 2000,
        checkedAt: null,
        evidence: 'No se pudo comprobar la cuenta de Alpaca. El corto real permanece bloqueado.',
      },
      completedCount: 0,
      total: 0,
      allComplete: false,
      blockReason: null,
    },
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

it('N6: Dinero real permite desactivar desde su pantalla y vuelve a listo', async () => {
  await complete();
  await adapter.api.live.activate({ phrase: liveConfirmationPhrase(limits) });
  const deactivate = vi.spyOn(adapter.api.live, 'deactivate');
  await mount();
  expect(screen.getByText('Dinero real activo', { exact: true })).toBeVisible();
  const trigger = screen.getByRole('button', { name: 'Volver a paper (desactivar dinero real)' });
  await userEvent.click(trigger);
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(deactivate).not.toHaveBeenCalled();
  await userEvent.click(trigger);
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar vuelta a paper' }));
  await waitFor(() =>
    expect(
      screen.getByText('Listo para confirmar · revisa los límites una última vez'),
    ).toBeVisible(),
  );
  expect(deactivate).toHaveBeenCalledOnce();
  expect(screen.queryByRole('button', { name: /Volver a paper/ })).not.toBeInTheDocument();
});

it('guarda los tres límites del corto y confirma la frase que los incluye', async () => {
  await complete();
  // Los límites del corto > 0 exigen antes su declaración legal propia.
  await adapter.api.live.declare({ requirement: 'revision-legal-corto', confirmed: true });
  await mount();
  for (const [label, value] of [
    ['Máximo por orden en corto', '100'],
    ['Exposición corta total máxima', '200'],
    ['Posiciones cortas simultáneas', '1'],
  ]) {
    expect(screen.getByLabelText(label!)).toHaveValue(0);
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  }
  await userEvent.click(screen.getByRole('button', { name: 'Guardar límites' }));
  const shortLimits = { ...limits, shortOrderUsd: 100, shortExposureUsd: 200, shortPositions: 1 };
  await openDialog();
  expect(screen.getByRole('alertdialog')).toHaveTextContent('Posiciones cortas simultáneas');
  fireEvent.change(screen.getByLabelText('Escribe exactamente esta frase para confirmar'), {
    target: { value: liveConfirmationPhrase(shortLimits) },
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Activar dinero real con estos límites' }),
  );
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect((await adapter.api.live.state()).limits).toEqual(shortLimits);
});
