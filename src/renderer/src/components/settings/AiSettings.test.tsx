// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { NEWS_LLM_SECRET_PROVIDER } from '../../../../shared/ai';
import { AiSettings } from './AiSettings';

beforeEach(async () => {
  window.tradia = createSimulatedAdapter().api;
  const settings = await window.tradia.ai.getLlmSettings();
  vi.spyOn(window.tradia.ai, 'getLlmSettings').mockResolvedValue({
    ...settings,
    provider: 'llm',
    enabled: false,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function mount() {
  await act(async () => {
    render(<AiSettings />);
  });
}
it('muestra uso diario y gasto mensual sin recuperar claves', async () => {
  const settings = await window.tradia.ai.getLlmSettings();
  vi.spyOn(window.tradia.ai, 'getLlmSettings').mockResolvedValue({
    ...settings,
    hasKey: true,
    usedToday: 34,
    spentThisMonthEur: 3.42,
    monthlyBudgetEur: 10,
  });
  await mount();
  expect(screen.getByText('Hoy: 34 de 200 titulares')).toBeInTheDocument();
  expect(screen.getByText(/Este mes: 3,42/)).toHaveTextContent('10,00');
  expect(screen.queryByLabelText('Clave de API de Anthropic')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reemplazar clave' }));
  expect(screen.getByLabelText('Clave de API de Anthropic')).toHaveValue('');
  expect(screen.getByLabelText('Clave de API de Anthropic')).toHaveAttribute('type', 'password');
});
it('guarda la clave por secrets y borra el borrador incluso ante fallo', async () => {
  const saveKey = vi.spyOn(window.tradia.secrets, 'setKey').mockRejectedValue(new Error('llavero'));
  const save = vi.spyOn(window.tradia.ai, 'setLlmSettings');
  await mount();
  fireEvent.change(screen.getByLabelText('Clave de API de Anthropic'), {
    target: { value: 'secret-test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Guardar ajustes' }));
  await screen.findByRole('alert');
  expect(saveKey).toHaveBeenCalledWith(NEWS_LLM_SECRET_PROVIDER, 'secret-test');
  expect(screen.getByLabelText('Clave de API de Anthropic')).toHaveValue('');
  expect(save).not.toHaveBeenCalled();
});
it('guarda clave sin devolverla al formulario ni enviarla en ajustes', async () => {
  vi.spyOn(window.tradia.secrets, 'setKey').mockResolvedValue();
  const initial = await window.tradia.ai.getLlmSettings();
  const save = vi
    .spyOn(window.tradia.ai, 'setLlmSettings')
    .mockResolvedValue({ ...initial, provider: 'llm', enabled: false, hasKey: true });
  await mount();
  fireEvent.change(screen.getByLabelText('Clave de API de Anthropic'), {
    target: { value: 'secret-test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Guardar ajustes' }));
  await screen.findByText('Clave guardada de forma cifrada');
  expect(save).toHaveBeenCalledWith({
    enabled: true,
    provider: 'llm',
    cliPath: null,
    dailyCap: 200,
    monthlyBudgetEur: 0,
  });
  fireEvent.click(screen.getByRole('button', { name: 'Reemplazar clave' }));
  expect(screen.getByLabelText('Clave de API de Anthropic')).toHaveValue('');
});
it('valida topes y bloquea activar sin clave', async () => {
  const save = vi.spyOn(window.tradia.ai, 'setLlmSettings');
  await mount();
  fireEvent.change(screen.getByLabelText('Proveedor de análisis'), { target: { value: 'llm' } });
  expect(screen.getByRole('button', { name: 'Guardar ajustes' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Clave de API de Anthropic'), {
    target: { value: 'secret-test' },
  });
  for (const value of ['', '0', '2001', '1.5']) {
    fireEvent.change(screen.getByLabelText('Máximo diario de titulares'), { target: { value } });
    expect(screen.getByRole('button', { name: 'Guardar ajustes' })).toBeDisabled();
  }
  fireEvent.change(screen.getByLabelText('Máximo diario de titulares'), {
    target: { value: '200' },
  });
  fireEvent.change(screen.getByLabelText('Tope mensual (€)'), { target: { value: '31' } });
  fireEvent.submit(screen.getByLabelText('Máximo diario de titulares').closest('form')!);
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
});
it('confirma gasto con foco seguro, Escape, retorno de foco y aceptación', async () => {
  const initial = await window.tradia.ai.getLlmSettings();
  vi.spyOn(window.tradia.ai, 'getLlmSettings').mockResolvedValue({
    ...initial,
    provider: 'llm',
    enabled: false,
    hasKey: true,
  });
  const save = vi.spyOn(window.tradia.ai, 'setLlmSettings');
  await mount();
  fireEvent.change(screen.getByLabelText('Proveedor de análisis'), { target: { value: 'llm' } });
  fireEvent.change(screen.getByLabelText('Tope mensual (€)'), { target: { value: '10' } });
  fireEvent.click(screen.getByRole('button', { name: 'Guardar ajustes' }));
  expect(screen.getByRole('dialog')).toHaveAccessibleName('Confirmar gasto del LLM');
  expect(screen.getByRole('button', { name: 'Seguir con análisis local' })).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(screen.getByRole('button', { name: /Aceptar tope/ })).toHaveFocus();
  await userEvent.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Guardar ajustes' })).toHaveFocus();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Guardar ajustes' }));
  fireEvent.click(screen.getByRole('button', { name: /Aceptar tope/ }));
  await screen.findByText('Ajustes del LLM guardados.');
  expect(save).toHaveBeenCalledWith({
    enabled: true,
    provider: 'llm',
    cliPath: null,
    dailyCap: 200,
    monthlyBudgetEur: 10,
  });
});
it('cubre carga, error de lectura, reintento y prueba fallida', async () => {
  const initial = await window.tradia.ai.getLlmSettings();
  vi.spyOn(window.tradia.ai, 'getLlmSettings')
    .mockRejectedValueOnce(new Error('IPC'))
    .mockResolvedValue({ ...initial, provider: 'llm', enabled: false, hasKey: true });
  vi.spyOn(window.tradia.ai, 'testLlm').mockResolvedValue({
    ok: false,
    error: 'Clave rechazada. Reemplaza la clave.',
    latencyMs: null,
  });
  render(<AiSettings />);
  expect(screen.getByText('Cargando ajustes del LLM…')).toBeInTheDocument();
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar ajustes' }));
  await screen.findByText('Clave guardada de forma cifrada');
  fireEvent.click(screen.getByRole('button', { name: 'Probar' }));
  await screen.findByText('Clave rechazada. Reemplaza la clave.');
});
it('actualiza uso al recibir noticias, bloquea prueba offline y libera suscripciones', async () => {
  const simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  const initial = await simulation.api.ai.getLlmSettings();
  const read = vi
    .spyOn(simulation.api.ai, 'getLlmSettings')
    .mockResolvedValue({ ...initial, provider: 'llm', enabled: false, hasKey: true });
  const { unmount } = render(<AiSettings />);
  await screen.findByText('Hoy: 0 de 200 titulares');
  read.mockResolvedValue({
    ...initial,
    provider: 'llm',
    enabled: false,
    hasKey: true,
    usedToday: 200,
  });
  act(() => simulation.emitAiChanged('noticias'));
  await screen.findByText('Hoy: 200 de 200 titulares');
  expect(screen.getByText(/Tope diario alcanzado/)).toBeInTheDocument();
  const connectivity = await simulation.api.connectivity.getState();
  act(() => simulation.emitConnectivity({ ...connectivity, status: 'offline' }));
  await screen.findByText(/la prueba del LLM está pausada/);
  expect(screen.getByRole('button', { name: 'Probar' })).toBeDisabled();
  unmount();
  expect(simulation.listenerCount()).toBe(0);
});

it('propone Local sin CLI y explica el inicio de sesión sin pedir API', async () => {
  const initial = await window.tradia.ai.getLlmSettings();
  vi.mocked(window.tradia.ai.getLlmSettings).mockResolvedValue({
    ...initial,
    provider: 'local',
    cliAvailable: false,
  });
  await mount();
  expect(screen.getByLabelText('Proveedor de análisis')).toHaveValue('local');
  expect(screen.getByText(/CLI no detectada/)).toHaveTextContent('Recomendamos Local');
  expect(screen.getByText(/Para iniciar sesión/)).toHaveTextContent('claude y después /login');
  expect(screen.queryByLabelText('Clave de API de Anthropic')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Probar' })).toBeEnabled();
});

it('elige suscripción con ruta opcional y prueba el proveedor guardado sin clave', async () => {
  const save = vi.spyOn(window.tradia.ai, 'setLlmSettings');
  const test = vi.spyOn(window.tradia.ai, 'testLlm');
  await mount();
  await userEvent.selectOptions(screen.getByLabelText('Proveedor de análisis'), 'suscripcion');
  expect(screen.getByRole('option', { name: 'API de Anthropic (opcional)' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Ruta de la CLI (opcional)'), {
    target: { value: '/opt/bin/claude' },
  });
  fireEvent.change(screen.getByLabelText('Máximo diario de titulares'), {
    target: { value: '25' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Probar' }));
  await screen.findByText('Conexión correcta · proveedor disponible.');
  expect(save).toHaveBeenCalledWith({
    enabled: true,
    provider: 'suscripcion',
    cliPath: '/opt/bin/claude',
    dailyCap: 25,
    monthlyBudgetEur: 0,
  });
  expect(test).toHaveBeenCalledOnce();
  expect(save.mock.invocationCallOrder[0]).toBeLessThan(test.mock.invocationCallOrder[0]!);
  expect(screen.queryByLabelText('Clave de API de Anthropic')).not.toBeInTheDocument();
});

it('muestra el motivo de CLI no encontrada y de sesión no iniciada', async () => {
  const test = vi.spyOn(window.tradia.ai, 'testLlm');
  await mount();
  await userEvent.selectOptions(screen.getByLabelText('Proveedor de análisis'), 'suscripcion');
  for (const error of [
    'CLI no encontrada. Configura la ruta.',
    'Sesión no iniciada. Ejecuta claude y /login.',
  ]) {
    test.mockResolvedValueOnce({ ok: false, error, latencyMs: null });
    await userEvent.click(screen.getByRole('button', { name: 'Probar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(error);
  }
});

it('prueba Local sin conexión y sin clave de pago', async () => {
  const simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  const initial = await simulation.api.ai.getLlmSettings();
  vi.spyOn(simulation.api.ai, 'getLlmSettings').mockResolvedValue({
    ...initial,
    provider: 'local',
    cliAvailable: false,
  });
  const connectivity = await simulation.api.connectivity.getState();
  simulation.emitConnectivity({ ...connectivity, status: 'offline' });
  await mount();
  expect(screen.queryByText(/la prueba del LLM está pausada/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Probar' }));
  await screen.findByText('Análisis local disponible · sin coste.');
});

it('Probar también pide confirmar un aumento de gasto de la API', async () => {
  const initial = await window.tradia.ai.getLlmSettings();
  vi.mocked(window.tradia.ai.getLlmSettings).mockResolvedValue({ ...initial, hasKey: true });
  const test = vi.spyOn(window.tradia.ai, 'testLlm');
  await mount();
  fireEvent.change(screen.getByLabelText('Tope mensual (€)'), { target: { value: '10' } });
  await userEvent.click(screen.getByRole('button', { name: 'Probar' }));
  expect(screen.getByRole('dialog')).toHaveAccessibleName('Confirmar gasto del LLM');
  expect(test).not.toHaveBeenCalled();
  await userEvent.keyboard('{Escape}');
  expect(test).not.toHaveBeenCalled();
});
