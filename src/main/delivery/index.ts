/**
 * Canales de entrega (fase 4): escritorio, Telegram y correo.
 *
 * - Escritorio: una notificación nativa por señal aprobada/reducida, señal
 *   vetada y límite alcanzado (y por resúmenes de la rutina), siempre por
 *   `notifications.notify`, que ya aplica las preferencias por nivel.
 * - Telegram y correo: opcionales y desactivados por defecto. La config
 *   (sin secretos) vive en `settings` bajo `delivery.config`; el token del
 *   bot y la contraseña SMTP solo se leen del almacén de secretos
 *   (`DELIVERY_SECRET_KEYS`), nunca viajan por `delivery:*` ni aparecen en
 *   errores, log o diario.
 * - Envíos con reintentos de espera creciente (`DELIVERY_RETRY_DELAYS_MS`);
 *   cada fallo queda en el log, en el diario ('error') y, en modo E2E, en
 *   el fichero de captura `userData/delivery-captures.jsonl`.
 * - El servicio se entera de las señales y los límites atravesando
 *   `ctx.broadcast`: intercepta `signals:new` (SignalNewEvent) y
 *   `risk:vetoed` (RiskVeto). La rutina diaria lo llama directamente con
 *   `sendEvent('resumen-diario', …)`.
 */

import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

import { app, ipcMain } from 'electron';
import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isDeliveryConfigInput,
  isDeliveryTestRequest,
  isE2eEnabled,
  type NotificationLevel,
  type NotificationPayload,
  type NotificationRoute,
} from '../../shared/ipc';
import {
  DELIVERY_CONFIG_DEFAULTS,
  DELIVERY_SECRET_KEYS,
  type DeliveryChannel,
  type DeliveryConfig,
  type DeliveryConfigInput,
  type DeliveryEventKind,
  type DeliveryTestableChannel,
  type DeliveryTestResult,
  type JournalRecordInput,
} from '../../shared/journal';
import type { RiskVeto } from '../../shared/risk';
import type { Signal, SignalNewEvent } from '../../shared/signals';
import type { ServiceContext } from '../services';
import { sendEmailMessage, type SmtpTransporterLike } from './email';
import { channelLabel, isLimitVeto, limitText, signalText, testText } from './format';
import { DELIVERY_RETRY_DELAYS_MS, sendTelegramMessage } from './telegram';

// ---------------------------------------------------------------------------
// Tipos públicos
// ---------------------------------------------------------------------------

/** Aviso ya redactado que sale por los canales (título + cuerpo). */
export interface DeliveryMessage {
  title: string;
  body: string;
  /** Vista que abre el clic de la notificación de escritorio. */
  navigateTo?: NotificationRoute;
}

/**
 * Registro del gancho E2E: una línea JSON por envío (o intento) en
 * `userData/delivery-captures.jsonl`. Solo se escribe fuera de la app
 * empaquetada; nunca contiene secretos.
 */
export interface DeliveryCaptureRecord {
  /** ISO 8601. */
  at: string;
  channel: DeliveryChannel;
  /** Evento entregado; 'prueba' para los envíos del botón «Enviar prueba». */
  event: DeliveryEventKind | 'prueba';
  title: string;
  body: string;
  /** Destino resumido (chat id, destinatario o 'sistema'); sin secretos. */
  to: string;
  ok: boolean;
  /** Intentos realizados (≥ 1). */
  attempts: number;
  error: string | null;
}

export interface DeliveryService {
  /**
   * Reparte un aviso: notificación de escritorio y cada canal externo
   * activo suscrito a `kind`. Lo usan los interceptores de broadcast y la
   * rutina diaria (`resumen-diario`).
   */
  sendEvent(kind: DeliveryEventKind, message: DeliveryMessage): void;
  /** Punto de entrada del evento `signals:new`. */
  handleSignal(signal: Signal): void;
  /** Punto de entrada del evento `risk:vetoed` (límites alcanzados). */
  handleRiskVeto(veto: RiskVeto): void;
  getConfig(): Promise<DeliveryConfig>;
  setConfig(input: DeliveryConfigInput): Promise<DeliveryConfig>;
  /** «Enviar prueba» por un canal externo. */
  test(channel: DeliveryTestableChannel): Promise<DeliveryTestResult>;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Núcleo del servicio (sin Electron)
// ---------------------------------------------------------------------------

export interface DeliveryLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface DeliveryDeps {
  notify(payload: NotificationPayload): void;
  /** Config persistida (sin secretos); memoria si falta el almacén. */
  getConfigInput(): DeliveryConfigInput;
  setConfigInput(input: DeliveryConfigInput): void;
  /** Secretos por clave de proveedor (DELIVERY_SECRET_KEYS). */
  getSecret(key: string): Promise<string | null>;
  hasSecret(key: string): Promise<boolean>;
  fetchImpl?: typeof fetch;
  /** Base de la Bot API; solo se desvía en pruebas/E2E. */
  telegramApiBase?: string;
  createTransport?(options: SMTPTransport.Options): SmtpTransporterLike;
  sleep?(ms: number): Promise<void>;
  /** Esperas entre reintentos; por defecto DELIVERY_RETRY_DELAYS_MS. */
  retryDelaysMs?: readonly number[];
  /**
   * Ventana de agrupación de `risk:vetoed`: las reglas de límite de una
   * misma evaluación se juntan en un solo aviso por activo.
   */
  limitWindowMs?: number;
  /** Reloj ISO para marcas de captura/diario. */
  nowIso?(): string;
  /** Reloj en ms para la latencia del envío de prueba. */
  nowMs?(): number;
  logger?: DeliveryLogger;
  /** Diario automático; opcional mientras convive con el esqueleto. */
  recordJournal?(input: JournalRecordInput): void;
  /** Gancho E2E: captura cada envío; solo se instala fuera del paquete. */
  capture?(record: DeliveryCaptureRecord): void;
}

const DELIVERY_CONFIG_KEY = 'delivery.config';
const DEFAULT_LIMIT_WINDOW_MS = 200;

const LEVEL_BY_EVENT: Record<DeliveryEventKind, NotificationLevel> = {
  'senal-aprobada': 'info',
  'senal-vetada': 'alerta',
  'limite-alcanzado': 'alerta',
  'resumen-diario': 'info',
};

/** Quita las credenciales de cualquier texto antes de log, diario o IPC. */
export function redactSecrets(text: string, secrets: Array<string | null>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('•••');
  }
  return out;
}

export function createDeliveryService(deps: DeliveryDeps): DeliveryService {
  const logger = deps.logger ?? console;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retryDelaysMs = deps.retryDelaysMs ?? DELIVERY_RETRY_DELAYS_MS;
  const limitWindowMs = deps.limitWindowMs ?? DEFAULT_LIMIT_WINDOW_MS;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const nowMs = deps.nowMs ?? (() => Date.now());
  const createTransport = deps.createTransport ?? ((o) => nodemailer.createTransport(o));
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;

  let stopped = false;
  // Cola por canal para que los avisos salgan en orden y nunca en paralelo.
  const queues: Record<'telegram' | 'correo', Promise<void>> = {
    telegram: Promise.resolve(),
    correo: Promise.resolve(),
  };
  // Vetos de límite pendientes, agrupados por activo y deduplicados por regla.
  const pendingLimits = new Map<string, Map<string, RiskVeto>>();
  let limitTimer: ReturnType<typeof setTimeout> | null = null;

  const capture = (record: Omit<DeliveryCaptureRecord, 'at'>): void => {
    deps.capture?.({ at: nowIso(), ...record });
  };

  const journalError = (channel: DeliveryChannel, event: string, error: string): void => {
    try {
      deps.recordJournal?.({
        type: 'error',
        reason: `Fallo al enviar el aviso por ${channelLabel(channel)}`,
        dataUsed: { channel, event },
        result: 'error',
        errors: [error],
      });
    } catch (journalProblem: unknown) {
      logger.warn(`[delivery] no se pudo registrar el fallo en el diario: ${journalProblem}`);
    }
  };

  const sendTelegram = async (text: string): Promise<{ attempts: number; to: string }> => {
    const config = deps.getConfigInput().telegram;
    const token = await deps.getSecret(DELIVERY_SECRET_KEYS.telegramBotToken);
    if (!token) throw new Error('falta el token del bot en el almacén de secretos');
    let attempts = 0;
    try {
      await sendTelegramMessage(
        {
          fetchImpl,
          apiBase: deps.telegramApiBase,
          sleep,
          retryDelaysMs,
          onAttempt: () => {
            attempts += 1;
          },
        },
        { token, chatId: config.chatId, text },
      );
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : String(error);
      throw new Error(redactSecrets(raw, [token]), { cause: error });
    }
    return { attempts: Math.max(attempts, 1), to: config.chatId };
  };

  const sendEmail = async (
    subject: string,
    text: string,
  ): Promise<{ attempts: number; to: string }> => {
    const config = deps.getConfigInput().email;
    const password = await deps.getSecret(DELIVERY_SECRET_KEYS.emailPassword);
    if (!password) throw new Error('falta la contraseña SMTP en el almacén de secretos');
    let attempts = 0;
    try {
      await sendEmailMessage(
        {
          createTransport,
          sleep,
          retryDelaysMs,
          onAttempt: () => {
            attempts += 1;
          },
        },
        { config, password, subject, text },
      );
    } catch (error: unknown) {
      const raw = error instanceof Error ? error.message : String(error);
      throw new Error(redactSecrets(raw, [password]), { cause: error });
    }
    return { attempts: Math.max(attempts, 1), to: config.to };
  };

  /**
   * Un envío con sus reintentos. Registra el resultado (captura, log y
   * diario en caso de fallo) y propaga el error ya saneado para que
   * `test()` pueda devolver `ok: false`; la cola lo traga para no
   * interrumpir los envíos siguientes.
   */
  const deliver = async (
    channel: 'telegram' | 'correo',
    event: DeliveryEventKind | 'prueba',
    title: string,
    body: string,
  ): Promise<void> => {
    try {
      const { attempts, to } =
        channel === 'telegram'
          ? await sendTelegram(`${title}\n\n${body}`)
          : await sendEmail(title, body);
      capture({ channel, event, title, body, to, ok: true, attempts, error: null });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[delivery] fallo al enviar por ${channelLabel(channel)}: ${message}`);
      journalError(channel, event, message);
      capture({ channel, event, title, body, to: '', ok: false, attempts: 1, error: message });
      throw new Error(message, { cause: error });
    }
  };

  const enqueue = (
    channel: 'telegram' | 'correo',
    event: DeliveryEventKind,
    title: string,
    body: string,
  ): void => {
    queues[channel] = queues[channel]
      .then(() => deliver(channel, event, title, body))
      .catch(() => undefined);
  };

  const service: DeliveryService = {
    sendEvent: (kind, message) => {
      if (stopped) return;
      deps.notify({
        level: LEVEL_BY_EVENT[kind],
        title: message.title,
        body: message.body,
        navigateTo: message.navigateTo,
      });
      capture({
        channel: 'escritorio',
        event: kind,
        title: message.title,
        body: message.body,
        to: 'sistema',
        ok: true,
        attempts: 1,
        error: null,
      });
      const config = deps.getConfigInput();
      if (config.telegram.enabled && config.telegram.events.includes(kind)) {
        enqueue('telegram', kind, message.title, message.body);
      }
      if (config.email.enabled && config.email.events.includes(kind)) {
        enqueue('correo', kind, message.title, message.body);
      }
    },

    handleSignal: (signal) => {
      const { kind, text } = signalText(signal);
      service.sendEvent(kind, { ...text, navigateTo: 'inicio' });
    },

    handleRiskVeto: (veto) => {
      if (stopped || !isLimitVeto(veto.code)) return;
      const byCode = pendingLimits.get(veto.ticker) ?? new Map<string, RiskVeto>();
      byCode.set(veto.code, veto);
      pendingLimits.set(veto.ticker, byCode);
      if (limitTimer !== null) return;
      limitTimer = setTimeout(() => {
        limitTimer = null;
        const groups = [...pendingLimits.entries()];
        pendingLimits.clear();
        for (const [ticker, vetoes] of groups) {
          const text = limitText(ticker, [...vetoes.values()]);
          service.sendEvent('limite-alcanzado', { ...text, navigateTo: 'riesgo' });
        }
      }, limitWindowMs);
    },

    getConfig: async () => {
      const input = deps.getConfigInput();
      const [hasToken, hasPassword] = await Promise.all([
        deps.hasSecret(DELIVERY_SECRET_KEYS.telegramBotToken),
        deps.hasSecret(DELIVERY_SECRET_KEYS.emailPassword),
      ]);
      return {
        telegram: { ...input.telegram, hasToken },
        email: { ...input.email, hasPassword },
      };
    },

    setConfig: async (input) => {
      deps.setConfigInput(input);
      return service.getConfig();
    },

    test: async (channel) => {
      const { title, body } = testText(channel);
      const config = deps.getConfigInput();
      const missing =
        channel === 'telegram' && !config.telegram.chatId
          ? 'configura primero el chat de destino'
          : channel === 'correo' && (!config.email.host || !config.email.to || !config.email.user)
            ? 'configura primero servidor, usuario y destinatario'
            : null;
      if (missing) return { ok: false, error: missing, latencyMs: null };

      const started = nowMs();
      try {
        await deliver(channel, 'prueba', title, body);
        return { ok: true, error: null, latencyMs: Math.max(0, Math.round(nowMs() - started)) };
      } catch (error: unknown) {
        // deliver() ya captura/registra: aquí solo se traduce el resultado.
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          latencyMs: Math.max(0, Math.round(nowMs() - started)),
        };
      }
    },

    stop: () => {
      stopped = true;
      if (limitTimer !== null) {
        clearTimeout(limitTimer);
        limitTimer = null;
      }
      pendingLimits.clear();
    },
  };

  return service;
}

// ---------------------------------------------------------------------------
// Envoltura de broadcast: signals:new y risk:vetoed
// ---------------------------------------------------------------------------

/**
 * Envuelve `ctx.broadcast` para que el servicio vea las señales nuevas y
 * los vetos de límite, igual que `health` observa `data-status:changed`.
 * Los emisores deben llamar a `ctx.broadcast` de forma perezosa (patrón
 * `broadcast: (c, p) => ctx.broadcast(c, p)` de todo `main/`).
 */
export function wrapBroadcastForDelivery(
  service: DeliveryService,
  inner: (channel: string, payload: unknown) => void,
): (channel: string, payload: unknown) => void {
  return (channel, payload) => {
    inner(channel, payload);
    if (channel === IPC_CHANNELS.signals.new) {
      const signal = (payload as SignalNewEvent | null | undefined)?.signal;
      if (signal && typeof signal === 'object') service.handleSignal(signal);
    } else if (channel === IPC_CHANNELS.risk.vetoed) {
      const veto = payload as RiskVeto | null | undefined;
      if (veto && typeof veto === 'object' && typeof veto.code === 'string') {
        service.handleRiskVeto(veto);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Registro en la app
// ---------------------------------------------------------------------------

/** Nombre del fichero de captura E2E dentro de userData (una línea JSON por envío). */
export const DELIVERY_CAPTURE_FILE = 'delivery-captures.jsonl';

/** Variable E2E que desvía la Bot API de Telegram a un servidor local. */
export const TELEGRAM_API_BASE_ENV = 'TRADIA_TELEGRAM_API_BASE';

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function registerDelivery(ctx: ServiceContext): DeliveryService {
  // La config vive en settings (clave 'delivery.config'); memoria si falta.
  const settings = ctx.services.settings;
  let memoryConfig: DeliveryConfigInput = structuredClone(DELIVERY_CONFIG_DEFAULTS);

  const readConfigInput = (): DeliveryConfigInput => {
    const raw = settings?.getValue(DELIVERY_CONFIG_KEY);
    if (raw === null || raw === undefined) return structuredClone(memoryConfig);
    try {
      const parsed: unknown = JSON.parse(raw);
      return isDeliveryConfigInput(parsed) ? parsed : structuredClone(DELIVERY_CONFIG_DEFAULTS);
    } catch {
      return structuredClone(DELIVERY_CONFIG_DEFAULTS);
    }
  };

  const e2e = isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E);
  const capturePath = e2e ? join(app.getPath('userData'), DELIVERY_CAPTURE_FILE) : null;
  const telegramApiBase =
    e2e && isHttpUrl(process.env[TELEGRAM_API_BASE_ENV])
      ? process.env[TELEGRAM_API_BASE_ENV].replace(/\/+$/, '')
      : undefined;
  const journal = ctx.services.journal as
    { record?(input: JournalRecordInput): unknown } | undefined;

  const service = createDeliveryService({
    notify: (payload) => ctx.services.notifications?.notify(payload),
    getConfigInput: readConfigInput,
    setConfigInput: (input) => {
      if (settings) {
        settings.setValue(DELIVERY_CONFIG_KEY, JSON.stringify(input));
      } else {
        memoryConfig = structuredClone(input);
      }
    },
    getSecret: (key) => ctx.services.secrets?.getKey(key) ?? Promise.resolve(null),
    hasSecret: (key) => ctx.services.secrets?.hasKey(key) ?? Promise.resolve(false),
    telegramApiBase,
    recordJournal: (input) => journal?.record?.(input),
    capture: capturePath
      ? (record) => {
          try {
            appendFileSync(capturePath, `${JSON.stringify(record)}\n`, 'utf8');
          } catch (error: unknown) {
            console.warn(`[delivery] no se pudo escribir la captura E2E: ${error}`);
          }
        }
      : undefined,
  });

  // Señales y límites llegan por broadcast (signals:new, risk:vetoed).
  ctx.broadcast = wrapBroadcastForDelivery(service, ctx.broadcast);

  ipcMain.handle(IPC_CHANNELS.delivery.getConfig, () => service.getConfig());
  ipcMain.handle(IPC_CHANNELS.delivery.setConfig, (_event, input: unknown) => {
    if (!isDeliveryConfigInput(input)) {
      throw new IpcValidationError(
        IPC_CHANNELS.delivery.setConfig,
        'se esperaba {telegram: {enabled, chatId, events}, email: {enabled, host, port, security, user, to, events}}; los secretos van por secrets:*',
      );
    }
    return service.setConfig(input);
  });
  ipcMain.handle(IPC_CHANNELS.delivery.test, (_event, request: unknown) => {
    if (!isDeliveryTestRequest(request)) {
      throw new IpcValidationError(IPC_CHANNELS.delivery.test, 'se esperaba {channel}');
    }
    return service.test(request.channel);
  });

  return service;
}
