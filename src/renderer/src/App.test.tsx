// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { LiveState } from '../../shared/live';
import { ONBOARDING_TOUR_VERSION } from '../../shared/ipc';
import { RISK_DISCLAIMER_VERSION } from '../../shared/riskDisclaimer';
import { createSimulatedAdapter } from './adapters/simulated';

let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(async () => {
  window.location.hash = '';
  localStorage.clear();
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  await simulation.api.settings.set({
    disclaimerAcceptedVersion: RISK_DISCLAIMER_VERSION,
    onboardingTourVersion: ONBOARDING_TOUR_VERSION,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const statusbar = () => within(screen.getByRole('contentinfo', { name: 'Estado del sistema' }));

describe('Estructura de Tradia', () => {
  it('navega entre Inicio y Ajustes con teclado y conserva la barra de estado', async () => {
    const user = userEvent.setup();
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByRole('link', { name: 'Inicio' })).toHaveAttribute('aria-current', 'page');
    const settings = screen.getByRole('link', { name: 'Ajustes' });
    settings.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Ajustes' })).toHaveFocus();
    expect(settings).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('region', { name: 'Preferencias' })).toBeInTheDocument();
    expect(statusbar().getByText('Comprobando conexión')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Inicio' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Estado del sistema' }),
    ).toBeInTheDocument();
  });

  it('muestra carga sin atribuir conexión o actividad antes de recibir datos', async () => {
    vi.spyOn(simulation.api.connectivity, 'getState').mockReturnValue(new Promise(() => {}));
    vi.spyOn(simulation.api.agents, 'getState').mockReturnValue(new Promise(() => {}));
    await act(async () => {
      render(<App />);
    });
    expect(statusbar().getByText('Cargando conexión…')).toBeInTheDocument();
    expect(statusbar().getByText('Cargando agentes…')).toBeInTheDocument();
    expect(statusbar().queryByText('En línea')).not.toBeInTheDocument();
    expect(statusbar().getAllByText('Pendiente')).toHaveLength(2);
  });

  it('actualiza conexión, pausa y latido mediante eventos del adaptador', async () => {
    await act(async () => {
      render(<App />);
    });
    await statusbar().findByText('Comprobando conexión');
    act(() => {
      simulation.emitConnectivity({
        status: 'offline',
        attempt: 1,
        lastCheckedAt: null,
        nextRetryAt: null,
      });
      simulation.emitAgents({ paused: true, pauseReason: 'sin-conexion', lastHeartbeatAt: null });
      simulation.emitHeartbeat('2026-10-08T08:42:00Z');
    });
    expect(statusbar().getByText('Sin conexión')).toBeInTheDocument();
    expect(statusbar().getByText('Agentes en pausa')).toBeInTheDocument();
    expect(
      statusbar().getByText(
        new Date('2026-10-08T08:42:00Z').toLocaleTimeString('es-ES', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
        }),
      ),
    ).toHaveAttribute('datetime', '2026-10-08T08:42:00Z');
    act(() => {
      simulation.emitConnectivity({
        status: 'online',
        attempt: 0,
        lastCheckedAt: null,
        nextRetryAt: null,
      });
      simulation.emitAgents({
        paused: false,
        pauseReason: null,
        lastHeartbeatAt: '2026-10-08T08:42:00Z',
      });
    });
    expect(statusbar().getByText('En línea')).toBeInTheDocument();
    expect(statusbar().getByText('Agentes activos')).toBeInTheDocument();
  });

  it('muestra fallos de consulta y se recupera con eventos posteriores', async () => {
    vi.spyOn(simulation.api.connectivity, 'getState').mockRejectedValue(new Error('IPC'));
    vi.spyOn(simulation.api.agents, 'getState').mockRejectedValue(new Error('IPC'));
    await act(async () => {
      render(<App />);
    });
    expect(await statusbar().findByText('Conexión no disponible')).toBeInTheDocument();
    expect(await statusbar().findByText('Agentes no disponibles')).toBeInTheDocument();
    act(() =>
      simulation.emitConnectivity({
        status: 'online',
        attempt: 0,
        lastCheckedAt: null,
        nextRetryAt: null,
      }),
    );
    expect(statusbar().getByText('En línea')).toBeInTheDocument();
  });

  it('no permite que una consulta antigua sobrescriba eventos recientes y limpia suscripciones', async () => {
    let resolveConnection!: (
      state: Awaited<ReturnType<typeof simulation.api.connectivity.getState>>,
    ) => void;
    vi.spyOn(simulation.api.connectivity, 'getState').mockReturnValue(
      new Promise((resolve) => {
        resolveConnection = resolve;
      }),
    );
    const { unmount } = render(<App />);
    await act(async () => {});
    act(() =>
      simulation.emitConnectivity({
        status: 'offline',
        attempt: 1,
        lastCheckedAt: null,
        nextRetryAt: null,
      }),
    );
    await act(async () =>
      resolveConnection({ status: 'online', attempt: 0, lastCheckedAt: null, nextRetryAt: null }),
    );
    expect(statusbar().getByText('Sin conexión')).toBeInTheDocument();
    expect(simulation.listenerCount()).toBe(16);
    unmount();
    expect(simulation.listenerCount()).toBe(0);
  });
});

it('navega a Mercado y Macro con teclado y muestra el vacío sin claves', async () => {
  const user = userEvent.setup();
  await act(async () => {
    render(<App />);
  });
  for (const [name, heading] of [
    ['Mercado', 'Mercado'],
    ['Macro', 'Contexto macro'],
  ]) {
    const link = screen.getByRole('link', { name });
    link.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toHaveFocus();
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByText('Conecta tus fuentes de datos.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Configurar claves' })).toHaveAttribute(
      'href',
      name === 'Macro' ? '#ajustes?provider=fred&focus=key' : '#ajustes?provider=tiingo&focus=key',
    );
  }
  await user.click(screen.getByRole('link', { name: 'Configurar claves' }));
  expect(await screen.findByRole('region', { name: 'Proveedores de datos' })).toBeInTheDocument();
});

it('prioriza configurar fuentes sin clave aunque fallen las consultas de datos', async () => {
  vi.spyOn(simulation.api.dataStatus, 'get').mockRejectedValue(new Error('IPC'));
  window.location.hash = '#mercado';
  await act(async () => {
    render(<App />);
  });
  expect(await screen.findByText('Conecta tus fuentes de datos.')).toBeInTheDocument();
});

it('navega con teclado a Noticias, Calendario y Fuentes y muestra sus estados vacíos', async () => {
  vi.spyOn(simulation.api.news, 'list').mockResolvedValue([]);
  vi.spyOn(simulation.api.calendar, 'list').mockResolvedValue([]);
  vi.spyOn(simulation.api.sources, 'list').mockResolvedValue([]);
  const user = userEvent.setup();
  await act(async () => {
    render(<App />);
  });
  for (const [name, empty] of [
    ['Noticias', 'No hay noticias disponibles. Añade una fuente para recibir titulares.'],
    ['Calendario', 'No hay eventos programados para esta semana.'],
    ['Fuentes', 'Todavía no has añadido fuentes de noticias.'],
  ] as const) {
    const link = screen.getByRole('link', { name });
    link.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name })).toHaveFocus();
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByText(empty)).toBeInTheDocument();
    expect(screen.getByRole('contentinfo', { name: 'Estado del sistema' })).toBeInTheDocument();
  }
});

it.each(['noticias', 'calendario', 'fuentes'] as const)('abre directamente #%s', async (route) => {
  window.location.hash = `#${route}`;
  await act(async () => {
    render(<App />);
  });
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
    { noticias: 'Noticias', calendario: 'Calendario', fuentes: 'Fuentes' }[route],
  );
});

it('muestra carga y permite reintentar una consulta fallida de noticias', async () => {
  window.location.hash = '#noticias';
  let reject!: (error: Error) => void;
  vi.spyOn(simulation.api.news, 'list').mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  await act(async () => {
    render(<App />);
  });
  expect(screen.getByText('Cargando noticias…')).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Feed de noticias' })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await act(async () => reject(new Error('IPC')));
  expect(screen.getByRole('alert')).toHaveTextContent('No pudimos consultar las noticias.');
  await userEvent.setup().click(screen.getByRole('button', { name: 'Reintentar' }));
  expect(await screen.findByText('3 titulares disponibles.')).toBeInTheDocument();
});

it('navega con teclado a las páginas paper después de Diario', async () => {
  const user = userEvent.setup();
  await act(async () => {
    render(<App />);
  });
  const links = within(screen.getByRole('navigation', { name: 'Principal' })).getAllByRole('link');
  const journalIndex = links.findIndex((link) => link.textContent === 'Diario');
  expect(
    links.slice(journalIndex + 1, journalIndex + 3).map((link) => link.getAttribute('href')),
  ).toEqual(['#ordenes', '#real-vs-backtest']);
  for (const name of ['Órdenes', 'Real vs backtest']) {
    const link = screen.getByRole('link', { name });
    link.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name })).toHaveFocus();
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('contentinfo', { name: 'Estado del sistema' })).toBeInTheDocument();
  }
});

it.each(['ordenes', 'real-vs-backtest'])('abre directamente #%s', async (route) => {
  window.location.hash = `#${route}`;
  await act(async () => {
    render(<App />);
  });
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
    route === 'ordenes' ? 'Órdenes' : 'Real vs backtest',
  );
});

const emitDifference = () =>
  simulation.emitReconcileDiscrepancy([
    {
      id: 1,
      runId: 1,
      type: 'posicion-cantidad',
      ticker: 'AAPL',
      detail: 'Cantidad distinta',
      appValue: '10 acciones',
      brokerValue: '8 acciones',
      status: 'abierta',
      createdAt: '2026-10-09T12:00:00Z',
      resolvedAt: null,
    },
  ]);

it('muestra el descuadre global, conserva el aviso al navegar y lo retira al resolverse', async () => {
  const user = userEvent.setup();
  await act(async () => {
    render(<App />);
  });
  await act(async () => {
    emitDifference();
  });
  const banner = screen.getByRole('alert', { name: 'Descuadre con el broker' });
  expect(banner).toHaveTextContent('AAPL: Tradia registra 10 acciones; broker paper, 8 acciones');
  expect(banner.closest('.app-global-banners')).toBeVisible();
  expect(banner.closest('.app')).toHaveClass('has-banner');
  await user.click(within(banner).getByRole('link', { name: 'Ver en Órdenes' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Órdenes' })).toHaveFocus();
  expect(banner).toBeVisible();
  await act(async () => {
    simulation.emitReconcileDiscrepancy([]);
  });
  expect(screen.queryByRole('alert', { name: 'Descuadre con el broker' })).not.toBeInTheDocument();
  expect(document.querySelector('.app-global-banners')).not.toBeVisible();
});

it('prioriza parada y desconexión y resume el descuadre sin un tercer banner', async () => {
  await act(async () => {
    render(<App />);
  });
  await act(async () => {
    await simulation.api.risk.activateKillSwitch();
    simulation.emitConnectivity({
      status: 'offline',
      attempt: 1,
      lastCheckedAt: null,
      nextRetryAt: null,
    });
    emitDifference();
  });
  const banners = document.querySelector('.app-global-banners')!;
  const stop = within(banners as HTMLElement).getByRole('alert');
  expect(stop).toHaveTextContent('Parada activa');
  expect(stop).toHaveTextContent('Sin conexión');
  expect(within(stop).getByRole('link', { name: 'Ver en Órdenes' })).toHaveAttribute(
    'href',
    '#ordenes',
  );
  expect(screen.queryByRole('alert', { name: 'Descuadre con el broker' })).not.toBeInTheDocument();
  expect(banners.querySelector('.offline-banner')).toBeVisible();
  await act(async () => {
    await simulation.api.risk.resumeKillSwitch({ confirm: true });
  });
  expect(screen.getByRole('alert', { name: 'Descuadre con el broker' })).toBeVisible();
});

it('marca Posiciones simuladas solo cuando hay una cuenta paper conectada', async () => {
  const user = userEvent.setup();
  await act(async () => {
    render(<App />);
  });
  expect(screen.queryByText('Paper conectado')).not.toBeInTheDocument();
  await user.click(screen.getByRole('link', { name: 'Ajustes' }));
  await act(async () => {
    await simulation.api.broker.connect({ apiKeyId: 'paper-key', apiSecret: 'paper-secret' });
  });
  await user.click(screen.getByRole('link', { name: 'Inicio' }));
  expect(
    await within(screen.getByRole('region', { name: 'Posiciones simuladas' })).findByText(
      'Paper conectado',
    ),
  ).toBeVisible();
});

const createStrategy = () =>
  simulation.api.strategies.create({
    name: 'Estrategia de prueba',
    hypothesis: 'Tendencia persistente',
    rules: {
      entry: 'Comprar',
      exit: 'Vender',
      stop: 'Cinco por ciento',
      target: 'Salida por señal',
    },
    markets: ['SPY'],
    parameters: {},
    regime: 'Tendencia',
    worksIn: ['tendencia'],
    failsIn: ['lateral'],
  });
const online = () =>
  simulation.emitConnectivity({
    status: 'online',
    attempt: 0,
    lastCheckedAt: '2026-10-10T14:00:00Z',
    nextRetryAt: null,
  });

it('abre IA, Salud de modelos y Dinero real con teclado en el orden aprobado', async () => {
  online();
  const user = userEvent.setup();
  await act(async () => {
    render(<App />);
  });
  const nav = within(screen.getByRole('navigation', { name: 'Principal' }));
  const routes = nav.getAllByRole('link').map((link) => link.getAttribute('href'));
  expect(routes.slice(1, 4)).toEqual(['#mercado', '#ia', '#salud-modelos']);
  expect(routes.slice(-2)).toEqual(['#dinero-real', '#ajustes']);
  for (const name of ['IA', 'Salud de modelos', 'Dinero real']) {
    const link = nav.getByRole('link', { name });
    link.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('heading', { level: 1, name })).toHaveFocus();
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { level: 2, name })).toBeVisible();
  }
  expect(screen.getByRole('heading', { name: 'Prueba de humo · 1,00 USD reales' })).toBeVisible();
  expect(screen.getByRole('heading', { name: 'Estado del escalado' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Activar dinero real' })).toBeDisabled();
});

it.each([
  ['ia', 'IA'],
  ['salud-modelos', 'Salud de modelos'],
  ['dinero-real', 'Dinero real'],
])('abre directamente #%s', async (route, name) => {
  online();
  window.location.hash = `#${route}`;
  await act(async () => {
    render(<App />);
  });
  expect(screen.getByRole('heading', { level: 1, name })).toBeVisible();
  expect(screen.getByRole('heading', { level: 2, name })).toBeVisible();
});

it('conecta la ficha de estrategia desde IA y la evidencia del checklist', async () => {
  await createStrategy();
  online();
  window.location.hash = '#ia';
  const user = userEvent.setup();
  await act(async () => {
    render(<App />);
  });
  await user.click((await screen.findAllByRole('button', { name: /^Ver ficha de / }))[0]!);
  expect(window.location.hash).toMatch(/^#estrategias\/\d+$/);
  expect(await screen.findByRole('heading', { level: 1, name: 'Estrategias' })).toHaveFocus();
  await user.click(screen.getByRole('link', { name: 'Dinero real' }));
  await user.click(await screen.findByRole('button', { name: 'Ver validación' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Estrategias' })).toHaveFocus();
});

it('monta los ajustes LLM y la conexión live junto a las preferencias existentes', async () => {
  online();
  window.location.hash = '#ajustes';
  await act(async () => {
    render(<App />);
  });
  expect(screen.getByRole('region', { name: 'Análisis de noticias' })).toBeVisible();
  expect(screen.getByRole('region', { name: 'Cuenta de broker · Dinero real' })).toBeVisible();
  expect(await screen.findByRole('region', { name: 'Claves live bloqueadas' })).toBeVisible();
});

it('conserva una única franja DINERO REAL en todas las páginas y en el aviso legal', async () => {
  online();
  const initial = await simulation.api.live.state();
  const active: LiveState = {
    ...initial,
    mode: 'activo',
    hasCredentials: true,
    accountMasked: '•••• 4821',
    limits: { capitalUsd: 500, orderUsd: 100, dailyLossUsd: 10, openPositions: 1 },
    activatedAt: '2026-10-10T14:00:00Z',
  };
  vi.spyOn(simulation.api.live, 'state').mockResolvedValue(active);
  const user = userEvent.setup();
  const { unmount } = render(<App />);
  const banner = await screen.findByRole('complementary', { name: 'Aviso de dinero real' });
  expect(banner).toHaveTextContent('DINERO REAL');
  expect(banner).toHaveTextContent('•••• 4821');
  expect(banner).toHaveTextContent('Capital 500,00 USD');
  expect(banner.closest('.app')).toHaveClass('has-banner');
  const links = within(screen.getByRole('navigation', { name: 'Principal' })).getAllByRole('link');
  for (const link of links) {
    link.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(link).toHaveAttribute('aria-current', 'page'));
    if (link.textContent !== 'Inicio') {
      await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
    }
    expect(screen.getAllByRole('complementary', { name: 'Aviso de dinero real' })).toHaveLength(1);
    expect(banner).toBeVisible();
  }
  await user.click(screen.getByRole('button', { name: /^Ver aviso de riesgo/ }));
  expect(banner).toBeVisible();
  await user.click(
    within(screen.getByRole('navigation', { name: 'Principal' })).getByRole('link', { name: 'IA' }),
  );
  expect(await screen.findByRole('heading', { level: 2, name: 'IA' })).toBeVisible();
  expect(banner).toBeVisible();
  unmount();
  expect(simulation.listenerCount()).toBe(0);
});

it('actualiza franja, cabecera y aviso principal al activar, suspender y volver a paper', async () => {
  online();
  const initial = await simulation.api.live.state();
  let state = initial;
  vi.spyOn(simulation.api.live, 'state').mockImplementation(async () => state);
  const listeners = new Set<(value: LiveState) => void>();
  vi.spyOn(simulation.api.live, 'onChanged').mockImplementation((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });
  await act(async () => {
    render(<App />);
  });
  expect(
    screen.queryByRole('complementary', { name: 'Aviso de dinero real' }),
  ).not.toBeInTheDocument();
  act(() => {
    state = { ...initial, mode: 'activo' };
    listeners.forEach((listener) => listener(state));
  });
  expect(screen.getByRole('complementary', { name: 'Aviso de dinero real' })).toBeVisible();
  expect(
    within(screen.getByRole('heading', { level: 1 }).parentElement!).getByText(
      'Dinero real activo',
    ),
  ).toBeVisible();
  const notices = within(screen.getByRole('region', { name: 'Avisos de IA y dinero real' }));
  expect(notices.getByRole('alert')).toHaveTextContent('Dinero real activo');
  act(() => {
    state = {
      ...state,
      mode: 'suspendido',
      suspension: { reason: 'sin-conexion', detail: 'Conexión perdida' },
    };
    listeners.forEach((listener) => listener(state));
  });
  expect(screen.getByRole('complementary', { name: 'Aviso de dinero real' })).toHaveTextContent(
    'DINERO REAL SUSPENDIDO',
  );
  expect(notices.getByRole('alert')).toHaveTextContent('Conexión perdida');
  act(() => {
    listeners.forEach((listener) => listener(initial));
  });
  expect(
    screen.queryByRole('complementary', { name: 'Aviso de dinero real' }),
  ).not.toBeInTheDocument();
  expect(notices.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByText('Señales + paper trading')).toBeVisible();
});

it('anuncia degradación recibida por evento en Inicio y abre Salud de modelos', async () => {
  await createStrategy();
  online();
  const original = await simulation.api.ai.health();
  const health = vi.spyOn(simulation.api.ai, 'health').mockResolvedValue(original);
  const user = userEvent.setup();
  await act(async () => {
    render(<App />);
  });
  expect(screen.queryByRole('heading', { name: 'Degradación detectada' })).not.toBeInTheDocument();
  health.mockResolvedValue({
    ...original,
    subjects: original.subjects.map((row) =>
      row.subject === 'estrategia'
        ? { ...row, state: 'degradada', reason: 'Drift sostenido verificado' }
        : row,
    ),
  });
  await act(async () => {
    simulation.emitAiChanged('salud');
  });
  const alert = screen
    .getByRole('heading', { name: 'Degradación detectada' })
    .closest('[role="alert"]') as HTMLElement;
  expect(alert).toHaveTextContent('Drift sostenido verificado');
  await user.click(
    within(alert).getByRole('link', { name: 'Ver degradación y propuestas de reentrenamiento' }),
  );
  expect(await screen.findByRole('heading', { level: 1, name: 'Salud de modelos' })).toHaveFocus();
});

it('muestra carga, error recuperable y desconexión sin afirmar que los modelos están sanos', async () => {
  online();
  let reject!: (cause: Error) => void;
  vi.spyOn(simulation.api.ai, 'health').mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  await act(async () => {
    render(<App />);
  });
  expect(screen.getByText('Comprobando degradación de modelos y estrategias…')).toBeVisible();
  await act(async () => {
    reject(new Error('IPC'));
  });
  expect(screen.getByText(/No se pudo verificar la degradación/)).toBeVisible();
  expect(screen.getByRole('link', { name: 'Revisar salud de modelos' })).toHaveAttribute(
    'href',
    '#salud-modelos',
  );
  act(() => {
    simulation.emitConnectivity({
      status: 'offline',
      attempt: 1,
      lastCheckedAt: null,
      nextRetryAt: null,
    });
  });
  expect(screen.getByText(/Sin conexión · revisión de salud pausada/)).toBeVisible();
});

it('mantiene visible la franja aunque la consulta de modo de la cabecera siga pendiente', async () => {
  const initial = await simulation.api.live.state();
  vi.spyOn(simulation.api.live, 'state')
    .mockResolvedValueOnce({ ...initial, mode: 'activo' })
    .mockReturnValue(new Promise(() => {}));
  await act(async () => {
    render(<App />);
  });
  expect(screen.getByText('Comprobando modo…')).toBeVisible();
  const banner = await screen.findByRole('complementary', { name: 'Aviso de dinero real' });
  expect(banner).toBeVisible();
  expect(banner.closest('.app-banner-stack')).not.toHaveAttribute('hidden');
});
