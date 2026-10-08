// @vitest-environment jsdom
import { cleanup, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SourcesPage } from './SourcesPage';
import { createSimulatedAdapter } from '../../adapters/simulated';
import type { NewsSource, TestSourceResult } from '../../../../shared/ipc';
import { validFeedUrl } from './sourceModel';

let simulation: ReturnType<typeof createSimulatedAdapter>;
beforeEach(() => {
  simulation = createSimulatedAdapter();
  window.tradia = simulation.api;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
async function form() {
  render(<SourcesPage />);
  await screen.findByText('Proveedores de noticias');
  return {
    user: userEvent.setup(),
    section: within(screen.getByRole('region', { name: 'Añadir nueva fuente de noticias' })),
  };
}
async function fillRss() {
  const context = await form();
  await context.user.type(context.section.getByLabelText('Nombre descriptivo'), 'Feed local');
  await context.user.type(
    context.section.getByLabelText('URL del Feed RSS o Atom'),
    'http://127.0.0.1:4321/feed.xml',
  );
  return context;
}
it('añade una RSS con URL, fiabilidad e intervalo, y la muestra activa', async () => {
  const add = vi.spyOn(simulation.api.sources, 'add');
  const { user, section } = await fillRss();
  await user.selectOptions(section.getByLabelText('Nivel de fiabilidad'), 'agencia');
  await user.click(section.getByRole('button', { name: 'Guardar fuente' }));
  expect(await screen.findByRole('rowheader', { name: 'Feed local' })).toBeInTheDocument();
  expect(add).toHaveBeenCalledWith({
    name: 'Feed local',
    kind: 'rss',
    connector: 'rss',
    url: 'http://127.0.0.1:4321/feed.xml',
    reliability: 'agencia',
    intervalSeconds: 300,
  });
  expect(screen.getByRole('switch', { name: 'Fuente activa: Feed local' })).toBeChecked();
});
it('valida nombre y URL sin enviar un alta inválida', async () => {
  const add = vi.spyOn(simulation.api.sources, 'add');
  const { user, section } = await form();
  await user.click(section.getByRole('button', { name: 'Guardar fuente' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('nombre descriptivo');
  await user.type(section.getByLabelText('Nombre descriptivo'), 'Inválida');
  await user.type(section.getByLabelText('URL del Feed RSS o Atom'), 'javascript:alert(1)');
  await user.click(section.getByRole('button', { name: 'Guardar fuente' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('URL HTTPS válida');
  expect(add).not.toHaveBeenCalled();
});
it('prueba el borrador con estado en curso y resultado OK', async () => {
  let finish!: (result: TestSourceResult) => void;
  const test = vi.spyOn(simulation.api.sources, 'test').mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { user, section } = await fillRss();
  await user.click(section.getByRole('button', { name: 'Probar conexión' }));
  expect(section.getByRole('button', { name: 'Probando conexión…' })).toBeDisabled();
  finish({ ok: true, itemsFound: 4, latencyMs: 12, error: null });
  expect(await section.findByRole('status')).toHaveTextContent('Conexión correcta · 4 titulares');
  expect(test).toHaveBeenCalledWith(expect.objectContaining({ connector: 'rss' }));
});
it.each([
  ['401 auth', 'rechazó la clave'],
  ['429 cuota', 'Límite temporal'],
  ['bad-data', 'No se pudo leer'],
])('muestra un error recuperable de prueba: %s', async (error, message) => {
  vi.spyOn(simulation.api.sources, 'test').mockResolvedValue({
    ok: false,
    itemsFound: 0,
    latencyMs: null,
    error,
  });
  const { user, section } = await fillRss();
  await user.click(section.getByRole('button', { name: 'Probar conexión' }));
  expect(await section.findByRole('alert')).toHaveTextContent(message);
  expect(section.getByRole('button', { name: 'Probar conexión' })).toBeEnabled();
});
it('prueba una fuente guardada por id y permite desactivar y reactivar', async () => {
  const test = vi.spyOn(simulation.api.sources, 'test');
  const update = vi.spyOn(simulation.api.sources, 'update');
  const { user } = await form();
  const sources = await simulation.api.sources.list();
  const source = sources.find((s) => s.kind !== 'oficial')!;
  const row = within(screen.getByRole('rowheader', { name: source.name }).closest('tr')!);
  await user.click(row.getByRole('button', { name: 'Probar conexión' }));
  expect(await row.findByRole('status')).toHaveTextContent('Conexión correcta');
  expect(test).toHaveBeenCalledWith({ id: source.id });
  const toggle = screen.getByRole('switch', { name: `Fuente activa: ${source.name}` });
  await user.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  await user.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(update).toHaveBeenCalledWith({ id: source.id, active: false });
});
it('confirma la baja, conserva el foco al cancelar y atrapa Tab y Escape', async () => {
  const remove = vi.spyOn(simulation.api.sources, 'remove');
  const { user } = await form();
  const source = (await simulation.api.sources.list()).find((s) => s.kind !== 'oficial')!;
  const trigger = screen.getByRole('button', { name: `Quitar fuente ${source.name}` });
  await user.click(trigger);
  let dialog = screen.getByRole('alertdialog');
  expect(within(dialog).getByRole('button', { name: 'Cancelar' })).toHaveFocus();
  expect(dialog).toHaveTextContent('Los titulares ya guardados se mantendrán');
  await user.tab({ shift: true });
  expect(within(dialog).getByRole('button', { name: 'Quitar fuente' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  expect(remove).not.toHaveBeenCalled();
  await user.click(trigger);
  dialog = screen.getByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Quitar fuente' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  expect(remove).toHaveBeenCalledWith(source.id);
  expect(screen.queryByRole('rowheader', { name: source.name })).not.toBeInTheDocument();
  expect(screen.getByText(/Fuente quitada/)).toBeInTheDocument();
});
it('marca y protege oficiales sin permitir quitar ni reclasificar', async () => {
  const official: NewsSource = {
    id: 99,
    name: 'Fed',
    kind: 'oficial',
    connector: 'fed',
    reliability: 'oficial',
    url: null,
    params: {},
    intervalSeconds: 600,
    active: true,
    lastStatus: 'ok',
    lastError: null,
    lastFetchedAt: '2026-10-08T12:00:00Z',
    createdAt: '2026-10-08T12:00:00Z',
  };
  vi.spyOn(simulation.api.sources, 'list').mockResolvedValue([official]);
  render(<SourcesPage />);
  const row = within((await screen.findByRole('rowheader', { name: /Fed/ })).closest('tr')!);
  expect(row.getByText('Oficial')).toBeInTheDocument();
  expect(row.queryByRole('button', { name: /Quitar/ })).not.toBeInTheDocument();
  expect(row.queryByRole('combobox')).not.toBeInTheDocument();
  expect(row.getByRole('switch')).toBeEnabled();
});
it.each(['finnhub', 'alphavantage', 'newsapi'] as const)(
  'guarda la clave de %s solo por secrets y limpia el DOM',
  async (provider) => {
    const saveKey = vi.spyOn(simulation.api.secrets, 'setKey').mockResolvedValue();
    const add = vi.spyOn(simulation.api.sources, 'add');
    const { user, section } = await form();
    await user.click(section.getByRole('radio', { name: 'API financiera' }));
    await user.selectOptions(section.getByLabelText('Proveedor de API'), provider);
    await user.type(section.getByLabelText('Nombre descriptivo'), 'Mi API');
    const key = section.getByLabelText('Clave de API');
    expect(key).toHaveAttribute('type', 'password');
    await user.type(key, 'secret-never-render');
    await user.click(section.getByRole('button', { name: 'Guardar fuente' }));
    await screen.findByRole('rowheader', { name: 'Mi API' });
    expect(saveKey).toHaveBeenCalledWith(provider, 'secret-never-render');
    expect(key).toHaveValue('');
    expect(document.body.innerHTML).not.toContain('secret-never-render');
    expect(JSON.stringify(add.mock.calls)).not.toContain('secret-never-render');
  },
);
it('GDELT no solicita clave; las APIs pueden reutilizar una clave guardada', async () => {
  const setKey = vi.spyOn(simulation.api.secrets, 'setKey');
  const { user, section } = await form();
  await user.click(section.getByRole('radio', { name: 'API financiera' }));
  await user.selectOptions(section.getByLabelText('Proveedor de API'), 'gdelt');
  expect(section.queryByLabelText('Clave de API')).not.toBeInTheDocument();
  await user.type(section.getByLabelText('Nombre descriptivo'), 'GDELT');
  await user.click(section.getByRole('button', { name: 'Guardar fuente' }));
  await screen.findByRole('rowheader', { name: 'GDELT' });
  expect(setKey).not.toHaveBeenCalled();
});
it('limpia secretos incluso si el almacén seguro falla sin mostrar la excepción', async () => {
  vi.spyOn(simulation.api.secrets, 'setKey').mockRejectedValue(new Error('secret-error-value'));
  const add = vi.spyOn(simulation.api.sources, 'add');
  const { user, section } = await form();
  await user.click(section.getByRole('radio', { name: 'API financiera' }));
  await user.type(section.getByLabelText('Nombre descriptivo'), 'Error API');
  await user.type(section.getByLabelText('Clave de API'), 'secret-error-value');
  await user.click(section.getByRole('button', { name: 'Guardar fuente' }));
  expect(await section.findByRole('alert')).toHaveTextContent('almacén seguro');
  expect(section.getByLabelText('Clave de API')).toHaveValue('');
  expect(document.body.innerHTML).not.toContain('secret-error-value');
  expect(add).not.toHaveBeenCalled();
});
it('cubre carga, error de listado, reintento y vacío', async () => {
  vi.spyOn(simulation.api.sources, 'list')
    .mockRejectedValueOnce(new Error('IPC'))
    .mockResolvedValue([]);
  render(<SourcesPage />);
  expect(screen.getByText('Cargando fuentes de noticias…')).toBeInTheDocument();
  expect(await screen.findByRole('alert')).toHaveTextContent('No pudimos consultar');
  await userEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
  expect(
    await screen.findByText('Todavía no has añadido fuentes de noticias.'),
  ).toBeInTheDocument();
});
it('rechaza credenciales en URLs y protocolos no admitidos', () => {
  expect(validFeedUrl('https://example.com/feed')).toBe(true);
  expect(validFeedUrl('http://localhost:1234/feed')).toBe(true);
  for (const url of [
    'file:///tmp/feed.xml',
    'http://example.com/feed',
    'https://user:secret@example.com/feed',
    'bad',
  ])
    expect(validFeedUrl(url)).toBe(false);
});

it('reutiliza la clave guardada después de probar sin enviarla con la fuente', async () => {
  const saveKey = vi.spyOn(simulation.api.secrets, 'setKey').mockResolvedValue();
  vi.spyOn(simulation.api.secrets, 'hasKey').mockResolvedValue(true);
  const add = vi.spyOn(simulation.api.sources, 'add');
  const { user, section } = await form();
  await user.click(section.getByRole('radio', { name: 'API financiera' }));
  await user.type(section.getByLabelText('Nombre descriptivo'), 'API guardada');
  await user.type(section.getByLabelText('Clave de API'), 'transient-secret');
  await user.click(section.getByRole('button', { name: 'Probar conexión' }));
  expect(await section.findByRole('status')).toHaveTextContent('Conexión correcta');
  expect(section.getByLabelText('Clave de API')).toHaveValue('');
  await user.click(section.getByRole('button', { name: 'Guardar fuente' }));
  await screen.findByRole('rowheader', { name: 'API guardada' });
  expect(saveKey).toHaveBeenCalledTimes(1);
  expect(add).toHaveBeenCalledWith(expect.objectContaining({ kind: 'api', connector: 'finnhub' }));
  expect(document.body.innerHTML).not.toContain('transient-secret');
});
it('mantiene una fuente cuando falla la baja y permite cancelar', async () => {
  vi.spyOn(simulation.api.sources, 'remove').mockRejectedValue(new Error('IPC'));
  const { user } = await form();
  const source = (await simulation.api.sources.list()).find((s) => s.kind !== 'oficial')!;
  await user.click(screen.getByRole('button', { name: `Quitar fuente ${source.name}` }));
  const dialog = within(screen.getByRole('alertdialog'));
  await user.click(dialog.getByRole('button', { name: 'Quitar fuente' }));
  expect(await dialog.findByRole('alert')).toHaveTextContent('No se pudo quitar');
  await user.click(dialog.getByRole('button', { name: 'Cancelar' }));
  expect(screen.getByRole('rowheader', { name: source.name })).toBeInTheDocument();
});
