// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import type { Signal } from '../../../../shared/signals';
import { FX_ANALYSIS_ONLY_REASON } from '../../../../shared/fxTrading';
import type { SystemState } from '../../hooks/useSystemState';
import { Dashboard } from './Dashboard';
import { portfolio, signal, strategies } from './testFixtures';

const system: SystemState = {
  connectivity: null,
  agents: null,
  connectionError: false,
  agentsError: false,
};
const fxSignal: Signal = {
  ...signal,
  id: 7,
  ticker: 'EURUSD',
  entry: 1.0842,
  stop: 1.0542,
  target: 1.1442,
};
const jpySignal: Signal = {
  ...signal,
  id: 8,
  ticker: 'USDJPY',
  decision: { ...signal.decision, status: 'vetada', size: 0 },
  destination: 'solo-analisis',
  destinationReason: FX_ANALYSIS_ONLY_REASON,
};
beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
  vi.spyOn(window.tradia.signals, 'list').mockResolvedValue([fxSignal, jpySignal]);
  vi.spyOn(window.tradia.signals, 'strategies').mockResolvedValue(strategies);
  vi.spyOn(window.tradia.journal, 'list').mockResolvedValue({
    entries: [],
    total: 0,
    limit: 20,
    offset: 0,
  });
  vi.spyOn(window.tradia.risk, 'getPortfolio').mockResolvedValue({
    ...portfolio,
    positions: [
      {
        id: 3,
        ticker: 'EURUSD',
        direction: 'largo',
        size: 1500,
        entry: 1.0842,
        markPrice: 1.0901,
        pnl: 8.85,
        pnlPct: 0.54,
        sector: 'divisas',
        currency: 'EUR',
        signalId: 7,
        openedAt: fxSignal.createdAt,
      },
    ],
    exposureByAsset: [{ key: 'EURUSD', notional: 1635, pct: 16.35, limitPct: 20 }],
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('la señal aprobada de EUR/USD se opera en la cartera simulada, sin bróker ni dinero real', async () => {
  render(<Dashboard system={system} />);
  const signals = screen.getByRole('region', { name: 'Señales vivas' });
  const item = (await within(signals).findByText('EUR/USD')).closest('li')!;
  expect(item).toHaveTextContent('Divisa · 24/5 · cartera simulada.');
  expect(item).toHaveTextContent('Se opera en la cartera simulada.');
  expect(item).not.toHaveTextContent('Si Riesgo la aprueba');
  expect(item).toHaveTextContent(
    'No va al bróker ni usa dinero real. El bróker conectado no opera divisas; se opera solo en la cartera simulada.',
  );
  expect(item.textContent).not.toContain('divisas: se opera');
  expect(within(item).queryAllByRole('button')).toHaveLength(0);
  expect(
    within(item)
      .getAllByRole('link')
      .map((link) => link.textContent),
  ).toEqual(['Ver en Diario · EUR/USD']);
});

it('una señal vetada de EUR/USD dice que Riesgo la vetó, sin condicional', async () => {
  vi.spyOn(window.tradia.signals, 'list').mockResolvedValue([
    {
      ...fxSignal,
      decision: {
        ...fxSignal.decision,
        status: 'vetada',
        size: 0,
        reasons: [{ code: 'exposicion', message: 'Supera la exposición máxima' }] as never,
      },
    },
  ]);
  render(<Dashboard system={system} />);
  const signals = screen.getByRole('region', { name: 'Señales vivas' });
  const item = (await within(signals).findByText('EUR/USD')).closest('li')!;
  expect(item).toHaveTextContent('Riesgo la vetó: Supera la exposición máxima.');
  expect(item).not.toHaveTextContent('Si Riesgo la aprueba');
  expect(item).not.toHaveTextContent('Se opera en la cartera simulada. No va');
});

it('USD/JPY sale como solo análisis con su motivo', async () => {
  render(<Dashboard system={system} />);
  const signals = screen.getByRole('region', { name: 'Señales vivas' });
  const item = (await within(signals).findByText('USD/JPY')).closest('li')!;
  expect(item).toHaveTextContent('Divisa · 24/5 · solo análisis.');
  expect(item).toHaveTextContent(`No abre posición: ${FX_ANALYSIS_ONLY_REASON}.`);
  expect(within(item).queryAllByRole('button')).toHaveLength(0);
});

it('la posición de EUR/USD aparece en la cartera simulada con el tamaño en EUR y el P&L en USD', async () => {
  render(<Dashboard system={system} />);
  const positions = screen.getByRole('region', { name: 'Posiciones simuladas' });
  const item = (await within(positions).findByText('EUR/USD')).closest('li')!;
  expect(item).toHaveTextContent('Divisa · 24/5 · cartera simulada');
  expect(item).toHaveTextContent(/Tamaño\s*1[.\s]?500 EUR/);
  expect(item).toHaveTextContent('1,08420 USD');
  expect(item).toHaveTextContent('1,09010 USD');
  expect(item).toHaveTextContent(/\+8,85 USD/);
  expect(within(positions).queryByRole('button', { name: /bróker|dinero real/i })).toBeNull();
  const exposure = screen.getByRole('region', { name: 'Exposición' });
  expect(await within(exposure).findByText('EUR/USD')).toBeVisible();
});
