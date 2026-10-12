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
    expect(form.getByRole('button', { name: 'Probar conexión' })).toBeEnabled();
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

it.each(['tiingo', 'fred'] as const)(
  '%s: cubre los seis resultados sin exponer secretos',
  async (provider) => {
    const name = provider === 'tiingo' ? 'Tiingo' : 'FRED';
    const statuses = [
      ['ok', 'Conectado', 'Actualizar datos ahora'],
      ['sin-clave', 'Sin clave', 'Añadir clave'],
      ['clave-rechazada', 'Clave rechazada', 'Cambiar clave'],
      ['cuota', 'Cuota agotada', 'Probar de nuevo'],
      ['sin-red', 'Sin red', 'Probar de nuevo'],
      ['error', 'Error del proveedor', 'Probar de nuevo'],
    ] as const;
    const test = vi.spyOn(simulation.api.providers, 'testConnection');
    render(<DataProvidersSettings />);
    const form = within(screen.getByRole('form', { name: `Proveedor ${name}` }));
    expect(form.getByText('Sin probar')).toBeInTheDocument();
    for (const [status, label, action] of statuses) {
      test.mockResolvedValueOnce({
        provider,
        status,
        message: 'Respuesta segura del proveedor',
        latestDataDate: status === 'ok' ? '2026-10-09' : null,
        checkedAt: '2026-10-11T12:15:00Z',
        latencyMs: 312,
      });
      await userEvent.click(form.getByRole('button', { name: 'Probar conexión' }));
      expect(await form.findByText(label)).toBeInTheDocument();
      expect(form.getByRole('button', { name: action })).toBeEnabled();
      expect(test).toHaveBeenLastCalledWith({ provider });
      if (status === 'ok')
        expect(form.getByText(/Último dato disponible: 9 oct 2026/)).toBeInTheDocument();
      if (status === 'sin-clave' || status === 'clave-rechazada') {
        await userEvent.click(form.getByRole('button', { name: action }));
        expect(form.getByLabelText(`Clave de API de ${name}`)).toHaveFocus();
      }
      expect(document.body).not.toHaveTextContent('clave-super-secreta');
    }
  },
);

it.each(['tiingo', 'fred'] as const)(
  '%s: anuncia probando, evita duplicados y filtra excepciones',
  async (provider) => {
    let reject!: (error: Error) => void;
    vi.spyOn(simulation.api.providers, 'testConnection').mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    render(<DataProvidersSettings />);
    const form = within(
      screen.getByRole('form', { name: `Proveedor ${provider === 'tiingo' ? 'Tiingo' : 'FRED'}` }),
    );
    await userEvent.click(form.getByRole('button', { name: 'Probar conexión' }));
    expect(form.getByRole('button', { name: 'Probando…' })).toBeDisabled();
    expect(form.getByText('Probando')).toBeInTheDocument();
    await act(async () => {
      reject(new Error('clave-super-secreta'));
    });
    expect(await form.findByText('Error del proveedor')).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent('clave-super-secreta');
  },
);

it.each(['tiingo', 'fred'] as const)(
  '%s: actualiza su proveedor y borra la prueba tras guardar una clave',
  async (provider) => {
    const name = provider === 'tiingo' ? 'Tiingo' : 'FRED';
    vi.spyOn(simulation.api.secrets, 'setKey').mockResolvedValue();
    const test = vi.spyOn(simulation.api.providers, 'testConnection').mockResolvedValue({
      provider,
      status: 'ok',
      message: 'Conectado',
      latestDataDate: '2026-10-09',
      checkedAt: '2026-10-11T12:15:00Z',
      latencyMs: 312,
    });
    const market = vi
      .spyOn(simulation.api.market, 'refreshNow')
      .mockResolvedValue({ accepted: true, reason: null, ok: false, detail: 'HTTP 503' });
    const macro = vi
      .spyOn(simulation.api.macro, 'refreshNow')
      .mockResolvedValue({ accepted: true, reason: null, ok: false, detail: 'HTTP 503' });
    render(<DataProvidersSettings />);
    const form = within(screen.getByRole('form', { name: `Proveedor ${name}` }));
    await userEvent.click(form.getByRole('button', { name: 'Probar conexión' }));
    await userEvent.click(form.getByRole('button', { name: 'Actualizar datos ahora' }));
    expect(await form.findByText('No se pudo actualizar: HTTP 503')).toBeInTheDocument();
    expect(provider === 'tiingo' ? market : macro).toHaveBeenCalledOnce();
    expect(provider === 'tiingo' ? macro : market).not.toHaveBeenCalled();
    await userEvent.type(form.getByLabelText(`Clave de API de ${name}`), 'clave-super-secreta');
    await userEvent.click(form.getByRole('button', { name: `Guardar clave de ${name}` }));
    expect(await form.findByText('Sin probar')).toBeInTheDocument();
    expect(test).toHaveBeenCalledOnce();
    expect(document.body).not.toHaveTextContent('clave-super-secreta');
  },
);
