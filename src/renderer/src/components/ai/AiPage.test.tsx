// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RegimeOverview, Prediction, ModelCard as ModelCardData } from '../../../../shared/ai';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { AiPage } from './AiPage';
import { ModelCard } from './ModelCard';

let adapter: ReturnType<typeof createSimulatedAdapter>;
let card: ModelCardData;
beforeEach(async () => {
  adapter = createSimulatedAdapter();
  window.tradia = adapter.api;
  adapter.emitConnectivity({
    status: 'online',
    lastCheckedAt: null,
    nextRetryAt: null,
    attempt: 0,
  });
  card = (await adapter.api.ai.modelCard())!;
  const snapshot = {
    scope: 'mercado' as const,
    ticker: 'SPY',
    sessionDate: '2026-10-09',
    direction: 'tendencia' as const,
    volatility: 'volatilidad-alta' as const,
    metrics: { adx: 29.4, smaSlope: 0.4, realizedVolatility: 0.038, volatilityMedian: 0.02 },
    previousChange: { direction: 'lateral' as const, sessionDate: '2026-10-07' },
    computedAt: '2026-10-09T20:00:00Z',
  };
  const overview: RegimeOverview = {
    market: snapshot,
    assets: [
      { ...snapshot, scope: 'activo', ticker: 'AAPL' },
      { ...snapshot, scope: 'activo', ticker: 'MSFT', volatility: 'volatilidad-baja' },
    ],
    strategies: [
      {
        strategyId: 1,
        name: 'Tendencia SMA',
        version: 1,
        status: 'paper',
        regimeState: 'habilitada',
        worksIn: ['tendencia'],
        failsIn: [],
        reason: 'Coincide: Tendencia. No coincide con ningún régimen de fallo.',
      },
      {
        strategyId: 2,
        name: 'Reversión RSI',
        version: 1,
        status: 'paper',
        regimeState: 'desactivada',
        worksIn: ['lateral'],
        failsIn: ['tendencia'],
        reason: 'Solo funciona en Lateral; el régimen actual es Tendencia.',
      },
    ],
    computedAt: snapshot.computedAt,
  };
  const predictions: Prediction[] = ['AAPL', 'MSFT'].map((ticker, index) => ({
    id: index + 1,
    ticker,
    sessionDate: snapshot.sessionDate,
    horizonDays: card.horizonDays,
    probUp: 0.62,
    probDown: 0.38,
    expectedVolatility: 0.038,
    modelVersion: card.version,
    modelHash: card.hash,
    modelCardId: card.id,
    createdAt: snapshot.computedAt,
    resolvedSession: null,
    outcomeUp: null,
    realizedBrier: null,
  }));
  vi.spyOn(adapter.api.ai, 'regimeOverview').mockResolvedValue(overview);
  vi.spyOn(adapter.api.ai, 'predictions').mockResolvedValue(predictions);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function mount(props = {}) {
  await act(async () => {
    render(<AiPage {...props} />);
  });
}

it('presenta ambos ejes, decisiones y motivos del contrato sin ofrecer eludir el filtro', async () => {
  const overview = await adapter.api.ai.regimeOverview();
  await mount();
  const table = screen.getByRole('table', { name: 'Decisión por régimen de cada estrategia' });
  for (const strategy of overview.strategies) {
    const row = within(table).getByRole('row', { name: new RegExp(strategy.name) });
    expect(row).toHaveTextContent(strategy.reason);
    expect(row).toHaveTextContent(
      strategy.regimeState === 'habilitada' ? 'Activa por régimen' : 'Desactivada por régimen',
    );
  }
  expect(screen.getByRole('table', { name: 'Régimen por activo' })).toHaveTextContent(
    overview.assets[0]!.ticker,
  );
  expect(screen.getByText(/Referencia SPY/)).toBeInTheDocument();
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
});

it('muestra probabilidades, horizonte, volatilidad y versión; filtra y abre calibración con teclado', async () => {
  await mount();
  const estimates = await adapter.api.ai.predictions();
  const first = estimates[0]!;
  const table = screen.getByRole('table', { name: 'Probabilidades estimadas al cierre diario' });
  const row = within(table).getByRole('row', { name: new RegExp(first.ticker) });
  expect(row).toHaveTextContent(`Próximas ${first.horizonDays} sesiones`);
  expect(row).toHaveTextContent(`v${first.modelVersion}`);
  expect(within(row).getByRole('img')).toHaveAccessibleName(/subida .*bajada .*horizonte/);
  expect(row).toHaveTextContent('Datos sintéticos · no apto');
  const user = userEvent.setup();
  const selector = screen.getByRole('combobox', { name: 'Activo' });
  selector.focus();
  await user.selectOptions(selector, first.ticker);
  expect(within(table).getAllByRole('row')).toHaveLength(2);
  const button = screen.getByRole('button', { name: 'Ver datos del gráfico' });
  button.focus();
  await user.keyboard('{Enter}');
  expect(button).toHaveAttribute('aria-expanded', 'true');
  expect(button).toHaveFocus();
  expect(screen.getByRole('table', { name: /Todos los intervalos/ })).toBeVisible();
  await user.keyboard(' ');
  expect(button).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByText('Brier del modelo')).toBeInTheDocument();
  expect(screen.getByText('Brier de referencia')).toBeInTheDocument();
});

it('cubre carga y vacío sin inventar cifras', async () => {
  let resolve!: (value: null) => void;
  vi.spyOn(adapter.api.ai, 'modelCard').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  vi.spyOn(adapter.api.ai, 'regimeOverview').mockResolvedValue({
    market: null,
    assets: [],
    strategies: [],
    computedAt: null,
  });
  vi.spyOn(adapter.api.ai, 'predictions').mockResolvedValue([]);
  await mount();
  expect(screen.getByText('Cargando régimen y estimaciones…')).toHaveAttribute('role', 'status');
  expect(screen.getByRole('button', { name: 'Actualizar' })).toBeDisabled();
  await act(async () => {
    resolve(null);
  });
  expect(
    screen.getByText('Todavía no hay cierres suficientes para clasificar el régimen'),
  ).toBeInTheDocument();
  expect(screen.getByText('Aún no hay una versión de modelo cargada.')).toBeInTheDocument();
  expect(screen.getByText('Aún no hay estimaciones por activo.')).toBeInTheDocument();
});

it('error total ofrece reintento con teclado y no expone errores crudos del IPC', async () => {
  for (const method of ['regimeOverview', 'predictions', 'modelCard'] as const)
    vi.spyOn(adapter.api.ai, method).mockRejectedValueOnce(new Error('/private/secret'));
  await mount();
  expect(screen.getByRole('alert')).toHaveTextContent('No se pudo cargar la página IA');
  expect(screen.getByRole('alert')).not.toHaveTextContent('secret');
  const retry = screen.getByRole('button', { name: 'Reintentar' });
  retry.focus();
  await userEvent.keyboard('{Enter}');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('table', { name: 'Régimen por activo' })).toBeInTheDocument();
});

it('conserva la última instantánea en error parcial y deja de atribuir aptitud a la ficha no verificada', async () => {
  vi.spyOn(adapter.api.ai, 'modelCard').mockResolvedValue({
    ...card,
    dataOrigin: 'real',
    eligible: true,
  });
  await mount();
  expect(screen.getAllByText('Apto para apoyar señales').length).toBeGreaterThan(0);
  vi.mocked(adapter.api.ai.modelCard).mockRejectedValueOnce(new Error('IPC'));
  await userEvent.click(screen.getByRole('button', { name: 'Actualizar' }));
  expect(screen.getByRole('alert')).toHaveTextContent('No se pudo verificar la ficha');
  expect(
    screen.getByText('Última ficha conservada. No se pudo verificar la ficha del modelo.'),
  ).toBeInTheDocument();
  expect(screen.queryByText('Apto para apoyar señales')).not.toBeInTheDocument();
  expect(screen.getByRole('table', { name: 'Régimen por activo' })).toBeInTheDocument();
});

it('congela la instantánea sin conexión, bloquea actualizar y reconecta', async () => {
  const fetch = vi.spyOn(adapter.api.ai, 'regimeOverview');
  await mount();
  await act(async () => {
    adapter.emitConnectivity({
      status: 'offline',
      lastCheckedAt: null,
      nextRetryAt: null,
      attempt: 1,
    });
  });
  expect(screen.getByRole('button', { name: 'Actualizar' })).toBeDisabled();
  expect(screen.getByText(/Sin conexión · régimen y predicciones congelados/)).toHaveTextContent(
    'No se evaluarán señales nuevas',
  );
  const calls = fetch.mock.calls.length;
  await act(async () => {
    adapter.emitAiChanged('regimen');
  });
  expect(fetch).toHaveBeenCalledTimes(calls);
  expect(screen.getByRole('table', { name: 'Régimen por activo' })).toBeInTheDocument();
  vi.spyOn(adapter.api.connectivity, 'checkNow').mockResolvedValue({
    status: 'online',
    lastCheckedAt: null,
    nextRetryAt: null,
    attempt: 0,
  });
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar conexión' }));
  expect(screen.getByRole('button', { name: 'Actualizar' })).toBeEnabled();
});

it('navega a la ficha de estrategia mediante callback y Tab', async () => {
  const open = vi.fn();
  await mount({ onOpenStrategy: open });
  const user = userEvent.setup();
  const first = screen.getAllByRole('button', { name: /Ver ficha de/ })[0]!;
  for (let i = 0; i < 12 && document.activeElement !== first; i++) await user.tab();
  expect(first).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(open).toHaveBeenCalledWith(expect.any(Number));
});

it('no atribuye las métricas vigentes a una predicción de otra versión', async () => {
  const predictions = await adapter.api.ai.predictions();
  vi.spyOn(adapter.api.ai, 'predictions').mockResolvedValue([
    { ...predictions[0]!, modelVersion: 'antigua' },
  ]);
  await mount();
  const table = screen.getByRole('table', { name: 'Probabilidades estimadas al cierre diario' });
  expect(table).toHaveTextContent('Sin evaluar · no apto');
  expect(
    within(table).queryByRole('link', { name: 'Ver ficha del modelo' }),
  ).not.toBeInTheDocument();
});

it.each([0.213, 0.9])(
  'señala un modelo real que no mejora Brier (%s) y conserva los periodos',
  (brier) => {
    render(
      <ModelCard
        model={{
          ...card,
          dataOrigin: 'real',
          eligible: false,
          metrics: { ...card.metrics, brierOos: brier, brierBaseline: 0.213 },
        }}
      />,
    );
    expect(screen.getByText('No mejora la referencia · no apto')).toBeInTheDocument();
    expect(screen.getByText('Prueba final intacta')).toBeInTheDocument();
    expect(screen.getByText('Entrenamiento')).toBeInTheDocument();
    expect(screen.getByRole('img')).toHaveAccessibleName(/Calibración fuera de muestra/);
  },
);

it('no dibuja bins vacíos como evidencia y muestra Sin casos en la tabla', async () => {
  render(
    <ModelCard
      model={{
        ...card,
        calibration: [{ from: 0, to: 1, meanPredicted: 0, observed: 0, count: 0 }],
      }}
    />,
  );
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByText('Aún no hay casos de calibración fuera de muestra.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Ver datos del gráfico' }));
  expect(screen.getAllByText('Sin casos')).toHaveLength(2);
});

it('muestra degradación y volatilidad ausente sin sustituirla por cero', async () => {
  const overview = await adapter.api.ai.regimeOverview();
  vi.mocked(adapter.api.ai.regimeOverview).mockResolvedValue({
    ...overview,
    strategies: [
      {
        ...overview.strategies[0]!,
        regimeState: 'degradada',
        reason: 'Drift sostenido. Revisa Salud de modelos.',
      },
    ],
  });
  const predictions = await adapter.api.ai.predictions();
  vi.mocked(adapter.api.ai.predictions).mockResolvedValue([
    { ...predictions[0]!, expectedVolatility: null },
  ]);
  await mount();
  expect(screen.getByText('Degradada')).toBeInTheDocument();
  expect(screen.getByText('Drift sostenido. Revisa Salud de modelos.')).toBeInTheDocument();
  expect(screen.getByText('No calculada')).toBeInTheDocument();
});

it('cubre apertura sin conexión y no solicita estimaciones nuevas', async () => {
  adapter.emitConnectivity({
    status: 'offline',
    lastCheckedAt: null,
    nextRetryAt: null,
    attempt: 1,
  });
  await mount();
  expect(adapter.api.ai.regimeOverview).not.toHaveBeenCalled();
  expect(screen.getByText(/sin una instantánea disponible/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Actualizar' })).toBeDisabled();
});
