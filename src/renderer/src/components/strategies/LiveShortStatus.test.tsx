// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { LiveShortStatus } from './LiveShortStatus';

beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it.each([0, 50])(
  'con límites confirmados de %s USD muestra el estado del corto',
  async (shortOrderUsd) => {
    const state = await window.tradia.live.state();
    vi.spyOn(window.tradia.live, 'state').mockResolvedValue({
      ...state,
      limits: {
        capitalUsd: 500,
        orderUsd: 100,
        dailyLossUsd: 10,
        openPositions: 1,
        shortOrderUsd,
        shortExposureUsd: 100,
        shortPositions: 1,
      },
    });
    render(<LiveShortStatus />);
    expect(
      await screen.findByText(
        shortOrderUsd ? /Corto con dinero real permitido/ : /Corto con dinero real desactivado/,
      ),
    ).toBeVisible();
    if (shortOrderUsd)
      expect(screen.getByText(/permitido/)).toHaveTextContent(
        '50,00 USD por orden, 100,00 USD de exposición total',
      );
    expect(screen.getByRole('link')).toHaveAttribute('href', '#dinero-real');
  },
);
it('carga sin asumir permiso y permite reintentar tras un error', async () => {
  vi.spyOn(window.tradia.live, 'state').mockRejectedValueOnce(new Error('sin lectura'));
  render(<LiveShortStatus />);
  expect(screen.getByRole('status')).toHaveTextContent('Comprobando límites');
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo comprobar');
  await act(async () => {
    screen.getByRole('button').click();
  });
  expect(await screen.findByText(/Corto con dinero real desactivado/)).toBeVisible();
});
