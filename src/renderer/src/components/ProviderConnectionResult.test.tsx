// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ProviderConnectionResult } from './ProviderConnectionResult';
afterEach(cleanup);
it.each([
  'El proveedor no respondió como se esperaba.',
  'El proveedor no respondió como se esperaba',
  'El proveedor no respondió como se esperaba..  ',
])('H3/N3: separa el motivo de la acción con un solo punto (%s)', (message) => {
  render(
    <ProviderConnectionResult
      provider="tiingo"
      name="Tiingo"
      testing={false}
      result={{
        provider: 'tiingo',
        status: 'error',
        message,
        latestDataDate: null,
        latencyMs: null,
        checkedAt: '2026-10-06T22:00:00Z',
      }}
      onRetry={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent(
    'El proveedor no respondió como se esperaba. Vuelve a probar',
  );
  expect(screen.getByRole('status')).not.toHaveTextContent('..');
});
