// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { AiSettings } from './AiSettings';

beforeEach(async () => {
  window.tradia = createSimulatedAdapter().api;
  const settings = await window.tradia.ai.getLlmSettings();
  vi.spyOn(window.tradia.ai, 'getLlmSettings').mockResolvedValue({
    ...settings,
    provider: 'suscripcion',
    enabled: true,
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

it('muestra el uso diario y no ofrece la API de pago', async () => {
  const settings = await window.tradia.ai.getLlmSettings();
  vi.spyOn(window.tradia.ai, 'getLlmSettings').mockResolvedValue({
    ...settings,
    usedToday: 34,
  });
  await mount();
  expect(screen.getByText('Hoy: 34 de 200 titulares')).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Suscripción/ })).toBeChecked();
  expect(screen.getByRole('radio', { name: /Suscripción \(Claude Code\)/ })).toBeInTheDocument();
  expect(screen.getByRole('radio', { name: /Analizador local/ })).toBeInTheDocument();
  expect(screen.queryByRole('radio', { name: /API/ })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Clave de API/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Tope mensual/)).not.toBeInTheDocument();
});

it('valida el máximo diario y avisa al enviar un valor fuera de margen', async () => {
  const save = vi.spyOn(window.tradia.ai, 'setLlmSettings');
  await mount();
  for (const value of ['', '0', '2001', '1.5']) {
    fireEvent.change(screen.getByLabelText('Máximo diario'), { target: { value } });
    expect(screen.getByRole('button', { name: 'Guardar ajustes' })).toBeDisabled();
  }
  fireEvent.change(screen.getByLabelText('Máximo diario'), {
    target: { value: '200' },
  });
  fireEvent.change(screen.getByLabelText('Máximo diario'), {
    target: { value: '0' },
  });
  fireEvent.submit(screen.getByLabelText('Ruta de Claude Code (opcional)').closest('form')!);
  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(save).not.toHaveBeenCalled();
});

it('guarda los ajustes de suscripción con ruta y devuelve el foco al guardar', async () => {
  const save = vi.spyOn(window.tradia.ai, 'setLlmSettings');
  await mount();
  fireEvent.change(screen.getByLabelText('Ruta de Claude Code (opcional)'), {
    target: { value: '/opt/bin/claude' },
  });
  fireEvent.change(screen.getByLabelText('Máximo diario'), {
    target: { value: '25' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Guardar ajustes' }));
  await screen.findByText('Ajustes de análisis guardados.');
  expect(save).toHaveBeenCalledWith({
    enabled: true,
    provider: 'suscripcion',
    cliPath: '/opt/bin/claude',
    dailyCap: 25,
  });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Guardar ajustes' })).toHaveFocus(),
  );
});

it('el analizador local guarda el LLM desactivado y no pide CLI ni clave', async () => {
  const save = vi.spyOn(window.tradia.ai, 'setLlmSettings');
  await mount();
  await userEvent.click(screen.getByRole('radio', { name: /Analizador local/ }));
  expect(screen.queryByLabelText('Ruta de Claude Code (opcional)')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Máximo diario')).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Clave de API/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Guardar ajustes' }));
  await screen.findByText('Ajustes de análisis guardados.');
  expect(save).toHaveBeenCalledWith({
    enabled: false,
    provider: 'local',
    cliPath: null,
    dailyCap: 200,
  });
});

it('cubre carga, error de lectura, reintento y prueba fallida', async () => {
  const initial = await window.tradia.ai.getLlmSettings();
  vi.spyOn(window.tradia.ai, 'getLlmSettings')
    .mockRejectedValueOnce(new Error('IPC'))
    .mockResolvedValue({ ...initial, provider: 'suscripcion', cliAvailable: true });
  vi.spyOn(window.tradia.ai, 'testLlm').mockResolvedValue({
    ok: false,
    error: 'Sesión no iniciada. Ejecuta claude y /login.',
    latencyMs: null,
  });
  render(<AiSettings />);
  expect(screen.getByText('Cargando ajustes de análisis…')).toBeInTheDocument();
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar ajustes' }));
  await screen.findByRole('radio', { name: /Suscripción/ });
  fireEvent.click(screen.getByRole('button', { name: 'Probar de nuevo' }));
  await screen.findByText('Sesión no iniciada. Ejecuta claude y /login.');
});

it('actualiza uso al recibir noticias, bloquea prueba offline y libera suscripciones', async () => {
  const simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  const initial = await simulation.api.ai.getLlmSettings();
  const read = vi
    .spyOn(simulation.api.ai, 'getLlmSettings')
    .mockResolvedValue({ ...initial, provider: 'suscripcion' });
  const { unmount } = render(<AiSettings />);
  await screen.findByText('Hoy: 0 de 200 titulares');
  read.mockResolvedValue({
    ...initial,
    provider: 'suscripcion',
    usedToday: 200,
  });
  act(() => simulation.emitAiChanged('noticias'));
  await screen.findByText('Hoy: 200 de 200 titulares');
  expect(screen.getByText(/Tope diario alcanzado/)).toBeInTheDocument();
  const connectivity = await simulation.api.connectivity.getState();
  act(() => simulation.emitConnectivity({ ...connectivity, status: 'offline' }));
  await screen.findByText(/la prueba está pausada/);
  expect(screen.getByRole('button', { name: 'Probar de nuevo' })).toBeDisabled();
  unmount();
  expect(simulation.listenerCount()).toBe(0);
});

it('propone el analizador local sin CLI y explica el inicio de sesión', async () => {
  const initial = await window.tradia.ai.getLlmSettings();
  vi.mocked(window.tradia.ai.getLlmSettings).mockResolvedValue({
    ...initial,
    provider: 'suscripcion',
    cliAvailable: false,
  });
  await mount();
  expect(screen.getByRole('radio', { name: /Suscripción/ })).toBeChecked();
  expect(screen.getByText(/Usa la sesión iniciada/)).toHaveTextContent('analizador local');
  expect(screen.getByRole('button', { name: 'Probar de nuevo' })).toBeEnabled();
});

it('prueba el proveedor guardado tras guardar los ajustes', async () => {
  const save = vi.spyOn(window.tradia.ai, 'setLlmSettings');
  const test = vi.spyOn(window.tradia.ai, 'testLlm');
  await mount();
  await userEvent.click(screen.getByRole('radio', { name: /Suscripción/ }));
  fireEvent.change(screen.getByLabelText('Máximo diario'), {
    target: { value: '25' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Probar de nuevo' }));
  await screen.findByText(/Suscripción disponible · Claude/);
  expect(save).toHaveBeenCalledWith({
    enabled: true,
    provider: 'suscripcion',
    cliPath: null,
    dailyCap: 25,
  });
  expect(test).toHaveBeenCalledOnce();
  expect(save.mock.invocationCallOrder[0]).toBeLessThan(test.mock.invocationCallOrder[0]!);
});

it('muestra el motivo de CLI no encontrada y de sesión no iniciada', async () => {
  const test = vi.spyOn(window.tradia.ai, 'testLlm');
  await mount();
  await userEvent.click(screen.getByRole('radio', { name: /Suscripción/ }));
  for (const error of [
    'CLI no encontrada. Configura la ruta.',
    'Sesión no iniciada. Ejecuta claude y /login.',
  ]) {
    test.mockResolvedValueOnce({ ok: false, error, latencyMs: null });
    await userEvent.click(screen.getByRole('button', { name: 'Probar de nuevo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(error);
  }
});

it('prueba el analizador local sin conexión y sin clave de pago', async () => {
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
  expect(screen.queryByText(/la prueba está pausada/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Probar de nuevo' }));
  await screen.findByText('Análisis local disponible · sin coste.');
});
