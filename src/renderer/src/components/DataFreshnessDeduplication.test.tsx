// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DataFreshnessSummary } from '../../../shared/ipc';
import { createSimulatedAdapter } from '../adapters/simulated';
import { ProviderBanner } from './ProviderBanner';
import { freshnessTitle, STALE_PAUSE_TEXT } from './DataFreshness';
import { Dashboard } from './dashboard/Dashboard';
import { MarketDataPage } from './MarketDataPage';
import { AiPage } from './ai/AiPage';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(['stale', 'unreliable', 'catching-up'] as const)(
  'el estado %s conserva un solo aviso accionable y chips sin anuncios duplicados',
  async (state) => {
    const simulation = createSimulatedAdapter();
    window.tradia = simulation.api;
    const summary: DataFreshnessSummary = {
      state,
      sinceDate: '2026-09-25',
      expectedSessionDate: '2026-09-28',
      missingSessions: 1,
      items: [
        {
          key: 'ticker:AAPL',
          label: 'AAPL',
          state:
            state === 'stale'
              ? 'desactualizado'
              : state === 'unreliable'
                ? 'no-fiable'
                : 'actualizando',
          lastDataDate: '2026-09-25',
          reason: 'Faltan datos verificados de AAPL.',
        },
      ],
      uncovered: [],
      updatedAt: '2026-09-28T20:00:00Z',
    };
    vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue(summary);
    render(
      <>
        <ProviderBanner />
        <Dashboard
          system={{ connectivity: null, agents: null, connectionError: false, agentsError: false }}
        />
        <MarketDataPage kind="mercado" />
        <AiPage />
      </>,
    );
    const banner = await screen.findByRole('region', { name: 'Estado de los datos' });
    await waitFor(() =>
      expect(screen.getAllByRole('group', { name: 'Frescura de datos' })).toHaveLength(3),
    );
    for (const chip of screen.getAllByRole('group', { name: 'Frescura de datos' })) {
      expect(chip).toHaveTextContent(freshnessTitle(summary));
      expect(within(chip).queryAllByRole('button')).toHaveLength(0);
      expect(within(chip).queryAllByRole('link')).toHaveLength(0);
      expect(within(chip).queryAllByRole('status')).toHaveLength(0);
      expect(within(chip).queryByText('Por qué ocurre')).not.toBeInTheDocument();
    }
    expect(screen.getAllByText('Por qué ocurre')).toHaveLength(1);
    const actions = state === 'catching-up' ? 0 : 1;
    expect(screen.queryAllByRole('button', { name: 'Actualizar ahora' })).toHaveLength(actions);
    expect(screen.queryAllByRole('link', { name: 'Probar conexión' })).toHaveLength(actions);
    if (state === 'stale') expect(within(banner).getByText(STALE_PAUSE_TEXT)).toBeVisible();
    else expect(screen.queryByText(STALE_PAUSE_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText('Datos actualizados.')).not.toBeInTheDocument();
  },
);
