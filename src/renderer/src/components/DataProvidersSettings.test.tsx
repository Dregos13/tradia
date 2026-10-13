// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../adapters/simulated';
import { navigateAndFocus } from './onboarding/storage';
import { DataProvidersSettings } from './DataProvidersSettings';
let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(() => {
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
});
afterEach(() => {
  cleanup();
  window.location.hash = '';
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
    await userEvent.click(form.getByText(`Cambiar clave de ${name}`));
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
  await userEvent.click(form.getByText('Cambiar clave de Tiingo'));
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
      ['ok', 'Funciona', 'Actualizar datos ahora'],
      ['sin-clave', 'Sin clave', 'Añadir clave'],
      ['clave-rechazada', 'Clave no válida', 'Revisar la clave'],
      ['cuota', 'Límite alcanzado', 'Probar conexión'],
      ['sin-red', 'Sin conexión', 'Probar conexión'],
      ['error', 'No responde', 'Probar conexión'],
    ] as const;
    const test = vi.spyOn(simulation.api.providers, 'testConnection');
    render(<DataProvidersSettings />);
    const form = within(screen.getByRole('form', { name: `Proveedor ${name}` }));
    expect(form.getByText('Sin comprobar')).toBeInTheDocument();
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
      if (status === 'ok') expect(form.getByText('9 oct 2026')).toBeInTheDocument();
      if (status === 'sin-clave' || status === 'clave-rechazada') {
        await userEvent.click(form.getByRole('button', { name: action }));
        await waitFor(() => expect(form.getByLabelText(`Clave de API de ${name}`)).toHaveFocus());
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
    expect(form.getByRole('button', { name: 'Comprobando…' })).toBeDisabled();
    expect(form.getByText('Comprobando…', { selector: 'strong' })).toBeInTheDocument();
    await act(async () => {
      reject(new Error('clave-super-secreta'));
    });
    expect(await form.findByText('No responde')).toBeInTheDocument();
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
      message: 'Funciona',
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
    await userEvent.click(form.getByText(`Cambiar clave de ${name}`));
    await userEvent.type(form.getByLabelText(`Clave de API de ${name}`), 'clave-super-secreta');
    await userEvent.click(form.getByRole('button', { name: `Guardar clave de ${name}` }));
    expect(await form.findByText('Sin comprobar')).toBeInTheDocument();
    expect(test).toHaveBeenCalledOnce();
    expect(document.body).not.toHaveTextContent('clave-super-secreta');
  },
);

it('Tiingo funciona aunque EUR no tenga cobertura; enlaza la lista y separa pendientes', async () => {
  vi.spyOn(simulation.api.watchlist, 'coverage').mockResolvedValue([
    { ticker: 'EUR', coverage: 'sin-cobertura', reason: 'not-found', suggestion: 'FXE' },
    { ticker: 'AAPL', coverage: 'cubierto', reason: null, suggestion: null },
    { ticker: 'MSFT', coverage: 'pendiente-verificar', reason: 'sin-red', suggestion: null },
  ]);
  vi.spyOn(simulation.api.providers, 'testConnection').mockResolvedValue({
    provider: 'tiingo',
    status: 'ok',
    message: 'Conectado',
    latestDataDate: '2026-10-09',
    latencyMs: 20,
    checkedAt: '2026-10-13T12:00:00Z',
  });
  render(<DataProvidersSettings />);
  const form = within(screen.getByRole('form', { name: 'Proveedor Tiingo' }));
  await userEvent.click(form.getByRole('button', { name: 'Probar conexión' }));
  expect(await form.findByText('Funciona')).toBeInTheDocument();
  expect(await form.findByText('EUR no está disponible en Tiingo')).toBeInTheDocument();
  expect(form.getByText('Alternativa disponible: FXE.')).toBeInTheDocument();
  expect(form.getByText(/Pendientes de verificar: MSFT/)).toBeInTheDocument();
  expect(form.getByRole('link', { name: /Ir a la lista/ })).toHaveAttribute('href', '#mercado');
  expect(form.queryByText('AAPL no está disponible en Tiingo')).not.toBeInTheDocument();
});
it('una clave rechazada abre el campo y le devuelve el foco automáticamente', async () => {
  vi.spyOn(simulation.api.providers, 'testConnection').mockResolvedValue({
    provider: 'tiingo',
    status: 'clave-rechazada',
    message: 'Rechazada',
    latestDataDate: null,
    latencyMs: null,
    checkedAt: '2026-10-13T12:00:00Z',
  });
  render(<DataProvidersSettings />);
  const form = within(screen.getByRole('form', { name: 'Proveedor Tiingo' }));
  await userEvent.click(form.getByRole('button', { name: 'Probar conexión' }));
  expect(await form.findByText(/La clave de Tiingo no es válida/)).toBeInTheDocument();
  await waitFor(() => expect(form.getByLabelText('Clave de API de Tiingo')).toHaveFocus());
  expect(form.getByLabelText('Clave de API de Tiingo')).toHaveAttribute('aria-invalid', 'true');
  expect(document.getElementById('tiingo-key-details')).toHaveAttribute('open');
});
it.each(['key', 'test'])('conserva el enlace profundo al foco %s', async (focus) => {
  window.location.hash = `#ajustes?provider=fred&focus=${focus}`;
  render(<DataProvidersSettings />);
  await waitFor(() => expect(document.getElementById(`fred-${focus}`)).toHaveFocus());
});
it('cobertura con error permite reintentar sin declarar la lista cubierta', async () => {
  const coverage = vi
    .spyOn(simulation.api.watchlist, 'coverage')
    .mockRejectedValueOnce(new Error('fallo'))
    .mockResolvedValue([]);
  render(<DataProvidersSettings />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos comprobar la cobertura');
  await userEvent.click(screen.getByRole('button', { name: 'Comprobar cobertura' }));
  expect(await screen.findByText('Tu lista de seguimiento está vacía.')).toBeInTheDocument();
  expect(coverage).toHaveBeenCalledTimes(2);
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Cobertura de tu lista en Tiingo' })).toHaveFocus(),
  );
});

it('el acceso desde el tour abre el campo de la clave incluso con una clave guardada', async () => {
  vi.spyOn(simulation.api.secrets, 'hasKey').mockResolvedValue(true);
  render(<DataProvidersSettings />);
  act(() => navigateAndFocus('ajustes', '#tiingo-key'));
  await waitFor(() => expect(screen.getByLabelText('Clave de API de Tiingo')).toHaveFocus());
  expect(document.getElementById('tiingo-key-details')).toHaveAttribute('open');
});
it('Tiingo dice qué divisas de la lista cubre y su calendario 24/5', async () => {
  vi.spyOn(simulation.api.watchlist, 'coverage').mockResolvedValue([
    { ticker: 'AAPL', coverage: 'cubierto', reason: null, suggestion: null },
    { ticker: 'EURUSD', coverage: 'cubierto', reason: null, suggestion: null },
    { ticker: 'USDJPY', coverage: 'pendiente-verificar', reason: 'sin-red', suggestion: null },
  ]);
  render(<DataProvidersSettings />);
  const form = within(screen.getByRole('form', { name: 'Proveedor Tiingo' }));
  const fx = (await form.findByRole('heading', { name: 'Divisas de tu lista' })).parentElement!;
  const rows = within(fx)
    .getAllByRole('listitem')
    .map((row) => row.textContent);
  expect(rows).toEqual([
    'EUR/USD · cubierta por Tiingo FX · Divisa · 24/5 · cartera simulada',
    'USD/JPY · pendiente de verificar en Tiingo FX · Divisa · 24/5 · solo análisis',
  ]);
  expect(
    within(fx).getByText(/sin datos en fin de semana y con datos en los festivos/),
  ).toBeVisible();
  expect(form.getByText(/Pendientes de verificar: USD\/JPY/)).toBeInTheDocument();
  expect(form.queryByText('Tiingo cubre todos los activos de tu lista.')).not.toBeInTheDocument();
  expect(within(fx).queryByText(/AAPL/)).toBeNull();
});

it('confirma que Tiingo cubre SPY y AAPL sin anunciar activos sin cobertura', async () => {
  vi.spyOn(simulation.api.watchlist, 'coverage').mockResolvedValue([
    { ticker: 'SPY', coverage: 'cubierto', reason: null, suggestion: null },
    { ticker: 'AAPL', coverage: 'cubierto', reason: null, suggestion: null },
  ]);
  render(<DataProvidersSettings />);
  expect(await screen.findByText('Tiingo cubre todos los activos de tu lista.')).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Cobertura de tu lista en Tiingo' })).toBeVisible();
  expect(document.body).not.toHaveTextContent(/sin cobertura/i);
});

it('mantiene el mensaje de lista vacía sin afirmar que todos los activos están cubiertos', async () => {
  vi.spyOn(simulation.api.watchlist, 'coverage').mockResolvedValue([]);
  render(<DataProvidersSettings />);
  expect(await screen.findByText('Tu lista de seguimiento está vacía.')).toBeVisible();
  expect(screen.queryByText('Tiingo cubre todos los activos de tu lista.')).not.toBeInTheDocument();
});

it('H2: la tarjeta de Tiingo explica su alcance y el siguiente paso sin jerga', async () => {
  vi.spyOn(simulation.api.watchlist, 'coverage').mockResolvedValue([
    { ticker: 'EUR', coverage: 'sin-cobertura', reason: 'Sin datos', suggestion: 'FXE' },
  ]);
  render(<DataProvidersSettings />);
  const card = screen.getByRole('form', { name: 'Proveedor Tiingo' });
  await within(card).findByText('EUR no está disponible en Tiingo');
  expect(card).toHaveTextContent('Precios diarios de acciones y fondos de EE. UU.');
  expect(card).toHaveTextContent('Prueba la conexión para saber si Tiingo responde.');
  expect(card).not.toHaveTextContent(/\b(?:ETF|símbolo|conector|par)\b/i);
  expect(screen.getByRole('heading', { name: 'Conectores de datos' })).toBeVisible();
});
