// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSimulatedAdapter } from '../../adapters/simulated';
import { SummaryPage } from './SummaryPage';

beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
});
afterEach(() => cleanup());

describe('Resumen', () => {
  it('sin pruebas explica los tres pasos y lleva a Mercado y a Crear', async () => {
    render(<SummaryPage />);
    expect(await screen.findByRole('heading', { name: 'Empieza en tres pasos' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Ir al mercado' })).toHaveAttribute('href', '#mesa');
    expect(screen.getByRole('link', { name: 'Crear estrategia' })).toHaveAttribute(
      'href',
      '#laboratorio',
    );
  });

  it('con una prueba en vivo muestra cifras, el tablero y los siguientes pasos', async () => {
    const strategy = await window.tradia.strategies.create({
      name: 'Ruptura EUR/USD',
      hypothesis: 'Las rupturas continúan',
      rules: {
        entry: 'cierre > maximo(20)',
        exit: 'cierre < minimo(10)',
        stop: '2 * atr(14)',
        target: 'ninguno',
      },
      markets: ['EURUSD'],
      parameters: {},
      regime: 'Tendencial',
    });
    await window.tradia.forward.start({ strategyId: strategy.id });
    render(<SummaryPage />);
    expect(await screen.findByText('En prueba ahora')).toBeVisible();
    expect(screen.getByText('1 estrategia creada')).toBeVisible();
    expect(await screen.findByRole('link', { name: 'Ruptura EUR/USD' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Qué hacer ahora' })).toBeVisible();
  });
});
