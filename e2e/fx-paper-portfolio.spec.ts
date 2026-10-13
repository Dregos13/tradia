import { expect, test, type Page } from '@playwright/test';
import type { Signal } from '../src/shared/signals';
import {
  closePhaseApp,
  launchPhaseApp,
  openPage,
  watchTickers,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * EUR/USD de punta a punta con el proveedor simulado: rechazo de «EUR»,
 * alta del par, velas 24/5, señal aprobada, posición en la cartera
 * simulada con el P&L en USD y ninguna orden de divisas hacia el bróker.
 * El bróker de la prueba es el simulado de TRADIA_E2E, así que todo es
 * local y determinista.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 150;
const BROKER_REASON = 'el bróker conectado no opera divisas; se opera solo en la cartera simulada';

let context: PhaseApp | undefined;
test.afterEach(async () => closePhaseApp(context));

/** Activa la estrategia semilla con ventanas cortas y la abre a SPY y EURUSD. */
async function activateRsiStrategy(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const found = (await window.tradia.strategies.list()).find(
      (item) => item.name === 'Reversión RSI/Bollinger',
    );
    if (!found) throw new Error('No se encontró la estrategia semilla Reversión RSI/Bollinger');
    const detail = await window.tradia.strategies.get({ id: found.id });
    if (!detail?.executable) throw new Error('La estrategia semilla no es ejecutable');
    const changed = await window.tradia.strategies.update({
      id: detail.id,
      note: 'Ventana corta y divisas para comprobar EUR/USD en la cartera simulada (E2E).',
      markets: ['SPY', 'EURUSD'],
      failsIn: [],
      parameters: {
        ...detail.parameters,
        rsiPeriod: 2,
        oversold: 50,
        trendPeriod: 2,
        atrPeriod: 2,
      },
    });
    await window.tradia.strategies.setStatus({ id: changed.id, status: 'activa' });
    return changed.id;
  });
}

/** Avanza el reloj de mercado un día cada vez hasta que haya una señal de EUR/USD aprobada o reducida. */
async function advanceUntilApprovedFxSignal(page: Page): Promise<Signal | null> {
  for (let day = 0; day < MAX_DAYS; day += 1) {
    await page.evaluate(
      (delta) => window.tradia.testing!.advanceMarketClock(delta),
      DAY_MS + 8 * 60 * 60 * 1000,
    );
    const signals = await page.evaluate(() => window.tradia.signals.list({ limit: 50 }));
    const approved = signals.find(
      (signal) => signal.ticker === 'EURUSD' && signal.decision.status !== 'vetada',
    );
    if (approved) return approved;
  }
  return null;
}

test('EUR/USD: rechazo de EUR, alta, señal aprobada en la cartera simulada y ninguna orden al bróker', async () => {
  test.setTimeout(240_000);
  context = await launchPhaseApp('tradia-fx-paper');
  const { page } = context;
  const shot = (name: string) => page.screenshot({ path: `test-results/fx-paper-${name}.png` });
  const watchlistTickers = () =>
    page.evaluate(async () => (await window.tradia.watchlist.list()).map((row) => row.ticker));

  await test.step('SPY ya en la lista y al día; el bróker simulado conectado antes de operar', async () => {
    await watchTickers(page, ['SPY']);
    await page.evaluate(() =>
      window.tradia.broker.connect({ apiKeyId: 'PKTESTKEY01', apiSecret: 'paper-test-secret-01' }),
    );
    await expect
      .poll(() => page.evaluate(async () => (await window.tradia.broker.status()).state))
      .toBe('conectada');
  });

  await test.step('escribir EUR: rechazo en español con las dos alternativas y la lista intacta', async () => {
    await openPage(page, 'Mercado');
    const input = page.getByLabel('Ticker', { exact: true });
    await input.fill('EUR');
    await input.press('Enter');
    const alert = page.getByRole('alert').filter({ hasText: 'Tiingo no ofrece datos para EUR' });
    await expect(alert).toContainText('Puedes añadir EUR/USD');
    await expect(alert).toContainText('cambiar por FXE');
    const actions = page.getByRole('button', { name: /^(Añadir EUR\/USD|Cambiar por FXE)/ });
    await expect(actions).toHaveText(['Añadir EUR/USD (divisa)', 'Cambiar por FXE']);
    await expect(input).toHaveValue('EUR');
    expect(await watchlistTickers()).toEqual(['SPY']);
    await shot('1-rechazo-eur');
  });

  await test.step('añadir EUR/USD: fila con su etiqueta, al día y ficha con calendario 24/5', async () => {
    await page.getByRole('button', { name: 'Añadir EUR/USD (divisa)' }).click();
    await expect(page.getByText('EUR/USD se ha añadido a tu lista')).toBeVisible();
    expect(await watchlistTickers()).toEqual(expect.arrayContaining(['SPY', 'EURUSD']));
    const row = page.getByRole('button', { name: 'EUR/USD', exact: true });
    await expect(row).toBeVisible();
    await expect(row).toHaveAccessibleDescription(/^Divisa · 24\/5 · cartera simulada/);
    await expect(row).toHaveAccessibleDescription(/Fiable/);
    // Velas 24/5: el reloj anclado es un martes tras el cierre; la última
    // sesión esperada de un par es el lunes y hay histórico suficiente.
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.tradia.market.getBars({ ticker: 'EURUSD' })).bars.length,
        ),
      )
      .toBeGreaterThan(250);
    const bars = await page.evaluate(() => window.tradia.market.getBars({ ticker: 'EURUSD' }));
    const lastDate = bars.bars.at(-1)!.date;
    expect(new Date(`${lastDate}T00:00:00Z`).getUTCDay()).toBeGreaterThanOrEqual(1);
    expect(new Date(`${lastDate}T00:00:00Z`).getUTCDay()).toBeLessThanOrEqual(5);
    expect(
      bars.bars.every((bar) => ![0, 6].includes(new Date(`${bar.date}T00:00:00Z`).getUTCDay())),
    ).toBe(true);
    const card = page.getByRole('region', { name: 'Precio de EUR/USD' });
    await expect(card).toContainText('USD por EUR · Divisa · 24/5 · cartera simulada');
    await expect(card).toContainText('No se esperan datos en fin de semana');
    await expect(card).toContainText('Fiable');
    const freshness = await page.evaluate(() => window.tradia.dataStatus.freshness());
    expect(freshness.uncovered).toEqual([]);
    expect(freshness.items.filter((item) => /EUR|SPY/.test(item.key))).toEqual([]);
    await shot('2-eurusd-al-dia');
  });

  let signal: Signal;
  await test.step('régimen, predicción y señal aprobada de EUR/USD', async () => {
    await activateRsiStrategy(page);
    const found = await advanceUntilApprovedFxSignal(page);
    expect(found, `ninguna señal aprobada de EUR/USD en ${MAX_DAYS} días`).not.toBeNull();
    signal = found!;
    expect(signal).toMatchObject({
      ticker: 'EURUSD',
      destination: 'cartera-simulada',
      dataUsed: { source: 'simulated' },
    });
    expect(['aprobada', 'reducida']).toContain(signal.decision.status);
    expect(signal.decision.size).toBeGreaterThan(0);
    expect(signal.dataUsed.ai?.regime).toBeTruthy();
    const overview = await page.evaluate(() => window.tradia.ai.regimeOverview());
    expect(overview).toBeTruthy();
  });

  await test.step('Inicio: la señal dice que se opera en la cartera simulada y no ofrece bróker ni dinero real', async () => {
    await openPage(page, 'Inicio', 'Estado del sistema');
    const signals = page.getByRole('region', { name: 'Señales vivas' });
    const card = signals.getByText('EUR/USD', { exact: true }).first();
    await expect(card).toBeVisible();
    await expect(signals).toContainText(/Se opera en la cartera simulada\.|Riesgo la vetó/);
    await expect(signals).toContainText('No va al bróker ni usa dinero real');
    await expect(signals).toContainText(BROKER_REASON.slice(1));
    await expect(
      signals.getByRole('button', { name: /bróker|broker|dinero real|enviar/i }),
    ).toHaveCount(0);
    await signals.screenshot({ path: 'test-results/fx-paper-3-senal-eurusd.png' });
  });

  await test.step('la posición abierta está en la cartera simulada con tamaño en EUR y P&L en USD', async () => {
    const portfolio = await page.evaluate(() => window.tradia.risk.getPortfolio());
    expect(portfolio.currency).toBe('USD');
    expect(portfolio.positions).toHaveLength(1);
    const position = portfolio.positions[0]!;
    expect(position).toMatchObject({
      ticker: 'EURUSD',
      direction: 'largo',
      size: signal.decision.size,
      sector: 'divisas',
      signalId: signal.id,
    });
    expect(position.pnl).toBeCloseTo(
      ((position.markPrice ?? position.entry) - position.entry) * position.size,
      2,
    );
    expect(portfolio.exposureBySector.map((row) => row.key)).toContain('divisas');

    const positions = page.getByRole('region', { name: 'Posiciones simuladas' });
    await expect(positions).toContainText('EUR/USD');
    await expect(positions).toContainText('Divisa · 24/5 · cartera simulada');
    await expect(positions).toContainText(new RegExp(`${position.size} EUR`));
    await expect(positions).toContainText(/Entrada\s*\d+,\d+ USD/);
    await expect(positions).toContainText(/P&L\s*[+−-]?\d[\d.,]* USD/);
    await expect(positions).toContainText('No son posiciones reales.');
    await expect(
      positions.getByRole('button', { name: /bróker|broker|dinero real|enviar/i }),
    ).toHaveCount(0);
    await expect(positions.getByRole('link', { name: /bróker|broker|dinero real/i })).toHaveCount(
      0,
    );
    await positions.screenshot({ path: 'test-results/fx-paper-4-posicion-simulada.png' });
  });

  await test.step('ninguna orden de divisas llegó al bróker simulado', async () => {
    const orders = await page.evaluate(() => window.tradia.orders.list());
    expect(orders.filter((order) => /EUR/.test(order.ticker))).toEqual([]);
    expect(orders.filter((order) => order.signalId === signal.id)).toEqual([]);
    // Control: el mismo bróker sí acepta una orden de una acción.
    const stock = await page.evaluate(() =>
      window.tradia.orders.create({ ticker: 'SPY', side: 'buy', quantity: 1, limitPrice: 1000 }),
    );
    expect(stock).toMatchObject({ ticker: 'SPY', status: 'enviada', brokerOrderId: 'sim-1' });
    // Una orden manual de EURUSD hecha directamente por IPC se rechaza con el motivo.
    const rejection = await page.evaluate(() =>
      window.tradia.orders
        .create({ ticker: 'EURUSD', side: 'buy', quantity: 100, limitPrice: 12 })
        .then(
          () => null,
          (error: unknown) => String(error),
        ),
    );
    expect(rejection).toContain(BROKER_REASON);
    const after = await page.evaluate(() => window.tradia.orders.list());
    expect(after.map((order) => order.ticker)).toEqual(['SPY']);

    // Y desde la pantalla de Órdenes se frena en el cliente, con el motivo visible.
    await openPage(page, 'Órdenes', 'Órdenes');
    await page.getByRole('button', { name: 'Crear orden limitada' }).click();
    await page.getByLabel('Activo', { exact: true }).fill('EUR/USD');
    await page.getByLabel('Cantidad', { exact: true }).fill('100');
    await page.getByLabel('Precio límite', { exact: true }).fill('12');
    await page.getByRole('button', { name: 'Enviar orden limitada' }).click();
    await expect(
      page.getByRole('alert').filter({ hasText: 'EUR/USD es una divisa' }),
    ).toContainText(BROKER_REASON);
    expect((await page.evaluate(() => window.tradia.orders.list())).map((o) => o.ticker)).toEqual([
      'SPY',
    ]);
    await shot('5-orden-divisa-frenada');
  });

  await test.step('Diario: la señal figura como EUR/USD', async () => {
    await openPage(page, 'Diario', 'Diario');
    await expect(
      page.getByRole('row').filter({ hasText: 'EUR/USD' }).filter({ hasText: 'Señal' }).first(),
    ).toBeVisible();
  });

  await test.step('el resto de activos sigue al día, sin avisos de cobertura', async () => {
    await openPage(page, 'Mercado');
    const spy = page.getByRole('button', { name: 'SPY', exact: true });
    await expect(spy).toHaveAccessibleDescription(/Fiable/);
    const eur = page.getByRole('button', { name: 'EUR/USD', exact: true });
    await expect(eur).toHaveAccessibleDescription(/Fiable/);
    const freshness = await page.evaluate(() => window.tradia.dataStatus.freshness());
    expect(freshness.uncovered).toEqual([]);
    expect(freshness.items.filter((item) => /SPY|EUR/.test(item.key))).toEqual([]);
    await expect(page.getByRole('region', { name: 'Estado de los datos' })).not.toContainText(
      /sin datos|sin cobertura/i,
    );
    await shot('6-lista-al-dia');
  });
});
