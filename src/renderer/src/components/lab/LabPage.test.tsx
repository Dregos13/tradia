// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSimulatedAdapter } from '../../adapters/simulated';
import { LabPage } from './LabPage';

beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
  window.location.hash = '#laboratorio';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Laboratorio', () => {
  it('lleva una idea a reglas, la prueba con el histórico y la lanza en vivo', async () => {
    const user = userEvent.setup();
    render(<LabPage />);
    expect(await screen.findByText('IA simulada')).toBeInTheDocument();
    expect(screen.getByText(/Todavía no hay ninguna/)).toBeInTheDocument();

    await user.type(
      screen.getByLabelText('Tu idea'),
      'Comprar rebotes con RSI en sobreventa en el SPY',
    );
    await user.click(screen.getByRole('button', { name: 'Generar estrategia' }));

    const draft = await screen.findByRole('article', { name: /Borrador: Rebote en sobreventa/ });
    expect(within(draft).getByText('rsi(2) < umbral y cierre > sma(200)')).toBeInTheDocument();
    expect(within(draft).getByText('Dónde puede fallar')).toBeInTheDocument();

    await user.type(within(draft).getByLabelText('¿Qué cambiarías?'), 'hazla más conservadora');
    await user.click(within(draft).getByRole('button', { name: 'Ajustar' }));
    expect(await screen.findByText('1.5 * atr(14)')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Probar con datos históricos' }));
    expect(await screen.findByText(/Así le habría ido/, {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText('Rentabilidad anual')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Informe completo' })).toHaveAttribute(
      'href',
      expect.stringMatching(/^#estrategias\/\d+\/backtest\/\d+$/),
    );

    const cash = screen.getByLabelText('Capital ficticio (USD)');
    await user.clear(cash);
    await user.type(cash, '500');
    expect(screen.getByRole('button', { name: 'Lanzar prueba en vivo' })).toBeDisabled();
    await user.clear(cash);
    await user.type(cash, '25000');
    await user.click(screen.getByRole('button', { name: 'Lanzar prueba en vivo' }));
    await vi.waitFor(() => expect(window.location.hash).toMatch(/^#laboratorio\/prueba\/\d+$/));
  });

  it('muestra el detalle de una prueba con su curva frente al SPY y permite detenerla', async () => {
    const user = userEvent.setup();
    const strategy = await window.tradia.strategies.create({
      name: 'Cruce rápido',
      hypothesis: 'Tendencia',
      rules: {
        entry: 'cruza_arriba(sma(5), sma(20))',
        exit: 'cruza_abajo(sma(5), sma(20))',
        stop: '2 * atr(14)',
        target: 'ninguno',
      },
      markets: ['QQQ'],
      parameters: {},
      regime: 'Tendencial',
    });
    const test = await window.tradia.forward.start({ strategyId: strategy.id });
    await act(async () => {
      window.location.hash = `#laboratorio/prueba/${test.id}`;
    });
    render(<LabPage />);
    expect(await screen.findByRole('heading', { name: 'Cruce rápido' })).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /Capital de la estrategia frente a SPY/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('Tu estrategia')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Detener prueba' }));
    await user.click(screen.getByRole('button', { name: 'Detener' }));
    expect(await screen.findByText(/hasta/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Detener prueba' })).not.toBeInTheDocument();
  });
});
