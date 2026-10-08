// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../adapters/simulated';
import { DataProvidersSettings } from './DataProvidersSettings';
let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(() => {
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it.each(['Tiingo', 'FRED'])(
  'guarda %s sin leer ni mostrar la clave y comprueba su existencia',
  async (name) => {
    const stored = new Set<string>();
    const save = vi.spyOn(simulation.api.secrets, 'setKey').mockImplementation(async (provider) => {
      stored.add(provider);
    });
    const has = vi
      .spyOn(simulation.api.secrets, 'hasKey')
      .mockImplementation(async (provider) => stored.has(provider));
    await act(async () => {
      render(<DataProvidersSettings />);
    });
    const form = within(screen.getByRole('form', { name: `Proveedor ${name}` }));
    const input = form.getByLabelText(`Clave de API de ${name}`);
    expect(input).toHaveAttribute('type', 'password');
    await userEvent.type(input, 'clave-super-secreta');
    await userEvent.click(form.getByRole('button', { name: `Guardar clave de ${name}` }));
    expect(save).toHaveBeenCalledWith(name.toLowerCase(), 'clave-super-secreta');
    expect(has).toHaveBeenCalledWith(name.toLowerCase());
    expect(await form.findByText('Guardada y cifrada')).toBeInTheDocument();
    expect(input).toHaveValue('');
    expect(document.body).not.toHaveTextContent('clave-super-secreta');
    expect(form.getByRole('button', { name: 'Probar conexión' })).toBeDisabled();
  },
);
it('valida claves vacías y filtra errores que puedan incluir el secreto', async () => {
  vi.spyOn(simulation.api.secrets, 'setKey').mockRejectedValue(new Error('clave-super-secreta'));
  await act(async () => {
    render(<DataProvidersSettings />);
  });
  const form = within(screen.getByRole('form', { name: 'Proveedor Tiingo' }));
  await userEvent.click(form.getByRole('button', { name: 'Guardar clave de Tiingo' }));
  expect(await form.findByRole('alert')).toHaveTextContent('Introduce una clave nueva');
  await userEvent.type(form.getByLabelText('Clave de API de Tiingo'), 'clave-super-secreta');
  await userEvent.click(form.getByRole('button', { name: 'Guardar clave de Tiingo' }));
  expect(await form.findByRole('alert')).toHaveTextContent('Revisa el llavero');
  expect(form.getByLabelText('Clave de API de Tiingo')).toHaveValue('');
  expect(document.body).not.toHaveTextContent('clave-super-secreta');
});
