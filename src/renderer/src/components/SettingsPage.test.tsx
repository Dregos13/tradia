// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { createSimulatedAdapter } from '../adapters/simulated';

let simulation: ReturnType<typeof createSimulatedAdapter>;
const state = { connectivity: null, agents: null, connectionError: false, agentsError: false };
beforeEach(() => {
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function mount() {
  await act(async () => {
    render(<SettingsPage state={state} />);
  });
}
it('consulta el inicio real y utiliza la respuesta del sistema, sin cambio optimista', async () => {
  await simulation.api.settings.set({ autostart: true });
  const set = vi.spyOn(simulation.api.settings, 'set').mockImplementation(async () => ({
    ...(await simulation.api.settings.get()),
    autostart: true,
  }));
  await mount();
  const toggle = screen.getByRole('switch', { name: 'Iniciar con el sistema' });
  expect(toggle).toBeChecked();
  await userEvent.click(toggle);
  expect(set).toHaveBeenCalledWith({ autostart: false });
  expect(toggle).toBeChecked();
});
it('reconsulta el inicio al volver de la bandeja y muestra errores de escritura', async () => {
  await mount();
  await simulation.api.settings.set({ autostart: true });
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  expect(screen.getByRole('switch', { name: 'Iniciar con el sistema' })).toBeChecked();
  vi.spyOn(simulation.api.settings, 'set').mockRejectedValue(new Error('SO'));
  await userEvent.click(screen.getByRole('switch', { name: 'Iniciar con el sistema' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo cambiar');
});
it('guarda preferencias, respeta niveles desactivados y prueba el nivel elegido', async () => {
  const test = vi.spyOn(simulation.api.notifications, 'test').mockResolvedValue();
  await mount();
  await userEvent.click(screen.getByRole('switch', { name: 'Notificaciones: Información' }));
  expect(await simulation.api.notifications.getPrefs()).toEqual({
    info: false,
    alerta: true,
    critica: true,
  });
  expect(screen.getByRole('button', { name: 'Enviar prueba' })).toBeDisabled();
  await userEvent.selectOptions(screen.getByRole('combobox'), 'critica');
  await userEvent.click(screen.getByRole('button', { name: 'Enviar prueba' }));
  expect(test).toHaveBeenCalledWith('critica');
  expect(await screen.findByText(/Prueba enviada/)).toBeInTheDocument();
});
it('mantiene preferencias anteriores si falla guardar y explica fallos de prueba', async () => {
  vi.spyOn(simulation.api.notifications, 'setPrefs').mockRejectedValue(new Error('IPC'));
  await mount();
  await userEvent.click(screen.getByRole('switch', { name: 'Notificaciones: Alerta' }));
  expect(screen.getByRole('switch', { name: 'Notificaciones: Alerta' })).toBeChecked();
  await userEvent.click(screen.getByRole('button', { name: 'Enviar prueba' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo enviar la prueba');
});
it('valida, guarda, limpia la contraseña y borra sin recuperar la clave', async () => {
  const save = vi.spyOn(simulation.api.secrets, 'setKey').mockResolvedValue();
  const remove = vi.spyOn(simulation.api.secrets, 'deleteKey').mockResolvedValue();
  await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Guardar clave' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Introduce un proveedor');
  await userEvent.type(screen.getByLabelText('Proveedor'), 'Proveedor libre');
  const input = screen.getByLabelText('Clave nueva');
  expect(input).toHaveAttribute('type', 'password');
  await userEvent.type(input, 'secreto-test');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar clave' }));
  expect(save).toHaveBeenCalledWith('Proveedor libre', 'secreto-test');
  expect(input).toHaveValue('');
  expect(await screen.findByText('Guardada (cifrada)')).toBeInTheDocument();
  expect(document.body).not.toHaveTextContent('secreto-test');
  await userEvent.click(screen.getByRole('button', { name: 'Borrar clave' }));
  expect(remove).toHaveBeenCalledWith('Proveedor libre');
  expect(
    await within(screen.getByRole('region', { name: 'Claves de API' })).findByText(
      'Sin clave guardada',
    ),
  ).toBeInTheDocument();
});
it('explica safeStorage sin mostrar el secreto ni mensajes de error sin filtrar', async () => {
  vi.spyOn(simulation.api.secrets, 'setKey').mockRejectedValue(
    new Error('safeStorage secreto-test'),
  );
  await mount();
  await userEvent.type(screen.getByLabelText('Proveedor'), 'Libre');
  await userEvent.type(screen.getByLabelText('Clave nueva'), 'secreto-test');
  await userEvent.click(screen.getByRole('button', { name: 'Guardar clave' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Activa el llavero');
  expect(screen.getByLabelText('Clave nueva')).toHaveValue('');
  expect(document.body).not.toHaveTextContent('secreto-test');
});
it('ignora respuestas antiguas de proveedores y muestra carga y errores', async () => {
  let resolve!: (value: boolean) => void;
  vi.spyOn(simulation.api.notifications, 'getPrefs').mockRejectedValue(new Error('IPC'));
  vi.spyOn(simulation.api.secrets, 'hasKey').mockImplementation((provider) =>
    provider === 'A'
      ? new Promise((r) => {
          resolve = r;
        })
      : Promise.resolve(false),
  );
  await mount();
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron cargar');
  await userEvent.type(screen.getByLabelText('Proveedor'), 'A');
  expect(screen.getByText('Comprobando clave…')).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Proveedor'), 'B');
  await act(async () => {
    resolve(true);
  });
  await waitFor(() =>
    expect(
      within(screen.getByRole('region', { name: 'Claves de API' })).getByText('Sin clave guardada'),
    ).toBeInTheDocument(),
  );
});
