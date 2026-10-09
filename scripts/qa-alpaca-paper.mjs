/**
 * Comprobación manual del adaptador Alpaca paper (no se ejecuta en CI).
 *
 * Empaqueta `src/main/broker/alpaca.ts` con esbuild (ya en node_modules vía
 * vite) y usa el adaptador REAL contra la URL paper fija: lee la cuenta,
 * envía una orden limitada y un OCO lejos de mercado y los cancela. Después
 * el usuario verifica en el panel web de Alpaca paper que las órdenes
 * aparecieron y quedaron canceladas.
 *
 * Uso (claves de una cuenta PAPER; las de live dan 401):
 *   APCA_API_KEY_ID=PK… APCA_API_SECRET_KEY=SK… npm run qa:alpaca-paper
 */
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const keyId = process.env.APCA_API_KEY_ID ?? process.env['APCA-API-KEY-ID'];
const secret = process.env.APCA_API_SECRET_KEY ?? process.env['APCA-API-SECRET-KEY'];
if (!keyId || !secret) {
  console.error('Faltan las claves de la cuenta paper de Alpaca. Uso:');
  console.error('  APCA_API_KEY_ID=PK… APCA_API_SECRET_KEY=SK… npm run qa:alpaca-paper');
  process.exit(2);
}

const outDir = mkdtempSync(join(tmpdir(), 'tradia-qa-alpaca-'));
const bundle = join(outDir, 'alpaca.mjs');
execFileSync(
  resolve('node_modules/.bin/esbuild'),
  [
    'src/main/broker/alpaca.ts',
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--log-level=warning',
    `--outfile=${bundle}`,
  ],
  { stdio: 'inherit' },
);
const { createAlpacaBroker, ALPACA_PAPER_BASE_URL } = await import(pathToFileURL(bundle).href);

const broker = createAlpacaBroker({
  fetch: globalThis.fetch,
  getCredentials: async () => ({ apiKeyId: keyId, apiSecret: secret }),
});

const line = (label, value) => console.log(`  ${String(label).padEnd(18)} ${value}`);

const run = async () => {
  console.log(`Adaptador Alpaca paper — ${ALPACA_PAPER_BASE_URL} (sin dinero real).`);

  const account = await broker.getAccount();
  console.log('\nCuenta paper:');
  line('cuenta', account.accountId);
  line('estado', account.status);
  line('efectivo', `${account.cash} ${account.currency}`);
  line('equity', account.equity);

  const ts = Date.now();

  console.log('\n1) Orden limitada lejos de mercado (buy 1 AAPL @ 1,00 $, gtc):');
  const limit = await broker.submitOrder({
    clientOrderId: `tradia-qa-limit-${ts}`,
    ticker: 'AAPL',
    type: 'limit',
    side: 'buy',
    quantity: 1,
    limitPrice: 1,
    timeInForce: 'gtc',
  });
  line('client_order_id', limit.clientOrderId);
  line('broker id', limit.brokerOrderId);
  line('estado', limit.status);
  const canceledLimit = await broker.cancelOrder(limit.brokerOrderId);
  line('tras cancelar', canceledLimit.status);

  console.log('\n2) OCO lejos de mercado (buy 1 AAPL: límite 1,00 $ / stop 9 999,00 $):');
  const oco = await broker.submitOrder({
    clientOrderId: `tradia-qa-oco-${ts}`,
    ticker: 'AAPL',
    type: 'oco',
    side: 'buy',
    quantity: 1,
    limitPrice: 1,
    stopPrice: 9999,
  });
  line('client_order_id', oco.clientOrderId);
  line('broker id', oco.brokerOrderId);
  line('estado', oco.status);
  line('patas', (oco.legs ?? []).map((leg) => leg.type).join(' + ') || '—');
  const canceledOco = await broker.cancelOrder(oco.brokerOrderId);
  line('tras cancelar', canceledOco.status);

  console.log('\nResultado: limitada y OCO enviadas y canceladas contra la API paper real.');
  console.log('Compruébalo en el panel web de Alpaca paper: ambas deben figurar canceladas.');
};

try {
  await run();
} catch (error) {
  const kind = typeof error?.kind === 'string' ? `[${error.kind}] ` : '';
  console.error(`\nFallo ${kind}${error?.message ?? error}`);
  if (error?.kind === 'auth') {
    console.error(
      'Pista: las claves deben ser de una cuenta PAPER de Alpaca; las de live dan 401.',
    );
  }
  process.exitCode = 1;
}
