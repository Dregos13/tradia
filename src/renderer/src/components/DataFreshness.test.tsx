// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../adapters/simulated';
import {
  DataFreshness,
  freshnessTitle,
  refreshResultMessage,
  STALE_PAUSE_TEXT,
} from './DataFreshness';
import { ProviderBanner } from './ProviderBanner';
import { Dashboard } from './dashboard/Dashboard';
import { MarketDataPage } from './MarketDataPage';
import { AiPage } from './ai/AiPage';
import { strategies as strategyFixtures } from './dashboard/testFixtures';
import { regimeLabels } from './strategies/regimeLabels';
import { DataProvidersSettings } from './DataProvidersSettings';
import type { DataFreshnessSummary, MarketRefreshResult } from '../../../shared/ipc';
let simulation: ReturnType<typeof createSimulatedAdapter>;
const uncoveredSummary: DataFreshnessSummary = {
  state: 'current',
  sinceDate: null,
  expectedSessionDate: '2026-10-09',
  missingSessions: 0,
  items: [],
  uncovered: [
    {
      ticker: 'EUR',
      reason: "el proveedor 'tiingo' no devolvió datos para EUR",
      suggestion: 'FXE',
    },
  ],
  updatedAt: '2026-10-11T10:00:00Z',
};

it('el refresco parcial cuenta los activos y nombra EUR sin anunciar éxito total', () => {
  expect(
    refreshResultMessage({
      accepted: true,
      reason: null,
      ok: false,
      updated: 3,
      total: 4,
      failedTickers: ['EUR'],
    }),
  ).toBe('Actualizados 3 de 4 · sin datos: EUR');
});
it.each([
  { ok: true, updated: 3, total: 4, failedTickers: [] },
  { ok: true, updated: 4, total: 4, failedTickers: ['EUR'] },
  { ok: false, failedTickers: ['EUR'] },
])('un resultado incompleto o contradictorio nunca anuncia datos actualizados: %j', (result) => {
  expect(refreshResultMessage({ accepted: true, reason: null, ...result })).not.toContain(
    'Datos actualizados',
  );
});
it.each(['stale', 'unreliable', 'catching-up'] as const)(
  'no anuncia éxito total con resumen %s',
  (state) => {
    expect(
      refreshResultMessage(
        { accepted: true, reason: null, ok: true },
        { ...uncoveredSummary, state, uncovered: [] },
      ),
    ).not.toContain('Datos actualizados');
  },
);
it('un éxito de otro conector no oculta los activos sin cobertura', () => {
  expect(refreshResultMessage({ accepted: true, reason: null, ok: true }, uncoveredSummary)).toBe(
    'Actualización parcial · sin datos: EUR',
  );
});

it('un EUR sin cobertura muestra acciones accesibles y solo pausa ese activo', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue(uncoveredSummary);
  render(<DataFreshness variant="banner" />);
  const notice = await screen.findByRole('region', { name: 'Activos sin datos' });
  expect(
    within(notice).getByRole('heading', { name: 'EUR no está disponible en Tiingo' }),
  ).toBeVisible();
  expect(
    within(notice).getByText(
      'Solo EUR queda en pausa. Los demás activos, predicciones y señales siguen al día.',
    ),
  ).toBeVisible();
  expect(within(notice).getByRole('button', { name: 'Cambiar por FXE para EUR' })).toBeEnabled();
  expect(within(notice).getByRole('button', { name: 'Quitar EUR de la lista' })).toHaveTextContent(
    'Quitar de la lista',
  );
  expect(screen.queryByText(/Régimen, predicciones y señales en pausa/)).not.toBeInTheDocument();
  expect(screen.queryByText('Al día')).not.toBeInTheDocument();
  expect(screen.queryByText(/fecha del último dato no disponible/)).not.toBeInTheDocument();
  await userEvent.click(within(notice).getByText('Por qué ocurre'));
  expect(
    within(notice).getByText(/EUR no es un símbolo disponible en este conector/),
  ).toBeVisible();
  // Sin jerga sin explicar: ni calendario 24/5 ni «exposición parecida»; ETF solo explicado.
  expect(notice).not.toHaveTextContent(/24\/5|exposición parecida/);
  expect(notice).toHaveTextContent('fondos cotizados (ETF)');
});

it('quitar por teclado llama a watchlist:remove y conserva el foco al desaparecer el aviso', async () => {
  const freshness = vi
    .spyOn(simulation.api.dataStatus, 'freshness')
    .mockResolvedValue(uncoveredSummary);
  const remove = vi.spyOn(simulation.api.watchlist, 'remove').mockImplementation(async () => {
    freshness.mockResolvedValue({ ...uncoveredSummary, uncovered: [] });
    return [];
  });
  render(<DataFreshness variant="banner" />);
  await screen.findByRole('button', { name: 'Quitar EUR de la lista' });
  const user = userEvent.setup();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Cambiar por FXE para EUR' })).toHaveFocus();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Quitar EUR de la lista' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(remove).toHaveBeenCalledExactlyOnceWith('EUR');
  await waitFor(() => {
    expect(screen.queryByRole('region', { name: 'Activos sin datos' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText('Avisos de datos'));
  });
  expect(screen.getByText('EUR se ha quitado de tu lista.')).toBeVisible();
});

it('cambiar por teclado añade FXE antes de retirar EUR y relee el resumen tras un push', async () => {
  const freshness = vi
    .spyOn(simulation.api.dataStatus, 'freshness')
    .mockResolvedValue(uncoveredSummary);
  const add = vi.spyOn(simulation.api.watchlist, 'add');
  const remove = vi.spyOn(simulation.api.watchlist, 'remove').mockImplementation(async () => {
    freshness.mockResolvedValue({ ...uncoveredSummary, uncovered: [] });
    simulation.emitDataStatus(stale);
    return [];
  });
  render(<DataFreshness variant="banner" />);
  await screen.findByRole('button', { name: 'Cambiar por FXE para EUR' });
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard(' ');
  await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith('EUR'));
  expect(add).toHaveBeenCalledExactlyOnceWith('FXE');
  expect(add.mock.invocationCallOrder[0]!).toBeLessThan(remove.mock.invocationCallOrder[0]!);
  await waitFor(() => {
    expect(screen.queryByRole('region', { name: 'Activos sin datos' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByLabelText('Avisos de datos'));
  });
  expect(screen.getByText('EUR se cambió por FXE.')).toBeVisible();
});

it('un fallo al añadir la alternativa conserva EUR y permite reintentar', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue(uncoveredSummary);
  vi.spyOn(simulation.api.watchlist, 'add').mockRejectedValue(new Error('IPC'));
  const remove = vi.spyOn(simulation.api.watchlist, 'remove');
  render(<DataFreshness variant="banner" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Cambiar por FXE para EUR' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'No pudimos cambiar EUR. Tu lista se conserva. Inténtalo de nuevo.',
  );
  expect(remove).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Cambiar por FXE para EUR' })).toBeEnabled(),
  );
});

it('la alternativa ya guardada se reutiliza sin intentar añadirla de nuevo', async () => {
  await simulation.api.watchlist.add('FXE');
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue(uncoveredSummary);
  const add = vi.spyOn(simulation.api.watchlist, 'add');
  const remove = vi.spyOn(simulation.api.watchlist, 'remove');
  render(<DataFreshness variant="banner" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Cambiar por FXE para EUR' }));
  await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith('EUR'));
  expect(add).not.toHaveBeenCalled();
});

it('varios activos sin cobertura tienen acciones propias, incluida la falta de sugerencia', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue({
    ...uncoveredSummary,
    uncovered: [...uncoveredSummary.uncovered, { ticker: 'XYZ', suggestion: null, reason: null }],
  });
  render(<DataFreshness variant="banner" />);
  expect(await screen.findByText('2 activos necesitan atención')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Quitar XYZ de la lista' })).toBeEnabled();
  expect(screen.getAllByRole('button', { name: /Cambiar por/ })).toHaveLength(1);
  expect(screen.queryByText(/Régimen, predicciones y señales en pausa/)).not.toBeInTheDocument();
});

it('una pausa global real conserva su aviso y no promete que el resto está al día', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue({
    ...uncoveredSummary,
    state: 'stale',
    items: [
      {
        key: 'ticker:AAPL',
        label: 'AAPL',
        state: 'desactualizado',
        lastDataDate: null,
        reason: 'Faltan cierres.',
      },
    ],
  });
  render(<DataFreshness variant="banner" />);
  expect(await screen.findByText(STALE_PAUSE_TEXT)).toBeVisible();
  expect(
    screen.queryByText(/Los demás activos, predicciones y señales siguen al día/),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Quitar EUR de la lista' })).toBeEnabled();
});

it('sin red mantiene la retirada local y deshabilita el cambio que necesita conexión', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue(uncoveredSummary);
  render(<DataFreshness variant="banner" offline />);
  expect(await screen.findByRole('button', { name: 'Quitar EUR de la lista' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Cambiar por FXE para EUR' })).toBeDisabled();
  expect(
    screen.queryByText(/Los demás activos, predicciones y señales siguen al día/),
  ).not.toBeInTheDocument();
});

it('sin ningún activo cubierto explica la cobertura sin pedir claves que ya pueden estar configuradas', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue({
    ...uncoveredSummary,
    state: 'no-data',
  });
  render(<DataFreshness variant="banner" />);
  expect(
    await screen.findByRole('heading', { name: 'EUR no está disponible en Tiingo' }),
  ).toBeVisible();
  expect(screen.queryByText(/Sin configurar/)).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Ir a Ajustes' })).not.toBeInTheDocument();
  expect(screen.queryByText(/Los demás activos.*siguen al día/)).not.toBeInTheDocument();
});

it('los eventos de un refresco parcial conservan el recuento cuando el resto queda al día', async () => {
  let summary: DataFreshnessSummary = { ...uncoveredSummary, state: 'stale' };
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockImplementation(async () => summary);
  vi.spyOn(simulation.api.market, 'refreshNow').mockImplementation(async () => {
    summary = uncoveredSummary;
    simulation.emitDataStatus(stale);
    return {
      accepted: true,
      reason: null,
      ok: false,
      updated: 3,
      total: 4,
      failedTickers: ['EUR'],
    };
  });
  render(<DataFreshness variant="banner" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Actualizar ahora' }));
  await waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Actualizar ahora' })).not.toBeInTheDocument();
    expect(screen.getByText('Actualizados 3 de 4 · sin datos: EUR')).toBeVisible();
  });
  expect(screen.queryByText('Datos actualizados.')).not.toBeInTheDocument();
});
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

it('banner, Inicio, Mercado, Macro e IA comparten fecha; solo la franja lleva motivo y acciones', async () => {
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
    if (surface.type === ProviderBanner) {
      const freshness = screen.getByLabelText('Estado de los datos');
      expect(within(freshness).getByText(stale.reason, { selector: 'p' })).toBeInTheDocument();
      expect(within(freshness).getByRole('button', { name: 'Actualizar ahora' })).toBeEnabled();
      expect(within(freshness).getByRole('link', { name: 'Probar conexión' })).toHaveAttribute(
        'href',
        '#ajustes?provider=tiingo&focus=test',
      );
    } else {
      const chip = screen.getByLabelText('Frescura de datos');
      expect(chip).toHaveTextContent('Datos desactualizados desde el 25 sept 2026');
      expect(within(chip).queryAllByRole('button')).toHaveLength(0);
    }
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
    render(<DataFreshness variant="banner" />);
    expect(
      (await screen.findAllByText(progress ? /Descargando 3 de 7 activos/ : /Poniéndose al día/))
        .length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/siguen con el último dato fiable/)).toBeInTheDocument();
    expect(screen.queryByText(/esperan a terminar/)).not.toBeInTheDocument();
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
  render(
    <>
      <DataFreshness variant="banner" />
      <DataFreshness />
    </>,
  );
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
  render(
    <>
      <DataFreshness variant="banner" />
      <DataFreshness />
    </>,
  );
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
  render(
    <>
      <DataFreshness variant="banner" />
      <DataFreshness />
    </>,
  );
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

it('un EUR/USD desactualizado explica el calendario 24/5 de las divisas', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue({
    ...uncoveredSummary,
    state: 'stale',
    uncovered: [],
    items: [
      {
        key: 'ticker:EURUSD',
        label: 'EURUSD',
        state: 'desactualizado',
        lastDataDate: '2026-10-08',
        reason: 'Falta la vela del 9 de octubre.',
      },
    ],
  });
  render(<DataFreshness variant="banner" />);
  expect(
    await screen.findByText(
      /Divisas: calendario 24\/5, de lunes a viernes\. No se esperan datos en fin de semana; sí en los festivos de EE\. UU\./,
    ),
  ).toBeVisible();
  await userEvent.click(screen.getByText('Por qué ocurre'));
  expect(screen.getByText(/EUR\/USD · divisa 24\/5\s+· último dato/)).toBeVisible();
});
it('el detalle de EUR sin cobertura propone seguir EUR/USD sin jerga', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue(uncoveredSummary);
  render(<DataFreshness variant="banner" />);
  const notice = await screen.findByRole('region', { name: 'Activos sin datos' });
  await userEvent.click(within(notice).getByText('Por qué ocurre'));
  expect(
    within(notice).getByText(
      /añade EUR\/USD desde la lista de seguimiento: es el par que Tiingo sí cubre\. Solo tiene datos de lunes a viernes\./,
    ),
  ).toBeVisible();
  // El orden de teclado del aviso no cambia: la alternativa, quitar y el detalle.
  expect(
    within(notice)
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['Cambiar por FXE', 'Quitar de la lista']);
});

it('un EUR sin cobertura se avisa una sola vez aunque la pantalla tenga su propio estado', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue(uncoveredSummary);
  render(
    <>
      <ProviderBanner />
      <MarketDataPage kind="mercado" />
      <Dashboard
        system={{ connectivity: null, agents: null, connectionError: false, agentsError: false }}
      />
    </>,
  );
  await screen.findByRole('region', { name: 'Activos sin datos' });
  expect(screen.getAllByRole('heading', { name: 'EUR no está disponible en Tiingo' })).toHaveLength(
    1,
  );
  expect(screen.getAllByRole('button', { name: 'Quitar EUR de la lista' })).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Cambiar por FXE para EUR' })).toHaveLength(1);
  expect(screen.queryByRole('group', { name: 'Frescura de datos' })).not.toBeInTheDocument();
  expect(
    screen.getAllByRole('status').filter((node) => node.textContent?.includes('EUR')),
  ).toHaveLength(1);
});
it('«Precios» sigue «Disponible» cuando solo un activo no tiene cobertura', async () => {
  const at = '2026-10-09T10:00:00Z';
  const row = (key: string, state: 'fiable' | 'sin-cobertura') => ({
    key,
    state,
    lastOkAt: at,
    consecutiveFailures: 0,
    reason: null,
    updatedAt: at,
  });
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue(uncoveredSummary);
  vi.spyOn(simulation.api.dataStatus, 'get').mockResolvedValue([
    row('provider:tiingo', 'fiable'),
    row('ticker:SPY', 'fiable'),
    row('ticker:AAPL', 'fiable'),
    row('ticker:EUR', 'sin-cobertura'),
  ]);
  render(
    <Dashboard
      system={{ connectivity: null, agents: null, connectionError: false, agentsError: false }}
    />,
  );
  const connection = await screen.findByRole('region', { name: 'Conexión y fuentes' });
  const prices = (await within(connection).findByText('Precios · Tiingo')).closest(
    '.dashboard-row',
  ) as HTMLElement;
  await waitFor(() => expect(within(prices).getByText('Disponible')).toBeVisible());
  expect(within(prices).queryByText('Sin evaluar')).not.toBeInTheDocument();
});
it('el aviso de datos atrasados usa «Por qué ocurre» y solo promete lo que el motor pausa', async () => {
  vi.spyOn(simulation.api.dataStatus, 'freshness').mockResolvedValue({
    ...uncoveredSummary,
    state: 'stale',
    uncovered: [],
    items: [
      {
        key: 'ticker:SPY',
        label: 'SPY',
        state: 'desactualizado',
        lastDataDate: '2026-10-08',
        reason: 'Falta la vela del 9 de octubre.',
      },
    ],
  });
  render(<DataFreshness variant="banner" />);
  expect(await screen.findByText(STALE_PAUSE_TEXT)).toBeVisible();
  expect(STALE_PAUSE_TEXT).not.toMatch(/en pausa/);
  expect(screen.getByText('Por qué ocurre')).toBeVisible();
  expect(screen.queryByText('Ver detalles')).not.toBeInTheDocument();
});
it('con datos atrasados la franja lleva el aviso y sus acciones una sola vez en cada pantalla', async () => {
  simulation.emitDataStatus(stale);
  render(
    <>
      <ProviderBanner />
      <Dashboard
        system={{ connectivity: null, agents: null, connectionError: false, agentsError: false }}
      />
      <MarketDataPage kind="mercado" />
      <AiPage />
    </>,
  );
  const banner = await screen.findByRole('region', { name: 'Estado de los datos' });
  await waitFor(() =>
    expect(screen.getAllByRole('group', { name: 'Frescura de datos' })).toHaveLength(3),
  );
  // Cada pantalla conserva un chip con el mismo título, sin repetir acciones ni anuncios.
  for (const chip of screen.getAllByRole('group', { name: 'Frescura de datos' })) {
    expect(chip).toHaveTextContent('Datos desactualizados desde el 25 sept 2026');
    expect(within(chip).queryAllByRole('button')).toHaveLength(0);
    expect(within(chip).queryAllByRole('link')).toHaveLength(0);
    expect(within(chip).queryAllByRole('status')).toHaveLength(0);
    expect(within(chip).queryByText('Por qué ocurre')).not.toBeInTheDocument();
  }
  expect(screen.getAllByRole('button', { name: 'Actualizar ahora' })).toHaveLength(1);
  expect(screen.getAllByRole('link', { name: 'Probar conexión' })).toHaveLength(1);
  expect(screen.getAllByText('Por qué ocurre')).toHaveLength(1);
  expect(screen.getAllByText(STALE_PAUSE_TEXT)).toHaveLength(1);
  expect(within(banner).getByRole('button', { name: 'Actualizar ahora' })).toBeEnabled();
  expect(within(banner).getByText(stale.reason, { selector: 'p' })).toBeInTheDocument();
});
