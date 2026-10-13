// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../adapters/simulated';
import { DataFreshness, freshnessTitle } from './DataFreshness';
import { ProviderBanner } from './ProviderBanner';
import { Dashboard } from './dashboard/Dashboard';
import { MarketDataPage } from './MarketDataPage';
import { AiPage } from './ai/AiPage';
import { strategies as strategyFixtures } from './dashboard/testFixtures';
import { regimeLabels } from './strategies/regimeLabels';
import { DataProvidersSettings } from './DataProvidersSettings';
import type { DataFreshnessSummary, MarketRefreshResult } from '../../../shared/ipc';
let simulation: ReturnType<typeof createSimulatedAdapter>;
it.each([
  ['2026-09-25', 'Datos desactualizados desde el 25 sept 2026'],
  ['no-es-fecha', 'Datos desactualizados desde el no-es-fecha'],
  [null, 'Datos desactualizados · fecha del último dato no disponible'],
])('conserva el texto de la fecha de sesión (%s)', (sinceDate, expected) => {
  expect(freshnessTitle({ state: 'stale', sinceDate })).toBe(expected);
});
const stale = {
  key: 'ticker:AAPL',
  state: 'desactualizado' as const,
  lastOkAt: '2026-09-25T20:00:00Z',
  consecutiveFailures: 1,
  reason: 'Falta la vela del 28 sept; último dato: 25 sept.',
  updatedAt: '2026-10-11T10:00:00Z',
};
beforeEach(() => {
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  simulation.emitConnectivity({
    status: 'online',
    lastCheckedAt: null,
    nextRetryAt: null,
    attempt: 0,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
});

it('banner, Inicio, Mercado, Macro e IA comparten fecha, motivo y acciones del adaptador', async () => {
  simulation.emitDataStatus(stale);
  for (const surface of [
    <ProviderBanner />,
    <Dashboard
      system={{ connectivity: null, agents: null, connectionError: false, agentsError: false }}
    />,
    <MarketDataPage kind="mercado" />,
    <MarketDataPage kind="macro" />,
    <AiPage />,
  ]) {
    const view = render(surface);
    await waitFor(() =>
      expect(
        screen.getAllByText('Datos desactualizados desde el 25 sept 2026').length,
      ).toBeGreaterThan(0),
    );
    const freshness = screen.getByLabelText(
      surface.type === ProviderBanner ? 'Estado de los datos' : 'Frescura de datos',
    );
    expect(within(freshness).getByText(stale.reason, { selector: 'p' })).toBeInTheDocument();
    expect(within(freshness).getByRole('button', { name: 'Actualizar ahora' })).toBeEnabled();
    expect(within(freshness).getByRole('link', { name: 'Probar conexión' })).toHaveAttribute(
      'href',
      '#ajustes?provider=tiingo&focus=test',
    );
    view.unmount();
  }
  expect(simulation.listenerCount()).toBe(0);
});
it('usa una sola suscripción y protege contra lecturas previas al push', async () => {
  let resolveInitial!: (value: DataFreshnessSummary) => void;
  const initial = await simulation.api.dataStatus.freshness();
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockReturnValueOnce(
    new Promise((resolve) => {
      resolveInitial = resolve;
    }),
  );
  const view = render(
    <>
      <DataFreshness />
      <ProviderBanner />
    </>,
  );
  expect(simulation.listenerCount()).toBe(1);
  act(() => simulation.emitDataStatus(stale));
  expect(await screen.findAllByText('Datos desactualizados desde el 25 sept 2026')).toHaveLength(2);
  await act(async () => resolveInitial(initial));
  expect(screen.getAllByText('Datos desactualizados desde el 25 sept 2026')).toHaveLength(2);
  view.unmount();
  expect(simulation.listenerCount()).toBe(0);
});
it.each([{ done: 3, total: 7 }, null])(
  'puesta al día muestra el progreso recibido: %j',
  async (progress) => {
    vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue({
      state: 'catching-up',
      sinceDate: '2026-09-25',
      expectedSessionDate: '2026-10-09',
      missingSessions: 10,
      uncovered: [],
      items: [],
      progress,
      updatedAt: '2026-10-11T10:00:00Z',
    });
    render(<DataFreshness />);
    expect(
      await screen.findByText(
        progress
          ? /Descargando 3 de 7 activos/
          : /Régimen, predicciones y señales esperan a terminar/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Actualizar ahora' })).not.toBeInTheDocument();
  },
);
it('un fallo de actualización muestra el motivo real y la franja permanece', async () => {
  simulation.emitDataStatus(stale);
  vi.spyOn(simulation.api.market, 'refreshNow').mockResolvedValue({
    accepted: true,
    reason: null,
    ok: false,
    detail: 'Tiingo no responde (HTTP 503).',
  });
  render(<ProviderBanner />);
  await userEvent.click(await screen.findByRole('button', { name: 'Actualizar ahora' }));
  expect(
    await screen.findByText('No se pudo actualizar: Tiingo no responde (HTTP 503).'),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Actualización solicitada/)).not.toBeInTheDocument();
});
it('sin conexión conserva fecha y motivo y oculta las acciones de red', async () => {
  simulation.emitDataStatus(stale);
  render(<ProviderBanner offline />);
  expect(
    await screen.findByText('Datos desactualizados desde el 25 sept 2026'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Actualizar ahora' })).not.toBeInTheDocument();
  expect(screen.queryByText('Sin conexión')).not.toBeInTheDocument();
});
it('un perfil sin configurar usa texto neutro y dirige al campo del proveedor', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue({
    state: 'no-data',
    sinceDate: null,
    expectedSessionDate: null,
    missingSessions: 0,
    uncovered: [],
    items: [],
    updatedAt: '2026-10-11T10:00:00Z',
  });
  render(<ProviderBanner />);
  expect(await screen.findByText(/Sin configurar · añade tus claves/)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
it.each(['key', 'test'])('Ajustes enfoca FRED con focus=%s', async (focus) => {
  window.location.hash = `#ajustes?provider=fred&focus=${focus}`;
  render(<DataProvidersSettings />);
  await waitFor(() => expect(document.getElementById(`fred-${focus}`)).toHaveFocus());
});
it('anuncia recuperación y permite reintentar un error al leer el resumen', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockRejectedValueOnce(new Error('IPC'));
  render(<DataFreshness />);
  expect(await screen.findByText(/No se pudo comprobar la frescura/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
  expect(await screen.findByText(/Al día/)).toBeInTheDocument();
});

it('IA mantiene régimen y probabilidades en pausa y oculta los valores caducados', async () => {
  simulation.emitDataStatus(stale);
  render(<AiPage />);
  expect(
    await screen.findByText(/No se calcula el régimen hasta ponerse al día/),
  ).toBeInTheDocument();
  expect(screen.getByText(/No se calculan nuevas probabilidades/)).toBeInTheDocument();
  expect(screen.queryByRole('table', { name: 'Predicción por activo' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Dirección: ADX/)).not.toBeInTheDocument();
});
it('Inicio muestra el mismo régimen SPY que IA y su procedencia en precios', async () => {
  const overview = await simulation.api.ai.regimeOverview();
  expect(overview.market).not.toBeNull();
  render(
    <Dashboard
      system={{ connectivity: null, agents: null, connectionError: false, agentsError: false }}
    />,
  );
  expect(
    await screen.findByText(
      `${regimeLabels[overview.market!.direction]} · ${regimeLabels[overview.market!.volatility]}`,
    ),
  ).toBeInTheDocument();
  expect(screen.getByText(/Referencia SPY · Fuente precios diarios/)).toBeInTheDocument();
});
it('Inicio muestra la fecha del dato real, nunca la hora de consulta del proveedor', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue({
    state: 'stale',
    sinceDate: '2026-09-25',
    expectedSessionDate: '2026-10-09',
    missingSessions: 10,
    uncovered: [],
    items: [
      {
        key: 'provider:tiingo',
        label: 'Tiingo',
        state: 'desactualizado',
        lastDataDate: '2026-09-25',
        reason: 'Faltan cierres.',
      },
    ],
    updatedAt: '2026-10-11T10:00:00Z',
  });
  simulation.emitDataStatus({ ...stale, key: 'provider:tiingo', lastOkAt: '2026-10-11T10:00:00Z' });
  render(
    <Dashboard
      system={{ connectivity: null, agents: null, connectionError: false, agentsError: false }}
    />,
  );
  await waitFor(() => {
    expect(screen.getByText('Último cierre 25 sept 2026')).toBeVisible();
    expect(document.body).not.toHaveTextContent(/\b\d{4}-\d{2}-\d{2}\b/);
  });
});
it('con estrategias paper el vacío de señales no pide activarlas otra vez', async () => {
  const strategies = strategyFixtures;
  vi.spyOn(simulation.api.signals, 'strategies').mockResolvedValue(
    strategies.map((row) => ({ ...row, status: 'paper' })),
  );
  render(
    <Dashboard
      system={{ connectivity: null, agents: null, connectionError: false, agentsError: false }}
    />,
  );
  expect(
    await screen.findByText(/estrategias en paper esperan el siguiente cierre verificado/),
  ).toBeInTheDocument();
  expect(screen.queryByText(/Activa una estrategia/)).not.toBeInTheDocument();
});

it('un fallo del estado detallado de Mercado mantiene un único indicador de frescura', async () => {
  simulation.emitDataStatus(stale);
  vi.spyOn(simulation.api.dataStatus, 'get').mockRejectedValue(new Error('IPC'));
  render(<MarketDataPage kind="mercado" />);
  await screen.findByText(/No pudimos comprobar el estado del dato/);
  expect(screen.getAllByLabelText('Frescura de datos')).toHaveLength(1);
  expect(document.querySelector('p section')).toBeNull();
});

it.each(['stale', 'unreliable'] as const)(
  'N1: %s sin fecha nunca compone «desde el sin datos»',
  async (state) => {
    vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue({
      state,
      sinceDate: null,
      expectedSessionDate: '2026-10-09',
      missingSessions: 0,
      uncovered: [],
      items: [
        {
          key: 'provider:fred',
          label: 'FRED',
          state: 'desactualizado',
          lastDataDate: null,
          reason: 'Error del proveedor',
        },
      ],
      updatedAt: stale.updatedAt,
    });
    render(<DataFreshness />);
    expect(await screen.findByText(/fecha del último dato no disponible/)).toBeVisible();
    expect(screen.queryByText(/desde el sin datos/)).not.toBeInTheDocument();
  },
);

it('N2: limpia el resultado anterior al recuperarse y no lo lleva al siguiente aviso', async () => {
  simulation.emitDataStatus(stale);
  vi.spyOn(simulation.api.market, 'refreshNow').mockResolvedValue({
    accepted: true,
    ok: false,
    detail: 'fallo anterior',
    reason: null,
  });
  render(<DataFreshness />);
  await userEvent.click(await screen.findByRole('button', { name: 'Actualizar ahora' }));
  expect(await screen.findByText('No se pudo actualizar: fallo anterior')).toBeVisible();
  await act(async () => simulation.emitDataStatus({ ...stale, state: 'fiable' }));
  await screen.findByText('Al día');
  await act(async () => simulation.emitDataStatus(stale));
  expect(await screen.findByRole('button', { name: 'Actualizar ahora' })).toBeEnabled();
  expect(screen.queryByText('No se pudo actualizar: fallo anterior')).not.toBeInTheDocument();
});

it('N2: una petición antigua no repone su error tras recuperarse', async () => {
  simulation.emitDataStatus(stale);
  let resolve!: (value: MarketRefreshResult) => void;
  vi.spyOn(simulation.api.market, 'refreshNow').mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<DataFreshness />);
  await userEvent.click(await screen.findByRole('button', { name: 'Actualizar ahora' }));
  await act(async () => simulation.emitDataStatus({ ...stale, state: 'fiable' }));
  await screen.findByText('Al día');
  await act(async () => simulation.emitDataStatus(stale));
  await act(async () =>
    resolve({ accepted: true, ok: false, detail: 'respuesta antigua', reason: null }),
  );
  expect(screen.queryByText(/respuesta antigua/)).not.toBeInTheDocument();
});

it('H2: sin conexión no anuncia datos al día con un resumen current', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue({
    state: 'current',
    sinceDate: null,
    expectedSessionDate: '2026-10-07',
    missingSessions: 0,
    uncovered: [],
    items: [],
    updatedAt: stale.updatedAt,
  });
  render(<DataFreshness offline snapshotSessionDate="2026-10-06" />);
  expect(await screen.findByText(/Sin conexión · datos del 6 oct 2026/)).toBeVisible();
  expect(screen.queryByText(/Al día|Datos al día/)).not.toBeInTheDocument();
});

it('N2: los eventos de la propia descarga no descartan su resultado de error', async () => {
  simulation.emitDataStatus(stale);
  vi.spyOn(simulation.api.market, 'refreshNow').mockImplementation(async () => {
    simulation.emitDataStatus({ ...stale, state: 'actualizando' });
    await Promise.resolve();
    simulation.emitDataStatus(stale);
    await Promise.resolve();
    return { accepted: true, ok: false, detail: 'fallo de esta descarga', reason: null };
  });
  render(<DataFreshness />);
  await userEvent.click(await screen.findByRole('button', { name: 'Actualizar ahora' }));
  await waitFor(() => {
    expect(screen.getByText('No se pudo actualizar: fallo de esta descarga')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Actualizar ahora' })).toBeEnabled();
  });
});

it.each(['2026-09-25', null])(
  'franja e IA comparten el aviso del resumen (%s) y nunca fechas ISO',
  async (sinceDate) => {
    vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue({
      state: 'stale',
      sinceDate,
      expectedSessionDate: '2026-10-09',
      missingSessions: 10,
      uncovered: [],
      items: [],
      updatedAt: stale.updatedAt,
    });
    await act(async () => {
      render(
        <>
          <ProviderBanner />
          <AiPage />
        </>,
      );
    });
    const title = sinceDate
      ? 'Datos desactualizados desde el 25 sept 2026'
      : 'Datos desactualizados · fecha del último dato no disponible';
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Estado de los datos' })).toHaveTextContent(title);
      for (const name of ['Régimen del mercado', 'Predicción por activo']) {
        expect(within(screen.getByRole('region', { name })).getByRole('status')).toHaveTextContent(
          title,
        );
      }
      expect(document.body).not.toHaveTextContent(/\b\d{4}-\d{2}-\d{2}\b/);
    });
  },
);

it('R4: IA sin red conserva la fecha conocida en ambos paneles sin negarla ni mostrar ISO', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue({
    state: 'current',
    sinceDate: null,
    expectedSessionDate: '2026-10-09',
    missingSessions: 0,
    uncovered: [],
    items: [],
    updatedAt: stale.updatedAt,
  });
  const overview = await simulation.api.ai.regimeOverview();
  expect(overview.market).not.toBeNull();
  vi.spyOn(simulation.api.ai, 'regimeOverview').mockResolvedValue({
    ...overview,
    market: { ...overview.market!, sessionDate: '2026-10-06' },
    expectedSessionDate: '2026-10-09',
    stale: true,
  });
  await simulation.api.watchlist.add('SPY');
  const predictions = await simulation.api.ai.predictions({});
  expect(predictions.length).toBeGreaterThan(0);
  vi.spyOn(simulation.api.ai, 'predictions').mockResolvedValue(
    predictions.map((row) => ({ ...row, sessionDate: '2026-10-06' })),
  );
  simulation.emitConnectivity({
    status: 'offline',
    lastCheckedAt: null,
    nextRetryAt: null,
    attempt: 0,
  });
  const view = render(<AiPage />);
  await waitFor(() => {
    for (const name of ['Régimen del mercado', 'Predicción por activo']) {
      const panel = screen.getByRole('region', { name });
      expect(within(panel).getByRole('status')).toHaveTextContent(
        'Sin conexión · datos del 6 oct 2026. No se pudo comprobar si hay datos más recientes.',
      );
      expect(panel).toHaveTextContent('Calculado con el cierre del 6 oct 2026');
    }
  });
  expect(view.container).not.toHaveTextContent('fecha del último dato no disponible');
  expect(view.container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
});
