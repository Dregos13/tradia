/**
 * Canal de correo: SMTP con nodemailer.
 *
 * La contraseña llega desde el almacén de secretos (nunca por IPC) y el
 * transporte se crea por envío: el volumen de avisos no justifica un pool
 * y así un cambio de config no convive con conexiones viejas. `security`
 * se traduce a nodemailer: 'tls' → `secure`, 'starttls' → `requireTLS` y
 * 'ninguna' → `ignoreTLS` (solo pensada para el servidor SMTP simulado de
 * las pruebas locales). Reintentos con espera creciente en fallos de red
 * y respuestas 4xx del servidor; los 5xx son permanentes.
 */

import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import type { EmailChannelInput } from '../../shared/journal';
import { DeliverySendError, type RetryDeps } from './telegram';

export interface SmtpTransporterLike {
  sendMail(mail: SMTPTransport.MailOptions): Promise<SMTPTransport.SentMessageInfo>;
  close(): void;
}

export interface EmailSendDeps extends RetryDeps {
  /** Factoría del transporte (nodemailer en producción, simulado en tests). */
  createTransport(options: SMTPTransport.Options): SmtpTransporterLike;
}

interface SmtpError extends Error {
  code?: string;
  command?: string;
  response?: string;
  responseCode?: number;
}

/** Opciones SMTP derivadas de la config del canal. */
export function smtpOptions(config: EmailChannelInput, password: string): SMTPTransport.Options {
  return {
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'ninguna',
    auth: { user: config.user, pass: password },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  };
}

/** 4xx SMTP es transitorio; 5xx (buzón rechazado, auth) es permanente. */
function classify(error: unknown): DeliverySendError {
  const smtpError = error as SmtpError;
  const code = smtpError?.code ?? '';
  const responseCode = smtpError?.responseCode;
  const transient =
    responseCode === undefined ||
    (responseCode >= 400 && responseCode < 500) ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKET' ||
    code === 'ECONNECTION';
  const message = smtpError?.response ?? smtpError?.message ?? String(error);
  return new DeliverySendError(`SMTP: ${String(message)}`, transient);
}

export async function sendEmailMessage(
  deps: EmailSendDeps,
  mail: { config: EmailChannelInput; password: string; subject: string; text: string },
): Promise<void> {
  const delays = deps.retryDelaysMs ?? [400, 800];

  const attempt = async (): Promise<void> => {
    deps.onAttempt?.();
    const transporter = deps.createTransport(smtpOptions(mail.config, mail.password));
    try {
      await transporter.sendMail({
        from: mail.config.user,
        to: mail.config.to,
        subject: mail.subject,
        text: mail.text,
      });
    } finally {
      transporter.close();
    }
  };

  let lastError: DeliverySendError | null = null;
  for (let i = 0; i <= delays.length; i += 1) {
    try {
      await attempt();
      return;
    } catch (error: unknown) {
      lastError = classify(error);
      if (!lastError.retryable || i === delays.length) break;
      await deps.sleep(delays[i] ?? 0);
    }
  }
  throw lastError;
}
