import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it } from 'vitest';

import type { EmailChannelInput } from '../../shared/journal';
import { sendEmailMessage } from './email';

/**
 * Servidor SMTP local simulado: un subconjunto mínimo del protocolo
 * (EHLO, AUTH PLAIN/LOGIN, MAIL/RCPT/DATA, QUIT) suficiente para que
 * nodemailer complete un envío real. `rcptReply` guiona la respuesta a
 * RCPT TO para probar los reintentos.
 */
interface SmtpCapture {
  authPlain: string[];
  mailFrom: string[];
  rcptTo: string[];
  data: string[];
}

function startFakeSmtp(
  rcptReply: string,
): Promise<{ server: Server; port: number; capture: SmtpCapture }> {
  const capture: SmtpCapture = { authPlain: [], mailFrom: [], rcptTo: [], data: [] };

  const server = createServer((socket: Socket) => {
    socket.setEncoding('utf8');
    socket.write('220 fake.local ESMTP\r\n');
    let buffer = '';
    let inData = false;
    let dataLines = '';
    let authLoginStep: 'user' | 'pass' | null = null;

    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          capture.data.push(dataLines + buffer.slice(0, end));
          dataLines = '';
          buffer = buffer.slice(end + 5);
          inData = false;
          socket.write('250 2.0.0 Ok: queued\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = (line.split(' ')[0] ?? '').toUpperCase();

        if (authLoginStep === 'user') {
          authLoginStep = 'pass';
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (authLoginStep === 'pass') {
          authLoginStep = null;
          socket.write('235 2.7.0 Accepted\r\n');
        } else if (verb === 'EHLO' || verb === 'HELO') {
          socket.write('250-fake.local\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        } else if (verb === 'AUTH' && line.toUpperCase().startsWith('AUTH PLAIN')) {
          capture.authPlain.push(line.slice('AUTH PLAIN'.length).trim());
          socket.write('235 2.7.0 Accepted\r\n');
        } else if (verb === 'AUTH' && line.toUpperCase().startsWith('AUTH LOGIN')) {
          authLoginStep = 'user';
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (verb === 'MAIL') {
          capture.mailFrom.push(line);
          socket.write('250 2.1.0 Ok\r\n');
        } else if (verb === 'RCPT') {
          capture.rcptTo.push(line);
          socket.write(rcptReply);
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'RSET' || verb === 'NOOP') {
          socket.write('250 2.0.0 Ok\r\n');
        } else if (verb === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('502 5.5.2 Command not recognized\r\n');
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, port, capture });
    });
  });
}

const emailConfig = (port: number): EmailChannelInput => ({
  enabled: true,
  host: '127.0.0.1',
  port,
  security: 'ninguna',
  user: 'tradia@local.dev',
  to: 'usuario@local.dev',
  events: ['senal-aprobada'],
});

describe('sendEmailMessage · SMTP local simulado', () => {
  let server: Server;

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('autentica y entrega el mensaje con asunto y cuerpo', async () => {
    const fake = await startFakeSmtp('250 2.1.5 Ok\r\n');
    server = fake.server;

    await sendEmailMessage(
      {
        createTransport: (options) => nodemailer.createTransport(options),
        sleep: () => Promise.resolve(),
        retryDelaysMs: [0, 0],
      },
      {
        config: emailConfig(fake.port),
        password: 'contraseña-secreta',
        subject: 'Prueba de Tradia · correo',
        text: 'Mensaje de prueba.\nAviso informativo: Tradia no ejecuta órdenes reales.',
      },
    );

    // AUTH PLAIN va en base64 (\0usuario\0contraseña).
    expect(fake.capture.authPlain).toHaveLength(1);
    const decoded = Buffer.from(fake.capture.authPlain[0]!, 'base64').toString('utf8');
    expect(decoded).toContain('tradia@local.dev');
    expect(decoded).toContain('contraseña-secreta');

    expect(fake.capture.rcptTo).toHaveLength(1);
    const data = fake.capture.data[0]!;
    // El asunto viaja codificado en MIME por la «·» (UTF-8 quoted-printable).
    expect(data).toContain('Subject: =?UTF-8?Q?Prueba_de_Tradia');
    expect(data).toContain('Mensaje de prueba.');
  });

  it('reintenta una respuesta 4xx del servidor hasta agotar intentos', async () => {
    const fake = await startFakeSmtp('450 4.7.1 Inténtalo más tarde\r\n');
    server = fake.server;
    await expect(
      sendEmailMessage(
        {
          createTransport: (options) => nodemailer.createTransport(options),
          sleep: () => Promise.resolve(),
          retryDelaysMs: [0, 0],
        },
        {
          config: emailConfig(fake.port),
          password: 'pw',
          subject: 's',
          text: 't',
        },
      ),
    ).rejects.toThrow('SMTP');
    // 3 intentos, pero cada intento reabre la sesión: varios RCPT recibidos.
    expect(fake.capture.rcptTo.length).toBe(3);
  });

  it('no reintenta un 5xx permanente', async () => {
    const fake = await startFakeSmtp('550 5.1.1 Buzón inexistente\r\n');
    server = fake.server;

    await expect(
      sendEmailMessage(
        {
          createTransport: (options) => nodemailer.createTransport(options),
          sleep: () => Promise.resolve(),
          retryDelaysMs: [0, 0],
        },
        {
          config: emailConfig(fake.port),
          password: 'pw',
          subject: 's',
          text: 't',
        },
      ),
    ).rejects.toThrow('SMTP');
    expect(fake.capture.rcptTo.length).toBe(1);
  });
});
