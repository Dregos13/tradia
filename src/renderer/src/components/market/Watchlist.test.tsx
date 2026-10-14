// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import type { WatchlistItem } from '../../../../shared/ipc';
import { Watchlist } from './Watchlist';

let simulation: ReturnType<typeof createSimulatedAdapter>;

const makeItem = (
  ticker: string,
  assetClass: 'equity' | 'fx' = 'equity',
  position = 0,
): WatchlistItem => ({
  ticker,
  assetClass,
  addedAt: '2026-10-14T10:00:00.000Z',
  position,
});

beforeEach(() => {
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Watchlist', () => {
  it('muestra el estado vacío cuando no hay activos en la lista', () => {
    render(
      <Watchlist
        items={[]}
        selected={null}
        onSelect={vi.fn()}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText('Tu lista está vacía.')).toBeDefined();
    expect(screen.getByText('0 / 25')).toBeDefined();
  });

  it('renderiza activos en seguimiento, identificando divisas como EUR/USD con badge y formato de barra', () => {
    const items: WatchlistItem[] = [makeItem('AAPL', 'equity', 0), makeItem('EURUSD', 'fx', 1)];

    render(
      <Watchlist
        items={items}
        selected="EURUSD"
        onSelect={vi.fn()}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const watch = screen.getByRole('complementary', { name: 'Lista de seguimiento' });
    expect(within(watch).getByText('2 / 25')).toBeDefined();

    // AAPL
    const aaplBtn = within(watch).getByRole('button', { name: 'AAPL' });
    expect(aaplBtn.getAttribute('aria-pressed')).toBe('false');

    // EUR/USD identificado con formato de barra y badge Divisa
    const eurBtn = within(watch).getByRole('button', { name: 'EUR/USD' });
    expect(eurBtn.getAttribute('aria-pressed')).toBe('true');
    expect(within(eurBtn).getByText('EUR/USD')).toBeDefined();

    const forexBadge = within(eurBtn).getByText('Divisa');
    expect(forexBadge.className).toContain('forex');
  });

  it('permite cambiar el activo seleccionado al pulsar sobre él', async () => {
    const onSelect = vi.fn();
    const items: WatchlistItem[] = [makeItem('AAPL', 'equity', 0), makeItem('EURUSD', 'fx', 1)];
    const user = userEvent.setup();

    render(
      <Watchlist
        items={items}
        selected="AAPL"
        onSelect={onSelect}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const eurBtn = screen.getByRole('button', { name: 'EUR/USD' });
    await user.click(eurBtn);

    expect(onSelect).toHaveBeenCalledWith('EURUSD');
  });

  it('busca y añade el par de divisas EUR/USD a la lista de seguimiento con un solo clic', async () => {
    const addSpy = vi.spyOn(simulation.api.watchlist, 'add');
    const onSelect = vi.fn();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<Watchlist items={[]} selected={null} onSelect={onSelect} onChanged={onChanged} />);

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'EUR');

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeDefined();
    });

    const eurOption = screen.getByRole('option', { name: /EUR\/USD/i });
    const addBtn = eurOption.querySelector('button');
    expect(addBtn?.textContent).toBe('+ Añadir');

    await user.click(addBtn!);

    expect(addSpy).toHaveBeenCalledWith('EURUSD');
    expect(onChanged).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith('EURUSD');
    expect(screen.getByRole('status').textContent).toContain('EUR/USD se ha añadido a tu lista.');
  });

  it('añade una acción escribiendo su símbolo y pulsando Añadir o Enter', async () => {
    const addSpy = vi.spyOn(simulation.api.watchlist, 'add');
    const onSelect = vi.fn();
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<Watchlist items={[]} selected={null} onSelect={onSelect} onChanged={onChanged} />);

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'MSFT');
    await user.click(screen.getByRole('button', { name: 'Añadir' }));

    expect(addSpy).toHaveBeenCalledWith('MSFT');
    expect(onChanged).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith('MSFT');
  });

  it('rechaza tickers no válidos y muestra mensaje de formato', async () => {
    const addSpy = vi.spyOn(simulation.api.watchlist, 'add');
    const user = userEvent.setup();

    render(
      <Watchlist
        items={[]}
        selected={null}
        onSelect={vi.fn()}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'INVALID#$%^');
    await user.click(screen.getByRole('button', { name: 'Añadir' }));

    expect(addSpy).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Símbolo no reconocido');
    expect(alert.textContent).toContain('Introduce un ticker');
  });

  it('rechaza duplicados y avisa de que el activo ya está en la lista', async () => {
    const addSpy = vi.spyOn(simulation.api.watchlist, 'add');
    const items: WatchlistItem[] = [makeItem('SPY', 'equity', 0)];
    const user = userEvent.setup();

    render(
      <Watchlist
        items={items}
        selected="SPY"
        onSelect={vi.fn()}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'spy');
    await user.click(screen.getByRole('button', { name: 'Añadir' }));

    expect(addSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('SPY ya está en tu lista.');
  });

  it('rechaza altas cuando se ha alcanzado el límite de 25 activos', async () => {
    const addSpy = vi.spyOn(simulation.api.watchlist, 'add');
    const items: WatchlistItem[] = Array.from({ length: 25 }, (_, i) =>
      makeItem(`TK${i}`, 'equity', i),
    );
    const user = userEvent.setup();

    render(
      <Watchlist
        items={items}
        selected="TK0"
        onSelect={vi.fn()}
        onChanged={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'AAPL');
    await user.click(screen.getByRole('button', { name: 'Añadir' }));

    expect(addSpy).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain('límite de 25');
  });

  it('permite quitar un activo seleccionado con diálogo de confirmación', async () => {
    const removeSpy = vi.spyOn(simulation.api.watchlist, 'remove');
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const items: WatchlistItem[] = [makeItem('EURUSD', 'fx', 0), makeItem('AAPL', 'equity', 1)];
    const user = userEvent.setup();

    render(<Watchlist items={items} selected="EURUSD" onSelect={vi.fn()} onChanged={onChanged} />);

    // Botón de quitar adaptado a EUR/USD
    const removeBtn = screen.getByRole('button', { name: 'Quitar EUR/USD' });
    await user.click(removeBtn);

    // Diálogo de confirmación
    expect(screen.getByText(/¿Quitar EUR\/USD de tu lista\?/)).toBeDefined();

    // Cancelar
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByText(/¿Quitar EUR\/USD de tu lista\?/)).toBeNull();
    expect(removeSpy).not.toHaveBeenCalled();

    // Confirmar
    await user.click(screen.getByRole('button', { name: 'Quitar EUR/USD' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar quitar EUR/USD' }));

    expect(removeSpy).toHaveBeenCalledWith('EURUSD');
    expect(onChanged).toHaveBeenCalled();
  });

  it('permite añadir el universo inicial de 25 activos', async () => {
    const universeSpy = vi.spyOn(simulation.api.watchlist, 'addUniverse');
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(<Watchlist items={[]} selected={null} onSelect={vi.fn()} onChanged={onChanged} />);

    const universeBtn = screen.getByRole('button', { name: 'Añadir universo inicial · 25' });
    await user.click(universeBtn);

    expect(universeSpy).toHaveBeenCalled();
    expect(onChanged).toHaveBeenCalled();
  });

  it('gestiona errores de red o fallo en el alta sin romper la interfaz y conserva el texto', async () => {
    vi.spyOn(simulation.api.watchlist, 'add').mockRejectedValueOnce(
      new Error('Fallo de conexión simulado'),
    );
    const user = userEvent.setup();

    render(<Watchlist items={[]} selected={null} onSelect={vi.fn()} onChanged={onChangedNoop} />);

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'AAPL');
    await user.click(screen.getByRole('button', { name: 'Añadir' }));

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('No pudimos actualizar la lista');
    });

    // El texto introducido se conserva para permitir reintentar o corregir
    expect((input as HTMLInputElement).value).toBe('AAPL');
  });
});

const onChangedNoop = vi.fn().mockResolvedValue(undefined);
