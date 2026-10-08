// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { NewsFeed } from './NewsFeed';
import type { NewsItem } from '../../../../shared/ipc';

let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(() => {
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('muestra oficial, redes sin confirmar, horas locales y enlaces externos', async () => {
  render(<NewsFeed />);
  await screen.findByText('3 titulares disponibles.');
  const cards = screen.getAllByTestId('news-item');
  const social = cards.find((card) => card.textContent?.includes('Rumor en redes'))!;
  expect(within(social).getByText('⚠ Sin confirmar')).toBeInTheDocument();
  expect(within(social).queryByText('✓ Confirmada')).not.toBeInTheDocument();
  expect(screen.getByText(/Oficial ·/)).toBeInTheDocument();
  const link = screen.getByRole('link', { name: /La Fed/ });
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  expect(cards[0]!.querySelector('time')).toHaveAttribute('datetime');
});

it('combina filtros de prioridad, fiabilidad y activo y permite restablecerlos', async () => {
  render(<NewsFeed />);
  await screen.findByText('3 titulares disponibles.');
  fireEvent.change(screen.getByLabelText('Prioridad'), { target: { value: 'maxima' } });
  expect(screen.getAllByTestId('news-item')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Fiabilidad'), { target: { value: 'redes' } });
  expect(screen.queryAllByTestId('news-item')).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Restablecer filtros' }));
  fireEvent.change(screen.getByLabelText('Activo'), { target: { value: 'AAPL' } });
  expect(screen.getAllByTestId('news-item')).toHaveLength(1);
  expect(screen.getByText(/Apple supera/)).toBeInTheDocument();
});

it('agrupa fuentes en un único titular y protege confirmación incluso ante datos inconsistentes', async () => {
  const items = await simulation.api.news.list();
  items[0]!.sources.push({ id: 99, name: 'Otra agencia', reliability: 'agencia' });
  items[2]!.confirmed = true;
  vi.spyOn(simulation.api.news, 'list').mockResolvedValue(items);
  render(<NewsFeed />);
  await screen.findByText('3 titulares disponibles.');
  expect(screen.getAllByTestId('news-item')).toHaveLength(3);
  expect(screen.getByText('Agencia · Otra agencia')).toBeInTheDocument();
  expect(screen.getAllByText('Fuentes agrupadas').length).toBeGreaterThan(0);
  expect(screen.getByText('⚠ Sin confirmar')).toBeInTheDocument();
});

it('retiene la lista y el scroll al recibir titulares mientras se lee más abajo', async () => {
  const list = vi.spyOn(simulation.api.news, 'list');
  const { container } = render(
    <main className="main">
      <NewsFeed />
    </main>,
  );
  await screen.findByText('3 titulares disponibles.');
  const main = container.querySelector('main')!;
  main.scrollTop = 350;
  const original = screen.getAllByTestId('news-item')[0];
  const items = await simulation.api.news.list();
  const fresh: NewsItem = {
    ...items[0]!,
    id: 1000,
    title: 'Nuevo comunicado oficial',
    publishedAt: new Date().toISOString(),
  };
  list.mockResolvedValue([fresh, ...items]);
  act(() => simulation.emitNewsUpdated({ newItems: 1, updatedAt: fresh.publishedAt }));
  const show = await screen.findByRole('button', { name: /1 titulares nuevos recibidos/ });
  expect(screen.queryByText('Nuevo comunicado oficial')).not.toBeInTheDocument();
  expect(screen.getAllByTestId('news-item')[0]).toBe(original);
  expect(main.scrollTop).toBe(350);
  main.scrollTo = vi.fn();
  fireEvent.click(show);
  expect(screen.getByText('Nuevo comunicado oficial')).toBeInTheDocument();
});

it('actualiza en la parte superior y limpia suscripciones al desmontarse', async () => {
  const items = await simulation.api.news.list();
  const list = vi.spyOn(simulation.api.news, 'list').mockResolvedValue(items);
  const { unmount } = render(<NewsFeed />);
  await screen.findByText('3 titulares disponibles.');
  list.mockResolvedValue([{ ...items[0]!, id: 100, title: 'Titular en vivo' }, ...items]);
  act(() => simulation.emitNewsUpdated({ newItems: 1, updatedAt: new Date().toISOString() }));
  await screen.findByText('Titular en vivo');
  unmount();
  expect(simulation.listenerCount()).toBe(0);
});

it('cubre carga, error, reintento, vacío y sin conexión', async () => {
  const list = vi
    .spyOn(simulation.api.news, 'list')
    .mockRejectedValueOnce(new Error('IPC'))
    .mockResolvedValue([]);
  render(<NewsFeed />);
  expect(screen.getByText('Cargando noticias…')).toBeInTheDocument();
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
  await screen.findByText('No hay noticias disponibles. Añade una fuente para recibir titulares.');
  const state = await simulation.api.connectivity.getState();
  act(() => simulation.emitConnectivity({ ...state, status: 'offline' }));
  await screen.findByText(/La lectura automática de fuentes está pausada/);
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
});
