// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STRATEGY_NAME_MAX_LENGTH, type StrategySummary } from '../../../../shared/strategy';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { StrategyForm } from './StrategyForm';
import { StrategyLibrary } from './StrategyLibrary';

beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const longName = 'Beta · Reversión RSI en QQQ para la consultora Pérez & Asociados — '.padEnd(
  STRATEGY_NAME_MAX_LENGTH + 14,
  'x',
);

describe('Contador del nombre', () => {
  it('muestra n/120 asociado al campo y avisa al llegar al límite', async () => {
    render(<StrategyForm save={vi.fn()} />);
    const name = screen.getByLabelText('Nombre');
    expect(name).not.toHaveAttribute('maxlength');
    expect(name).toHaveAccessibleDescription(/^\s*0\/120$/);
    await userEvent.type(name, 'Cruce SPY');
    expect(name).toHaveAccessibleDescription(/^\s*9\/120$/);
    fireEvent.change(name, { target: { value: 'a'.repeat(STRATEGY_NAME_MAX_LENGTH) } });
    expect(name).toHaveAccessibleDescription('Has llegado al máximo de 120 caracteres. 120/120');
    expect(name).toHaveAttribute('aria-invalid', 'false');
    expect(document.getElementById('strategy-name-result')).toHaveAttribute('aria-live', 'polite');
  });

  it('un nombre pegado de más se conserva entero, se marca como error y no se guarda', async () => {
    const save = vi.fn();
    render(<StrategyForm save={save} />);
    const name = screen.getByLabelText('Nombre');
    name.focus();
    await userEvent.paste(longName);
    expect(name).toHaveValue(longName);
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAccessibleDescription(
      'Sobran 14 caracteres: acorta el nombre para poder guardar. 134/120',
    );
    expect(document.getElementById('strategy-name-result')).toHaveClass('strategy-rule-error');
    fireEvent.change(screen.getByLabelText('Entrada'), {
      target: { value: 'cruza_arriba(sma(20), sma(50))' },
    });
    const create = screen.getByRole('button', { name: 'Crear estrategia' });
    expect(create).toHaveAttribute('aria-disabled', 'true');
    screen.getByLabelText('Hipótesis económica').focus();
    await userEvent.click(create);
    await waitFor(() => expect(name).toHaveFocus());
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: longName.slice(0, -13) } });
    expect(name).toHaveAccessibleDescription(
      'Sobran 1 carácter: acorta el nombre para poder guardar. 121/120',
    );
  });
});

describe('Columnas de la biblioteca', () => {
  const summary = (id: number, name: string): StrategySummary => ({
    id,
    name,
    version: 1,
    status: 'investigacion',
    regime: 'Tendencias',
    worksIn: [],
    failsIn: [],
    markets: ['QQQ'],
    metricsSummary: null,
    updatedAt: '2026-10-12T10:00:00.000Z',
  });

  it('el nombre lleva title y las cabeceras y cifras van en columnas que no se parten', () => {
    const name = longName.slice(0, STRATEGY_NAME_MAX_LENGTH);
    render(<StrategyLibrary strategies={[summary(1, name), summary(2, 'Alfa')]} />);
    const table = screen.getByRole('table');
    expect(table).toHaveClass('strategy-library-table');
    const link = within(table).getByRole('link', { name });
    expect(link).toHaveAttribute('title', name);
    expect(link).toHaveClass('strategy-table-name');
    for (const header of ['Rentabilidad', 'Sharpe', 'Actualización', 'Drawdown', 'Operaciones'])
      expect(within(table).getByRole('columnheader', { name: header })).toHaveClass(
        'strategy-table-fixed',
      );
    expect(within(table).getByRole('columnheader', { name: 'Estrategia' })).not.toHaveClass(
      'strategy-table-fixed',
    );
    for (const cell of within(table).getAllByText('Sin datos'))
      expect(cell).toHaveClass('strategy-table-fixed');
  });
});
