import { expect, test } from '@playwright/test';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
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
