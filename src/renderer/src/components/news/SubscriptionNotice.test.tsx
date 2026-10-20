// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { AiSettings } from '../settings/AiSettings';
import { NewsFeed } from './NewsFeed';
import { NewsSubscriptionNotice } from './SubscriptionNotice';
import { NEWS_SUBSCRIPTION_COPY } from '../../../../shared/newsSubscription';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(['cli-no-encontrada', 'sin-sesion', 'tope-diario', 'error'] as const)(
  'muestra %s en Noticias y Ajustes sin cambiar el foco, y desaparece al recuperarse',
  async (state) => {
    const simulation = createSimulatedAdapter();
    window.tradia = simulation.api;
    render(
      <>
        <button>Control previo</button>
        <NewsFeed />
        <AiSettings />
      </>,
    );
    await screen.findByRole('combobox', { name: 'Motor de análisis de noticias' });
    const previous = screen.getByRole('button', { name: 'Control previo' });
    previous.focus();
    act(() => simulation.forceNewsStatus(state));
    const notices = await screen.findAllByRole('status', { name: 'Estado de la suscripción' });
    expect(notices).toHaveLength(2);
    for (const notice of notices)
      expect(notice).toHaveTextContent(NEWS_SUBSCRIPTION_COPY[state].title);
    expect(notices[1]).toHaveTextContent(NEWS_SUBSCRIPTION_COPY[state].step);
    expect(notices[0]).toHaveTextContent('las noticias se analizan con el analizador local');
    await waitFor(() => expect(previous).toHaveFocus());
    expect(await simulation.api.ai.newsStatus()).toMatchObject({ state });
    act(() => simulation.forceNewsStatus('ok'));
    await waitFor(() =>
      expect(
        screen.queryByRole('status', { name: 'Estado de la suscripción' }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(previous).toHaveFocus());
  },
);

it('prueba una sola vez, conserva el foco tras recuperarse y libera los listeners', async () => {
  const simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  simulation.forceNewsStatus('sin-sesion');
  let resolve!: () => void;
  const test = vi.spyOn(simulation.api.ai, 'testLlm').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = () => {
          simulation.forceNewsStatus('ok');
          done({ ok: true, error: null, latencyMs: 12 });
        };
      }),
  );
  const { unmount } = render(<NewsSubscriptionNotice />);
  const retry = await screen.findByRole('button', { name: 'Probar de nuevo' });
  await userEvent.click(retry);
  await userEvent.click(screen.getByRole('button', { name: 'Probando…' }));
  expect(test).toHaveBeenCalledOnce();
  expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  await act(async () => resolve());
  await screen.findByText(/Suscripción recuperada/);
  await waitFor(() => expect(retry).toHaveFocus());
  unmount();
  expect(simulation.listenerCount()).toBe(0);
});

it('el evento push prevalece sobre una lectura inicial atrasada', async () => {
  const simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  const initial = await simulation.api.ai.newsStatus();
  let resolve!: (value: typeof initial) => void;
  vi.spyOn(simulation.api.ai, 'newsStatus').mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  render(<NewsSubscriptionNotice />);
  act(() => simulation.forceNewsStatus('sin-sesion'));
  await screen.findByText(NEWS_SUBSCRIPTION_COPY['sin-sesion'].title);
  await act(async () => resolve(initial));
  expect(screen.getByRole('status')).toHaveTextContent('No hay una sesión iniciada');
});

it('IDV-E2E-4: el título de «sin sesión» es el texto contractual y el detalle va aparte', async () => {
  const simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  render(<NewsSubscriptionNotice />);
  act(() => simulation.forceNewsStatus('sin-sesion'));
  const notice = await screen.findByRole('status', { name: 'Estado de la suscripción' });
  expect(notice.querySelector('strong')).toHaveTextContent(
    /^Suscripción no disponible · sesión no iniciada$/,
  );
  expect(notice.querySelector('p')).toHaveTextContent(
    'No hay una sesión iniciada en Claude Code. Abre un terminal, ejecuta claude y después /login. Vuelve aquí y prueba de nuevo.',
  );
});

it('permite reintentar si falla la lectura del estado', async () => {
  const simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  vi.spyOn(simulation.api.ai, 'newsStatus').mockRejectedValueOnce(new Error('IPC'));
  render(<NewsSubscriptionNotice />);
  await screen.findByText(/No se pudo consultar el estado/);
  await userEvent.click(screen.getByRole('button', { name: 'Probar de nuevo' }));
  await screen.findByText('Analizador local seleccionado');
});

it('reintenta desde Ajustes guardando antes, mantiene una sola acción y conserva el foco', async () => {
  const simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
  await simulation.api.ai.setLlmSettings({ provider: 'suscripcion', enabled: true });
  simulation.forceNewsStatus('sin-sesion');
  const save = vi.spyOn(simulation.api.ai, 'setLlmSettings');
  const test = vi.spyOn(simulation.api.ai, 'testLlm').mockImplementation(async () => {
    simulation.forceNewsStatus('ok');
    return { ok: true, error: null, latencyMs: 12 };
  });
  render(<AiSettings />);
  const retry = await screen.findByRole('button', { name: 'Probar de nuevo' });
  await userEvent.click(retry);
  await screen.findByText(/Suscripción recuperada/);
  expect(save).toHaveBeenCalledOnce();
  expect(test).toHaveBeenCalledOnce();
  expect(save.mock.invocationCallOrder[0]).toBeLessThan(test.mock.invocationCallOrder[0]!);
  expect(screen.getAllByRole('button', { name: 'Probar de nuevo' })).toHaveLength(1);
  await waitFor(() => expect(retry).toHaveFocus());
});

it.each([
  {
    engine: 'suscripcion-codex' as const,
    name: 'OpenAI Codex',
    cmd: 'codex',
  },
  {
    engine: 'suscripcion-antigravity' as const,
    name: 'Google Antigravity',
    cmd: 'agy',
  },
  {
    engine: 'suscripcion-copilot' as const,
    name: 'GitHub Copilot',
    cmd: 'copilot',
  },
])(
  'muestra nombre de $name e instrucción de $cmd en Ajustes para cli-no-encontrada y sin-sesion',
  async ({ engine, name, cmd }) => {
    const simulation = createSimulatedAdapter();
    window.tradia = simulation.api;
    await simulation.api.ai.setLlmSettings({
      provider: 'suscripcion',
      enabled: true,
      engine,
    });
    simulation.forceNewsStatus('cli-no-encontrada');
    const { unmount } = render(<AiSettings />);
    await screen.findByRole('combobox', { name: 'Motor de análisis de noticias' });

    // cli-no-encontrada
    const noticeCli = await screen.findByRole('status', { name: 'Estado de la suscripción' });
    expect(noticeCli).toHaveTextContent(`No encontramos el comando de ${name}`);
    expect(noticeCli).toHaveTextContent(`Instala ${name} en tu ordenador`);

    // sin-sesion
    act(() => simulation.forceNewsStatus('sin-sesion'));
    const noticeAuth = await screen.findByRole('status', { name: 'Estado de la suscripción' });
    expect(noticeAuth).toHaveTextContent(`No hay una sesión iniciada en ${name}`);
    expect(noticeAuth).toHaveTextContent(`ejecuta ${cmd} para iniciar sesión`);

    unmount();
  },
);
