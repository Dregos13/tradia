// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  LIVE_ALL_DECLARATION_REQUIREMENTS,
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
  for (const requirement of LIVE_ALL_DECLARATION_REQUIREMENTS)
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
  await adapter.api.live.declare({ requirement: 'revision-legal-corto', confirmed: true });
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

it('un límite del corto vacío bloquea la confirmación aunque el guardado sea cero', async () => {
  await adapter.api.live.testKillSwitch();
  await adapter.api.delivery.test({ channel: 'telegram' });
  for (const requirement of LIVE_ALL_DECLARATION_REQUIREMENTS)
    await adapter.api.live.declare({ requirement, confirmed: true, detail: 'Plan revisado' });
  await adapter.api.live.connect({ apiKeyId: 'AKTESTKEY', apiSecret: 'test-secret' });
  await adapter.api.live.setLimits({ ...limits, shortOrderUsd: 0 });
  render(<LiveLimitsSettings />);
  const confirm = await screen.findByRole('button', {
    name: 'Confirmar límites y activar dinero real',
  });
  await waitFor(() => expect(confirm).toBeEnabled());
  const input = screen.getByLabelText('Máximo por orden en corto');
  fireEvent.change(input, { target: { value: '' } });
  expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(screen.getByRole('button', { name: 'Guardar límites' })).toBeDisabled();
  expect(confirm).toBeDisabled();
  expect(
    screen.queryByText(liveConfirmationPhrase({ ...limits, shortOrderUsd: 0 })),
  ).not.toBeInTheDocument();
  fireEvent.change(input, { target: { value: '0' } });
  expect(confirm).toBeEnabled();
});

it('bloquea solo el corto, conserva foco y permite guardar el largo con los tres ceros', async () => {
  const save = vi.spyOn(adapter.api.live, 'setLimits');
  render(<LiveLimitsSettings />);
  await screen.findByRole('heading', { name: 'Revisión legal y fiscal específica del corto' });
  const input = screen.getByLabelText('Máximo por orden en corto');
  expect(input).not.toBeDisabled();
  expect(input).toHaveAttribute('readonly');
  expect(input).toHaveAttribute('aria-disabled', 'true');
  expect(input).toHaveAccessibleDescription(/No has declarado|Falta|Completa/);
  input.focus();
  expect(input).toHaveFocus();
  await userEvent.keyboard('100');
  expect(input).toHaveValue(0);
  for (const [label, value] of [
    ['Capital total en real', '500'],
    ['Máximo por orden', '100'],
    ['Pérdida diaria máxima', '10'],
    ['Posiciones abiertas simultáneas', '1'],
  ] as const)
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  await userEvent.click(screen.getByRole('button', { name: 'Guardar límites' }));
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith({
      ...limits,
      shortOrderUsd: 0,
      shortExposureUsd: 0,
      shortPositions: 0,
    }),
  );
});

it('guarda la declaración específica y desbloquea los campos al releer evidencia paper', async () => {
  const declare = vi.spyOn(adapter.api.live, 'declare');
  render(<LiveLimitsSettings />);
  const section = await screen.findByRole('region', {
    name: 'Preparación del corto con dinero real',
  });
  const checkbox = await within(section).findByRole('checkbox', { name: /CNMV\/MiFID II.*IRPF/ });
  await userEvent.click(checkbox);
  await userEvent.click(within(section).getByRole('button', { name: 'Guardar declaración' }));
  await waitFor(() =>
    expect(declare).toHaveBeenCalledWith({
      requirement: 'revision-legal-corto',
      confirmed: true,
      detail: '',
    }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText('Máximo por orden en corto')).not.toHaveAttribute('readonly'),
  );
  expect(within(section).getByRole('link', { name: 'Ver órdenes paper' })).toHaveAttribute(
    'href',
    '#ordenes?modo=paper',
  );
});

it('conserva los límites confirmados al retirar la declaración y bloquea guardado y confirmación', async () => {
  await adapter.api.live.declare({ requirement: 'revision-legal-corto', confirmed: true });
  await adapter.api.live.setLimits(limits);
  render(<LiveLimitsSettings />);
  await waitFor(() => expect(screen.getByLabelText('Máximo por orden en corto')).toHaveValue(100));
  const save = vi.spyOn(adapter.api.live, 'setLimits');
  const checkbox = screen.getByRole('checkbox', { name: /CNMV\/MiFID II.*IRPF/ });
  await userEvent.click(checkbox);
  await userEvent.click(screen.getByRole('button', { name: 'Guardar retirada de declaración' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Máximo por orden en corto')).toHaveAttribute('readonly'),
  );
  expect(screen.getByText(/Tus límites del corto siguen guardados/)).toBeVisible();
  expect(screen.getByLabelText('Máximo por orden en corto')).toHaveValue(100);
  expect(screen.getByRole('button', { name: 'Guardar límites' })).toBeDisabled();
  expect(
    screen.getByRole('button', { name: 'Confirmar límites y activar dinero real' }),
  ).toBeDisabled();
  fireEvent.submit(screen.getByLabelText('Máximo por orden en corto').closest('form')!);
  expect(save).not.toHaveBeenCalled();
  expect((await adapter.api.live.checklist()).limits.limits).toEqual(limits);
});

it('muestra literalmente el rechazo del proceso principal y conserva el borrador', async () => {
  await adapter.api.live.declare({ requirement: 'revision-legal-corto', confirmed: true });
  await adapter.api.live.setLimits(limits);
  render(<LiveLimitsSettings />);
  await waitFor(() => expect(screen.getByLabelText('Máximo por orden en corto')).toHaveValue(100));
  vi.spyOn(adapter.api.live, 'setLimits').mockRejectedValue(
    new Error('[corto-requisitos] Evidencia paper vencida.'),
  );
  fireEvent.change(screen.getByLabelText('Máximo por orden en corto'), { target: { value: '50' } });
  await userEvent.click(screen.getByRole('button', { name: 'Guardar límites' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '[corto-requisitos] Evidencia paper vencida.',
  );
  expect(screen.getByLabelText('Máximo por orden en corto')).toHaveValue(50);
});

it('una lectura fallida bloquea los campos cortos y ofrece reintento', async () => {
  vi.spyOn(adapter.api.live, 'checklist').mockRejectedValueOnce(new Error('lectura'));
  render(<LiveLimitsSettings />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo verificar');
  expect(screen.getByLabelText('Máximo por orden en corto')).toHaveAttribute('readonly');
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar comprobación' }));
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
});

it('la declaración legal general no sustituye la específica y paper pendiente mantiene el bloqueo', async () => {
  await adapter.api.live.declare({ requirement: 'revision-legal', confirmed: true });
  const checklist = await adapter.api.live.checklist();
  checklist.short.items = checklist.short.items.map((item) =>
    item.requirement === 'paper-cortos'
      ? {
          ...item,
          state: 'pendiente',
          evidence:
            '2 de 5 cortos cerrados · 1 de 4 semanas · sin descuadres de paper abiertos en el periodo',
        }
      : item,
  );
  checklist.short.allComplete = false;
  checklist.short.blockReason = 'Faltan semanas y cortos cerrados en paper.';
  vi.spyOn(adapter.api.live, 'checklist').mockResolvedValue(checklist);
  render(<LiveLimitsSettings />);
  await screen.findByText(
    '1 de 4 semanas · 2 de 5 cortos cerrados · sin descuadres de paper abiertos en el periodo',
  );
  expect(screen.getByRole('checkbox', { name: /CNMV\/MiFID II.*IRPF/ })).not.toBeChecked();
  expect(screen.getByLabelText('Máximo por orden en corto')).toHaveAttribute('readonly');
});
