// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import type { DataStatusEntry } from '../../../../shared/ipc';
import { FirstStepsCard } from './FirstStepsCard';
import { FIRST_STEPS_HIDDEN_KEY } from './storage';

let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(() => {
  window.location.hash = '';
  localStorage.clear();
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const reliable = (provider: string): DataStatusEntry => ({
  key: `provider:${provider}`,
  state: 'fiable',
  lastOkAt: '2026-10-09',
  consecutiveFailures: 0,
  reason: null,
  updatedAt: '2026-10-11T12:00:00Z',
});
const card = () => within(screen.getByRole('region', { name: 'Primeros pasos' }));

it('carga sin ofrecer acciones ni dar la configuración por comprobada', () => {
  vi.spyOn(simulation.api.secrets, 'hasKey').mockReturnValue(new Promise(() => {}));
  render(<FirstStepsCard />);
  expect(card().getByRole('status')).toHaveTextContent('Comprobando tu configuración…');
  expect(card().getAllByText('Pendiente')).toHaveLength(3);
  expect(card().queryByRole('button')).not.toBeInTheDocument();
});

it('guía a Ajustes, enfoca la clave pendiente y no lee ni guarda secretos', async () => {
  vi.spyOn(simulation.api.secrets, 'hasKey').mockImplementation(
    async (provider) => provider === 'tiingo',
  );
  vi.spyOn(simulation.api.sources, 'list').mockResolvedValue([]);
  const setKey = vi.spyOn(simulation.api.secrets, 'setKey');
  const user = userEvent.setup();
  render(
    <>
      <FirstStepsCard />
      <label htmlFor="fred-key">Clave de API de FRED</label>
      <input id="fred-key" />
    </>,
  );
  await screen.findByText('0 de 3 hechos');
  await user.click(card().getByRole('button', { name: 'Añadir claves' }));
  expect(window.location.hash).toBe('#ajustes');
  await waitFor(() => expect(screen.getByLabelText('Clave de API de FRED')).toHaveFocus());
  await user.click(card().getByRole('button', { name: 'Añadir fuente' }));
  expect(window.location.hash).toBe('#fuentes');
  expect(setKey).not.toHaveBeenCalled();
});

it('muestra un fallo recuperable y reintenta la configuración', async () => {
  vi.spyOn(simulation.api.sources, 'list').mockRejectedValueOnce(new Error('IPC'));
  const user = userEvent.setup();
  render(<FirstStepsCard />);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'No pudimos comprobar tu configuración.',
  );
  await user.click(screen.getByRole('button', { name: 'Reintentar' }));
  expect(await screen.findByText('1 de 3 hechos')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('explica el llavero no disponible sin mostrar detalles de la excepción', async () => {
  vi.spyOn(simulation.api.secrets, 'hasKey').mockRejectedValue(
    new Error('safeStorage no disponible: detalle privado'),
  );
  render(<FirstStepsCard />);
  expect(
    await screen.findByText(
      'El llavero del sistema no está disponible, así que no se pueden guardar claves.',
    ),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Ver ayuda en Ajustes' })).toBeInTheDocument();
  expect(screen.queryByText(/detalle privado/)).not.toBeInTheDocument();
});

it('refleja el estado real de los proveedores sin lanzar una prueba de conexión', async () => {
  vi.spyOn(simulation.api.secrets, 'hasKey').mockResolvedValue(true);
  const get = vi
    .spyOn(simulation.api.dataStatus, 'get')
    .mockResolvedValue([
      { ...reliable('tiingo'), state: 'no-fiable', reason: 'Clave rechazada por el proveedor' },
      reliable('fred'),
    ]);
  const test = vi.spyOn(simulation.api.providers, 'testConnection');
  const user = userEvent.setup();
  render(
    <>
      <FirstStepsCard />
      <form aria-label="Proveedor Tiingo">
        <button id="tiingo-test" type="button">
          Probar conexión de Tiingo
        </button>
      </form>
    </>,
  );
  expect(await screen.findByText('Tiingo: Clave rechazada por el proveedor')).toBeInTheDocument();
  expect(card().getByText('Revisar')).toBeInTheDocument();
  await user.click(card().getByRole('button', { name: 'Probar conexión' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Probar conexión de Tiingo' })).toHaveFocus(),
  );
  expect(test).not.toHaveBeenCalled();
  get.mockResolvedValue([reliable('tiingo'), reliable('fred')]);
  await act(async () => {
    simulation.emitDataStatus(reliable('tiingo'));
  });
  expect(
    await screen.findByText('Todo listo: Tradia ya recibe datos y noticias.'),
  ).toBeInTheDocument();
});

it('permite ocultar cuando todo está hecho y reaparece si se elimina una clave', async () => {
  vi.spyOn(simulation.api.secrets, 'hasKey').mockResolvedValue(true);
  vi.spyOn(simulation.api.dataStatus, 'get').mockResolvedValue([
    reliable('tiingo'),
    reliable('fred'),
  ]);
  const user = userEvent.setup();
  const { unmount } = render(<FirstStepsCard />);
  await user.click(await screen.findByRole('button', { name: 'Ocultar' }));
  expect(localStorage.getItem(FIRST_STEPS_HIDDEN_KEY)).toBe('true');
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
  unmount();
  vi.mocked(simulation.api.secrets.hasKey).mockImplementation(
    async (provider) => provider === 'tiingo',
  );
  render(<FirstStepsCard />);
  expect(await screen.findByText('1 de 3 hechos')).toBeInTheDocument();
  // La marca se borra en un useEffect posterior al render: bajo carga puede llegar después.
  await waitFor(() => expect(localStorage.getItem(FIRST_STEPS_HIDDEN_KEY)).toBeNull());
});
