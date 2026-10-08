import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

const projectRoot = resolve('.');
const nowRssDate = (): string => new Date().toUTCString();

function rss(items: readonly { title: string; id: string }[]): string {
  const entries = items
    .map(
      ({ title, id }) =>
        `<item><title>${title}</title><link>https://example.test/${id}</link><guid>${id}</guid><pubDate>${nowRssDate()}</pubDate><description>Comunicado de prueba</description></item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Tradia E2E</title><link>https://example.test</link><description>Feed local de pruebas</description>${entries}</channel></rss>`;
}

interface FeedServer {
  server: Server;
  url(path: string): string;
  setCustom(items: Array<{ title: string; id: string }>): void;
}

async function startFeedServer(): Promise<FeedServer> {
  let customItems: Array<{ title: string; id: string }> = [
    { title: 'AAPL shares close higher', id: 'custom-initial' },
  ];
  const responseByPath: Record<string, Array<{ title: string; id: string }>> = {
    '/empty': [],
    '/duplicate': [{ title: 'Institutional bulletin published', id: 'duplicate-bulletin' }],
    '/bls': [{ title: 'Statistical release number 8', id: 'bls-release' }],
    '/bea': [{ title: 'Economic release number 16', id: 'bea-release' }],
    '/sec': [
      { title: 'Issuer filing accepted: 8-K', id: 'sec-8k' },
      { title: 'Issuer filing accepted: Form 4', id: 'sec-form4' },
    ],
    '/cnmv': [{ title: 'Hecho relevante número 23', id: 'cnmv-release' }],
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    if (path === '/health') {
      response.writeHead(204).end();
      return;
    }
    const items = path === '/custom' ? customItems : responseByPath[path];
    if (!items) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
    response.end(rss(items));
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    setCustom: (items) => {
      customItems = items;
    },
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
}

async function launchTradia(userData: string, healthUrl: string): Promise<ElectronApplication> {
  return electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      TRADIA_E2E: '1',
      TRADIA_E2E_USER_DATA: userData,
      TRADIA_SIMULATE_OFFLINE: '1',
      TRADIA_CONNECTIVITY_URLS: JSON.stringify([healthUrl, healthUrl]),
    },
  });
}

function prepareDatabaseWithoutLiveSources(userData: string): void {
  const database = new Database(join(userData, 'tradia.db'));
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const migrations = [
    ['001_init.sql', 'init'],
    ['002_app_state.sql', 'app-state'],
    ['003_market_data.sql', 'market-data'],
    ['004_news.sql', 'news'],
  ];
  for (const [index, [file, name]] of migrations.entries()) {
    const raw = readFileSync(join(projectRoot, 'src/main/db/migrations', file!), 'utf8');
    const up = raw
      .slice(raw.indexOf('-- migrate:up') + '-- migrate:up'.length, raw.indexOf('-- migrate:down'))
      .trim();
    database.exec(up);
    database
      .prepare(
        'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      )
      .run(
        index + 1,
        name,
        createHash('sha256').update(up, 'utf8').digest('hex'),
        new Date().toISOString(),
      );
  }

  const official = [
    ['fed', 'Reserva Federal — comunicados y FOMC', {}],
    ['ecb', 'BCE — notas de prensa', {}],
    ['bls', 'BLS — nóminas no agrícolas e IPC', {}],
    ['bea', 'BEA — comunicados (PIB, PCE…)', {}],
    ['sec-edgar', 'SEC EDGAR — 8-K y Form 4 de los activos seguidos', { ciks: [] }],
    ['cnmv', 'CNMV — información privilegiada y relevante', {}],
  ] as const;
  const insertSource = database.prepare(`
    INSERT INTO news_sources (nombre, tipo, conector, params, fiabilidad, intervalo_segundos, activa)
    VALUES (?, 'oficial', ?, ?, 'oficial', 600, 0)
  `);
  const markSeeded = database.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, '1', ?)",
  );
  const seededAt = new Date().toISOString();
  for (const [connector, name, params] of official) {
    insertSource.run(name, connector, JSON.stringify(params));
    markSeeded.run(`news.seed.oficial.${connector}`, seededAt);
  }
  database.close();
}

async function acceptRisk(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Antes de empezar' })).toBeVisible();
  await page.getByLabel('He leído y acepto').check();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible();
}

async function setOfficialFeeds(page: Page, feedUrl: (path: string) => string): Promise<void> {
  const official = await page.evaluate(() => window.tradia.sources.list());
  expect(official).toHaveLength(6);
  const paths: Record<string, string> = {
    fed: '/duplicate',
    ecb: '/duplicate',
    bls: '/bls',
    bea: '/bea',
    'sec-edgar': '/sec',
    cnmv: '/cnmv',
  };
  for (const source of official) {
    expect(source.kind).toBe('oficial');
    expect(source.reliability).toBe('oficial');
    const path = paths[source.connector];
    expect(path, `conector oficial simulado: ${source.connector}`).toBeTruthy();
    await page.evaluate(
      async ({ id, url }) => window.tradia.sources.update({ id, url, active: true }),
      { id: source.id, url: feedUrl(path!) },
    );
  }
}

async function followAapl(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Mercado', exact: true }).click();
  const ticker = page.getByLabel('Ticker', { exact: true });
  await ticker.fill('AAPL');
  await ticker.press('Enter');
  await expect(page.getByRole('button', { name: 'Quitar AAPL', exact: true })).toBeVisible();
}

async function addRssThroughUi(
  page: Page,
  name: string,
  url: string,
  reliability = 'agencia',
  connectionEdges?: { failureUrl: string; emptyUrl: string },
): Promise<void> {
  await page.getByRole('link', { name: 'Fuentes', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Canales de información bajo tu control.' }),
  ).toBeVisible();
  const form = page.getByRole('region', { name: 'Añadir nueva fuente de noticias' });
  await form.getByLabel('URL del Feed RSS o Atom').fill(url);
  await form.getByLabel('Nombre descriptivo').fill(name);
  await form.getByLabel('Nivel de fiabilidad').selectOption(reliability);
  if (connectionEdges) {
    await form.getByLabel('URL del Feed RSS o Atom').fill(connectionEdges.failureUrl);
    await form.getByRole('button', { name: 'Probar conexión' }).click();
    await expect(form.getByRole('alert')).toContainText('No se pudo leer la fuente');
    await form.getByLabel('URL del Feed RSS o Atom').fill(connectionEdges.emptyUrl);
    await form.getByRole('button', { name: 'Probar conexión' }).click();
    await expect(form.getByRole('status')).toContainText('0 titulares encontrados');
    await form.getByLabel('URL del Feed RSS o Atom').fill(url);
  }
  await form.getByRole('button', { name: 'Probar conexión' }).click();
  await expect(form.getByRole('status').filter({ hasText: /Conexión correcta/i })).toBeVisible();
  await form.getByRole('button', { name: 'Guardar fuente', exact: true }).click();
  await expect(page.getByRole('rowheader', { name })).toBeVisible();
}

async function mockNativeNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const state = globalThis as typeof globalThis & {
      __tradiaNotificationCalls?: Array<{ title: string; body: string }>;
    };
    state.__tradiaNotificationCalls = [];
    Object.defineProperty(Notification, 'isSupported', {
      configurable: true,
      value: () => true,
    });
    Notification.prototype.show = function (this: Notification) {
      state.__tradiaNotificationCalls?.push({ title: this.title, body: this.body });
    };
  });
}

async function notificationCalls(app: ElectronApplication) {
  return app.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __tradiaNotificationCalls?: Array<{ title: string; body: string }>;
    };
    return state.__tradiaNotificationCalls ?? [];
  });
}

test.describe('Noticias, fuentes, calendario y avisos E2E', () => {
  test('Profesional independiente: prueba, añade y quita una fuente RSS', async () => {
    mkdirSync('test-results', { recursive: true });
    const userData = mkdtempSync(join(tmpdir(), 'tradia-news-sources-'));
    prepareDatabaseWithoutLiveSources(userData);
    const feeds = await startFeedServer();
    const app = await launchTradia(userData, feeds.url('/health'));
    try {
      const page = await app.firstWindow();
      await acceptRisk(page);
      await followAapl(page);

      const longTitle = 'Long market bulletin '.repeat(25);
      feeds.setCustom([
        { title: 'AAPL shares close higher', id: 'custom-initial' },
        { title: longTitle, id: 'long-headline' },
      ]);
      await addRssThroughUi(page, 'Feed local de mercado', feeds.url('/custom'), 'agencia', {
        failureUrl: feeds.url('/missing'),
        emptyUrl: feeds.url('/empty'),
      });
      await page.screenshot({ path: 'test-results/news-sources-added.png' });
      const row = page.getByRole('rowheader', { name: 'Feed local de mercado' }).locator('..');
      await expect(row).toContainText('Agencia');

      await page.evaluate(() => window.tradia.testing!.simulateOffline(false));
      await expect
        .poll(() => page.evaluate(() => window.tradia.connectivity.getState()))
        .toMatchObject({ status: 'online' });
      await page.evaluate(() => window.tradia.testing!.pollNewsNow());
      const pollResult = await page.evaluate(() => window.tradia.testing!.pollNewsNow());
      expect(pollResult.sourcesPolled).toBe(1);
      await expect
        .poll(async () => {
          const items = await page.evaluate(() => window.tradia.news.list());
          return items.some((item) => item.title === 'AAPL shares close higher');
        })
        .toBe(true);
      await expect(row).toContainText('Correcto');
      const longNews = (await page.evaluate(() => window.tradia.news.list())).find((item) =>
        item.title.startsWith('Long market bulletin'),
      );
      expect(longNews?.title).toHaveLength(301);
      expect(longNews?.title.endsWith('…')).toBe(true);

      await page.getByRole('link', { name: 'Noticias', exact: true }).click();
      const card = page.getByTestId('news-item').filter({ hasText: 'AAPL shares close higher' });
      await expect(card).toHaveCount(1);
      await expect(card).toContainText('Agencia · Feed local de mercado');
      await expect(card.locator('time[datetime]')).toHaveCount(1);
      await expect(card).toContainText('Baja');
      await expect(card.getByRole('button', { name: 'Filtrar por AAPL' })).toBeVisible();
      await page.screenshot({ path: 'test-results/news-rss-feed.png' });

      await page.getByRole('link', { name: 'Fuentes', exact: true }).click();
      await page.getByRole('button', { name: 'Quitar fuente Feed local de mercado' }).click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog.getByRole('button', { name: 'Cancelar' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(
        dialog.getByRole('button', { name: 'Quitar fuente', exact: true }),
      ).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('rowheader', { name: 'Feed local de mercado' })).toHaveCount(0);

      feeds.setCustom([{ title: 'Nuevo titular posterior a la baja', id: 'after-removal' }]);
      const removedSourcePoll = await page.evaluate(() => window.tradia.testing!.pollNewsNow());
      expect(removedSourcePoll.sourcesPolled).toBe(0);
      expect(removedSourcePoll.newItems).toBe(0);
      const afterRemoval = await page.evaluate(() => window.tradia.news.list());
      expect(afterRemoval.some((item) => item.title === 'Nuevo titular posterior a la baja')).toBe(
        false,
      );
      expect(afterRemoval.some((item) => item.title === 'AAPL shares close higher')).toBe(true);
      await page.screenshot({ path: 'test-results/news-source-removed.png' });
    } finally {
      await app.close();
      await closeServer(feeds.server);
      rmSync(userData, { recursive: true, force: true });
    }
  });

  test('Responsable de equipo: revisa oficiales, calendario y avisos con la ventana oculta', async () => {
    mkdirSync('test-results', { recursive: true });
    const userData = mkdtempSync(join(tmpdir(), 'tradia-news-team-'));
    prepareDatabaseWithoutLiveSources(userData);
    const feeds = await startFeedServer();
    const app = await launchTradia(userData, feeds.url('/health'));
    try {
      const page = await app.firstWindow();
      await acceptRisk(page);
      await followAapl(page);
      await setOfficialFeeds(page, feeds.url);
      await mockNativeNotifications(app);

      await addRssThroughUi(page, 'Fuente de seguimiento', feeds.url('/custom'));
      await page.evaluate(() => window.tradia.testing!.simulateOffline(false));
      await expect
        .poll(() => page.evaluate(() => window.tradia.connectivity.getState()))
        .toMatchObject({ status: 'online' });
      await page.evaluate(() => window.tradia.testing!.pollNewsNow());
      const pollResult = await page.evaluate(() => window.tradia.testing!.pollNewsNow());
      expect(pollResult.sourcesPolled).toBe(7);
      await expect
        .poll(() =>
          page.evaluate(async () =>
            (await window.tradia.news.list()).some(
              (item) => item.title === 'Institutional bulletin published',
            ),
          ),
        )
        .toBe(true);

      await page.getByRole('link', { name: 'Noticias', exact: true }).click();
      const feed = page.getByRole('region', { name: 'Feed de noticias' });
      const duplicate = page.getByTestId('news-item').filter({
        hasText: 'Institutional bulletin published',
      });
      await expect(duplicate).toHaveCount(1);
      await expect(duplicate).toContainText('Oficial · Reserva Federal');
      await expect(duplicate).toContainText('Oficial · BCE');
      await expect(duplicate).toContainText('Fuentes agrupadas');
      for (const [title, sourceName] of [
        ['Statistical release number 8', 'BLS'],
        ['Economic release number 16', 'BEA'],
        ['Issuer filing accepted: 8-K', 'SEC EDGAR'],
        ['Issuer filing accepted: Form 4', 'SEC EDGAR'],
        ['Hecho relevante número 23', 'CNMV'],
      ]) {
        const item = page.getByTestId('news-item').filter({ hasText: title });
        await expect(item).toHaveCount(1);
        await expect(item).toContainText(`Oficial · ${sourceName}`);
      }
      await expect(feed.getByTestId('news-item')).toHaveCount(7);
      await page.screenshot({ path: 'test-results/news-official-feed.png' });

      await page.getByRole('link', { name: 'Calendario', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Calendario económico y de resultados' }),
      ).toBeVisible();
      const events = page.getByTestId('calendar-event');
      await expect(events.first()).toBeVisible();
      const eventCount = await events.count();
      expect(eventCount).toBeGreaterThan(0);
      for (let index = 0; index < eventCount; index += 1) {
        await expect(events.nth(index)).toContainText(/Impacto (alto|medio|bajo)/);
      }
      await page.screenshot({ path: 'test-results/news-calendar-week.png' });

      feeds.setCustom([
        { title: 'Apple AAPL earnings guidance revised upward', id: 'critical-aapl' },
      ]);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false,
          ),
        )
        .toBe(false);
      const hiddenPollResult = await page.evaluate(() => window.tradia.testing!.pollNewsNow());
      expect(hiddenPollResult.newItems).toBeGreaterThan(0);
      await expect
        .poll(() =>
          page.evaluate(async () =>
            (await window.tradia.news.list()).some(
              (item) => item.title === 'Apple AAPL earnings guidance revised upward',
            ),
          ),
        )
        .toBe(true);
      await expect
        .poll(async () =>
          (await notificationCalls(app)).some((notification) =>
            /Noticia crítica: AAPL/.test(notification.title),
          ),
        )
        .toBe(true);

      const today = new Date();
      const monthAhead = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
      const upcoming = await page.evaluate(
        ({ desde, hasta }) => window.tradia.calendar.list({ desde, hasta }),
        {
          desde: today.toISOString().slice(0, 10),
          hasta: monthAhead.toISOString().slice(0, 10),
        },
      );
      const now = Date.now();
      const nextHighImpact = upcoming
        .filter(
          (event) => event.impact === 'alto' && Date.parse(event.dateUtc) > now + 31 * 60 * 1000,
        )
        .sort((a, b) => a.dateUtc.localeCompare(b.dateUtc))[0];
      expect(
        nextHighImpact,
        'debe existir un evento de alto impacto futuro en 30 días',
      ).toBeTruthy();
      const advanceMs = Date.parse(nextHighImpact!.dateUtc) - 20 * 60 * 1000 - now;
      expect(advanceMs).toBeGreaterThan(0);
      await page.evaluate((delta) => window.tradia.testing!.advanceNewsClock(delta), advanceMs);

      const database = new Database(join(userData, 'tradia.db'), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const records = database
          .prepare('SELECT tipo, nivel, titulo, cuerpo FROM notification_log ORDER BY id')
          .all() as Array<{ tipo: string; nivel: string; titulo: string; cuerpo: string }>;
        expect(
          records.some((record) => record.tipo === 'evento-previo' && record.nivel === 'alerta'),
        ).toBe(true);
        expect(
          records.some(
            (record) =>
              record.tipo === 'noticia-critica' &&
              record.nivel === 'critica' &&
              /Noticia crítica: AAPL/.test(record.titulo),
          ),
        ).toBe(true);
      } finally {
        database.close();
      }
      const calls = await notificationCalls(app);
      expect(calls.some((notification) => /Evento de alto impacto/.test(notification.title))).toBe(
        true,
      );
    } finally {
      await app.close();
      await closeServer(feeds.server);
      rmSync(userData, { recursive: true, force: true });
    }
  });
});
