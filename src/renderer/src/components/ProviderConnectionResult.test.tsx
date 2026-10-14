// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
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
        checkedAt: '2026-10-06T12:00:00Z',
      }}
      onRetry={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  expect(screen.getByText('El proveedor no respondió como se esperaba.')).toBeInTheDocument();
  expect(screen.getByRole('status')).not.toHaveTextContent('..');
});

it.each([
  ['ok', 'Funciona', 'Siguiente paso'],
  ['sin-clave', 'Sin clave', 'Cómo arreglarlo'],
  ['clave-rechazada', 'Clave no válida', 'Cómo arreglarlo'],
  ['cuota', 'Límite alcanzado', 'Cómo arreglarlo'],
  ['sin-red', 'Sin conexión', 'Cómo arreglarlo'],
  ['error', 'No responde', 'Cómo arreglarlo'],
] as const)('%s ofrece texto, fecha y siguiente paso', (status, label, heading) => {
  render(
    <ProviderConnectionResult
      provider="fred"
      name="FRED"
      testing={false}
      result={{
        provider: 'fred',
        status,
        message: 'Respuesta segura',
        latestDataDate: null,
        checkedAt: '2026-10-06T12:00:00Z',
        latencyMs: null,
      }}
      onRetry={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  expect(screen.getByText(label)).toBeInTheDocument();
  expect(screen.getByText('Última comprobación')).toBeInTheDocument();
  expect(screen.getByText(/6 oct/)).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: heading })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Probar conexión' })).toBeEnabled();
});

it.each([
  ['ok', 'Actualizar datos ahora'],
  ['clave-rechazada', 'Revisar la clave'],
  ['error', 'Probar conexión'],
] as const)('%s deja una sola acción en «Siguiente paso»: %s', (status, action) => {
  const view = render(
    <ProviderConnectionResult
      provider="tiingo"
      name="Tiingo"
      testing={false}
      result={{
        provider: 'tiingo',
        status,
        message: 'Respuesta segura',
        latestDataDate: null,
        checkedAt: '2026-10-06T12:00:00Z',
        latencyMs: null,
      }}
      onRetry={vi.fn()}
      onRefresh={vi.fn()}
    />,
  );
  const next = view.container.querySelector('.connector-next') as HTMLElement;
  expect(within(next).getAllByRole('button')).toHaveLength(1);
  expect(within(next).getByRole('button', { name: action })).toBeVisible();
  // «Probar conexión» sigue disponible, como acción secundaria fuera del bloque.
  expect(screen.getAllByRole('button', { name: 'Probar conexión' })).toHaveLength(1);
  if (status !== 'error')
    expect(next).not.toContainElement(screen.getByRole('button', { name: 'Probar conexión' }));
});
