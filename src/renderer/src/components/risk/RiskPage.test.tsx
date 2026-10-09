// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { useRisk } from '../../hooks/useRisk';
import { RiskPage } from './RiskPage';
import { LimitsForm } from './LimitsForm';
import { CautionBanner } from './CautionBanner';
import { RISK_DEFAULTS, type RiskDecision } from '../../../../shared/risk';
function Harness() {
  return <RiskPage risk={useRisk()} />;
}
beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function fillSignal(target = '110', stop = '90') {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Activo'), 'AAPL');
  await user.type(screen.getByLabelText('Entrada'), '100');
  if (stop) await user.type(screen.getByLabelText('Stop (vacío: sin stop)'), stop);
  await user.type(screen.getByLabelText('Objetivo (opcional)'), target);
  await user.type(screen.getByLabelText('Confianza (0–1)'), '0.8');
  return user;
}
it('muestra valores prudentes y márgenes al abrir', async () => {
  render(<Harness />);
  expect(await screen.findByLabelText('Riesgo por operación (%)')).toHaveValue('0.5');
  expect(screen.getByLabelText('Beneficio/riesgo mínimo')).toHaveValue('2');
  expect(screen.getByLabelText('Pérdida diaria (%)')).toHaveValue('2');
  expect(screen.getByLabelText('Pérdida semanal (%)')).toHaveValue('4');
  expect(screen.getByLabelText('Pérdida mensual (%)')).toHaveValue('6');
  expect(screen.getByText('Predeterminado: 0,5 % · Margen: 0,5 %–2 %')).toBeVisible();
  expect(screen.getByLabelText('Apalancamiento fijo')).toHaveAttribute('readonly');
  expect(screen.getByText('Todavía no hay vetos')).toBeVisible();
});
it('rechaza riesgo 3 % y ratio 1:1,5 en línea y conserva los valores', async () => {
  const user = userEvent.setup();
  const save = vi.spyOn(window.tradia.risk, 'setLimits');
  render(<LimitsForm limits={RISK_DEFAULTS} />);
  const risk = screen.getByLabelText('Riesgo por operación (%)');
  await user.clear(risk);
  await user.type(risk, '3');
  expect(risk).toHaveAttribute('aria-invalid', 'true');
  expect(risk).toHaveAccessibleDescription(/Introduce un valor entre 0,5 y 2/);
  const ratio = screen.getByLabelText('Beneficio/riesgo mínimo');
  await user.clear(ratio);
  await user.type(ratio, '1,5');
  expect(ratio).toHaveAttribute('aria-invalid', 'true');
  expect(ratio).toHaveValue('1,5');
  expect(screen.getByRole('button', { name: 'Guardar límites' })).toBeDisabled();
  expect(save).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Restablecer valores prudentes' }));
  expect(risk).toHaveValue('0.5');
  expect(ratio).toHaveValue('2');
  await user.click(screen.getByRole('button', { name: 'Guardar límites' }));
  expect(save).toHaveBeenCalledWith(RISK_DEFAULTS);
  expect(await screen.findByText('Límites guardados')).toBeVisible();
});
it('rechaza posiciones fraccionarias y campos vacíos', async () => {
  const user = userEvent.setup();
  render(<LimitsForm limits={RISK_DEFAULTS} />);
  const positions = screen.getByLabelText('Posiciones abiertas');
  await user.clear(positions);
  await user.type(positions, '2.5');
  expect(positions).toHaveAttribute('aria-invalid', 'true');
  await user.clear(screen.getByLabelText('Pérdida diaria (%)'));
  expect(screen.getByRole('button', { name: 'Guardar límites' })).toBeDisabled();
});
it('muestra tal cual el error del proceso principal y permite reintentar', async () => {
  const user = userEvent.setup();
  vi.spyOn(window.tradia.risk, 'setLimits').mockRejectedValueOnce(
    new Error('Error exacto del proceso principal.'),
  );
  render(<LimitsForm limits={RISK_DEFAULTS} />);
  await user.click(screen.getByRole('button', { name: 'Guardar límites' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Error exacto del proceso principal.');
  await user.click(screen.getByRole('button', { name: 'Guardar límites' }));
  expect(await screen.findByText('Límites guardados')).toBeVisible();
});
it('una señal 1:1 crea un veto visible en directo con motivo, regla y valores', async () => {
  const list = vi.spyOn(window.tradia.risk, 'listVetoes');
  const submit = vi.spyOn(window.tradia.risk, 'submitSignal');
  render(<Harness />);
  await screen.findByText('Todavía no hay vetos');
  const user = await fillSignal();
  await user.click(screen.getByRole('button', { name: 'Evaluar señal' }));
  const table = await screen.findByRole('table');
  expect(within(table).getByText('Beneficio/riesgo por debajo del mínimo')).toBeVisible();
  expect(within(table).getByText('RR_TOO_LOW')).toBeVisible();
  expect(within(table).getByText('AAPL')).toBeVisible();
  expect(within(table).getByText('ratio')).toBeVisible();
  expect(within(table).getByText('minimo')).toBeVisible();
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({ origin: 'probador', entry: 100, stop: 90, target: 110 }),
  );
  expect(list).toHaveBeenCalledOnce();
  await user.selectOptions(screen.getByLabelText('Filtrar por regla'), 'STOP_MISSING');
  expect(screen.getByText('No hay vetos para esta regla')).toBeVisible();
  await user.selectOptions(screen.getByLabelText('Filtrar por regla'), 'RR_TOO_LOW');
  expect(screen.getByRole('table')).toBeVisible();
});
it('sin stop llega al motor y registra STOP_MISSING', async () => {
  render(<Harness />);
  await screen.findByText('Todavía no hay vetos');
  const user = await fillSignal('120', '');
  await user.click(screen.getByRole('button', { name: 'Evaluar señal' }));
  expect(
    within(await screen.findByRole('table')).getByText('La señal no tiene stop de protección'),
  ).toBeVisible();
});
it('muestra aprobada con el tamaño devuelto por el motor', async () => {
  render(<Harness />);
  const user = await fillSignal('120');
  await user.click(screen.getByRole('button', { name: 'Evaluar señal' }));
  expect(await screen.findByText('Aprobada · Simulación')).toBeVisible();
  expect(screen.getByText(/Tamaño: 50 unidades/)).toBeVisible();
});
it('valida el formulario simulado sin enviar datos inválidos', async () => {
  const submit = vi.spyOn(window.tradia.risk, 'submitSignal');
  const user = userEvent.setup();
  render(<Harness />);
  await user.click(screen.getByRole('button', { name: 'Evaluar señal' }));
  expect(screen.getByLabelText('Entrada')).toHaveAttribute('aria-invalid', 'true');
  expect(submit).not.toHaveBeenCalled();
});
it('muestra evaluando, reducción y motivos sin afirmar ejecución', async () => {
  let resolve!: (value: RiskDecision) => void;
  vi.spyOn(window.tradia.risk, 'submitSignal').mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<Harness />);
  const user = await fillSignal('120');
  await user.click(screen.getByRole('button', { name: 'Evaluar señal' }));
  expect(screen.getByRole('button', { name: 'Evaluando…' })).toBeDisabled();
  await act(async () =>
    resolve({
      status: 'reducida',
      size: 25,
      sizeFactor: 0.5,
      riskAmount: 250,
      notional: 2500,
      decidedAt: new Date().toISOString(),
      reasons: [{ code: 'CAUTION_MODE', message: 'Modo cautela', details: { evento: 'VIX 35' } }],
    }),
  );
  expect(screen.getByText('Reducida · Simulación')).toBeVisible();
  expect(screen.getByText('VIX 35')).toBeVisible();
});
it('muestra error de evaluación y permite recuperar', async () => {
  vi.spyOn(window.tradia.risk, 'submitSignal').mockRejectedValueOnce(
    new Error('No se pudo evaluar.'),
  );
  render(<Harness />);
  const user = await fillSignal('120');
  await user.click(screen.getByRole('button', { name: 'Evaluar señal' }));
  expect(await screen.findByText('No se pudo evaluar.')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Evaluar señal' }));
  expect(await screen.findByText('Aprobada · Simulación')).toBeVisible();
});
it('cubre carga, fallo de lectura y reintento', async () => {
  vi.spyOn(window.tradia.risk, 'getLimits').mockRejectedValueOnce(new Error('IPC'));
  render(<Harness />);
  expect(screen.getByText('Cargando estado de riesgo…')).toBeVisible();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Reintentar' })).toBeVisible());
  await userEvent.setup().click(screen.getByRole('button', { name: 'Reintentar' }));
  expect(await screen.findByLabelText('Riesgo por operación (%)')).toBeVisible();
});
it('cautela muestra evento, efecto y vencimiento; se oculta si está inactiva', () => {
  const caution = {
    active: true,
    effect: 'bloquear' as const,
    sizeFactor: 0,
    cause: 'alto-impacto' as const,
    eventTitle: 'IPC EE. UU.',
    until: '2026-10-09T14:00:00Z',
  };
  const view = render(<CautionBanner caution={caution} />);
  expect(screen.getByRole('status')).toHaveTextContent('IPC EE. UU. · Entradas bloqueadas');
  expect(screen.getByText(/Hasta/)).toBeVisible();
  view.rerender(<CautionBanner caution={{ ...caution, effect: 'reducir', sizeFactor: 0.5 }} />);
  expect(screen.getByRole('status')).toHaveTextContent('Tamaño × 0,5');
  view.rerender(<CautionBanner caution={{ ...caution, active: false }} />);
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
