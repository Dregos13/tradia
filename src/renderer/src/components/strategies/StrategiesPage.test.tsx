// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { StrategiesPage } from './StrategiesPage';
import type { BacktestProgressEvent } from '../../../../shared/backtest';
import type { StrategyDraft } from '../../../../shared/strategy';
const draft: StrategyDraft = {
  name: 'Cruce de medias',
  hypothesis: 'Persistencia de tendencias',
  rules: {
    entry: 'Cruce alcista',
    exit: 'Cruce bajista',
    stop: 'Stop del 5 %',
    target: 'Salida por señal',
  },
  markets: ['SPY'],
  parameters: { fast: 20, slow: 50 },
  regime: 'Tendencial',
};
beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
  window.location.hash = '#estrategias';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function navigate(hash: string) {
  await act(async () => {
    window.location.hash = hash;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
}
describe('Biblioteca y ficha versionada', () => {
  it('muestra estrategias, métricas ausentes y filtros', async () => {
    await window.tradia.strategies.create(draft);
    render(<StrategiesPage />);
    expect(await screen.findByRole('link', { name: draft.name })).toHaveAttribute(
      'href',
      '#estrategias/1',
    );
    expect(screen.getAllByText('Sin datos')).toHaveLength(4);
    await userEvent.selectOptions(screen.getByLabelText('Estado'), 'activa');
    expect(screen.getByText('No hay estrategias con este estado')).toBeInTheDocument();
  });
  it('refresca las métricas al terminar la siembra y libera la suscripción', async () => {
    await window.tradia.strategies.create(draft);
    let progress: ((event: BacktestProgressEvent) => void) | undefined;
    const off = vi.fn();
    vi.spyOn(window.tradia.backtest, 'onProgress').mockImplementation((listener) => {
      progress = listener;
      return off;
    });
    const view = render(<StrategiesPage />);
    await screen.findByRole('link', { name: draft.name });
    expect(screen.getAllByText('Sin datos')).toHaveLength(4);
    const summaries = await window.tradia.strategies.list();
    vi.spyOn(window.tradia.strategies, 'list').mockResolvedValue(
      summaries.map((summary) => ({
        ...summary,
        metricsSummary: {
          totalReturnPct: 12,
          maxDrawdownPct: 4,
          sharpe: 1.5,
          trades: 8,
          profitFactor: 2,
          winRatePct: 50,
          expectancy: 10,
          maxLosingStreak: 2,
        },
      })),
    );
    act(() =>
      progress?.({
        ticket: 'seed',
        strategyId: 1,
        stage: 'completado',
        percent: 100,
        detail: null,
        elapsedMs: 100,
      }),
    );
    expect(screen.getByRole('link', { name: draft.name })).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await screen.findByText('12%');
    expect(screen.queryByText('Sin datos')).not.toBeInTheDocument();
    const row = screen.getByRole('link', { name: draft.name }).closest('tr')!;
    expect(within(row).getByText('12%')).toBeInTheDocument();
    expect(within(row).getByText('8')).toBeInTheDocument();
    view.unmount();
    expect(off).toHaveBeenCalledOnce();
  });
  it('crea, exige nota y conserva v1 al guardar v2 con su registro', async () => {
    const user = userEvent.setup();
    window.location.hash = '#estrategias/nueva';
    render(<StrategiesPage />);
    for (const [label, value] of Object.entries({
      Nombre: 'Mi estrategia',
      'Hipótesis económica': 'Tendencia persistente',
      Entrada: 'Comprar al cruce',
      Salida: 'Vender al cruce',
      Stop: 'Cinco por ciento',
      Objetivo: 'Salida por señal',
      'Mercados (separados por comas)': 'SPY',
      'Régimen favorable y limitaciones': 'Tendencial',
    }))
      await user.type(screen.getByLabelText(label), value);
    await user.click(screen.getByRole('button', { name: 'Crear estrategia' }));
    expect(await screen.findByRole('heading', { name: 'Mi estrategia' })).toBeInTheDocument();
    await navigate('#estrategias/1/editar');
    await user.clear(screen.getByLabelText('Nombre'));
    await user.type(screen.getByLabelText('Nombre'), 'Mi estrategia revisada');
    await user.click(screen.getByRole('button', { name: 'Guardar nueva versión' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Explica qué cambió y por qué');
    expect((await window.tradia.strategies.get({ id: 1 }))?.version).toBe(1);
    await user.type(
      screen.getByLabelText('Nota del cambio'),
      'Actualizo el nombre para identificar la hipótesis',
    );
    await user.click(screen.getByRole('button', { name: 'Guardar nueva versión' }));
    expect(
      await screen.findByRole('heading', { name: 'Mi estrategia revisada' }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe('#estrategias/1/v2');
    expect(
      screen.getByText('Actualizo el nombre para identificar la hipótesis'),
    ).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Versión'), '1');
    expect(await screen.findByRole('heading', { name: 'Mi estrategia' })).toBeInTheDocument();
    expect(screen.getByText('Versión histórica · solo lectura')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Editar' })).not.toBeInTheDocument();
    await navigate('#estrategias');
    expect(await screen.findByRole('link', { name: 'Mi estrategia revisada' })).toBeInTheDocument();
  });
  it('cambia el estado sin crear versión y registra el cambio', async () => {
    await window.tradia.strategies.create(draft);
    window.location.hash = '#estrategias/1';
    render(<StrategiesPage />);
    await screen.findByRole('heading', { name: draft.name });
    await userEvent.selectOptions(screen.getByLabelText('Nuevo estado'), 'paper');
    await userEvent.click(screen.getByRole('button', { name: 'Cambiar estado' }));
    expect(await screen.findByText('Cambio de estado: investigacion → paper')).toBeInTheDocument();
    expect((await window.tradia.strategies.get({ id: 1 }))?.version).toBe(1);
  });
  it('muestra carga, error recuperable y vacío', async () => {
    const read = vi.spyOn(window.tradia.strategies, 'list').mockRejectedValueOnce(new Error('IPC'));
    render(<StrategiesPage />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos consultar');
    await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByText('Aún no hay estrategias')).toBeInTheDocument();
    expect(read).toHaveBeenCalledTimes(2);
  });
  it('valida JSON y conserva los datos al fallar el guardado', async () => {
    await window.tradia.strategies.create(draft);
    window.location.hash = '#estrategias/1/editar';
    render(<StrategiesPage />);
    const name = await screen.findByLabelText('Nombre');
    await userEvent.type(screen.getByLabelText('Nota del cambio'), 'Cambio documentado de reglas');
    const parameters = screen.getByLabelText('Parámetros (objeto JSON de números)');
    await userEvent.clear(parameters);
    await userEvent.type(parameters, 'invalido');
    await userEvent.click(screen.getByRole('button', { name: 'Guardar nueva versión' }));
    expect(screen.getByRole('alert')).toHaveTextContent('JSON válidos');
    await userEvent.clear(parameters);
    await userEvent.type(parameters, '{{}');
    vi.spyOn(window.tradia.strategies, 'update').mockRejectedValue(new Error('IPC'));
    await userEvent.click(screen.getByRole('button', { name: 'Guardar nueva versión' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tus cambios se conservan');
    expect(name).toHaveValue(draft.name);
  });
  it('rechaza una versión inexistente', async () => {
    window.location.hash = '#estrategias/1/v99';
    render(<StrategiesPage />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Esta estrategia o versión no existe',
    );
    expect(within(screen.getByRole('alert')).getByRole('link')).toHaveAttribute(
      'href',
      '#estrategias',
    );
  });
});

it('identifica fuente, periodo ejecutado y validación del último resultado de la versión', async () => {
  const strategy = await window.tradia.strategies.create({
    ...draft,
    parameters: { fastPeriod: 50, slowPeriod: 200, atrPeriod: 14, stopAtr: 3 },
  });
  const report = await window.tradia.backtest.run({
    strategyId: strategy.id,
    desde: '2020-01-01',
    hasta: '2024-01-01',
  });
  const list = vi.spyOn(window.tradia.backtest, 'list');
  window.location.hash = '#estrategias/1';
  render(<StrategiesPage />);
  expect(await screen.findByText(/Último resultado: Datos simulados/)).toHaveTextContent(
    'Fuente: simulated',
  );
  expect(screen.getByText(/Periodo ejecutado:/)).toHaveTextContent(report.config.ejecutadoHasta!);
  expect(screen.getByText('Temporalidad: sesiones diarias.')).toBeInTheDocument();
  expect(screen.getByText(/Prueba final reservada:/)).toHaveTextContent(
    report.split!.validation.endDate,
  );
  expect(list).toHaveBeenCalledWith({ strategyId: 1, version: 1 });
  await window.tradia.strategies.update({
    id: 1,
    note: 'Cambio de hipótesis',
    hypothesis: 'Otra hipótesis',
  });
  await navigate('#estrategias/1/v2');
  expect(
    await screen.findByText('Aún no hay resultados guardados para esta versión.'),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Último resultado:/)).not.toBeInTheDocument();
});
it('permite reintentar una consulta de evidencia fallida', async () => {
  await window.tradia.strategies.create(draft);
  const read = vi.spyOn(window.tradia.backtest, 'list').mockRejectedValue(new Error('IPC'));
  window.location.hash = '#estrategias/1';
  render(<StrategiesPage />);
  await screen.findByRole('button', { name: 'Reintentar evidencia' });
  read.mockResolvedValue([]);
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar evidencia' }));
  expect(
    await screen.findByText('Aún no hay resultados guardados para esta versión.'),
  ).toBeInTheDocument();
});
