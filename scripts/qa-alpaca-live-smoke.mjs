/**
 * Prueba de humo con DINERO REAL contra Alpaca live (comprobación manual;
 * no se ejecuta en CI ni desde la app).
 *
 * Empaqueta `src/main/broker/alpacaLive.ts` con esbuild (ya en
 * node_modules vía vite) y ejecuta la misma secuencia que
 * `live:smoke-test` en la app: lee la cuenta real, compra una fracción
 * de SPY por 1 USD nocional (orden de mercado, day), espera la
 * ejecución, vende el cierre y lista posiciones y órdenes para cuadrar
 * el resultado en el panel web de Alpaca.
 *
 * AVISO: este script mueve dinero real de tu cuenta. Pide escribir
 * «CONFIRMO» por consola antes de enviar la primera orden. Ejecutarlo
 * forma parte de la comprobación manual de la fase 7, después de haber
 * completado la lista de comprobación del modo real en la app.
 *
 * Uso (claves LIVE de Alpaca, prefijo AK, generadas sin permiso de
 * retirada de fondos):
 *   APCA_API_KEY_ID=AK… APCA_API_SECRET_KEY=SK… npm run qa:alpaca-live-smoke
 *
 * Opcional: TRADIA_SPY_REFERENCE=<precio> fija el precio de referencia
 * sin consultar la API de datos de Alpaca.
 */
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import readline from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers';

const NOTIONAL_USD = 1;
const TICKER = 'SPY';
const FILL_TIMEOUT_MS = 90_000;
const POLL_MS = 2_000;
const DATA_BASE_URL = 'https://data.alpaca.markets';

const keyId = process.env.APCA_API_KEY_ID ?? process.env['APCA-API-KEY-ID'];
const secret = process.env.APCA_API_SECRET_KEY ?? process.env['APCA-API-SECRET-KEY'];
if (!keyId || !secret) {
  console.error('Faltan las claves LIVE de Alpaca. Uso:');
  console.error('  APCA_API_KEY_ID=AK… APCA_API_SECRET_KEY=SK… npm run qa:alpaca-live-smoke');
  process.exit(2);
}
if (!keyId.startsWith('AK')) {
  console.error(
    'Estas claves no son de una cuenta LIVE (las claves live empiezan por «AK»; ' +
      'las paper, por «PK»). No se ejecuta nada contra una cuenta que no sea real.',
  );
  process.exit(2);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question(
  '\n⚠️  DINERO REAL. Esta prueba comprará y venderá una fracción de SPY por ' +
    `${NOTIONAL_USD} USD en tu cuenta LIVE de Alpaca.\n` +
    'Escribe CONFIRMO para continuar: ',
);
rl.close();
if (answer.trim() !== 'CONFIRMO') {
  console.log('Cancelado. No se ha enviado ninguna orden.');
  process.exit(2);
}

const outDir = mkdtempSync(join(tmpdir(), 'tradia-qa-live-'));
const bundle = join(outDir, 'alpacaLive.mjs');
execFileSync(
  resolve('node_modules/.bin/esbuild'),
  [
    'src/main/broker/alpacaLive.ts',
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--log-level=warning',
    `--outfile=${bundle}`,
  ],
  { stdio: 'inherit' },
);
const { createAlpacaLiveBroker, ALPACA_LIVE_BASE_URL } = await import(pathToFileURL(bundle).href);

// La puerta de la lista ya se verificó en la app; aquí la confirmación
// escrita de arriba hace de guarda manual del script.
const broker = createAlpacaLiveBroker({
  fetch: globalThis.fetch,
  getCredentials: async () => ({ apiKeyId: keyId, apiSecret: secret }),
  isLiveGateOpen: () => true,
});

const line = (label, value) => console.log(`  ${String(label).padEnd(20)} ${value}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const step = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`\n${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const referencePrice = async () => {
  if (process.env.TRADIA_SPY_REFERENCE) {
    const price = Number(process.env.TRADIA_SPY_REFERENCE);
    if (Number.isFinite(price) && price > 0) return price;
  }
  const headers = {
    'APCA-API-KEY-ID': keyId,
    'APCA-API-SECRET-KEY': secret,
  };
  for (const path of ['trades/latest', 'bars/latest']) {
    try {
      const res = await globalThis.fetch(`${DATA_BASE_URL}/v2/stocks/${TICKER}/${path}`, {
        headers,
      });
      if (!res.ok) continue;
      const body = await res.json();
      const price = Number(body?.trade?.p ?? body?.bar?.c);
      if (Number.isFinite(price) && price > 0) return price;
    } catch {
      // Prueba la siguiente fuente.
    }
  }
  return null;
};

const waitForFill = async (clientOrderId) => {
  const deadline = Date.now() + FILL_TIMEOUT_MS;
  for (;;) {
    const order = await broker.getOrderByClientId(clientOrderId);
    if (order !== null && order.status === 'ejecutada') return order;
    if (order !== null && ['rechazada', 'cancelada'].includes(order.status)) {
      throw new Error(`la orden ${clientOrderId} quedó ${order.status}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `la orden ${clientOrderId} no ejecutó en ${FILL_TIMEOUT_MS / 1000} s` +
          ` (último estado: ${order?.status ?? 'desconocido'})`,
      );
    }
    await sleep(POLL_MS);
  }
};

const run = async () => {
  console.log(`\nAdaptador Alpaca LIVE — ${ALPACA_LIVE_BASE_URL}.`);

  const account = await broker.getAccount();
  console.log('\nCuenta live:');
  line('cuenta', `•••• ${account.accountId.slice(-4)}`);
  line('estado', account.status);
  line('efectivo', `${account.cash} ${account.currency}`);

  const price = await referencePrice();
  if (price === null) {
    throw new Error(
      `no se pudo obtener un precio de referencia de ${TICKER}; ` +
        'pásalo con TRADIA_SPY_REFERENCE=<precio>',
    );
  }
  const quantity = Math.floor((NOTIONAL_USD / price) * 1e6) / 1e6;
  console.log(
    `\nReferencia ${TICKER}: ${price.toFixed(2)} USD → cantidad fraccionaria ${quantity}`,
  );
  if (!(quantity > 0)) {
    throw new Error('la fracción calculada es cero; revisa el precio de referencia');
  }

  const ts = Date.now();
  const buyClientId = `tradia-qa-humo-${ts}-compra`;
  const buy = await broker.submitOrder({
    clientOrderId: buyClientId,
    ticker: TICKER,
    type: 'market',
    side: 'buy',
    quantity,
    timeInForce: 'day',
  });
  step('1) Compra enviada', true, `${buyClientId} → ${buy.brokerOrderId}`);

  const filledBuy = await waitForFill(buyClientId);
  step(
    '2) Compra ejecutada',
    true,
    `${filledBuy.filledQuantity} uds a ${filledBuy.filledAvgPrice} USD`,
  );

  const sellClientId = `tradia-qa-humo-${ts}-cierre`;
  const sell = await broker.submitOrder({
    clientOrderId: sellClientId,
    ticker: TICKER,
    type: 'market',
    side: 'sell',
    quantity: filledBuy.filledQuantity,
    timeInForce: 'day',
  });
  step('3) Venta de cierre enviada', true, `${sellClientId} → ${sell.brokerOrderId}`);

  const filledSell = await waitForFill(sellClientId);
  step(
    '4) Posición cerrada',
    true,
    `${filledSell.filledQuantity} uds a ${filledSell.filledAvgPrice} USD`,
  );

  // Conciliación: posiciones y órdenes tal como las ve el broker.
  const positions = await broker.listPositions();
  const spyPosition = positions.find((p) => p.ticker === TICKER);
  const spyOpen = spyPosition !== undefined && Math.abs(spyPosition.quantity) > 1e-9;
  step(
    '5) Conciliación',
    !spyOpen,
    spyOpen
      ? `queda posición abierta de ${spyPosition.quantity} uds de ${TICKER}`
      : `sin posición en ${TICKER}; ${positions.length} posición(es) en la cuenta`,
  );

  const openOrders = await broker.listOrders({ openOnly: true });
  const dangling = openOrders.filter((o) => o.clientOrderId.startsWith('tradia-qa-humo-'));
  line('órdenes abiertas de la prueba', dangling.length === 0 ? '0' : dangling.length);

  const buyPrice = filledBuy.filledAvgPrice;
  const sellPrice = filledSell.filledAvgPrice;
  const pnl =
    filledBuy.filledQuantity * ((sellPrice ?? buyPrice ?? 0) - (buyPrice ?? sellPrice ?? 0));
  const slippageBps =
    buyPrice !== null && price > 0
      ? Math.round(((buyPrice - price) / price) * 10_000 * 100) / 100
      : null;

  console.log('\nResumen:');
  line('precio de referencia', `${price.toFixed(2)} USD`);
  line('ejecutado compra', `${buyPrice} USD`);
  line('ejecutado cierre', `${sellPrice} USD`);
  line('slippage compra', slippageBps === null ? '—' : `${slippageBps} pb`);
  line('PnL de la prueba', `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} USD`);

  console.log(
    '\nCompruébalo en el panel web de Alpaca live: la compra, la venta y el ' +
      'saldo deben coincidir con lo anterior.',
  );
};

try {
  await run();
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\nLa prueba terminó con ${failed.length} paso(s) en rojo.`);
    process.exitCode = 1;
  } else {
    console.log('\nResultado: prueba de humo real completada sin descuadres.');
  }
} catch (error) {
  const kind = typeof error?.kind === 'string' ? `[${error.kind}] ` : '';
  console.error(`\nFallo ${kind}${error?.message ?? error}`);
  console.error(
    'Si la compra llegó a ejecutarse, revisa la posición en el panel web de ' +
      'Alpaca y ciérrala a mano antes de repetir la prueba.',
  );
  process.exitCode = 1;
}
