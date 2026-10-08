// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App';
import { createSimulatedAdapter } from '../adapters/simulated';
import { RISK_DISCLAIMER_VERSION } from '../../../shared/riskDisclaimer';

beforeEach(() => {
  window.location.hash = '';
  window.tradia = createSimulatedAdapter().api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('bloquea la navegación y enfoca el aviso hasta aceptar con teclado', async () => {
  const user = userEvent.setup();
  const save = vi.spyOn(window.tradia.settings, 'set');
  render(<App />);
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  expect(await screen.findByRole('heading', { name: 'Antes de empezar' })).toHaveFocus();
  const button = screen.getByRole('button', { name: 'Continuar' });
  expect(button).toBeDisabled();
  await user.tab();
  expect(screen.getByRole('checkbox', { name: 'He leído y acepto' })).toHaveFocus();
  await user.keyboard(' ');
  await user.tab();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('navigation')).toBeInTheDocument();
  expect(save).toHaveBeenCalledWith({ disclaimerAcceptedVersion: RISK_DISCLAIMER_VERSION });
  expect((await window.tradia.settings.get()).disclaimerAcceptedAt).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  cleanup();
  render(<App />);
  expect(await screen.findByRole('navigation')).toBeInTheDocument();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
});

it('vuelve a solicitar aceptación si la versión aceptada no coincide', async () => {
  await window.tradia.settings.set({ disclaimerAcceptedVersion: '0.9' });
  window.location.hash = '#ajustes';
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Antes de empezar' })).toBeInTheDocument();
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Continuar' })).toBeDisabled();
});

it('mantiene el bloqueo durante la carga y permite reintentar una consulta fallida', async () => {
  const user = userEvent.setup();
  vi.spyOn(window.tradia.settings, 'get').mockRejectedValueOnce(new Error('IPC'));
  render(<App />);
  expect(screen.getByRole('status')).toHaveTextContent('Cargando ajustes');
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
  expect(await screen.findByRole('heading', { name: 'Antes de empezar' })).toBeInTheDocument();
});

it('no desbloquea durante el guardado ni ante un error y permite reintentar', async () => {
  const user = userEvent.setup();
  let reject!: (error: Error) => void;
  vi.spyOn(window.tradia.settings, 'set').mockImplementationOnce(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  render(<App />);
  await user.click(await screen.findByRole('checkbox'));
  await user.click(screen.getByRole('button', { name: 'Continuar' }));
  expect(screen.getByRole('button', { name: 'Guardando…' })).toBeDisabled();
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  reject(new Error('SQLite'));
  expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos guardar');
  await user.click(screen.getByRole('button', { name: 'Continuar' }));
  expect(await screen.findByRole('navigation')).toBeInTheDocument();
});

it('abre el aviso en Legal sin controles de aceptación y restaura el foco', async () => {
  const user = userEvent.setup();
  await window.tradia.settings.set({ disclaimerAcceptedVersion: RISK_DISCLAIMER_VERSION });
  const save = vi.spyOn(window.tradia.settings, 'set');
  window.location.hash = '#ajustes';
  render(<App />);
  const open = await screen.findByRole('button', { name: /Ver aviso de riesgo/ });
  await user.click(open);
  expect(screen.getByRole('heading', { name: 'Aviso de riesgo' })).toHaveFocus();
  expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Continuar' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Volver a Ajustes' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: /Ver aviso de riesgo/ })).toHaveFocus(),
  );
  expect(save).not.toHaveBeenCalled();
});
