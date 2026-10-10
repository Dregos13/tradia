// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DeviationPeriod, DeviationReport } from '../../../../shared/broker';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { DeviationPage } from './DeviationPage';

function fixture(period: DeviationPeriod): DeviationReport {
  return {
    period,
    marginPp: 2,
    maxSlippageBps: 10,
    generatedAt: '2026-10-01T11:10:00Z',
    rows: Array.from({ length: period === 'semanal' ? 8 : 2 }, (_, index) => ({
      strategyId: 1,
      strategyName: 'Tendencia SMA',
      desde:
        period === 'semanal'
          ? new Date(Date.UTC(2026, 7, 3 + 7 * index)).toISOString().slice(0, 10)
          : `2026-0${index + 8}-01`,
      hasta:
        period === 'semanal'
          ? new Date(Date.UTC(2026, 7, 9 + 7 * index)).toISOString().slice(0, 10)
          : index === 0
            ? '2026-08-31'
            : '2026-09-30',
      trades: 4,
      expectedReturnPct: 2.4,
      realReturnPct: index === 0 ? -1.2 : 2.5,
      deviationPp: index === 0 ? -3.6 : 0.1,
      expectedWinRate: 0.6,
      realWinRate: 0.5,
      avgSlippageBps: index === 0 ? 14 : 6,
      outOfMargin: index === 0,
    })),
  };
}
beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
  vi.spyOn(window.tradia.deviation, 'report').mockImplementation(async ({ period }) =>
    fixture(period),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function mount() {
  await act(async () => {
    render(<DeviationPage />);
  });
}
function rows() {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1);
}

it('muestra ocho semanas, cambia a dos meses y anuncia la estrategia fuera de margen', async () => {
  await mount();
  expect(rows()).toHaveLength(8);
  expect(screen.getByRole('button', { name: 'Semanal' })).toHaveAttribute('aria-pressed', 'true');
  const alert = within(rows()[0]!);
  expect(alert.getByText('Fuera de margen')).toBeInTheDocument();
  expect(alert.getByText(/Desviación −3,6 pp supera ±2,0 pp/)).toHaveTextContent(
    'Slippage 14,0 pb supera 10,0 pb',
  );
  expect(alert.getByText('Fuera de margen').querySelector('svg')).toHaveAttribute(
    'aria-hidden',
    'true',
  );
  expect(
    screen
      .getAllByRole('status')
      .some((node) => node.textContent?.includes('fuera de margen: Tendencia SMA')),
  ).toBe(true);
  expect(alert.getByText('−1,2 %')).toBeInTheDocument();
  expect(alert.getByText('Esperada: 60,0 %')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Mensual' }));
  expect(rows()).toHaveLength(2);
  expect(window.tradia.deviation.report).toHaveBeenLastCalledWith({ period: 'mensual' });
});
it('persiste los márgenes en settings y recalcula el informe', async () => {
  await mount();
  const set = vi.spyOn(window.tradia.settings, 'set');
  fireEvent.change(screen.getByLabelText('Rentabilidad · ± pp'), { target: { value: '3' } });
  fireEvent.change(screen.getByLabelText('Slippage medio máximo · pb'), {
    target: { value: '20' },
  });
  await userEvent.click(screen.getByRole('button', { name: 'Guardar márgenes' }));
  expect(set).toHaveBeenCalledWith({ deviationMarginPp: 3, deviationSlippageBps: 20 });
  expect(await screen.findByText('Márgenes guardados')).toHaveAttribute('role', 'status');
  expect(window.tradia.deviation.report).toHaveBeenCalledTimes(2);
});
it.each([
  ['Rentabilidad · ± pp', '0'],
  ['Rentabilidad · ± pp', '51'],
  ['Slippage medio máximo · pb', '501'],
  ['Slippage medio máximo · pb', '0'],
])('valida %s = %s sin guardar y enfoca el error', async (label, value) => {
  await mount();
  const set = vi.spyOn(window.tradia.settings, 'set');
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  await userEvent.click(screen.getByRole('button', { name: 'Guardar márgenes' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Usa un valor entre');
  expect(screen.getByLabelText(label)).toHaveFocus();
  expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid', 'true');
  expect(set).not.toHaveBeenCalled();
});
it('muestra vacíos semanal y mensual', async () => {
  vi.mocked(window.tradia.deviation.report).mockImplementation(async ({ period }) => ({
    ...fixture(period),
    rows: [],
  }));
  await mount();
  expect(
    screen.getByText('Aún no hay semanas cerradas con operaciones en paper'),
  ).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Mensual' }));
  expect(
    await screen.findByText('Aún no hay meses cerrados con operaciones en paper'),
  ).toBeInTheDocument();
});
it('conserva el informe ante un fallo de recálculo y permite reintentar', async () => {
  await mount();
  vi.mocked(window.tradia.deviation.report).mockRejectedValueOnce(new Error('IPC'));
  await userEvent.click(screen.getByRole('button', { name: 'Guardar márgenes' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo calcular el informe');
  expect(rows()).toHaveLength(8);
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar informe' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it('anuncia la carga y descarta una respuesta semanal tardía después de elegir mensual', async () => {
  let resolve!: (report: DeviationReport) => void;
  vi.mocked(window.tradia.deviation.report).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await mount();
  expect(screen.getByText('Cargando informe…')).toHaveAttribute('role', 'status');
  await userEvent.click(screen.getByRole('button', { name: 'Mensual' }));
  await act(async () => {
    resolve(fixture('semanal'));
  });
  expect(rows()).toHaveLength(2);
  expect(screen.getByRole('table')).toHaveTextContent('Resultados mensuales');
});
it('muestra datos incompletos sin inventar ceros ni éxito', async () => {
  const report = fixture('semanal');
  report.rows = [
    {
      ...report.rows[1]!,
      expectedReturnPct: null,
      deviationPp: null,
      expectedWinRate: null,
      avgSlippageBps: null,
    },
  ];
  vi.mocked(window.tradia.deviation.report).mockResolvedValue(report);
  await mount();
  expect(rows()[0]).toHaveTextContent('Falta la expectativa del backtest');
  expect(within(rows()[0]!).queryByText('Dentro del margen')).not.toBeInTheDocument();
});
it('permite reintentar carga de márgenes y conserva el borrador si no se guarda', async () => {
  vi.spyOn(window.tradia.settings, 'get').mockRejectedValueOnce(new Error('IPC'));
  await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar márgenes' }));
  vi.spyOn(window.tradia.settings, 'set').mockRejectedValue(new Error('IPC'));
  fireEvent.change(screen.getByLabelText('Rentabilidad · ± pp'), { target: { value: '3' } });
  await userEvent.click(screen.getByRole('button', { name: 'Guardar márgenes' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudieron guardar');
  expect(screen.getByLabelText('Rentabilidad · ± pp')).toHaveValue(3);
  expect(screen.queryByText('Márgenes guardados')).not.toBeInTheDocument();
});
