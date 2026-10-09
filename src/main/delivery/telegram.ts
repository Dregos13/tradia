/**
 * Canal de Telegram: Bot API `sendMessage` por HTTPS.
 *
 * Un POST JSON a `{apiBase}/bot{token}/sendMessage` con `chat_id` y
 * `text`. `apiBase` es inyectable para que las pruebas sirvan un servidor
 * HTTP local (y el modo E2E lo redirige con `TRADIA_TELEGRAM_API_BASE`);
 * en producción es siempre `https://api.telegram.org`. Los reintentos con
 * espera creciente solo aplican a errores de red, 429 (respeta
 * `retry_after`) y 5xx: un 4xx es permanente y no se reintenta. Nunca se
 * incluye el token en los errores.
 */

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
export const TELEGRAM_TIMEOUT_MS = 10_000;
/** Esperas entre intentos: 400 ms y 800 ms (creciente). */
export const DELIVERY_RETRY_DELAYS_MS = [400, 800] as const;

export class DeliverySendError extends Error {
  /** true si merece un reintento (red, 429, 5xx); false si es permanente. */
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = 'DeliverySendError';
    this.retryable = retryable;
  }
}

export interface RetryDeps {
  sleep(ms: number): Promise<void>;
  /** Esperas entre intentos; el número de intentos es delays.length + 1. */
  retryDelaysMs?: readonly number[];
  /** Se llama al inicio de cada intento (para contar en la captura E2E). */
  onAttempt?(): void;
}

interface TelegramApiResponse {
  ok?: boolean;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface TelegramSendDeps extends RetryDeps {
  fetchImpl: typeof fetch;
  /** Base de la Bot API sin barra final; inyectable solo en pruebas/E2E. */
  apiBase?: string;
  /** Tope del `retry_after` que Telegram puede pedir (ms). */
  maxRetryAfterMs?: number;
  timeoutMs?: number;
}

/** Espera los ms indicados salvo que se pare el envío (sleep inyectable). */
export async function sendTelegramMessage(
  deps: TelegramSendDeps,
  message: { token: string; chatId: string; text: string },
): Promise<void> {
  const delays = deps.retryDelaysMs ?? DELIVERY_RETRY_DELAYS_MS;
  const apiBase = deps.apiBase ?? TELEGRAM_API_BASE;
  const timeoutMs = deps.timeoutMs ?? TELEGRAM_TIMEOUT_MS;

  const attempt = async (): Promise<void> => {
    deps.onAttempt?.();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await deps.fetchImpl(`${apiBase}/bot${message.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: message.chatId,
          text: message.text,
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      const aborted = error instanceof Error && error.name === 'AbortError';
      throw new DeliverySendError(
        aborted
          ? `tiempo de espera agotado (${timeoutMs} ms) contactando con Telegram`
          : `sin conexión con Telegram: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    let payload: TelegramApiResponse = {};
    try {
      payload = (await response.json()) as TelegramApiResponse;
    } catch {
      // Cuerpo no JSON: se valora solo el estado HTTP.
    }

    if (response.ok && payload.ok === true) return;

    const detail = payload.description ?? `HTTP ${response.status}`;
    if (response.status === 429) {
      const retryAfterMs = Math.min(
        Math.max(0, (payload.parameters?.retry_after ?? 0) * 1000),
        deps.maxRetryAfterMs ?? 60_000,
      );
      const error = new DeliverySendError(`Telegram pide esperar: ${detail}`, true);
      (error as DeliverySendError & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
      throw error;
    }
    if (response.status >= 500) {
      throw new DeliverySendError(`Telegram no disponible (${detail})`, true);
    }
    // 4xx (token inválido, chat desconocido…): permanente, no se reintenta.
    throw new DeliverySendError(`Telegram rechazó el mensaje (${detail})`, false);
  };

  let lastError: DeliverySendError | null = null;
  for (let i = 0; i <= delays.length; i += 1) {
    try {
      await attempt();
      return;
    } catch (error: unknown) {
      lastError =
        error instanceof DeliverySendError ? error : new DeliverySendError(String(error), true);
      if (!lastError.retryable || i === delays.length) break;
      const extra = (lastError as DeliverySendError & { retryAfterMs?: number }).retryAfterMs;
      await deps.sleep(Math.max(delays[i] ?? 0, extra ?? 0));
    }
  }
  throw lastError;
}
