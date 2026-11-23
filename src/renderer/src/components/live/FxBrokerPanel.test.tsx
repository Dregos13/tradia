// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { FxBrokerPanel } from './FxBrokerPanel';

const TOKEN = '0123456789abcdef0123456789abcdef-fedcba9876543210fedcba9876543210';

beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
});
afterEach(() => cleanup());

async function mount() {
  await act(async () => {
    render(<FxBrokerPanel />);
  });
}

it('explica en claro qué es OANDA y bloquea la cuenta real sin la lista', async () => {
  await mount();
  expect(screen.getByRole('heading', { name: 'Divisas y oro con OANDA' })).toBeInTheDocument();
  expect(screen.getByText(/es dinero simulado, así que no arriesgas nada/)).toBeInTheDocument();
  expect(
    screen.getByText(/Se desbloquea cuando completes la lista de comprobación/),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Hacer orden de prueba en práctica' })).toBeDisabled();
});

it('avisa si la cuenta es real en la ranura de práctica sin enviarla', async () => {
  await mount();
  await userEvent.type(screen.getByLabelText('Número de cuenta'), '001-004-1234567-001');
  await userEvent.type(screen.getByLabelText('Token de acceso (API)'), TOKEN);
  await userEvent.click(screen.getByRole('button', { name: 'Conectar cuenta de práctica' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Esa cuenta es real');
});

it('conecta la práctica, enseña el saldo y hace la orden mínima de prueba', async () => {
  await mount();
  await userEvent.type(screen.getByLabelText('Número de cuenta'), '101-004-1234567-001');
  await userEvent.type(screen.getByLabelText('Token de acceso (API)'), TOKEN);
  await userEvent.click(screen.getByRole('button', { name: 'Conectar cuenta de práctica' }));
  const account = await screen.findByLabelText('Saldo de práctica');
  expect(within(account).getAllByText('100,00 EUR')).toHaveLength(2);
  expect(screen.getByText('Cuenta de práctica conectada.')).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: 'Hacer orden de prueba en práctica' }));
  const result = await screen.findByRole('status', { name: 'Resultado de la orden de prueba' });
  expect(result).toHaveTextContent('Orden de prueba correcta');
  expect(result).toHaveTextContent('Cuentas cuadradas con OANDA');
});

it('valida los límites en euros contra los techos', async () => {
  await mount();
  const capital = screen.getByLabelText('Capital para divisas (€)');
  await userEvent.clear(capital);
  await userEvent.type(capital, '20');
  expect(screen.getByText('El capital debe estar entre 50 € y 500 €.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Guardar mis límites en euros' })).toBeDisabled();
});
