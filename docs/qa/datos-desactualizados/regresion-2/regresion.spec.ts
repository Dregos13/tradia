/**
 * Diagnóstico «datos desactualizados» en la app real (fuera del modo E2E).
 * Informe: docs/qa/datos-desactualizados.md. Capturas y volcados en
 * docs/qa/datos-desactualizados/.
 *
 * Cómo se abre la app sin TRADIA_E2E:
 * - `electron --require bootstrap.cjs .`: el arranque fija un userData
 *   temporal (la app real no acepta otro), puede adelantar o atrasar el
 *   reloj del proceso principal y desvía api.tiingo.com y
 *   api.stlouisfed.org a un servidor local que imita a ambos proveedores.
 *   El código de la app (proveedores, ingesta, salud, régimen, predicción y
 *   señales) es el de producción: solo cambia el otro lado de la red.
 * - TRADIA_CONNECTIVITY_URLS apunta a /health del servidor local, que se
 *   puede «desenchufar» para simular la caída de internet.
 */
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

import { expectedSessionsBetween } from '../../../../src/main/market/calendar';

const projectRoot = resolve(__dirname, '../../../..');
const evidenceDir = resolve(projectRoot, 'docs/qa/datos-desactualizados/regresion-2');
const bootstrap = join(tmpdir(), 'tradia-qa-bootstrap.cjs');

// ---------------------------------------------------------------------------
// Servidor local: conectividad + Tiingo + FRED
// ---------------------------------------------------------------------------

interface MockState {
  /** false: /health corta la conexión (sin internet). */
  online: boolean;
  /** 'up' sirve datos; 'down' responde 503; 'auth' 401. */
  tiingo: 'up' | 'down' | 'auth';
  fred: 'up' | 'down' | 'auth';
  /** Última sesión que Tiingo tiene publicada. */
  tiingoLast: string;
  /** Última observación publicada por serie FRED. */
  fredLast: Record<string, string>;
  /** Días sin observación de las series del Tesoro (festivos de bonos). */
  bondHolidays: string[];
  requests: string[];
}

const _SERIES = ['DFF', 'CPIAUCSL', 'DGS2', 'DGS10', 'T10Y2Y', 'VIXCLS'] as const;
const SESSIONS = expectedSessionsBetween('2021-01-04', '2027-12-31').map((s) => s.date);

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

const priceCache = new Map<string, number[]>();
function closes(ticker: string): number[] {
  const cached = priceCache.get(ticker);
  if (cached) return cached;
  let price = 80 + hash(ticker) * 300;
  const out = SESSIONS.map((date) => {
    price *= 1 + (hash(`${ticker}:${date}`) - 0.48) * 0.03;
    return price;
  });
  priceCache.set(ticker, out);
  return out;
}

function tiingoRows(ticker: string, desde: string, hasta: string, last: string) {
  const series = closes(ticker);
  const rows: unknown[] = [];
  SESSIONS.forEach((date, i) => {
    if (date < desde || date > hasta || date > last) return;
    const close = series[i]!;
    const open = i > 0 ? series[i - 1]! : close;
    const high = Math.max(open, close) * 1.006;
    const low = Math.min(open, close) * 0.994;
    const volume = Math.round(1e6 + hash(`v:${ticker}:${date}`) * 5e6);
    rows.push({
      date: `${date}T00:00:00.000Z`,
      open,
      high,
      low,
      close,
      volume,
      adjOpen: open,
      adjHigh: high,
      adjLow: low,
      adjClose: close,
      adjVolume: volume,
      divCash: 0,
      splitFactor: 1,
    });
  });
  return rows;
}

function fredObservations(id: string, desde: string, hasta: string, state: MockState) {
  const last = state.fredLast[id] ?? '1900-01-01';
  const dates: string[] = [];
  if (id === 'CPIAUCSL') {
    for (let y = 2020; y <= 2027; y += 1)
      for (let m = 1; m <= 12; m += 1) dates.push(`${y}-${String(m).padStart(2, '0')}-01`);
  } else if (id === 'DFF') {
    for (let t = Date.parse('2020-01-01'); t <= Date.parse('2027-12-31'); t += 86_400_000)
      dates.push(new Date(t).toISOString().slice(0, 10));
  } else if (id === 'VIXCLS') {
    dates.push(...SESSIONS);
  } else {
    dates.push(...SESSIONS.filter((d) => !state.bondHolidays.includes(d)));
  }
  return dates
    .filter((d) => d >= desde && d <= hasta && d <= last)
    .map((date) => ({
      realtime_start: date,
      realtime_end: date,
      date,
      value: (1 + hash(`${id}:${date.slice(0, 7)}`) * 4).toFixed(2),
    }));
}

async function startMock(state: MockState): Promise<{ server: Server; base: string }> {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    state.requests.push(`${new Date().toISOString()} ${url.pathname}`);
    if (url.pathname === '/health') {
      if (!state.online) {
        request.socket.destroy();
        return;
      }
      response.writeHead(204).end();
      return;
    }
    const tiingo = /^\/tiingo-api\/tiingo\/daily\/([^/]+)\/prices$/.exec(url.pathname);
    if (tiingo) {
      if (!state.online) return void request.socket.destroy();
      if (state.tiingo === 'down') return void response.writeHead(503).end('maintenance');
      if (state.tiingo === 'auth')
        return void response.writeHead(401).end('{"detail":"Invalid token."}');
      const rows = tiingoRows(
        decodeURIComponent(tiingo[1]!).toUpperCase(),
        url.searchParams.get('startDate') ?? '2000-01-01',
        url.searchParams.get('endDate') ?? '2100-01-01',
        state.tiingoLast,
      );
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(rows));
      return;
    }
    if (url.pathname === '/fred-api/fred/series/observations') {
      if (!state.online) return void request.socket.destroy();
      if (state.fred === 'down') return void response.writeHead(503).end('{}');
      if (state.fred === 'auth')
        return void response
          .writeHead(400)
          .end(
            '{"error_code":400,"error_message":"Bad Request.  The value for variable api_key is not registered."}',
          );
      const id = url.searchParams.get('series_id') ?? '';
      const observations = fredObservations(
        id,
        url.searchParams.get('observation_start') ?? '1900-01-01',
        url.searchParams.get('observation_end') ?? '2100-01-01',
        state,
      );
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ observations }));
      return;
    }
    response.writeHead(404).end();
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

// ---------------------------------------------------------------------------
// Arranque de la app real
// ---------------------------------------------------------------------------

interface Session {
  app: ElectronApplication;
  page: Page;
  logs: string[];
}

async function launch(
  userData: string,
  base: string,
  options: { fakeNow?: string } = {},
): Promise<Session> {
  copyFileSync(join(__dirname, '../recorrido/bootstrap.cjs'), bootstrap);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('TRADIA_')) env[key] = value;
  }
  const app = await electron.launch({
    args: ['--require', bootstrap, '.'],
    cwd: projectRoot,
    env: {
      ...env,
      QA_USER_DATA: userData,
      QA_PROVIDER_MOCK: base,
      ...(options.fakeNow ? { QA_FAKE_NOW: options.fakeNow } : {}),
      TRADIA_CONNECTIVITY_URLS: JSON.stringify([`${base}/health`, `${base}/health?b`]),
    },
  });
  const logs: string[] = [];
  app.process().stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  app.process().stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
  const real = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  if (real !== userData) {
    await app.close();
    throw new Error(`userData inesperado: ${real}`);
  }
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 1000 }).catch(() => undefined);
  const gate = page.getByRole('heading', { name: 'Antes de empezar' });
  const home = page.getByRole('heading', { name: 'Estado del sistema', level: 1 });
  await expect(gate.or(home).first()).toBeVisible({ timeout: 30_000 });
  if (await gate.isVisible()) {
    await page.getByLabel('He leído y acepto').check();
    await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  }
  await expect(home).toBeVisible({ timeout: 30_000 });
  return { app, page, logs };
}

async function close(session: Session | undefined, name: string): Promise<void> {
  if (!session) return;
  writeFileSync(join(evidenceDir, `${name}-main.log`), session.logs.join(''));
  await session.app.close().catch(() => undefined);
}

async function openPage(page: Page, link: string, heading = link): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Principal' })
    .getByRole('link', { name: link, exact: true })
    .click();
  await expect(page.getByRole('heading', { name: heading, exact: true, level: 1 })).toBeVisible({
    timeout: 15_000,
  });
}

/** Captura a pantalla completa de la zona principal y su texto visible. */
async function snap(page: Page, name: string): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  await page.waitForTimeout(1_500); // deja asentar los fetch de la página
  await page.screenshot({ path: join(evidenceDir, `${name}.png`), fullPage: true });
  const text = await page.locator('body').innerText();
  writeFileSync(join(evidenceDir, `${name}.txt`), text);
}

const PAGES: Array<[string, string]> = [
  ['Inicio', 'Estado del sistema'],
  ['Mercado', 'Mercado'],
  ['IA', 'IA'],
  ['Salud de modelos', 'Salud de modelos'],
  ['Macro', 'Contexto macro'],
  ['Estrategias', 'Estrategias'],
];

async function tour(page: Page, prefix: string): Promise<void> {
  for (const [link, heading] of PAGES) {
    await openPage(page, link, heading);
    await snap(page, `${prefix}-${link.toLowerCase().replace(/\s+/g, '-')}`);
  }
  await openPage(page, 'Inicio', 'Estado del sistema');
}

/** Estado interno por IPC: lo que la app cree saber de sus datos. */
async function dump(page: Page, name: string): Promise<Record<string, unknown>> {
  const data = await page.evaluate(async () => {
    const t = window.tradia;
    const safe = async <T>(fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (error) {
        return { error: String(error) };
      }
    };
    const watch = (await safe(() => t.watchlist.list())) as Array<{ ticker: string }>;
    const lastBars: Record<string, unknown> = {};
    if (Array.isArray(watch)) {
      for (const { ticker } of watch) {
        const result = await safe(() => t.market.getBars({ ticker }));
        const bars = (result as { bars?: Array<{ date: string }>; source?: string }).bars ?? [];
        lastBars[ticker] = {
          source: (result as { source?: string }).source,
          count: bars.length,
          last: bars.at(-1)?.date ?? null,
        };
      }
    }
    return {
      now: new Date().toISOString(),
      connectivity: await safe(() => t.connectivity.getState()),
      dataStatus: await safe(() => t.dataStatus.get()),
      lastBars,
      regime: await safe(() => t.ai.regimeOverview()),
      predictions: await safe(() => t.ai.predictions({ limit: 20 })),
      modelCard: await safe(async () => {
        const card = await t.ai.modelCard();
        return card ? { version: (card as { version?: string }).version } : null;
      }),
      health: await safe(() => t.ai.health()),
      signals: await safe(() => t.signals.list()),
      signalStrategies: await safe(() => t.signals.strategies()),
    };
  });
  writeFileSync(join(evidenceDir, `${name}.json`), JSON.stringify(data, null, 2));
  return data;
}

async function saveKeys(page: Page): Promise<void> {
  await openPage(page, 'Ajustes');
  for (const name of ['Tiingo', 'FRED']) {
    await page
      .getByLabel(`Clave de API de ${name}`)
      .fill(`qa-${name.toLowerCase()}-key-0123456789`);
    await page.getByRole('button', { name: `Guardar clave de ${name}` }).click();
    await expect(page.getByRole('button', { name: `Guardar clave de ${name}` })).toBeEnabled({
      timeout: 15_000,
    });
  }
}

async function waitForBars(page: Page, tickers: string[], last: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (list) => {
          const dates = await Promise.all(
            list.map(async (ticker) => {
              const { bars } = await window.tradia.market.getBars({ ticker });
              return bars.length > 250 ? (bars.at(-1)?.date ?? '') : '';
            }),
          );
          return dates.sort()[0] ?? '';
        }, tickers),
      { timeout: 240_000, intervals: [2_000] },
    )
    .toBe(last);
}

const TICKERS = ['SPY', 'QQQ', 'AAPL', 'MSFT'];

function realisticFred(lastDaily: string, cpi: string, overrides: Record<string, string> = {}) {
  return {
    DFF: lastDaily,
    CPIAUCSL: cpi,
    DGS2: lastDaily,
    DGS10: lastDaily,
    T10Y2Y: lastDaily,
    VIXCLS: lastDaily,
    ...overrides,
  };
}

function newState(partial: Partial<MockState>): MockState {
  return {
    online: true,
    tiingo: 'up',
    fred: 'up',
    tiingoLast: '2026-10-09',
    fredLast: realisticFred('2026-10-08', '2026-08-01'),
    bondHolidays: ['2026-10-12', '2026-11-11'],
    requests: [],
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Escenarios
// ---------------------------------------------------------------------------

test.describe.configure({ mode: 'serial' });

const work = mkdtempSync(join(tmpdir(), 'tradia-qa-regr2-'));
const seeded = join(work, 'seeded-2026-09-18');

test.afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

async function journalTail(page: Page, name: string): Promise<void> {
  const data = await page.evaluate(async () => {
    const t = window.tradia as unknown as Record<
      string,
      Record<string, (a?: unknown) => Promise<unknown>>
    >;
    const out: Record<string, unknown> = {};
    try {
      out.killSwitch = await t.risk!.getKillSwitch!();
    } catch (e) {
      out.killSwitch = String(e);
    }
    try {
      out.agents = await t.agents!.getState!();
    } catch (e) {
      out.agents = String(e);
    }
    try {
      out.overview = await t.risk!.getOverview!();
    } catch (e) {
      out.overview = String(e);
    }
    return out;
  });
  writeFileSync(join(evidenceDir, `${name}.json`), JSON.stringify(data, null, 2));
}

test('B0 · siembra: base al día del viernes 18-sep-2026 (reloj atrasado)', async () => {
  const state = newState({
    tiingoLast: '2026-09-18',
    fredLast: realisticFred('2026-09-17', '2026-08-01'),
  });
  const { server, base } = await startMock(state);
  let session: Session | undefined;
  try {
    session = await launch(seeded, base, { fakeNow: '2026-09-19T10:00:00.000Z' });
    const { page } = session;
    await saveKeys(page);
    await page.evaluate(async (list) => {
      for (const ticker of list) await window.tradia.watchlist.add(ticker);
    }, TICKERS);
    await waitForBars(page, TICKERS, '2026-09-18');
    await expect
      .poll(
        () => page.evaluate(async () => (await window.tradia.ai.predictions({ limit: 5 })).length),
        { timeout: 120_000 },
      )
      .toBeGreaterThan(0)
      .catch(() => undefined);
    await page.waitForTimeout(10_000);
    await dump(page, 'b0-estado-sembrado');
  } finally {
    await close(session, 'b0');
    server.close();
  }
});

test('B3 · estrategias en paper y Tiingo solo hasta el 25-sep (sigue desactualizado)', async () => {
  const userData = join(work, 'b3');
  cpSync(seeded, userData, { recursive: true });
  let state = newState({
    tiingoLast: '2026-09-18',
    fredLast: realisticFred('2026-09-17', '2026-08-01'),
  });
  let mock = await startMock(state);
  let session: Session | undefined;
  try {
    session = await launch(userData, mock.base, { fakeNow: '2026-09-19T11:00:00.000Z' });
    const result = await session.page.evaluate(async () => {
      const list = await window.tradia.strategies.list();
      const out: unknown[] = [];
      for (const s of list as Array<{ id: number; name: string }>) {
        try {
          out.push(await window.tradia.strategies.setStatus({ id: s.id, status: 'paper' }));
        } catch (error) {
          out.push({ id: s.id, error: String(error) });
        }
      }
      return out;
    });
    writeFileSync(join(evidenceDir, 'b3-paso1-paper.json'), JSON.stringify(result, null, 2));
  } finally {
    await close(session, 'b3-paso1');
    mock.server.close();
  }
  state = newState({ tiingoLast: '2026-09-25' });
  mock = await startMock(state);
  session = undefined;
  try {
    session = await launch(userData, mock.base);
    await waitForBars(session.page, TICKERS, '2026-09-25');
    await session.page.waitForTimeout(15_000);
    await tour(session.page, 'b3');
    await openPage(session.page, 'Diario');
    await snap(session.page, 'b3-diario');
    await dump(session.page, 'b3-estado');
  } finally {
    await close(session, 'b3');
    mock.server.close();
  }
});

test('C-largo · más de 60 s sin red con datos viejos y vuelta a la red', async () => {
  const userData = join(work, 'c');
  cpSync(seeded, userData, { recursive: true });
  const state = newState({ online: false });
  const { server, base } = await startMock(state);
  let session: Session | undefined;
  try {
    session = await launch(userData, base);
    const { page } = session;
    await expect(page.getByText(/Sin conexión/).first()).toBeVisible({ timeout: 60_000 });
    await page.waitForTimeout(80_000);
    await snap(page, 'c1-sin-red-80s');
    await dump(page, 'c1-estado-80s');
    await journalTail(page, 'c1-parada-80s');
    const before = state.requests.filter((r) => r.includes('tiingo-api')).length;
    state.online = true;
    const reconnectedAt = Date.now();
    await expect(page.getByText(/Sin conexión/).first()).toBeHidden({ timeout: 120_000 });
    const reconnectMs = Date.now() - reconnectedAt;
    await page.waitForTimeout(30_000);
    await snap(page, 'c2-inicio-tras-volver-red');
    await journalTail(page, 'c2-parada-tras-volver-red');
    await openPage(page, 'Estrategias');
    await snap(page, 'c2-estrategias');
    await openPage(page, 'Inicio', 'Estado del sistema');
    const after = await dump(page, 'c2-estado-tras-volver-red');
    writeFileSync(
      join(evidenceDir, 'c-resumen.json'),
      JSON.stringify(
        {
          reconnectMs,
          tiingoRequestsBefore: before,
          tiingoRequestsAfter: state.requests.filter((r) => r.includes('tiingo-api')).length,
          lastBars: after.lastBars,
        },
        null,
        2,
      ),
    );
  } finally {
    await close(session, 'c');
    server.close();
  }
});
