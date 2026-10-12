import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
  recordNotifications,
  recordedNotifications,
  watchTickers,
  type LocalRoute,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * Fase 6 · resumen y sentimiento de noticias. En modo E2E la app usa el
 * analizador simulado determinista (rotulado «LLM» sin tocar la red).
 * Los titulares confirmados salen del conjunto etiquetado
 * (src/main/ai/news/__fixtures__/headlines.labeled.json); el de redes
 * sociales nunca se confirma y no debe analizarse ni influir en señales.
 */

const NEWS_LLM_MODEL = 'claude-haiku-4-5-20251001';
const CONFIRMED = [
  {
    id: 'e2e-aapl',
    title: 'Apple beats estimates as iPhone sales surge',
    ticker: 'AAPL',
    sentiment: 'positivo',
    label: 'Favorable',
  },
  {
    id: 'e2e-msft',
    title: 'Microsoft drops after cloud growth misses estimates',
    ticker: 'MSFT',
    sentiment: 'negativo',
    label: 'Desfavorable',
  },
] as const;
const RUMOR = { id: 'e2e-rumor', title: 'Rumor: Apple shares to soar on secret deal' } as const;
const EXPECTED_TITLES: readonly string[] = [...CONFIRMED.map((c) => c.title), RUMOR.title];

function rss(items: readonly { id: string; title: string }[]): string {
  // La fecha de publicación es la del momento de la prueba: el sondeo
  // descarta titulares viejos, y ninguna aserción depende del día.
  const published = new Date().toUTCString();
  const entries = items
    .map(
      ({ id, title }) =>
        `<item><title>${title}</title><link>https://example.test/${id}</link><guid>${id}</guid><pubDate>${published}</pubDate></item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Tradia E2E</title><link>https://example.test</link><description>Feed local</description>${entries}</channel></rss>`;
}

const feeds: LocalRoute = (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  const items = path === '/agencia' ? CONFIRMED : path === '/redes' ? [RUMOR] : null;
  if (!items) return false;
  response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
  response.end(rss(items));
  return true;
};

let context: PhaseApp | undefined;

test.beforeEach(async () => {
  context = await launchPhaseApp('tradia-news-sentiment-e2e', { route: feeds });
});

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

async function ingestHeadlines(ctx: PhaseApp) {
  const { page } = ctx;
  await watchTickers(page, ['AAPL', 'MSFT']);
  await page.evaluate(
    async ({ agencia, redes }) => {
      await window.tradia.sources.add({
        name: 'Agencia local E2E',
        kind: 'rss',
        connector: 'rss',
        url: agencia,
        reliability: 'agencia',
      });
      await window.tradia.sources.add({
        name: 'Redes locales E2E',
        kind: 'rss',
        connector: 'rss',
        url: redes,
        reliability: 'redes',
      });
      await window.tradia.testing!.pollNewsNow();
    },
    { agencia: ctx.url('/agencia'), redes: ctx.url('/redes') },
  );
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.tradia.news.list({}))).filter((item) =>
          EXPECTED_TITLES.includes(item.title),
        ).length,
      { timeout: 30_000 },
    )
    .toBe(3);
  return page.evaluate(() => window.tradia.news.list({}));
}

test.describe('Profesional independiente que organiza varios proyectos', () => {
  test('lee el resumen y el sentimiento por activo de los titulares confirmados', async () => {
    test.setTimeout(180_000);
    const { page } = context!;
    const items = await ingestHeadlines(context!);

    for (const expected of CONFIRMED) {
      const item = items.find((candidate) => candidate.title === expected.title)!;
      expect(item.confirmed).toBe(true);
      expect(item.assets).toContain(expected.ticker);
      await expect
        .poll(
          () =>
            page.evaluate((newsItemId) => window.tradia.ai.newsAnalysis({ newsItemId }), item.id),
          { timeout: 30_000 },
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              ticker: expected.ticker,
              sentiment: expected.sentiment,
              analyzer: 'llm',
              model: NEWS_LLM_MODEL,
              summary: expect.stringContaining(expected.ticker),
            }),
          ]),
        );
    }

    await openPage(page, 'Noticias');
    for (const expected of CONFIRMED) {
      const card = page.getByTestId('news-item').filter({ hasText: expected.title });
      await expect(card.getByText('✓ Confirmada')).toBeVisible();
      const analysis = card.getByRole('region', { name: 'Análisis automático' });
      await expect(
        analysis.getByText(`${expected.ticker} · Sentimiento ${expected.label}`),
      ).toBeVisible({ timeout: 20_000 });
      await expect(analysis.getByText('Resumen automático:')).toBeVisible();
      await expect(analysis).toContainText(`LLM · ${NEWS_LLM_MODEL}`);
      await expect(analysis).toContainText('No crea señales y Riesgo conserva el veto.');
    }
    await capturePhaseScreenshot(
      page,
      'fase-6-7-noticias-sentimiento.png',
      page.getByTestId('news-item').filter({ hasText: CONFIRMED[0].title }),
    );
  });
});

test.describe('Responsable de equipo que revisa entregas', () => {
  test('un titular solo de redes queda «Sin verificar», sin análisis y fuera de las señales', async () => {
    test.setTimeout(180_000);
    const { page } = context!;
    const items = await ingestHeadlines(context!);
    const rumor = items.find((item) => item.title === RUMOR.title)!;
    expect(rumor.confirmed).toBe(false);
    expect(rumor.assets).toContain('AAPL');

    // Los confirmados ya tienen análisis: el rumor sigue sin ninguno.
    const confirmedIds = items
      .filter((item) => CONFIRMED.some((c) => c.title === item.title))
      .map((item) => item.id);
    await expect
      .poll(
        async () =>
          (
            await Promise.all(
              confirmedIds.map((newsItemId) =>
                page.evaluate(
                  (id) => window.tradia.ai.newsAnalysis({ newsItemId: id }),
                  newsItemId,
                ),
              ),
            )
          ).every((rows) => rows.length > 0),
        { timeout: 30_000 },
      )
      .toBe(true);
    expect(
      await page.evaluate((newsItemId) => window.tradia.ai.newsAnalysis({ newsItemId }), rumor.id),
    ).toEqual([]);

    // Una evaluación de señales no cita nunca el titular sin verificar.
    await page.evaluate(() => window.tradia.testing!.evaluateSignalsNow());
    const signals = await page.evaluate(() => window.tradia.signals.list({ limit: 200 }));
    for (const signal of signals) {
      expect(signal.dataUsed.ai?.newsItemIds ?? []).not.toContain(rumor.id);
    }

    await openPage(page, 'Noticias');
    const card = page.getByTestId('news-item').filter({ hasText: RUMOR.title });
    await expect(card.getByText('Sin verificar · no genera señales')).toBeVisible();
    await expect(card.getByRole('note')).toContainText(
      'Noticia procedente únicamente de redes sociales',
    );
    await expect(card.getByRole('region', { name: 'Análisis automático' })).toHaveCount(0);
    await capturePhaseScreenshot(page, 'fase-6-7-noticias-sin-verificar.png', card);
  });
});

test('la caída de suscripción se ve en Noticias y Ajustes y se recupera sin mover el foco', async () => {
  const { app, page } = context!;
  await page.evaluate(() =>
    window.tradia.ai.setLlmSettings({ provider: 'suscripcion', enabled: true }),
  );
  // Doble del contrato IPC: recorre preload y eventos reales de Electron,
  // sin CLI externa ni cambios en el proceso principal de producción.
  await app.evaluate(({ ipcMain }) => {
    const state = globalThis as typeof globalThis & {
      __newsStatusE2E?: {
        provider: 'suscripcion';
        state: 'ok' | 'sin-sesion';
        since: string;
        message: string | null;
      };
    };
    state.__newsStatusE2E = {
      provider: 'suscripcion',
      state: 'ok',
      since: new Date().toISOString(),
      message: null,
    };
    ipcMain.removeHandler('ai:news-status');
    ipcMain.handle('ai:news-status', () => state.__newsStatusE2E);
    ipcMain.removeHandler('ai:test-llm');
    ipcMain.handle('ai:test-llm', () => ({ ok: true, error: null, latencyMs: 1 }));
  });
  await openPage(page, 'Noticias');
  const search = page.getByRole('searchbox').first();
  await search.focus();
  async function force(state: 'ok' | 'sin-sesion') {
    await app.evaluate(({ BrowserWindow }, value) => {
      const global = globalThis as typeof globalThis & { __newsStatusE2E?: unknown };
      const status = {
        provider: 'suscripcion',
        state: value,
        since: new Date().toISOString(),
        message:
          value === 'ok'
            ? null
            : 'Abre un terminal, ejecuta claude y después /login. Vuelve aquí y prueba de nuevo. Mientras tanto, se usa el analizador local.',
      };
      global.__newsStatusE2E = status;
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('ai:news-status-changed', status);
    }, state);
  }
  await force('sin-sesion');
  const notice = page.getByRole('status', { name: 'Estado de la suscripción' });
  await expect(notice).toContainText('Suscripción no disponible · sesión no iniciada');
  await expect(notice).toContainText('claude y después /login');
  await expect(notice).toContainText('las noticias se analizan con el analizador local');
  await expect(search).toBeFocused();
  await page.screenshot({ path: join(tmpdir(), 'tradia-news-notice-desktop.png') });
  await page.setViewportSize({ width: 700, height: 900 });
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'dark';
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect
    .poll(() => notice.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe('rgb(75, 28, 38)');
  await page.screenshot({ path: join(tmpdir(), 'tradia-news-notice-dark-700.png') });
  await force('ok');
  await expect(notice).toHaveCount(0);
  await expect(search).toBeFocused();

  await force('sin-sesion');
  await openPage(page, 'Ajustes');
  await expect(page.getByRole('radio', { name: /Suscripción \(Claude Code\)/ })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Analizador local/ })).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Análisis de noticias', exact: true })
      .getByLabel(/Clave de API/),
  ).toHaveCount(0);
  await expect(notice).toContainText('Vuelve aquí y prueba de nuevo.');
  await page
    .getByRole('region', { name: 'Análisis de noticias', exact: true })
    .screenshot({ path: join(tmpdir(), 'tradia-settings-notice-dark-700.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await app.evaluate(({ nativeTheme }) => {
    nativeTheme.themeSource = 'light';
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect
    .poll(() => notice.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe('rgb(251, 228, 231)');
  await page
    .getByRole('region', { name: 'Análisis de noticias', exact: true })
    .screenshot({ path: join(tmpdir(), 'tradia-settings-notice-desktop.png') });
  const retry = notice.getByRole('button', { name: 'Probar de nuevo' });
  await retry.focus();
  await force('ok');
  await expect(notice).toHaveCount(0);
});

/**
 * Recorrido real del proceso principal, sin dobles del IPC: una CLI falsa
 * de Claude Code (el mismo fixture que las pruebas de `claudeCli.ts`)
 * responde «sesión no iniciada» y después vuelve a responder. TMPDIR
 * propio para que su configuración no choque con otras pruebas.
 */
test.describe('Responsable de equipo que revisa entregas', () => {
  test('sin sesión de Claude Code: un solo aviso del sistema, motivo en Ajustes y Noticias y vuelta a ok', async () => {
    test.setTimeout(180_000);
    await closePhaseApp(context);
    const fakeTmp = mkdtempSync(join(tmpdir(), 'tradia-fake-claude-e2e-'));
    const cliPath = join(fakeTmp, 'bin', process.platform === 'win32' ? 'claude.cmd' : 'claude');
    mkdirSync(join(fakeTmp, 'bin'), { recursive: true });
    const fixture = resolve('src/main/ai/news/__fixtures__/fake-claude-cli.mjs');
    if (process.platform === 'win32') {
      copyFileSync(fixture, join(fakeTmp, 'bin', 'fake-claude-cli.mjs'));
      writeFileSync(cliPath, `@echo off\r\nnode "%~dp0fake-claude-cli.mjs" %*\r\n`);
    } else {
      copyFileSync(fixture, cliPath);
      chmodSync(cliPath, 0o755);
    }
    const mode = (value: 'noauth' | 'ok') =>
      writeFileSync(join(fakeTmp, 'tradia-fake-claude.json'), JSON.stringify({ mode: value }));
    mode('noauth');
    try {
      context = await launchPhaseApp('tradia-news-subscription-e2e', {
        env: { TMPDIR: fakeTmp, TEMP: fakeTmp, TMP: fakeTmp },
      });
      const { app, page } = context;
      await recordNotifications(app);
      const failure = (calls: { title: string }[]) =>
        calls.filter((call) => call.title === 'Tradia usa el analizador local');

      // Ajustes: solo los dos proveedores sin API, ruta de la CLI y «Probar de nuevo».
      await openPage(page, 'Ajustes');
      const section = page.getByRole('region', { name: 'Análisis de noticias', exact: true });
      await expect(section.getByRole('radio')).toHaveCount(2);
      await section.getByRole('radio', { name: /Suscripción \(Claude Code\)/ }).check();
      await section.getByLabel('Ruta de Claude Code (opcional)').fill(cliPath);
      await section.getByRole('button', { name: 'Probar de nuevo', exact: true }).click();
      const notice = section.getByRole('status', { name: 'Estado de la suscripción' });
      await expect(notice).toContainText('Suscripción no disponible · sesión no iniciada', {
        timeout: 30_000,
      });
      await expect(notice).toContainText('ejecuta claude y después /login');
      await expect.poll(async () => failure(await recordedNotifications(app)).length).toBe(1);
      await capturePhaseScreenshot(page, 'suscripcion-sin-sesion-ajustes.png', notice);

      // Noticias muestra el mismo motivo; reintentar sin sesión no repite el aviso.
      await openPage(page, 'Noticias');
      const newsNotice = page.getByRole('status', { name: 'Estado de la suscripción' });
      await expect(newsNotice).toContainText('Suscripción no disponible · sesión no iniciada');
      await expect(newsNotice).toContainText('las noticias se analizan con el analizador local');
      await capturePhaseScreenshot(page, 'suscripcion-sin-sesion-noticias.png');
      await newsNotice.getByRole('button', { name: 'Probar de nuevo', exact: true }).click();
      await expect(newsNotice).toHaveAttribute('aria-busy', 'false', { timeout: 30_000 });
      await expect(newsNotice).toContainText('sesión no iniciada');

      // Tras /login la CLI responde: vuelta a 'ok' y un aviso de recuperación.
      mode('ok');
      await newsNotice.getByRole('button', { name: 'Probar de nuevo', exact: true }).click();
      await expect(newsNotice).toContainText('Suscripción recuperada', { timeout: 30_000 });
      expect(await page.evaluate(() => window.tradia.ai.newsStatus())).toMatchObject({
        provider: 'suscripcion',
        state: 'ok',
      });
      await capturePhaseScreenshot(page, 'suscripcion-recuperada-noticias.png');
      const calls = await recordedNotifications(app);
      expect(failure(calls)).toHaveLength(1);
      expect(
        calls.filter((call) => call.title === 'Suscripción de Claude recuperada'),
      ).toHaveLength(1);
    } finally {
      await closePhaseApp(context);
      context = undefined;
      rmSync(fakeTmp, { recursive: true, force: true });
    }
  });
});
