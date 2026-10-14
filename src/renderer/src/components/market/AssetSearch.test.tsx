// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import type { WatchlistItem } from '../../../../shared/ipc';
import { AssetSearch } from './AssetSearch';

let simulation: ReturnType<typeof createSimulatedAdapter>;

beforeEach(() => {
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AssetSearch', () => {
  it('tiene la estructura y roles ARIA de combobox accesibles', () => {
    render(<AssetSearch items={[]} onAdd={vi.fn()} />);

    const combobox = screen.getByRole('combobox');
    expect(combobox).toBeDefined();
    expect(combobox.getAttribute('aria-expanded')).toBe('false');
    expect(combobox.getAttribute('aria-haspopup')).toBe('listbox');

    const input = screen.getByLabelText('Buscar activo o divisa');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');
    expect(input.getAttribute('placeholder')).toContain('EUR/USD');
  });

  it('muestra resultados instantáneos con ticker, nombre y badges por clase de activo', async () => {
    const user = userEvent.setup();
    render(<AssetSearch items={[]} onAdd={vi.fn()} />);

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'EUR');

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeDefined();
    });

    const listbox = screen.getByRole('listbox', { name: 'Sugerencias de activos' });
    expect(listbox).toBeDefined();

    // EUR/USD (Divisa)
    const eurOption = screen.getByRole('option', { name: /EUR\/USD/i });
    expect(eurOption.textContent).toContain('EUR/USD');
    expect(eurOption.textContent).toContain('Euro / Dólar estadounidense');
    expect(eurOption.textContent).toContain('Divisa');
    expect(eurOption.textContent).toContain('Forex 24/5');

    // Badge Divisa con clase forex
    const forexBadge = eurOption.querySelector('.asset-badge.forex');
    expect(forexBadge).not.toBeNull();
    expect(forexBadge?.textContent).toBe('Divisa');

    // FXE (ETF)
    const fxeOption = screen.getByRole('option', { name: /FXE/i });
    expect(fxeOption.textContent).toContain('FXE');
    expect(fxeOption.textContent).toContain('ETF');
    const etfBadge = fxeOption.querySelector('.asset-badge.etf');
    expect(etfBadge).not.toBeNull();
    expect(etfBadge?.textContent).toBe('ETF');
  });

  it('muestra etiqueta de Acción para acciones como AAPL', async () => {
    const user = userEvent.setup();
    render(<AssetSearch items={[]} onAdd={vi.fn()} />);

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'AAPL');

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /AAPL/i })).toBeDefined();
    });

    const aaplOption = screen.getByRole('option', { name: /AAPL/i });
    expect(aaplOption.textContent).toContain('Apple Inc.');
    const stockBadge = aaplOption.querySelector('.asset-badge.stock');
    expect(stockBadge).not.toBeNull();
    expect(stockBadge?.textContent).toBe('Acción');
  });

  it('permite seleccionar y añadir pares de divisas como EUR/USD con un clic en + Añadir', async () => {
    const onAdd = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<AssetSearch items={[]} onAdd={onAdd} />);

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'EUR');

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /EUR\/USD/i })).toBeDefined();
    });

    const eurOption = screen.getByRole('option', { name: /EUR\/USD/i });
    const addBtn = eurOption.querySelector('button');
    expect(addBtn?.textContent).toBe('+ Añadir');

    await user.click(addBtn!);
    expect(onAdd).toHaveBeenCalledWith('EURUSD');

    // Tras añadir con éxito, el desplegable se cierra y el campo se vacía
    await waitFor(() => {
      expect(screen.queryByRole('listbox')).toBeNull();
      expect((input as HTMLInputElement).value).toBe('');
    });
  });

  it('permite añadir haciendo clic en la fila de la opción', async () => {
    const onAdd = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<AssetSearch items={[]} onAdd={onAdd} />);

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'SPY');

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /SPY/i })).toBeDefined();
    });

    const spyOption = screen.getByRole('option', { name: /SPY/i });
    await user.click(spyOption);
    expect(onAdd).toHaveBeenCalledWith('SPY');
  });

  it('identifica activos que ya están en la lista deshabilitando el botón con "Ya en lista"', async () => {
    const onAdd = vi.fn();
    const existingItems: WatchlistItem[] = [
      {
        ticker: 'EURUSD',
        assetClass: 'fx',
        addedAt: '2026-10-14T10:00:00.000Z',
        position: 0,
      },
    ];
    const user = userEvent.setup();
    render(<AssetSearch items={existingItems} onAdd={onAdd} />);

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'EUR');

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /EUR\/USD/i })).toBeDefined();
    });

    const eurOption = screen.getByRole('option', { name: /EUR\/USD/i });
    const btn = eurOption.querySelector('button');
    expect(btn?.disabled).toBe(true);
    expect(btn?.textContent).toBe('Ya en lista');

    // Clicar la fila no añade el duplicado
    await user.click(eurOption);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('soporta navegación por teclado accesible (ArrowDown, ArrowUp, Enter, Escape)', async () => {
    const onAdd = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<AssetSearch items={[]} onAdd={onAdd} />);

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'EUR');

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeDefined();
    });

    const combobox = screen.getByRole('combobox');
    expect(combobox.getAttribute('aria-expanded')).toBe('true');

    // ArrowDown selecciona la primera opción
    await user.keyboard('{ArrowDown}');
    const firstOption = screen.getByRole('option', { name: /EUR\/USD/i });
    expect(firstOption.getAttribute('aria-selected')).toBe('true');
    expect(firstOption.className).toContain('focused');
    expect(input.getAttribute('aria-activedescendant')).toBe('search-item-EURUSD');

    // ArrowDown selecciona la siguiente
    await user.keyboard('{ArrowDown}');
    const secondOption = screen.getByRole('option', { name: /FXE/i });
    expect(secondOption.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe('search-item-FXE');

    // ArrowUp vuelve a la anterior
    await user.keyboard('{ArrowUp}');
    expect(firstOption.getAttribute('aria-selected')).toBe('true');

    // Enter confirma y añade
    await user.keyboard('{Enter}');
    expect(onAdd).toHaveBeenCalledWith('EURUSD');

    // Escape cierra el desplegable
    await user.type(input, 'MSFT');
    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeDefined();
    });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(combobox.getAttribute('aria-expanded')).toBe('false');
  });

  it('soporta añadir símbolos directos fuera del catálogo', async () => {
    const onAdd = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<AssetSearch items={[]} onAdd={onAdd} />);

    const input = screen.getByLabelText('Buscar activo o divisa');
    // RBLX no está en el catálogo estático inicial, viene como directTicker
    await user.type(input, 'RBLX');

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /RBLX/i })).toBeDefined();
    });

    const option = screen.getByRole('option', { name: /RBLX/i });
    expect(option.textContent).toContain('Símbolo directo');

    await user.click(option.querySelector('button')!);
    expect(onAdd).toHaveBeenCalledWith('RBLX');
  });

  it('muestra mensaje claro cuando no hay resultados para la consulta', async () => {
    const user = userEvent.setup();
    render(<AssetSearch items={[]} onAdd={vi.fn()} />);

    const input = screen.getByLabelText('Buscar activo o divisa');
    // Cadena con espacios que no coincide con ningún ticker ni nombre del catálogo
    await user.type(input, 'empresa inexistente');

    await waitFor(() => {
      expect(
        screen.getByText(/No encontramos ningún activo para «empresa inexistente»/),
      ).toBeDefined();
    });
  });

  it('permite limpiar la búsqueda con el botón ✕', async () => {
    const user = userEvent.setup();
    render(<AssetSearch items={[]} onAdd={vi.fn()} />);

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'AAPL');

    const clearBtn = screen.getByRole('button', { name: 'Limpiar búsqueda' });
    expect(clearBtn).toBeDefined();

    await user.click(clearBtn);
    expect((input as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('cierra el desplegable al hacer clic fuera', async () => {
    const user = userEvent.setup();
    render(
      <div>
        <div data-testid="outside">Exterior</div>
        <AssetSearch items={[]} onAdd={vi.fn()} />
      </div>,
    );

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'EUR');

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeDefined();
    });

    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('comunica estado de error mediante aria-invalid y notifica cambio para limpiar error', async () => {
    const onClearError = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <AssetSearch
        items={[]}
        onAdd={vi.fn()}
        error="Ticker no válido"
        onClearError={onClearError}
      />,
    );

    const input = screen.getByLabelText('Buscar activo o divisa');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toBe('market-list-error');

    await user.type(input, 'A');
    expect(onClearError).toHaveBeenCalled();

    rerender(<AssetSearch items={[]} onAdd={vi.fn()} error={null} onClearError={onClearError} />);
    expect(input.getAttribute('aria-invalid')).toBe('false');
  });

  it('respeta el estado desactivado (disabled)', () => {
    render(<AssetSearch items={[]} onAdd={vi.fn()} disabled={true} />);

    const input = screen.getByLabelText<HTMLInputElement>('Buscar activo o divisa');
    expect(input.disabled).toBe(true);

    const addBtn = screen.getByRole<HTMLButtonElement>('button', { name: 'Añadir' });
    expect(addBtn.disabled).toBe(true);
  });

  it('la primera pulsación de ArrowDown resalta la primera sugerencia incluso si el ratón estaba estático sobre ella', async () => {
    const onAdd = vi.fn().mockResolvedValue(true);
    const user = userEvent.setup();
    render(<AssetSearch items={[]} onAdd={onAdd} />);

    // Simular que el ratón del usuario quedó posicionado en (100, 150) tras un clic previo
    fireEvent.mouseDown(window, { clientX: 100, clientY: 150 });

    const input = screen.getByLabelText('Buscar activo o divisa');
    await user.type(input, 'Apple');

    await waitFor(() => {
      expect(screen.getByRole('listbox')).toBeDefined();
    });

    const firstOption = screen.getByRole('option', { name: /AAPL/i });
    // Al montarse bajo el cursor estático, se dispara mouseEnter con la misma coordenada
    fireEvent.mouseEnter(firstOption, { clientX: 100, clientY: 150 });
    fireEvent.mouseMove(firstOption, { clientX: 100, clientY: 150 });

    // La posición estática no debe haber resaltado la opción
    expect(firstOption.getAttribute('aria-selected')).toBe('false');
    expect(input.getAttribute('aria-activedescendant')).toBeNull();

    // La primera pulsación de ArrowDown resalta limpiamente la primera opción
    await user.keyboard('{ArrowDown}');
    expect(firstOption.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe('search-item-AAPL');

    // Una segunda pulsación avanza a la siguiente sugerencia
    await user.keyboard('{ArrowDown}');
    expect(firstOption.getAttribute('aria-selected')).toBe('false');

    // Al mover físicamente el ratón con nuevas coordenadas, el cursor vuelve a tomar el control
    fireEvent.mouseMove(firstOption, { clientX: 100, clientY: 200 });
    expect(firstOption.getAttribute('aria-selected')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBe('search-item-AAPL');
  });
});
