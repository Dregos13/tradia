// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { AiSettings, ENGINE_SPECS } from './AiSettings';

beforeEach(async () => {
  window.tradia = createSimulatedAdapter().api;
  const settings = await window.tradia.ai.getLlmSettings();
  vi.spyOn(window.tradia.ai, 'getLlmSettings').mockResolvedValue({
    ...settings,
    provider: 'suscripcion',
    engine: 'suscripcion-claude',
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

it('muestra el selector desplegable con los 5 motores, uso diario y sin API de pago', async () => {
  const settings = await window.tradia.ai.getLlmSettings();
  vi.spyOn(window.tradia.ai, 'getLlmSettings').mockResolvedValue({
    ...settings,
    usedToday: 34,
  });
  await mount();
  expect(screen.getByText('Hoy: 34 de 200 titulares')).toBeInTheDocument();

  const select = screen.getByRole('combobox', {
    name: 'Motor de análisis de noticias',
  }) as HTMLSelectElement;
  expect(select).toBeInTheDocument();
  expect(select.value).toBe('suscripcion-claude');

  expect(
    screen.getByRole('option', { name: /Claude Code \(Suscripción en este equipo\)/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('option', { name: /OpenAI Codex \(Suscripción de OpenAI\)/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('option', { name: /Google Antigravity \(Suscripción de Google\)/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('option', { name: /GitHub Copilot \(Suscripción de GitHub\)/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('option', { name: /Analizador local \(Sin suscripción/ }),
  ).toBeInTheDocument();

  // Solo los dos orígenes sin API de pago: la suscripción de la CLI y el analizador local.
  expect(screen.getAllByRole('radio').map((radio) => radio.getAttribute('name'))).toEqual([
    'news-origin',
    'news-origin',
  ]);
  expect(screen.getByRole('radio', { name: 'Suscripción (Claude Code)' })).toBeChecked();
  expect(screen.getByRole('radio', { name: 'Analizador local' })).not.toBeChecked();
  expect(screen.queryByLabelText(/Clave de API/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Tope mensual/)).not.toBeInTheDocument();
});

it('IDV-E2E-5: los dos radios cambian el origen y recuerdan la CLI elegida', async () => {
  const save = vi.spyOn(window.tradia.ai, 'setLlmSettings');
  await mount();
  const select = screen.getByRole('combobox', { name: 'Motor de análisis de noticias' });
  fireEvent.change(select, { target: { value: 'suscripcion-codex' } });
  expect(screen.getByRole('radio', { name: 'Suscripción (OpenAI Codex)' })).toBeChecked();
  fireEvent.change(screen.getByLabelText('Ruta de OpenAI Codex (opcional)'), {
    target: { value: '/opt/tradia/codex' },
  });
  await userEvent.click(screen.getByRole('radio', { name: 'Analizador local' }));
  expect(select).toHaveValue('local');
  expect(screen.getByRole('radio', { name: 'Analizador local' })).toBeChecked();
  expect(screen.queryByLabelText(/Ruta de/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('radio', { name: 'Suscripción (OpenAI Codex)' }));
  expect(select).toHaveValue('suscripcion-codex');
  expect(screen.getByLabelText('Ruta de OpenAI Codex (opcional)')).toHaveValue('/opt/tradia/codex');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar ajustes' }));
  await screen.findByText('Ajustes de análisis guardados.');
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ engine: 'suscripcion-codex', cliPath: '/opt/tradia/codex' }),
  );
});

it('el radio de suscripción usa el primer CLI instalado al partir del analizador local', async () => {
  const settings = await window.tradia.ai.getLlmSettings();
  vi.spyOn(window.tradia.ai, 'getLlmSettings').mockResolvedValue({
    ...settings,
    provider: 'local',
    engine: 'local',
    enabled: false,
    engines: (['suscripcion-claude', 'suscripcion-codex', 'suscripcion-copilot'] as const).map(
      (id) => ({
        id,
        label: id,
        cliName: id,
        available: id !== 'suscripcion-claude',
        resolvedPath: null,
        source: null,
        configuredPath: null,
        configuredInvalid: false,
      }),
    ),
  });
  const save = vi.spyOn(window.tradia.ai, 'setLlmSettings');
  await mount();
  expect(screen.getByRole('radio', { name: 'Analizador local' })).toBeChecked();
  await userEvent.click(screen.getByRole('radio', { name: 'Suscripción (OpenAI Codex)' }));
  expect(screen.getByLabelText('Motor de análisis de noticias')).toHaveValue('suscripcion-codex');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar ajustes' }));
  await screen.findByText('Ajustes de análisis guardados.');
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      engine: 'suscripcion-codex',
      provider: 'suscripcion',
      enabled: true,
    }),
  );
});

it('permite cambiar entre cada uno de los motores del desplegable y actualiza descripciones y rutas', async () => {
  await mount();
  const select = screen.getByRole('combobox', { name: 'Motor de análisis de noticias' });

  // 1. OpenAI Codex
  fireEvent.change(select, { target: { value: 'suscripcion-codex' } });
  expect(screen.getByText(ENGINE_SPECS['suscripcion-codex'].description)).toBeInTheDocument();
  expect(screen.getByLabelText('Ruta de OpenAI Codex (opcional)')).toBeInTheDocument();

  // 2. Google Antigravity
  fireEvent.change(select, { target: { value: 'suscripcion-antigravity' } });
  expect(screen.getByText(ENGINE_SPECS['suscripcion-antigravity'].description)).toBeInTheDocument();
  expect(screen.getByLabelText('Ruta de Google Antigravity (opcional)')).toBeInTheDocument();

  // 3. GitHub Copilot
  fireEvent.change(select, { target: { value: 'suscripcion-copilot' } });
  expect(screen.getByText(ENGINE_SPECS['suscripcion-copilot'].description)).toBeInTheDocument();
  expect(screen.getByLabelText('Ruta de GitHub Copilot (opcional)')).toBeInTheDocument();

  // 4. Analizador local
  fireEvent.change(select, { target: { value: 'local' } });
  expect(screen.getByText(ENGINE_SPECS['local'].description)).toBeInTheDocument();
  expect(screen.queryByLabelText(/Ruta de/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Máximo diario')).not.toBeInTheDocument();
  expect(
    screen.getByText(/Analizador local preparado · Sin suscripción externa/),
  ).toBeInTheDocument();

  // 5. Claude Code
  fireEvent.change(select, { target: { value: 'suscripcion-claude' } });
  expect(screen.getByText(ENGINE_SPECS['suscripcion-claude'].description)).toBeInTheDocument();
  expect(screen.getByLabelText('Ruta de Claude Code (opcional)')).toBeInTheDocument();
  expect(screen.getByLabelText('Máximo diario')).toBeInTheDocument();
});

it('muestra el indicador de autodetección de CLI cuando está disponible o no encontrada', async () => {
  const settings = await window.tradia.ai.getLlmSettings();
  vi.spyOn(window.tradia.ai, 'getLlmSettings').mockResolvedValue({
    ...settings,
    cliAvailable: false,
    engines: [
      {
        id: 'suscripcion-claude',
        label: 'Claude Code',
        cliName: 'claude',
        available: false,
        resolvedPath: null,
        source: null,
        configuredPath: null,
        configuredInvalid: false,
      },
    ],
  });
  await mount();
  expect(
    screen.getByText(/No se encontró el comando claude en las rutas estándar/),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Probar de nuevo' })).toBeEnabled();
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
    engine: 'suscripcion-claude',
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
  const select = screen.getByRole('combobox', { name: 'Motor de análisis de noticias' });
  fireEvent.change(select, { target: { value: 'local' } });
  expect(screen.queryByLabelText('Ruta de Claude Code (opcional)')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Máximo diario')).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/Clave de API/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Guardar ajustes' }));
  await screen.findByText('Ajustes de análisis guardados.');
  expect(save).toHaveBeenCalledWith({
    enabled: false,
    provider: 'local',
    engine: 'local',
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
  await screen.findByRole('combobox', { name: 'Motor de análisis de noticias' });
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

it('prueba el motor seleccionado tras guardar los ajustes', async () => {
  const save = vi.spyOn(window.tradia.ai, 'setLlmSettings');
  const test = vi.spyOn(window.tradia.ai, 'testLlm');
  await mount();
  const select = screen.getByRole('combobox', { name: 'Motor de análisis de noticias' });
  fireEvent.change(select, { target: { value: 'suscripcion-codex' } });
  fireEvent.change(screen.getByLabelText('Máximo diario'), {
    target: { value: '25' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Probar de nuevo' }));
  await screen.findByText(/Suscripción disponible · OpenAI Codex/);
  expect(save).toHaveBeenCalledWith({
    enabled: true,
    provider: 'suscripcion',
    engine: 'suscripcion-codex',
    cliPath: null,
    dailyCap: 25,
  });
  expect(test).toHaveBeenCalledOnce();
  expect(save.mock.invocationCallOrder[0]).toBeLessThan(test.mock.invocationCallOrder[0]!);
});

it('muestra el motivo de CLI no encontrada y de sesión no iniciada', async () => {
  const test = vi.spyOn(window.tradia.ai, 'testLlm');
  await mount();
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
    engine: 'local',
    cliAvailable: false,
  });
  const connectivity = await simulation.api.connectivity.getState();
  simulation.emitConnectivity({ ...connectivity, status: 'offline' });
  await mount();
  expect(screen.queryByText(/la prueba está pausada/)).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Probar de nuevo' }));
  await screen.findByText('Análisis local disponible · sin coste.');
});
