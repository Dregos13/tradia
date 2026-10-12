// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  LIVE_DECLARATION_REQUIREMENTS,
  liveConfirmationPhrase,
  type LiveLimits,
} from '../../../../shared/live';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { LiveLimitsSettings } from './LiveLimitsSettings';

let adapter: ReturnType<typeof createSimulatedAdapter>;
const limits: LiveLimits = {
  capitalUsd: 500,
  orderUsd: 100,
  dailyLossUsd: 10,
  openPositions: 1,
  shortOrderUsd: 100,
  shortExposureUsd: 200,
  shortPositions: 1,
};
beforeEach(() => {
  adapter = createSimulatedAdapter();
  window.tradia = adapter.api;
  adapter.emitConnectivity({
    status: 'online',
    lastCheckedAt: null,
    nextRetryAt: null,
    attempt: 0,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it('Ajustes guarda y confirma el corto, retiene el foco y lo devuelve al cancelar', async () => {
  await adapter.api.live.testKillSwitch();
  await adapter.api.delivery.test({ channel: 'telegram' });
  for (const requirement of LIVE_DECLARATION_REQUIREMENTS)
    await adapter.api.live.declare({
      requirement,
      confirmed: true,
      detail: 'Plan de contingencia revisado',
    });
  await adapter.api.live.connect({ apiKeyId: 'AKTESTKEY', apiSecret: 'test-secret' });
  await act(async () => {
    render(<LiveLimitsSettings />);
  });
  for (const [label, key] of [
    ['Capital total en real', 'capitalUsd'],
    ['Máximo por orden', 'orderUsd'],
    ['Pérdida diaria máxima', 'dailyLossUsd'],
    ['Posiciones abiertas simultáneas', 'openPositions'],
    ['Máximo por orden en corto', 'shortOrderUsd'],
    ['Exposición corta total máxima', 'shortExposureUsd'],
    ['Posiciones cortas simultáneas', 'shortPositions'],
  ] as const)
    fireEvent.change(screen.getByLabelText(label), { target: { value: String(limits[key]) } });
  await userEvent.click(screen.getByRole('button', { name: 'Guardar límites' }));
  const trigger = screen.getByRole('button', { name: 'Confirmar límites y activar dinero real' });
  await userEvent.click(trigger);
  const dialog = await screen.findByRole('alertdialog');
  await waitFor(() =>
    expect(
      within(dialog).getByRole('button', { name: 'Cancelar y seguir en paper' }),
    ).toHaveFocus(),
  );
  await userEvent.tab({ shift: true });
  await waitFor(() => expect(within(dialog).getByRole('textbox')).toHaveFocus());
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(trigger).toHaveFocus());
  await userEvent.click(trigger);
  fireEvent.change(screen.getByLabelText('Escribe exactamente esta frase para confirmar'), {
    target: { value: liveConfirmationPhrase(limits) },
  });
  await userEvent.click(
    screen.getByRole('button', { name: 'Activar dinero real con estos límites' }),
  );
  expect(await screen.findByText('Límites confirmados por escrito.')).toBeVisible();
  await waitFor(() =>
    expect(screen.getByText('Dinero real activado con los límites confirmados.')).toHaveFocus(),
  );
  expect((await adapter.api.live.state()).limits).toEqual(limits);
});
it('Ajustes conserva el borrador y muestra un error de guardado accesible', async () => {
  await adapter.api.live.setLimits(limits);
  await act(async () => {
    render(<LiveLimitsSettings />);
  });
  vi.spyOn(adapter.api.live, 'setLimits').mockRejectedValue(new Error('fallo IPC'));
  fireEvent.change(screen.getByLabelText('Máximo por orden en corto'), { target: { value: '50' } });
  await userEvent.click(screen.getByRole('button', { name: 'Guardar límites' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron guardar');
  expect(screen.getByLabelText('Máximo por orden en corto')).toHaveValue(50);
  expect(
    screen.getByRole('button', { name: 'Confirmar límites y activar dinero real' }),
  ).toBeDisabled();
});
