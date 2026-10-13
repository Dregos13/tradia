// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  expect(screen.getByRole('alert')).toHaveTextContent(message);
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
  fireEvent.submit(input.closest('form')!);
  expect(onSave).toHaveBeenCalledExactlyOnceWith({ ...saved, shortPositions: 0 });
});
