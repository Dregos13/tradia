// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRisk } from '../../hooks/useRisk';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { KillSwitchControl } from './KillSwitchControl';
import App from '../../App';
import { RISK_DISCLAIMER_VERSION } from '../../../../shared/riskDisclaimer';

function Harness() {
  const risk = useRisk();
  return (
    <div className="app">
      <KillSwitchControl state={risk.killSwitch} onChange={risk.updateKillSwitch} />
      <div id="risk-global-banner" />
    </div>
  );
}
beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('activa de inmediato sin confirmación y muestra causa, hora y autor', async () => {
  const user = userEvent.setup();
  const activate = vi.spyOn(window.tradia.risk, 'activateKillSwitch');
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Parada' }));
  expect(activate).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent(
    /Parada activa: Parada manual.*Activada por Tú/,
  );
  expect(screen.getByRole('button', { name: 'Parada activa' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(screen.getByRole('link', { name: 'Ver en Riesgo' })).toHaveAttribute('href', '#riesgo');
});

it('no reanuda al cancelar o pulsar Escape y devuelve el foco al disparador', async () => {
  await window.tradia.risk.activateKillSwitch();
  const resume = vi.spyOn(window.tradia.risk, 'resumeKillSwitch');
  const user = userEvent.setup();
  render(<Harness />);
  const trigger = await screen.findByRole('button', { name: 'Parada activa' });
  await user.click(trigger);
  expect(screen.getByRole('button', { name: 'Mantener parada' })).toHaveFocus();
  await user.keyboard('{Shift>}{Tab}{/Shift}');
  expect(screen.getByRole('button', { name: 'Confirmar y reanudar' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Mantener parada' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Mantener parada' }));
  expect(trigger).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Reanudar' }));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(resume).not.toHaveBeenCalled();
  expect((await window.tradia.risk.getKillSwitch()).active).toBe(true);
});

it('solo reanuda tras confirmar explícitamente', async () => {
  await window.tradia.risk.activateKillSwitch();
  const resume = vi.spyOn(window.tradia.risk, 'resumeKillSwitch');
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(await screen.findByRole('button', { name: 'Reanudar' }));
  expect(resume).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Confirmar y reanudar' }));
  expect(resume).toHaveBeenCalledWith({ confirm: true });
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Parada' })).toHaveFocus());
});

it('mantiene parada y diálogo si falla la reanudación y permite reintentar', async () => {
  await window.tradia.risk.activateKillSwitch();
  const resume = vi
    .spyOn(window.tradia.risk, 'resumeKillSwitch')
    .mockRejectedValueOnce(new Error('IPC'));
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(await screen.findByRole('button', { name: 'Reanudar' }));
  await user.click(screen.getByRole('button', { name: 'Confirmar y reanudar' }));
  expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
    'No se pudo reanudar. La parada sigue activa.',
  );
  expect((await window.tradia.risk.getKillSwitch()).active).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Confirmar y reanudar' }));
  expect(resume).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('deshabilita acciones durante la petición de reanudación', async () => {
  await window.tradia.risk.activateKillSwitch();
  let finish!: (value: Awaited<ReturnType<typeof window.tradia.risk.getKillSwitch>>) => void;
  vi.spyOn(window.tradia.risk, 'resumeKillSwitch').mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(await screen.findByRole('button', { name: 'Reanudar' }));
  await user.click(screen.getByRole('button', { name: 'Confirmar y reanudar' }));
  expect(
    within(screen.getByRole('dialog')).getByRole('button', { name: 'Reanudando…' }),
  ).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  const state = await window.tradia.risk.getKillSwitch();
  await act(async () => finish({ ...state, active: false }));
});

it('muestra el error de activación y deja disponible un nuevo intento', async () => {
  vi.spyOn(window.tradia.risk, 'activateKillSwitch').mockRejectedValueOnce(new Error('IPC'));
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Parada' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo activar la parada');
  await user.click(screen.getByRole('button', { name: 'Parada' }));
  expect(await screen.findByRole('button', { name: 'Parada activa' })).toBeEnabled();
});

it('monta la ruta Riesgo y conserva la parada global al navegar', async () => {
  await window.tradia.settings.set({ disclaimerAcceptedVersion: RISK_DISCLAIMER_VERSION });
  await window.tradia.risk.activateKillSwitch();
  window.location.hash = '#riesgo';
  render(<App />);
  expect(await screen.findByRole('heading', { name: 'Control de riesgo' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Riesgo' })).toHaveAttribute('aria-current', 'page');
  expect(await screen.findByRole('alert')).toHaveTextContent('Parada manual');
  await act(async () => {
    window.location.hash = '#inicio';
    window.dispatchEvent(new Event('hashchange'));
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('Parada manual');
});
