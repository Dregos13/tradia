// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { WatchlistItem } from '../../../../shared/ipc';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { Watchlist } from './Watchlist';

let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(() => {
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function Harness({ initial = [] }: { initial?: WatchlistItem[] }) {
  const [items, setItems] = useState(initial);
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <Watchlist
      items={items}
      selected={selected}
      onSelect={setSelected}
      onChanged={async () => setItems(await simulation.api.watchlist.list())}
    />
  );
}
async function add(ticker: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Ticker'), ticker);
  await user.click(screen.getByRole('button', { name: 'Añadir' }));
}
it('rechaza EUR, conserva la lista y el valor, anuncia y enfoca el campo', async () => {
  await simulation.api.watchlist.add('SPY');
  simulation.markTickerUncovered('EUR');
  render(<Harness initial={await simulation.api.watchlist.list()} />);
  await add('EUR');
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(
    'Tiingo no ofrece datos para EUR. Puedes añadir FXE, un ETF que sigue una exposición parecida.',
  );
  expect(alert).toHaveAttribute('aria-live', 'assertive');
  expect(screen.getByLabelText('Ticker')).toHaveAttribute(
    'aria-describedby',
    'market-ticker-help market-list-error',
  );
  expect(screen.getByLabelText('Ticker')).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByLabelText('Ticker')).toHaveValue('EUR');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ticker')));
  expect((await simulation.api.watchlist.list()).map((item) => item.ticker)).toEqual(['SPY']);
  expect(screen.getByRole('button', { name: 'Añadir FXE' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Añadir EURUSD' })).toBeEnabled();
});
it('añade FXE con un clic, muestra el nombre real devuelto y devuelve foco estable', async () => {
  simulation.markTickerUncovered('EUR');
  const original = simulation.api.watchlist.add;
  vi.spyOn(simulation.api.watchlist, 'add').mockImplementation(async (ticker) => {
    const result = await original(ticker);
    return ticker === 'FXE' ? { ...result, name: 'Invesco CurrencyShares Euro Trust' } : result;
  });
  render(<Harness />);
  await add('EUR');
  await userEvent.click(await screen.findByRole('button', { name: 'Añadir FXE' }));
  const row = await screen.findByRole('button', { name: 'FXE' });
  expect(row).toHaveAttribute('aria-pressed', 'true');
  expect(row).toHaveTextContent('Invesco CurrencyShares Euro Trust');
  expect(screen.getByRole('status')).toHaveTextContent(
    'FXE se ha añadido a tu lista como Invesco CurrencyShares Euro Trust.',
  );
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Ticker')).toHaveValue('');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ticker')));
  expect((await simulation.api.watchlist.list()).map((item) => item.ticker)).toEqual(['FXE']);
});
it('muestra Comprobando y bloquea el formulario mientras espera al proveedor', async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const original = simulation.api.watchlist.add;
  vi.spyOn(simulation.api.watchlist, 'add').mockImplementation(async (ticker) => {
    await pending;
    return original(ticker);
  });
  render(<Harness />);
  await add('AAPL');
  expect(screen.getByRole('button', { name: 'Comprobando…' })).toBeDisabled();
  expect(screen.getByLabelText('Ticker')).toBeDisabled();
  expect(screen.getByText('Comprobando si AAPL está disponible en Tiingo…')).toHaveAttribute(
    'aria-live',
    'polite',
  );
  await act(async () => {
    finish();
  });
  await screen.findByRole('button', { name: 'AAPL' });
  expect(screen.getByRole('button', { name: 'Añadir' })).toBeEnabled();
});
it('rechaza sin alternativa y elimina el error al editar', async () => {
  simulation.markTickerUncovered('ZZZZ');
  render(<Harness />);
  await add('ZZZZ');
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Prueba con el ticker de una acción o un ETF de EE. UU.',
  );
  expect(within(screen.getByRole('alert')).queryByRole('button')).not.toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('Ticker'), 'A');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByLabelText('Ticker')).toHaveAttribute('aria-invalid', 'false');
});
it('una alternativa rechazada no entra en la lista y queda en el campo', async () => {
  simulation.markTickerUncovered('EUR');
  simulation.markTickerUncovered('FXE');
  render(<Harness />);
  await add('EUR');
  await userEvent.click(await screen.findByRole('button', { name: 'Añadir FXE' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Tiingo no ofrece datos para FXE.');
  expect(await simulation.api.watchlist.list()).toEqual([]);
  expect(screen.getByLabelText('Ticker')).toHaveValue('FXE');
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ticker')));
});
it('añade pendiente sin rechazarlo y describe la marca de su fila', async () => {
  const original = simulation.api.watchlist.add;
  vi.spyOn(simulation.api.watchlist, 'add').mockImplementation(async (ticker) => {
    await original(ticker);
    return { added: true, reason: 'pendiente-verificar' };
  });
  vi.spyOn(simulation.api.watchlist, 'coverage').mockResolvedValue([
    { ticker: 'AAPL', coverage: 'pendiente-verificar', reason: null, suggestion: null },
  ]);
  render(<Harness />);
  await add('AAPL');
  expect(await screen.findByRole('button', { name: 'AAPL' })).toHaveAccessibleDescription(
    'Pendiente de verificar',
  );
  expect(screen.getByRole('status')).toHaveTextContent(
    'AAPL se ha añadido, pero aún no pudimos comprobarlo.',
  );
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('marca los activos sin cobertura sin marcar el resto', async () => {
  await simulation.api.watchlist.add('EUR');
  await simulation.api.watchlist.add('SPY');
  const items = await simulation.api.watchlist.list();
  vi.spyOn(simulation.api.watchlist, 'coverage').mockResolvedValue([
    { ticker: 'EUR', coverage: 'sin-cobertura', reason: null, suggestion: 'FXE' },
    { ticker: 'SPY', coverage: 'cubierto', reason: null, suggestion: null },
  ]);
  render(<Harness initial={items} />);
  const row = screen.getByRole('button', { name: 'EUR' });
  await waitFor(() => expect(row).toHaveAccessibleDescription('Sin datos en Tiingo'));
  expect(screen.getByRole('button', { name: 'SPY' })).not.toHaveAccessibleDescription(
    'Sin datos en Tiingo',
  );
  expect(within(row.closest('li')!).getByText('Sin datos en Tiingo')).toBeVisible();
});
it.each(['duplicado', 'limite'] as const)(
  'explica el rechazo %s devuelto por el contrato',
  async (reason) => {
    vi.spyOn(simulation.api.watchlist, 'add').mockResolvedValue({ added: false, reason });
    render(<Harness />);
    await add('AAPL');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      reason === 'duplicado'
        ? 'AAPL ya está en tu lista.'
        : 'Has alcanzado el límite de 25 activos.',
    );
    expect(await simulation.api.watchlist.list()).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ticker')));
  },
);
it('valida el formato sin llamar al proveedor y no expone excepciones', async () => {
  const request = vi
    .spyOn(simulation.api.watchlist, 'add')
    .mockRejectedValue(new Error('private token'));
  render(<Harness />);
  await add('???');
  expect(await screen.findByRole('alert')).toHaveTextContent('Introduce un ticker');
  expect(request).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Añadir' }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Ticker')));
  await userEvent.clear(screen.getByLabelText('Ticker'));
  await add('AAPL');
  expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos actualizar la lista');
  expect(screen.queryByText(/private token/)).not.toBeInTheDocument();
});
