import Database from 'better-sqlite3';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { DataFreshnessSummary, DataStatusEntry } from '../src/shared/ipc';
import {
  closePhaseApp,
  launchPhaseApp,
  openPage,
  relaunchPhaseApp,
  watchTickers,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * H1 de docs/qa/perfiles-tiingo-claridad.md: quitar un activo sin
 * cobertura debe retirar su aviso, de forma que un estado viejo no pueda
 * resucitarlo tras reiniciar. EUR se siembra como activo heredado
 * escribiendo `tradia.db` directamente (como lo tendría quien lo guardó
 * en una versión anterior, cuando el alta aún no comprobaba la cobertura);
 * el estado 'sin-cobertura' lo escribe la ingesta real del proveedor
 * simulado — nada del resumen se publica por IPC.
 */

let context: PhaseApp | undefined;

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

const freshness = (page: Page): Promise<DataFreshnessSummary> =>
  page.evaluate(() => window.tradia.dataStatus.freshness());

const dataStatuses = (page: Page): Promise<DataStatusEntry[]> =>
  page.evaluate(() => window.tradia.dataStatus.get());

const watchlistTickers = (page: Page): Promise<string[]> =>
  page
    .evaluate(async () => (await window.tradia.watchlist.list()).map((row) => row.ticker))
    .then((tickers) => tickers.sort());

/**
 * Inserta el ticker en `watchlist` como una fila heredada de otra versión
 * (misma tabla y orden compacto). La base está en WAL y la app la lee en
 * cada consulta, así que la fila la recoge la siguiente pasada de ingesta.
 */
function seedLegacyTicker(userData: string, ticker: string): void {
  const database = new Database(join(userData, 'tradia.db'));
  try {
    database.pragma('busy_timeout = 5000');
    database
      .prepare(
        `INSERT INTO watchlist (ticker, alta, orden, asset_class)
         VALUES (?, ?, (SELECT COALESCE(MAX(orden), -1) + 1 FROM watchlist), 'equity')`,
      )
      .run(ticker, new Date().toISOString());
  } finally {
    database.close();
  }
}

test('quitar un activo sin cobertura borra su aviso, también tras reiniciar la app', async () => {
  test.setTimeout(300_000);
  context = await launchPhaseApp('tradia-quitar-activo');
  const { page } = context;
  await watchTickers(page, ['SPY', 'AAPL']);

  // EUR heredado: quedó en la lista antes de que el alta verificara la
  // cobertura. La próxima pasada real lo marca 'sin-cobertura'.
  seedLegacyTicker(context.userData, 'EUR');
  await page.evaluate(() => window.tradia.market.refreshNow());
  await expect
    .poll(async () => (await freshness(page)).uncovered.map((asset) => asset.ticker), {
      timeout: 30_000,
    })
    .toEqual(['EUR']);

  // El aviso nombra a EUR; SPY y AAPL siguen al día.
  await openPage(page, 'Mercado');
  const banner = page.getByRole('region', { name: 'Estado de los datos' });
  await expect(
    banner.first().getByRole('heading', { name: 'EUR no está disponible en Tiingo' }),
  ).toBeVisible();
  const before = await dataStatuses(page);
  expect(before.find((entry) => entry.key === 'ticker:EUR')?.state).toBe('sin-cobertura');
  expect(before.find((entry) => entry.key === 'ticker:SPY')?.state).toBe('fiable');
  expect(before.find((entry) => entry.key === 'ticker:AAPL')?.state).toBe('fiable');

  // «Quitar de la lista» retira el aviso en menos de 5 s: watchlist:remove
  // borra la fila de estado y el resumen deja de nombrar a EUR.
  await banner.first().getByRole('button', { name: 'Quitar EUR de la lista' }).click();
  await expect(page.getByText('EUR no está disponible en Tiingo')).toHaveCount(0, {
    timeout: 5_000,
  });
  await expect(banner).toHaveCount(0);
  await expect(page.getByText('EUR se ha quitado de tu lista.')).toBeVisible();
  expect(await watchlistTickers(page)).toEqual(['AAPL', 'SPY']);
  const afterRemove = await freshness(page);
  expect(afterRemove.uncovered).toEqual([]);
  expect(afterRemove.state).toBe('current');
  const afterRemoveStatuses = await dataStatuses(page);
  expect(afterRemoveStatuses.find((entry) => entry.key === 'ticker:EUR')).toBeUndefined();
  expect(afterRemoveStatuses.find((entry) => entry.key === 'ticker:SPY')?.state).toBe('fiable');
  expect(afterRemoveStatuses.find((entry) => entry.key === 'ticker:AAPL')?.state).toBe('fiable');
  await page.screenshot({ path: 'test-results/quitar-activo-sin-cobertura.png' });

  // Tras reiniciar la app el aviso no vuelve: la fila ya no existe.
  await relaunchPhaseApp(context);
  const restarted = context.page;
  await expect(restarted.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible({
    timeout: 30_000,
  });
  await expect
    .poll(async () => (await freshness(restarted)).state, { timeout: 60_000 })
    .toBe('current');
  expect((await freshness(restarted)).uncovered).toEqual([]);
  await expect(restarted.getByText('EUR no está disponible en Tiingo')).toHaveCount(0);
  const restartedStatuses = await dataStatuses(restarted);
  expect(restartedStatuses.find((entry) => entry.key === 'ticker:EUR')).toBeUndefined();
  expect(restartedStatuses.find((entry) => entry.key === 'ticker:SPY')?.state).toBe('fiable');
  expect(restartedStatuses.find((entry) => entry.key === 'ticker:AAPL')?.state).toBe('fiable');
  expect(await watchlistTickers(restarted)).toEqual(['AAPL', 'SPY']);
});
