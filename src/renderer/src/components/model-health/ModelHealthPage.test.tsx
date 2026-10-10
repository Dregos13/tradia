// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ModelHealthOverview, RetrainProposal } from '../../../../shared/ai';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { ModelHealthPage } from './ModelHealthPage';
let adapter: ReturnType<typeof createSimulatedAdapter>;
let overview: ModelHealthOverview;
const proposal: RetrainProposal = {
  id: 1,
  modelCardId: 1,
  strategyId: null,
  quarter: '2026-Q4',
  reason: 'Drift sostenido en ret_5 y vol_20',
  dataScope: 'Velas limpias hasta septiembre',
  lastTrainedAt: '2026-07-01T12:00:00Z',
  nextAllowedAt: '2027-01-01',
  status: 'pendiente',
  note: null,
  postponedUntil: null,
  createdAt: '2026-10-10T12:00:00Z',
  resolvedAt: null,
};
beforeEach(async () => {
  adapter = createSimulatedAdapter();
  window.tradia = adapter.api;
  adapter.emitConnectivity({
    status: 'online',
    lastCheckedAt: null,
    nextRetryAt: null,
    attempt: 0,
  });
  overview = await adapter.api.ai.health();
  overview.subjects[0] = {
    ...overview.subjects[0]!,
    state: 'degradada',
    dataDrift: {
      drifted: true,
      sessions: 20,
      driftedFeatures: 2,
      features: [
        { name: 'ret_5', psi: 0.31, overThreshold: true },
        { name: 'vol_20', psi: 0.28, overThreshold: true },
      ],
    },
    resultsDrift: {
      drifted: true,
      resolvedCount: 60,
      rollingBrier: 0.229,
      cardBrier: 0.184,
      delta: 0.045,
    },
  };
  overview.subjects[1] = {
    ...overview.subjects[1]!,
    state: 'degradada',
    strategyEval: {
      trades: 34,
      deviationPct: -36,
      consecutiveReviews: 2,
      losingStreak: 4,
      maxLosingStreakBacktest: 6,
    },
    reason: 'Drift sostenido de rendimiento',
  };
  overview.counts = { saludable: 2, observacion: 1, degradada: 2, insuficiente: 0 };
  overview.proposals = [{ ...proposal }];
  vi.spyOn(adapter.api.ai, 'health').mockImplementation(async () => structuredClone(overview));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function mount() {
  await act(async () => {
    render(<ModelHealthPage />);
  });
}
it('muestra PSI por variable, Brier contra ficha, persistencia y evidencia de degradación', async () => {
  await mount();
  const rows = within(screen.getByRole('table')).getAllByRole('row');
  expect(rows[1]).toHaveTextContent('Brier móvil 0,229');
  expect(rows[1]).toHaveTextContent('Ficha 0,184');
  expect(rows[1]).toHaveTextContent('umbral +0,02');
  expect(rows[1]).toHaveTextContent('Desde hace 20 sesiones');
  expect(rows[2]).toHaveTextContent('34 operaciones · desviación -36 %');
  expect(rows[2]).toHaveTextContent('Desde hace 2 revisiones mensuales');
  const detail = within(rows[1]!).getByRole('button');
  await userEvent.click(detail);
  expect(detail).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('ret_5')).toBeInTheDocument();
  expect(screen.getByText('PSI 0,31 · umbral > 0,25')).toBeInTheDocument();
  expect(screen.getByText(/Una racha mala aislada no degrada una estrategia/)).toBeInTheDocument();
});
it('aprobar exige confirmación, recibe instrucciones externas y actualiza el estado', async () => {
  const resolve = vi.spyOn(adapter.api.ai, 'resolveRetrain').mockResolvedValue({
    proposal: { ...proposal, status: 'aprobada' },
    instructions:
      '1. Exportar velas limpias.\n2. Ejecutar ml/train.py fuera de Tradia.\n3. Validar la ficha fuera de muestra.',
  });
  await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Aprobar y abrir instrucciones' }));
  expect(resolve).not.toHaveBeenCalled();
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Confirmar aprobación' }));
  expect(resolve).toHaveBeenCalledWith({ id: 1, action: 'aprobar' });
  expect(await screen.findByText('Propuesta 2026-Q4 · aprobada')).toBeInTheDocument();
  expect(screen.getByText(/2. Ejecutar ml\/train.py/)).toBeInTheDocument();
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('posponer valida fecha futura y motivo y registra la decisión tras confirmar', async () => {
  const resolve = vi
    .spyOn(adapter.api.ai, 'resolveRetrain')
    .mockImplementation(async (request) => ({
      proposal: {
        ...proposal,
        status: 'pospuesta',
        note: request.note!,
        postponedUntil: request.postponeUntil!,
      },
      instructions: null,
    }));
  await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Posponer' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar aplazamiento' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Indica una fecha futura y el motivo');
  expect(resolve).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('Posponer hasta'), { target: { value: '2099-01-01' } });
  await userEvent.type(screen.getByLabelText('Motivo'), 'Revisar calidad de datos');
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar aplazamiento' }));
  expect(resolve).toHaveBeenCalledWith({
    id: 1,
    action: 'posponer',
    postponeUntil: '2099-01-01',
    note: 'Revisar calidad de datos',
  });
  expect(await screen.findByText('Propuesta 2026-Q4 · pospuesta')).toBeInTheDocument();
  expect(screen.getByText('Revisar calidad de datos')).toBeInTheDocument();
});
it('Escape cancela, restaura foco y el teclado permanece dentro de la confirmación', async () => {
  const resolve = vi.spyOn(adapter.api.ai, 'resolveRetrain');
  await mount();
  const trigger = screen.getByRole('button', { name: 'Aprobar y abrir instrucciones' });
  await userEvent.click(trigger);
  await userEvent.tab({ shift: true });
  expect(screen.getByRole('button', { name: 'Confirmar aprobación' })).toHaveFocus();
  await userEvent.tab();
  expect(screen.getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  await userEvent.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  expect(resolve).not.toHaveBeenCalled();
});
it('un rechazo conserva la propuesta y permite reintentar sin mostrar instrucciones', async () => {
  vi.spyOn(adapter.api.ai, 'resolveRetrain').mockRejectedValue(new Error('rechazo'));
  await mount();
  await userEvent.click(screen.getByRole('button', { name: 'Aprobar y abrir instrucciones' }));
  await userEvent.click(screen.getByRole('button', { name: 'Confirmar aprobación' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo resolver la propuesta');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  expect(screen.getByText('Propuesta 2026-Q4 · pendiente')).toBeInTheDocument();
  expect(screen.queryByText('Pasos del reentrenamiento fuera de la app')).not.toBeInTheDocument();
});
it('sin conexión conserva la evidencia y bloquea las decisiones', async () => {
  await mount();
  await act(async () => {
    adapter.emitConnectivity({
      status: 'offline',
      lastCheckedAt: null,
      nextRetryAt: null,
      attempt: 1,
    });
  });
  expect(screen.getByText(/Sin conexión · la revisión queda pausada/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Posponer' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Revisar ahora' })).toBeDisabled();
  expect(screen.getByRole('table')).toHaveTextContent('34 operaciones');
});
it('muestra carga, vacío y error de actualización con la última revisión conservada', async () => {
  let done!: (value: ModelHealthOverview) => void;
  vi.mocked(adapter.api.ai.health).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  render(<ModelHealthPage />);
  expect(
    await screen.findByText('Calculando salud con las últimas revisiones…'),
  ).toBeInTheDocument();
  await act(async () => {
    done({
      subjects: [],
      proposals: [],
      counts: { saludable: 0, observacion: 0, degradada: 0, insuficiente: 0 },
      evaluatedAt: null,
    });
  });
  expect(
    screen.getByText('Aún no hay predicciones resueltas ni operaciones suficientes'),
  ).toBeInTheDocument();
  expect(screen.getByText('No hay reentrenamientos propuestos')).toBeInTheDocument();
  vi.mocked(adapter.api.ai.health).mockRejectedValue(new Error('datos'));
  await userEvent.click(screen.getByRole('button', { name: 'Revisar ahora' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'No se pudo calcular la salud de los modelos',
  );
  expect(
    screen.getByText('Se conserva la última revisión; consulta su fecha.'),
  ).toBeInTheDocument();
});
