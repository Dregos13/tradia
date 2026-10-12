// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createSimulatedAdapter } from '../../adapters/simulated';
import { readFileSync } from 'node:fs';
const globalStyles = readFileSync('src/renderer/src/styles.css', 'utf8');
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
  expect(within(social).getByText('Sin verificar · no genera señales')).toBeInTheDocument();
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
  expect(screen.getByText('Sin verificar · no genera señales')).toBeInTheDocument();
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

it('muestra resumen y sentimiento por activo con método y fecha', async () => {
  const items = (await simulation.api.news.list()).sort((a, b) => a.id - b.id);
  vi.spyOn(simulation.api.ai, 'newsAnalysis').mockImplementation(async ({ newsItemId } = {}) =>
    newsItemId === items[0]!.id
      ? [
          {
            id: 1,
            newsItemId,
            ticker: 'SPY',
            summary: 'Resumen confirmado del sistema.',
            sentiment: 'positivo',
            analyzer: 'llm',
            model: 'modelo-prueba',
            analyzedAt: items[0]!.publishedAt,
            publishedAt: items[0]!.publishedAt,
          },
          {
            id: 2,
            newsItemId,
            ticker: 'QQQ',
            summary: 'Resumen local para QQQ.',
            sentiment: 'negativo',
            analyzer: 'local',
            model: null,
            analyzedAt: items[0]!.publishedAt,
            publishedAt: items[0]!.publishedAt,
          },
        ]
      : [],
  );
  render(<NewsFeed />);
  await screen.findByText('Resumen confirmado del sistema.');
  expect(screen.getByText('SPY · Sentimiento Favorable')).toBeInTheDocument();
  expect(screen.getByText('QQQ · Sentimiento Desfavorable')).toBeInTheDocument();
  expect(screen.getByText(/Método: LLM · modelo-prueba/)).toBeInTheDocument();
  expect(screen.getByText(/Método: Análisis local/)).toBeInTheDocument();
  expect(screen.getAllByText(/Riesgo conserva el veto/).length).toBeGreaterThan(0);
});

it('no consulta ni muestra sentimientos de titulares sin verificar o solo sociales', async () => {
  const items = (await simulation.api.news.list()).sort((a, b) => a.id - b.id);
  items[0]!.confirmed = false;
  items[2]!.confirmed = true;
  vi.spyOn(simulation.api.news, 'list').mockResolvedValue(items);
  const analysis = vi.spyOn(simulation.api.ai, 'newsAnalysis');
  render(<NewsFeed />);
  await screen.findByText('3 titulares disponibles.');
  for (const index of [0, 2]) {
    const card = screen
      .getAllByTestId('news-item')
      .find((node) => node.textContent?.includes(items[index]!.title))!;
    expect(within(card).getByText('Sin verificar · no genera señales')).toBeInTheDocument();
    expect(within(card).queryByText(/Sentimiento/)).not.toBeInTheDocument();
    expect(analysis).not.toHaveBeenCalledWith({ newsItemId: items[index]!.id });
  }
});

it('conserva el titular ante fallo de análisis y permite reintentarlo', async () => {
  vi.spyOn(simulation.api.ai, 'newsAnalysis').mockRejectedValueOnce(new Error('red'));
  render(<NewsFeed />);
  await screen.findByText(/No se pudo analizar este titular/);
  expect(screen.getByRole('link', { name: /La Fed/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reintentar análisis' }));
  await waitFor(() =>
    expect(screen.queryByText(/No se pudo analizar este titular/)).not.toBeInTheDocument(),
  );
});

it('actualiza el análisis al recibir ai:changed sin sustituir el titular', async () => {
  const read = vi.spyOn(simulation.api.ai, 'newsAnalysis').mockResolvedValue([]);
  render(<NewsFeed />);
  await screen.findAllByText('Sin análisis disponible para este titular.');
  const headline = screen.getByRole('link', { name: /La Fed/ });
  read.mockImplementation(async ({ newsItemId } = {}) => [
    {
      id: 99,
      newsItemId: newsItemId!,
      ticker: 'SPY',
      summary: 'Análisis actualizado.',
      sentiment: 'mixto',
      analyzer: 'local',
      model: null,
      analyzedAt: new Date().toISOString(),
      publishedAt: (await simulation.api.news.list()).find((item) => item.id === newsItemId)!
        .publishedAt,
    },
  ]);
  act(() => simulation.emitAiChanged('noticias'));
  await screen.findAllByText('SPY · Sentimiento Mixto');
  expect(screen.getByRole('link', { name: /La Fed/ })).toBe(headline);
});

it('mantiene el aviso del navegador externo solo para lectores de pantalla', async () => {
  render(
    <>
      <style>{globalStyles}</style>
      <NewsFeed />
    </>,
  );
  const link = await screen.findByRole('link', { name: /La Fed.*abre en el navegador externo/ });
  const hint = within(link).getByText('(abre en el navegador externo)');
  const style = getComputedStyle(hint);
  expect(style.position).toBe('absolute');
  expect(style.width).toBe('1px');
  expect(style.height).toBe('1px');
  expect(style.overflow).toBe('hidden');
  expect(style.clip).toBe('rect(0px, 0px, 0px, 0px)');
  expect(hint).not.toHaveAttribute('aria-hidden');
  expect(link).toHaveAccessibleName(/abre en el navegador externo/);
});

it('identifica los resúmenes de suscripción como Claude Code', async () => {
  vi.spyOn(simulation.api.ai, 'newsAnalysis').mockImplementation(async ({ newsItemId } = {}) => [
    {
      id: 99,
      newsItemId: newsItemId!,
      ticker: 'SPY',
      summary: 'Resumen confirmado por suscripción.',
      sentiment: 'neutro',
      analyzer: 'suscripcion',
      model: 'claude-code',
      analyzedAt: '2026-10-11T12:00:00Z',
      publishedAt: (await simulation.api.news.list()).find((item) => item.id === newsItemId)!
        .publishedAt,
    },
  ]);
  render(<NewsFeed />);
  const methods = await screen.findAllByText(/Método: Suscripción \(Claude Code\)/);
  expect(methods.length).toBeGreaterThan(0);
});
