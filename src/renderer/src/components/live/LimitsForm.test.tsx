// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import type { LiveLimits } from '../../../../shared/live';
import { LimitsForm } from './LimitsForm';

const saved: LiveLimits = {
  capitalUsd: 500,
  orderUsd: 100,
  dailyLossUsd: 10,
  openPositions: 1,
  shortOrderUsd: 100,
  shortExposureUsd: 200,
  shortPositions: 1,
};
afterEach(cleanup);

it.each([
  ['Máximo por orden en corto', '101', /supera el techo/],
  ['Exposición corta total máxima', '201', /supera el techo/],
  ['Posiciones cortas simultáneas', '2', /supera el techo/],
  ['Posiciones cortas simultáneas', '0.5', /número entero/],
  ['Máximo por orden en corto', '-1', /igual o mayor que cero/],
  ['Exposición corta total máxima', '', /igual o mayor que cero/],
] as const)('rechaza %s = %s sin guardar ni ocultar el error', (label, value, message) => {
  const onSave = vi.fn();
  const onDirty = vi.fn();
  render(<LimitsForm saved={saved} disabled={false} onSave={onSave} onDirty={onDirty} />);
  const input = screen.getByLabelText(label);
  fireEvent.change(input, { target: { value } });
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(input).toHaveAccessibleDescription(message);
  expect(screen.getAllByRole('alert').some((alert) => message.test(alert.textContent ?? ''))).toBe(
    true,
  );
  expect(onDirty).toHaveBeenLastCalledWith(true);
  expect(screen.getByRole('button', { name: 'Guardar límites' })).toBeDisabled();
  fireEvent.submit(input.closest('form')!);
  expect(onSave).not.toHaveBeenCalled();
});

it('acepta cero para desactivar el corto y conserva los otros límites', () => {
  const onSave = vi.fn().mockResolvedValue(true);
  render(<LimitsForm saved={saved} disabled={false} onSave={onSave} onDirty={vi.fn()} />);
  const input = screen.getByLabelText('Posiciones cortas simultáneas');
  fireEvent.change(input, { target: { value: '0' } });
  expect(input).toHaveAttribute('aria-invalid', 'false');
  fireEvent.change(screen.getByLabelText('Máximo por orden en corto'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('Exposición corta total máxima'), {
    target: { value: '0' },
  });
  fireEvent.submit(input.closest('form')!);
  expect(onSave).toHaveBeenCalledExactlyOnceWith({
    ...saved,
    shortOrderUsd: 0,
    shortExposureUsd: 0,
    shortPositions: 0,
  });
});

it('pone el corto bloqueado a 0 con teclado sin perder el borrador general ni permitir subirlo', async () => {
  const onSave = vi.fn().mockResolvedValue(true);
  const onDirty = vi.fn();
  render(
    <LimitsForm
      saved={saved}
      disabled={false}
      shortBlocked
      shortBlockReason="Falta la declaración del corto."
      onSave={onSave}
      onDirty={onDirty}
    />,
  );
  const capital = screen.getByLabelText('Capital total en real');
  fireEvent.change(capital, { target: { value: '400' } });
  expect(screen.getByRole('button', { name: 'Guardar límites' })).toBeDisabled();
  const reset = screen.getByRole('button', { name: 'Poner el corto a 0' });
  reset.focus();
  await userEvent.keyboard('{Enter}');
  expect(capital).toHaveValue(400);
  for (const label of [
    'Máximo por orden en corto',
    'Exposición corta total máxima',
    'Posiciones cortas simultáneas',
  ]) {
    const input = screen.getByLabelText(label);
    expect(input).toHaveValue(0);
    expect(input).not.toBeDisabled();
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveAttribute('aria-disabled', 'true');
    expect(input).toHaveAccessibleDescription(/Falta la declaración del corto/);
    fireEvent.change(input, { target: { value: '1' } });
    expect(input).toHaveValue(0);
  }
  expect(onDirty).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole('button', { name: 'Poner el corto a 0' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Guardar límites' }));
  expect(onSave).toHaveBeenCalledExactlyOnceWith({
    ...saved,
    capitalUsd: 400,
    shortOrderUsd: 0,
    shortExposureUsd: 0,
    shortPositions: 0,
  });
});
