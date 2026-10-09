// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { BrokerSettings } from './BrokerSettings';

beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function mount() {
  await act(async () => {
    render(<BrokerSettings />);
  });
}
async function enterKeys() {
  await userEvent.type(screen.getByLabelText('Clave de API'), 'PKPAPER123');
  await userEvent.type(screen.getByLabelText('Secreto de API'), 'SecretPaper123');
}
async function connect() {
  await enterKeys();
  await userEvent.click(screen.getByRole('button', { name: 'Probar conexión' }));
  await screen.findByText('Clave y secreto guardados de forma cifrada');
}
it('enmascara los dos campos, valida vacíos y no llama al broker', async () => {
  const test = vi.spyOn(window.tradia.broker, 'test');
  await mount();
  expect(screen.getByText('Solo paper · sin dinero real')).toBeInTheDocument();
  expect(screen.getByLabelText('Secreto de API')).toHaveAttribute('type', 'password');
  expect(screen.getByLabelText('Clave de API')).toHaveAttribute('type', 'password');
  expect(screen.getByRole('button', { name: 'Probar conexión' })).toBeDisabled();
  fireEvent.submit(screen.getByLabelText('Clave de API').closest('form')!);
  expect(screen.getByText('Introduce la clave de API')).toBeInTheDocument();
  expect(screen.getByText('Introduce el secreto de API')).toBeInTheDocument();
  expect(screen.getByLabelText('Clave de API')).toHaveFocus();
  expect(test).not.toHaveBeenCalled();
});
it.each([
  ['corta', 'SecretPaper123', 'Clave de API'],
  ['PKPAPER123', 'mal secreto', 'Secreto de API'],
])('enfoca el campo inválido con clave %s y secreto %s', async (key, secret, field) => {
  const test = vi.spyOn(window.tradia.broker, 'test');
  const save = vi.spyOn(window.tradia.broker, 'connect');
  await mount();
  await userEvent.type(screen.getByLabelText('Clave de API'), key);
  await userEvent.type(screen.getByLabelText('Secreto de API'), secret);
  expect(screen.getByRole('button', { name: 'Probar conexión' })).toBeDisabled();
  fireEvent.submit(screen.getByLabelText('Clave de API').closest('form')!);
  expect(screen.getByLabelText(field)).toHaveFocus();
  expect(screen.getByRole('alert')).toHaveTextContent(
    'Usa claves de 6 a 256 caracteres alfanuméricos o guiones, sin espacios.',
  );
  expect(test).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
it('enfoca el secreto vacío cuando la clave es válida', async () => {
  const test = vi.spyOn(window.tradia.broker, 'test');
  const save = vi.spyOn(window.tradia.broker, 'connect');
  await mount();
  await userEvent.type(screen.getByLabelText('Clave de API'), 'PKPAPER123');
  fireEvent.submit(screen.getByLabelText('Clave de API').closest('form')!);
  expect(screen.getByLabelText('Secreto de API')).toHaveFocus();
  expect(screen.getByText('Introduce el secreto de API')).toBeInTheDocument();
  expect(test).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});
it('prueba, conecta y borra los borradores sin recuperar secretos', async () => {
  const test = vi.spyOn(window.tradia.broker, 'test');
  const save = vi.spyOn(window.tradia.broker, 'connect');
  await mount();
  await connect();
  expect(test).toHaveBeenCalledWith({ apiKeyId: 'PKPAPER123', apiSecret: 'SecretPaper123' });
  expect(save).toHaveBeenCalledWith({ apiKeyId: 'PKPAPER123', apiSecret: 'SecretPaper123' });
  expect(screen.getByText(/Saldo paper/)).toHaveTextContent('USD');
  await userEvent.click(screen.getByRole('button', { name: 'Reemplazar claves' }));
  expect(screen.getByLabelText('Secreto de API')).toHaveValue('');
  expect(screen.getByLabelText('Clave de API')).toHaveValue('');
});
it('muestra el motivo de fallo y no guarda claves rechazadas', async () => {
  vi.spyOn(window.tradia.broker, 'test').mockResolvedValue({
    ok: false,
    account: null,
    error: 'Estas claves no corresponden a una cuenta paper. No se han guardado.',
    latencyMs: null,
  });
  const save = vi.spyOn(window.tradia.broker, 'connect');
  await mount();
  await enterKeys();
  await userEvent.click(screen.getByRole('button', { name: 'Probar conexión' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se han guardado');
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByLabelText('Secreto de API')).toHaveValue('');
});
it('bloquea campos y envíos duplicados mientras comprueba', async () => {
  let resolve!: (value: Awaited<ReturnType<typeof window.tradia.broker.test>>) => void;
  vi.spyOn(window.tradia.broker, 'test').mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await mount();
  await enterKeys();
  await userEvent.click(screen.getByRole('button', { name: 'Probar conexión' }));
  expect(screen.getByLabelText('Secreto de API')).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Comprobando cuenta paper…' })).toBeDisabled();
  await act(async () => {
    resolve({ ok: false, account: null, error: 'Sin conexión', latencyMs: null });
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('Sin conexión');
});
it('guarda el interruptor mediante ajustes y conserva el estado ante un fallo', async () => {
  await mount();
  await connect();
  const toggle = screen.getByRole('switch', { name: 'Ejecutar señales aprobadas en paper' });
  const previous = (toggle as HTMLInputElement).checked;
  const set = vi.spyOn(window.tradia.settings, 'set');
  await userEvent.click(toggle);
  expect(set).toHaveBeenCalledWith({ brokerExecutionEnabled: !previous });
  expect((toggle as HTMLInputElement).checked).toBe(!previous);
  set.mockRejectedValue(new Error('No se pudo guardar el ajuste'));
  await userEvent.click(toggle);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo guardar');
  expect((toggle as HTMLInputElement).checked).toBe(!previous);
});
it('confirma desconexión, atrapa foco y permite cancelar con Escape', async () => {
  const disconnect = vi.spyOn(window.tradia.broker, 'disconnect');
  await mount();
  await connect();
  const trigger = screen.getByRole('button', { name: 'Desconectar' });
  await userEvent.click(trigger);
  expect(screen.getByRole('button', { name: 'Mantener conectada' })).toHaveFocus();
  await userEvent.tab({ shift: true });
  expect(screen.getByRole('button', { name: 'Desconectar y borrar claves' })).toHaveFocus();
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(disconnect).not.toHaveBeenCalled();
  await userEvent.click(trigger);
  await userEvent.click(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Desconectar y borrar claves' }),
  );
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(disconnect).toHaveBeenCalledOnce();
  expect(screen.getByLabelText('Secreto de API')).toHaveValue('');
});
it('permite reintentar la carga y oculta credenciales en errores', async () => {
  vi.spyOn(window.tradia.broker, 'status').mockRejectedValueOnce(new Error('IPC'));
  await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar cuenta paper' }));
  await screen.findByLabelText('Clave de API');
  vi.spyOn(window.tradia.broker, 'test').mockRejectedValue(
    new Error('Fallo SecretPaper123 PKPAPER123'),
  );
  await enterKeys();
  await userEvent.click(screen.getByRole('button', { name: 'Probar conexión' }));
  const alert = await screen.findByRole('alert');
  expect(alert).not.toHaveTextContent('SecretPaper123');
  expect(alert).not.toHaveTextContent('PKPAPER123');
});

it('conserva borradores en un error corregible y los borra si no hay llavero', async () => {
  const test = vi
    .spyOn(window.tradia.broker, 'test')
    .mockResolvedValue({
      ok: false,
      account: null,
      error: 'No se pudo contactar con Alpaca Paper.',
      latencyMs: null,
    });
  await mount();
  await enterKeys();
  await userEvent.click(screen.getByRole('button', { name: 'Probar conexión' }));
  await screen.findByRole('alert');
  expect(screen.getByLabelText('Secreto de API')).toHaveValue('SecretPaper123');
  test.mockResolvedValue({
    ok: false,
    account: null,
    error: 'No hay un llavero seguro disponible. Activa gnome-keyring o KWallet.',
    latencyMs: null,
  });
  await userEvent.click(screen.getByRole('button', { name: 'Probar conexión' }));
  await waitFor(() => expect(screen.getByLabelText('Secreto de API')).toHaveValue(''));
});
