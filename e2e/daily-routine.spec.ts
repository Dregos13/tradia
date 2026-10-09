import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';

import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import type { JournalEntry } from '../src/shared/journal';

const projectRoot = resolve('.');
const ROUTINE_ADVANCE_MS = 25 * 60 * 60 * 1000;
const TEST_TOKEN = '123456789:e2e-local-token';
const TEST_PASSWORD = 'tradia-e2e-local-smtp-password';

function createSmtpServer(messages: string[]): TcpServer {
  return createTcpServer((socket) => {
    let pending = '';
    let message = '';
    let readingData = false;
    socket.write('220 localhost ESMTP Tradia E2E\r\n');
    socket.on('data', (chunk) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\r\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (readingData) {
          if (line === '.') {
            readingData = false;
            messages.push(message);
            message = '';
            socket.write('250 2.0.0 queued\r\n');
          } else {
            message += `${line}\r\n`;
          }
          continue;
        }
        const command = line.toUpperCase();
        if (command.startsWith('EHLO ') || command.startsWith('HELO ')) {
          socket.write('250-localhost\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n');
        } else if (command.startsWith('AUTH PLAIN')) {
          socket.write('235 2.7.0 authenticated\r\n');
        } else if (command === 'AUTH LOGIN') {
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (command === 'DGVzdGVyQGV4YW1wbGUudGVzdA==') {
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (command === Buffer.from(TEST_PASSWORD).toString('base64')) {
          socket.write('235 2.7.0 authenticated\r\n');
        } else if (command.startsWith('MAIL FROM:') || command.startsWith('RCPT TO:')) {
          socket.write('250 2.1.0 accepted\r\n');
        } else if (command === 'DATA') {
          readingData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (command === 'QUIT') {
          socket.write('221 2.0.0 bye\r\n');
          socket.end();
        } else if (command === 'RSET' || command === 'NOOP') {
          socket.write('250 2.0.0 ok\r\n');
        } else {
          socket.write('250 2.0.0 ok\r\n');
        }
      }
    });
  });
}

async function listen(server: HttpServer | TcpServer): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: HttpServer | TcpServer): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

async function launchTradia(
  userData: string,
  endpoint: string,
  telegramApiBase: string,
): Promise<ElectronApplication> {
  return electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      TRADIA_E2E: '1',
      TRADIA_E2E_USER_DATA: userData,
      TRADIA_CONNECTIVITY_URLS: JSON.stringify([endpoint, endpoint]),
      TRADIA_TELEGRAM_API_BASE: telegramApiBase,
    },
  });
}

async function acceptRisk(page: Page): Promise<void> {
  await page.getByLabel('He leído y acepto').check();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible();
}

async function captureNotifications(app: ElectronApplication): Promise<void> {
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

test('Responsable de equipo: adelanta el reloj y recibe los tres resúmenes en diario, escritorio y canales locales', async () => {
  test.setTimeout(120_000);
  const userData = mkdtempSync(join(tmpdir(), 'tradia-routine-e2e-'));
  const telegramMessages: Array<{ url: string; body: string }> = [];
  const mailMessages: string[] = [];
  const telegramServer = createHttpServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => {
      telegramMessages.push({ url: request.url ?? '', body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, result: { message_id: telegramMessages.length } }));
    });
  });
  const smtpServer = createSmtpServer(mailMessages);
  const connectivityServer = createHttpServer((_request, response) => {
    response.writeHead(204).end();
  });
  const telegramPort = await listen(telegramServer);
  const smtpPort = await listen(smtpServer);
  const connectivityPort = await listen(connectivityServer);
  const telegramApiBase = `http://127.0.0.1:${telegramPort}`;
  const connectivityUrl = `http://127.0.0.1:${connectivityPort}/health`;
  let app: ElectronApplication | null = null;

  try {
    app = await launchTradia(userData, connectivityUrl, telegramApiBase);
    const page = await app.firstWindow();
    await acceptRisk(page);
    await captureNotifications(app);
    await page.evaluate(
      async ({ token, password, smtpPort }) => {
        await window.tradia.secrets.setKey('telegram-bot-token', token);
        await window.tradia.secrets.setKey('correo-smtp-password', password);
        await window.tradia.delivery.setConfig({
          telegram: {
            enabled: true,
            chatId: '246810',
            events: ['resumen-diario'],
          },
          email: {
            enabled: true,
            host: '127.0.0.1',
            port: smtpPort,
            security: 'ninguna',
            user: 'tester@example.test',
            to: 'qa@example.test',
            events: ['resumen-diario'],
          },
        });
      },
      { token: TEST_TOKEN, password: TEST_PASSWORD, smtpPort },
    );
    const routineConfig = {
      preapertura: '00:01',
      cierre: '00:02',
      conciliacion: '00:03',
    };
    await page.evaluate((config) => window.tradia.routine.setConfig(config), routineConfig);

    let summaries: JournalEntry[] = [];
    for (let day = 0; day < 14; day += 1) {
      await page.evaluate(
        (delta) => window.tradia.testing!.advanceRoutineClock(delta),
        ROUTINE_ADVANCE_MS,
      );
      summaries = (
        await page.evaluate(() => window.tradia.journal.list({ type: 'resumen', limit: 100 }))
      ).entries;
      if (new Set(summaries.map((entry) => entry.dataUsed?.['rutina'])).size >= 3) break;
    }

    const kinds = new Set(summaries.map((entry) => entry.dataUsed?.['rutina']));
    expect([...kinds]).toEqual(expect.arrayContaining(['preapertura', 'cierre', 'conciliacion']));
    expect(summaries.filter((entry) => entry.result === 'con-retraso').length).toBeGreaterThan(0);
    await expect.poll(async () => telegramMessages.length).toBeGreaterThanOrEqual(3);
    await expect.poll(async () => mailMessages.length).toBeGreaterThanOrEqual(3);
    for (const [kind, expectedText] of [
      ['preapertura', /Resumen previo a la apertura/],
      ['cierre', /Revisión al cierre/],
      ['conciliacion', /Conciliación/],
    ] as const) {
      const entry = summaries.find((item) => item.dataUsed?.['rutina'] === kind);
      expect(entry).toBeDefined();
      expect(entry?.reason).toMatch(expectedText);
      expect(telegramMessages.some(({ body }) => JSON.parse(body).text.match(expectedText))).toBe(
        true,
      );
    }

    const desktopCalls = await app.evaluate(() => {
      const state = globalThis as typeof globalThis & {
        __tradiaNotificationCalls?: Array<{ title: string; body: string }>;
      };
      return state.__tradiaNotificationCalls ?? [];
    });
    expect(
      desktopCalls.filter((item) => /resumen|apertura|cierre|conciliación/i.test(item.title)),
    ).toHaveLength(3);
    expect(telegramMessages.every(({ url }) => url === `/bot${TEST_TOKEN}/sendMessage`)).toBe(true);

    await page.getByRole('link', { name: 'Diario', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Diario', level: 2 })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Conciliación' })).toBeVisible();
    await page.screenshot({ path: 'test-results/daily-routine-journal.png' });

    const capture = readFileSync(join(userData, 'delivery-captures.jsonl'), 'utf8');
    const emailDeliveries = capture
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as { channel: string; event: string; title: string; ok: boolean },
      )
      .filter((record) => record.channel === 'correo' && record.event === 'resumen-diario');
    expect(emailDeliveries).toHaveLength(3);
    expect(emailDeliveries.every((record) => record.ok)).toBe(true);
    expect(mailMessages).toHaveLength(3);
  } finally {
    if (app) await app.close();
    await Promise.all([close(telegramServer), close(smtpServer), close(connectivityServer)]);
    rmSync(userData, { recursive: true, force: true });
  }
});
