// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { Dashboard } from './Dashboard';
import type { SystemState } from '../../hooks/useSystemState';
import type { SignalNewEvent } from '../../../../shared/signals';
import { signal, portfolio, strategies, contradiction } from './testFixtures';
import { DrawdownBlock, ExposureBlock } from './PortfolioBlocks';
import { PositionsBlock } from './PositionsBlock';
import { SignalsBlock } from './SignalsBlock';
const system: SystemState = {
  connectivity: null,
  agents: null,
  connectionError: false,
  agentsError: false,
};
beforeEach(() => {
  window.tradia = createSimulatedAdapter().api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function seed() {
  vi.spyOn(window.tradia.signals, 'list').mockResolvedValue([signal]);
  vi.spyOn(window.tradia.signals, 'strategies').mockResolvedValue(strategies);
  vi.spyOn(window.tradia.risk, 'getPortfolio').mockResolvedValue(portfolio);
  vi.spyOn(window.tradia.journal, 'list').mockResolvedValue({
    entries: [contradiction],
    total: 1,
    limit: 20,
    offset: 0,
  });
}
it('conserva los siete títulos y geometría durante la carga', () => {
  vi.spyOn(window.tradia.signals, 'list').mockReturnValue(new Promise(() => {}));
  render(<Dashboard system={system} />);
  expect(screen.getAllByRole('region')).toHaveLength(7);
  expect(screen.getByRole('region', { name: 'Señales vivas' })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  expect(screen.getAllByText('Cargando…').length).toBeGreaterThan(0);
});
it('explica el vacío de cada bloque sin cifras inventadas', async () => {
  vi.spyOn(window.tradia.macro, 'getSeries').mockResolvedValue([]);
  vi.spyOn(window.tradia.sources, 'list').mockResolvedValue([]);
  render(<Dashboard system={system} />);
  expect(await screen.findByText(/Todavía no hay señales/)).toBeVisible();
  expect(screen.getByText(/No hay posiciones simuladas abiertas/)).toBeVisible();
  expect(screen.getByText('No hay estrategias.')).toBeVisible();
  expect(screen.getByText(/No hay fuentes de noticias/)).toBeVisible();
  expect(screen.getByText(/No hay exposición simulada/)).toBeVisible();
  expect(screen.getAllByText('Sin dato')).toHaveLength(3);
});
it('muestra conexión, fuentes y frescura verificadas', async () => {
  vi.spyOn(window.tradia.dataStatus, 'get').mockResolvedValue([
    {
      key: 'provider:tiingo',
      state: 'fiable',
      lastOkAt: signal.createdAt,
      consecutiveFailures: 0,
      reason: null,
      updatedAt: signal.createdAt,
    },
    {
      key: 'ticker:AAPL',
      state: 'desactualizado',
      lastOkAt: signal.createdAt,
      consecutiveFailures: 0,
      reason: 'Retraso',
      updatedAt: signal.createdAt,
    },
  ]);
  render(<Dashboard system={system} />);
  const connection = screen.getByRole('region', { name: 'Conexión y fuentes' });
  expect(await within(connection).findByText('Precios · Tiingo')).toBeVisible();
  expect(within(connection).getByText('Con retraso')).toBeVisible();
  expect(within(connection).getByText('Comprobando…')).toBeVisible();
});
it('reutiliza macro con indicadores, procedencia y datos obsoletos', async () => {
  vi.spyOn(window.tradia.macro, 'getSeries').mockResolvedValue([
    {
      id: 'VIXCLS',
      name: 'VIX',
      unit: 'puntos',
      frequency: 'diaria',
      observations: [{ date: '2026-10-08', value: 21.4 }],
      status: {
        key: 'macro:VIXCLS',
        state: 'desactualizado',
        lastOkAt: signal.createdAt,
        updatedAt: signal.createdAt,
        reason: 'Dato vencido',
        consecutiveFailures: 0,
      },
    },
  ]);
  render(<Dashboard system={system} />);
  expect(await screen.findByText('21,40 puntos')).toBeVisible();
  expect(screen.getByText('Desactualizado')).toBeVisible();
  expect(screen.getByText('Dato vencido')).toBeVisible();
  expect(screen.getByText('Sin clasificar')).toBeVisible();
});
it('muestra motivos, confianza, decisiones, versiones y contradicción', async () => {
  seed();
  render(<Dashboard system={system} />);
  expect(await screen.findByText(signal.reason)).toBeVisible();
  expect(screen.getByRole('progressbar', { name: 'Confianza de AAPL' })).toHaveAttribute(
    'aria-valuenow',
    '78',
  );
  expect(screen.getByText('✓ Aprobada')).toBeVisible();
  expect(screen.getByText('↔ Sin señal · Contradicción')).toBeVisible();
  expect(screen.getByText(contradiction.reason)).toBeVisible();
  expect(screen.getByRole('link', { name: 'Ver en Diario · AAPL' })).toHaveAttribute(
    'href',
    '#diario?signalId=1',
  );
  const agents = screen.getByRole('region', { name: 'Estado por estrategia' });
  expect(within(agents).getByText('v3 · cierre 2026-10-08')).toBeVisible();
  expect(within(agents).getByText('● Activa')).toBeVisible();
  expect(within(agents).getByText('◇ Paper')).toBeVisible();
});
it('explica vetos y tamaño reducido con la decisión de riesgo', () => {
  render(
    <SignalsBlock
      signals={[
        {
          ...signal,
          decision: {
            ...signal.decision,
            status: 'vetada',
            reasons: [{ code: 'MAX_DRAWDOWN', message: 'Drawdown máximo alcanzado', details: {} }],
          },
        },
      ]}
      contradictions={[]}
      stopped={false}
    />,
  );
  expect(screen.getByText('× Vetada')).toBeVisible();
  expect(screen.getByText('Riesgo: Drawdown máximo alcanzado')).toBeVisible();
});
it('identifica posiciones simuladas y precios y P&L con signo', () => {
  render(<PositionsBlock positions={portfolio.positions} />);
  expect(screen.getByText('◇ Simulación')).toBeVisible();
  expect(screen.getByText('25 u')).toBeVisible();
  expect(screen.getByText('102 USD')).toBeVisible();
  expect(screen.getByText(/\+50 USD/)).toBeVisible();
  expect(screen.getByText('No son posiciones reales.')).toBeVisible();
});
it('no inventa P&L cuando falta cotización', () => {
  render(
    <PositionsBlock
      positions={[{ ...portfolio.positions[0]!, markPrice: null, pnl: null, pnlPct: null }]}
    />,
  );
  expect(screen.getAllByText('Sin cotización')).toHaveLength(2);
});
it.each([
  [3.2, 'Dentro del límite'],
  [8, 'Cautela · cerca del límite'],
  [10, 'Límite alcanzado'],
])('compara drawdown %s frente al límite', (drawdownPct, label) => {
  render(<DrawdownBlock portfolio={{ ...portfolio, drawdownPct }} />);
  expect(screen.getByText(label)).toBeVisible();
  expect(screen.getByRole('progressbar')).toHaveAttribute(
    'aria-valuetext',
    `${String(drawdownPct).replace('.', ',')} % de 10 %`,
  );
});
it('cambia exposición por activo y sector usando el teclado', async () => {
  const user = userEvent.setup();
  render(<ExposureBlock portfolio={portfolio} />);
  expect(screen.getByRole('progressbar', { name: 'Exposición de AAPL' })).toHaveAttribute(
    'aria-valuetext',
    '25,5 %; límite 30 %',
  );
  await user.tab();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Por sector' })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(screen.getByText('Tecnología')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Por sector' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});
it('conserva la instantánea y la rotula al perder la conexión', async () => {
  seed();
  const { rerender } = render(<Dashboard system={system} />);
  await screen.findByText(signal.reason);
  const connectivity = await window.tradia.connectivity.getState();
  rerender(
    <Dashboard system={{ ...system, connectivity: { ...connectivity, status: 'offline' } }} />,
  );
  expect(screen.getByText('Sin conexión')).toBeVisible();
  expect(screen.getByText(/Datos congelados/)).toBeVisible();
  expect(screen.getByText(signal.reason)).toBeVisible();
});
it('parada activa bloquea señales y estrategias manteniendo posiciones visibles', async () => {
  seed();
  await window.tradia.risk.activateKillSwitch();
  render(<Dashboard system={system} />);
  expect(await screen.findByText('No se admiten nuevas señales.')).toBeVisible();
  expect(screen.getAllByText('Bloqueada por parada')).toHaveLength(2);
  expect(screen.getByText(/\+50 USD/)).toBeVisible();
});
it('un fallo parcial no inutiliza el resto y permite reintentar', async () => {
  seed();
  vi.spyOn(window.tradia.risk, 'getPortfolio').mockRejectedValueOnce(new Error('IPC'));
  const user = userEvent.setup();
  render(<Dashboard system={system} />);
  expect(await screen.findByText(signal.reason)).toBeVisible();
  const positions = screen.getByRole('region', { name: 'Posiciones simuladas' });
  expect(await within(positions).findByRole('alert')).toBeVisible();
  await user.click(within(positions).getByRole('button', { name: 'Reintentar' }));
  expect(await screen.findByText(/\+50 USD/)).toBeVisible();
});
it('signals:new se intercala sin duplicados ni pérdida de foco y limpia listeners', async () => {
  let notify: (event: SignalNewEvent) => void = () => {};
  const unsubscribe = vi.fn();
  vi.spyOn(window.tradia.signals, 'onNew').mockImplementation((listener) => {
    notify = listener;
    return unsubscribe;
  });
  seed();
  const { unmount } = render(<Dashboard system={system} />);
  await screen.findByText(signal.reason);
  const focused = screen.getByRole('link', { name: 'Ver fuentes' });
  focused.focus();
  const newer = { ...signal, id: 2, ticker: 'NVDA', createdAt: '2026-10-09T14:00:00Z' };
  act(() => {
    notify({ signal: newer });
    notify({ signal: newer });
  });
  expect(await screen.findByText('NVDA')).toBeVisible();
  await waitFor(() => expect(screen.getAllByText('NVDA')).toHaveLength(1));
  expect(focused).toHaveFocus();
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
it('actualiza inmediatamente la parada por risk:changed aunque getKillSwitch devuelva una instantánea antigua', async () => {
  seed();
  const stop = await window.tradia.risk.getKillSwitch();
  let notify: (overview: import('../../../../shared/risk').RiskOverview) => void = () => {};
  vi.spyOn(window.tradia.risk, 'getKillSwitch').mockResolvedValue(stop);
  vi.spyOn(window.tradia.risk, 'onChanged').mockImplementation((listener) => {
    notify = listener;
    return () => {};
  });
  render(<Dashboard system={system} />);
  await screen.findByText(signal.reason);
  act(() =>
    notify({
      limits: {} as import('../../../../shared/risk').RiskLimits,
      killSwitch: { ...stop, active: true },
      caution: {} as import('../../../../shared/risk').CautionState,
    }),
  );
  await waitFor(() => expect(screen.getByText('No se admiten nuevas señales.')).toBeVisible());
});
it('conserva datos conocidos tras fallar una actualización de riesgo y cartera', async () => {
  seed();
  let notify: () => void = () => {};
  vi.spyOn(window.tradia.risk, 'onVetoed').mockImplementation((listener) => {
    notify = () => listener({} as import('../../../../shared/risk').RiskVeto);
    return () => {};
  });
  render(<Dashboard system={system} />);
  await screen.findByText(/\+50 USD/);
  vi.spyOn(window.tradia.risk, 'getPortfolio').mockRejectedValue(new Error('Offline'));
  act(() => notify());
  await waitFor(() =>
    expect(
      within(screen.getByRole('region', { name: 'Posiciones simuladas' })).getByRole('alert'),
    ).toBeVisible(),
  );
  expect(screen.getByText(/\+50 USD/)).toBeVisible();
});
it('no reemplaza una instantánea congelada con signals:new mientras está sin conexión', async () => {
  seed();
  let notify: (event: SignalNewEvent) => void = () => {};
  vi.spyOn(window.tradia.signals, 'onNew').mockImplementation((listener) => {
    notify = listener;
    return () => {};
  });
  const { rerender } = render(<Dashboard system={system} />);
  await screen.findByText(signal.reason);
  const connectivity = await window.tradia.connectivity.getState();
  rerender(
    <Dashboard system={{ ...system, connectivity: { ...connectivity, status: 'offline' } }} />,
  );
  act(() => notify({ signal: { ...signal, id: 2, ticker: 'NVDA' } }));
  expect(screen.queryByText('NVDA')).not.toBeInTheDocument();
});
it('una consulta inicial antigua no oculta una señal recibida durante la carga', async () => {
  let resolveList!: (signals: import('../../../../shared/signals').Signal[]) => void;
  vi.spyOn(window.tradia.signals, 'list')
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveList = resolve;
      }),
    )
    .mockResolvedValue([]);
  let notify: (event: SignalNewEvent) => void = () => {};
  vi.spyOn(window.tradia.signals, 'onNew').mockImplementation((listener) => {
    notify = listener;
    return () => {};
  });
  render(<Dashboard system={system} />);
  act(() => notify({ signal }));
  await screen.findByText(signal.reason);
  await act(async () => resolveList([]));
  expect(screen.getByText(signal.reason)).toBeVisible();
});
