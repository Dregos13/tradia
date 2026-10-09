import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeliverySendError, sendTelegramMessage } from './telegram';

/**
 * Servidor HTTP local que simula la Bot API de Telegram: guarda cada
 * petición y contesta según el guion que fije la prueba.
 */
interface TelegramRequest {
  url: string;
  body: { chat_id?: unknown; text?: unknown; disable_web_page_preview?: unknown };
}

interface ScriptedReply {
  status: number;
  payload: Record<string, unknown>;
}

describe('sendTelegramMessage · Bot API sobre HTTP local', () => {
  let server: Server;
  let apiBase: string;
  let requests: TelegramRequest[];
  let script: ScriptedReply[];

  const reply = (status: number, payload: Record<string, unknown>): ScriptedReply => ({
    status,
    payload,
  });

  beforeEach(async () => {
    requests = [];
    script = [reply(200, { ok: true, result: {} })];
    server = createServer((request, response) => {
      let raw = '';
      request.on('data', (chunk) => {
        raw += chunk;
      });
      request.on('end', () => {
        requests.push({ url: request.url ?? '', body: JSON.parse(raw || '{}') });
        const next = script.length > 1 ? script.shift()! : script[0]!;
        response.writeHead(next.status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(next.payload));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    apiBase = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const send = (sleep: (ms: number) => Promise<void> = () => Promise.resolve()) =>
    sendTelegramMessage(
      { fetchImpl: globalThis.fetch, apiBase, sleep, retryDelaysMs: [0, 0] },
      { token: 'token-abc', chatId: '42', text: 'Señal aprobada · AAPL compra' },
    );

  it('hace POST a sendMessage con chat_id y texto', async () => {
    await send();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('/bottoken-abc/sendMessage');
    expect(requests[0]!.body).toMatchObject({
      chat_id: '42',
      text: 'Señal aprobada · AAPL compra',
      disable_web_page_preview: true,
    });
  });

  it('reintenta ante un 5xx y acaba entregando', async () => {
    script = [reply(500, { ok: false, description: 'caído' }), reply(200, { ok: true })];
    await send();
    expect(requests).toHaveLength(2);
  });

  it('reintenta ante un 429 con retry_after', async () => {
    script = [
      reply(429, { ok: false, description: 'demasiadas', parameters: { retry_after: 0 } }),
      reply(200, { ok: true }),
    ];
    await send();
    expect(requests).toHaveLength(2);
  });

  it('no reintenta un 4xx permanente y propaga la descripción', async () => {
    script = [reply(400, { ok: false, description: 'chat not found' })];
    await expect(send()).rejects.toThrow('chat not found');
    expect(requests).toHaveLength(1);
  });

  it('agota los reintentos ante un fallo de red', async () => {
    // Un puerto que acabamos de liberar: fetch rechaza y se agotan los 3 intentos.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const dead = `http://127.0.0.1:${deadPort}`;
    let attempts = 0;
    await expect(
      sendTelegramMessage(
        {
          fetchImpl: globalThis.fetch,
          apiBase: dead,
          sleep: () => Promise.resolve(),
          retryDelaysMs: [0, 0],
          onAttempt: () => {
            attempts += 1;
          },
        },
        { token: 't', chatId: '1', text: 'x' },
      ),
    ).rejects.toBeInstanceOf(DeliverySendError);
    expect(attempts).toBe(3);
  });
});
