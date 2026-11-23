// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSimulatedAdapter } from '../../adapters/simulated';

// lightweight-charts necesita canvas real: en jsdom basta con un gráfico mudo.
vi.mock('./MesaChart', () => ({
  MesaChart: ({ label }: { label: string }) => <div role="img" aria-label={`Velas de ${label}`} />,
}));

const { MesaPage } = await import('./MesaPage');

beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
  window.location.hash = '#mesa';
});
afterEach(() => {
  cleanup();
});

describe('Mesa', () => {
  it('muestra las sesiones, pide seguir los activos y los lleva al Laboratorio', async () => {
    const user = userEvent.setup();
    render(<MesaPage />);
    for (const city of ['Tokio', 'Londres', 'Nueva York']) {
      expect(screen.getByText(city)).toBeInTheDocument();
    }
    // Nada se añade a la lista sin pedirlo.
    expect(await window.tradia.watchlist.list()).toEqual([]);
    await user.click(await screen.findByRole('button', { name: 'Seguir estos activos' }));
    const tickers = (await window.tradia.watchlist.list()).map((item) => item.ticker);
    expect(tickers).toEqual(expect.arrayContaining(['EURUSD', 'USDJPY', 'GBPUSD', 'GLD']));
    expect(tickers).not.toContain('SPY');

    const assets = screen.getByRole('region', { name: 'Activos' });
    await user.click(within(assets).getByRole('button', { name: /Oro/ }));
    expect(await screen.findByRole('img', { name: 'Velas de Oro' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Oro' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Escribir mi propia idea sobre Oro' }));
    expect(decodeURIComponent(window.location.hash)).toBe(
      '#laboratorio?idea=Estrategia sobre Oro (GLD): ',
    );
  });
});
