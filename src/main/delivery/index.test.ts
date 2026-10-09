import { describe, expect, it, vi } from 'vitest';

import {
  DELIVERY_CONFIG_DEFAULTS,
  DELIVERY_SECRET_KEYS,
  type DeliveryConfigInput,
  type JournalRecordInput,
} from '../../shared/journal';
import {
  IPC_CHANNELS,
  type NotificationPayload,
  type RiskVeto,
  type SignalIntent,
} from '../../shared/ipc';
import { VETO_REASON_MESSAGES } from '../../shared/risk';
import type { Signal } from '../../shared/signals';
import {
  createDeliveryService,
  redactSecrets,
  wrapBroadcastForDelivery,
  type DeliveryCaptureRecord,
  type DeliveryDeps,
} from './index';
import type { SmtpTransporterLike } from './email';

// ---------------------------------------------------------------------------
// Fijaciones
// ---------------------------------------------------------------------------

const intent: SignalIntent = {
  ticker: 'AAPL',
  direction: 'largo',
  entry: 100,
  stop: 95,
  target: 115,
  confidence: 0.72,
  origin: 'estrategia',
};

const makeSignal = (patch: Partial<Signal> = {}): Signal => ({
  id: 7,
  ticker: 'AAPL',
  direction: 'largo',
  entry: 100,
  stop: 95,
  target: 115,
  confidence: 0.72,
  reason: 'Cruce de medias 50/200 alcista',
  strategies: [
    {
      strategyId: 3,
      name: 'Cruce de medias',
      version: 2,
      direction: 'largo',
      confidence: 0.72,
      reason: 'Cruce de medias 50/200 alcista',
    },
  ],
  dataUsed: {
    barDate: '2026-10-08',
    desde: '2026-06-01',
    hasta: '2026-10-08',
    barCount: 90,
    batchId: 4,
    batchVersion: 2,
    source: 'tiingo',
  },
  decision: {
    status: 'aprobada',
    size: 12,
    sizeFactor: 1,
    riskAmount: 60,
    notional: 1200,
    reasons: [],
    decidedAt: '2026-10-08T20:00:00.000Z',
  },
  createdAt: '2026-10-08T20:00:00.000Z',
  ...patch,
});

const makeVeto = (patch: Partial<RiskVeto> = {}): RiskVeto => ({
  id: 1,
  signal: intent,
  ticker: 'AAPL',
  decision: 'vetada',
  code: 'DAILY_LOSS',
  message: VETO_REASON_MESSAGES.DAILY_LOSS,
  details: { limite: 3, perdida: 4.2 },
  size: 0,
  createdAt: '2026-10-08T20:00:00.000Z',
  ...patch,
});

interface Harness {
  deps: DeliveryDeps;
  notifications: NotificationPayload[];
  captures: DeliveryCaptureRecord[];
  journal: JournalRecordInput[];
  secrets: Map<string, string>;
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  fetchImpl: ReturnType<typeof vi.fn>;
  sentMails: Array<{ subject?: string; text?: string | { toString(): string } }>;
  config: { current: DeliveryConfigInput };
}

function makeDeps(overrides: Partial<DeliveryDeps> = {}): Harness {
  const notifications: NotificationPayload[] = [];
  const captures: DeliveryCaptureRecord[] = [];
  const journal: JournalRecordInput[] = [];
  const secrets = new Map<string, string>();
  const sentMails: Harness['sentMails'] = [];
  const config = { current: structuredClone(DELIVERY_CONFIG_DEFAULTS) };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const createTransport = vi.fn((): SmtpTransporterLike => ({
    sendMail: async (mail) => {
      sentMails.push(mail);
      return {} as never;
    },
    close: () => undefined,
  }));

  const deps: DeliveryDeps = {
    notify: (payload) => notifications.push(payload),
    getConfigInput: () => structuredClone(config.current),
    setConfigInput: (input) => {
      config.current = structuredClone(input);
    },
    getSecret: async (key) => secrets.get(key) ?? null,
    hasSecret: async (key) => secrets.has(key),
    fetchImpl: fetchImpl as unknown as typeof fetch,
    createTransport,
    sleep: () => Promise.resolve(),
    retryDelaysMs: [0, 0],
    limitWindowMs: 5,
    nowIso: () => '2026-10-09T12:00:00.000Z',
    logger,
    recordJournal: (input) => journal.push(input),
    capture: (record) => captures.push(record),
    ...overrides,
  };
  return { deps, notifications, captures, journal, secrets, logger, fetchImpl, sentMails, config };
}

/** Espera a que las colas internas de envío se vacíen. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 15));

const enableTelegram = (config: { current: DeliveryConfigInput }, events?: string[]) => {
  config.current.telegram = {
    enabled: true,
    chatId: '12345',
    events: (events ?? [
      'senal-aprobada',
      'senal-vetada',
      'limite-alcanzado',
      'resumen-diario',
    ]) as DeliveryConfigInput['telegram']['events'],
  };
};

// ---------------------------------------------------------------------------
// Pruebas
// ---------------------------------------------------------------------------

describe('createDeliveryService · configuración', () => {
  it('empieza con los canales externos desactivados y sin secretos', async () => {
    const { deps } = makeDeps();
    const service = createDeliveryService(deps);
    const config = await service.getConfig();
    expect(config.telegram).toMatchObject({ enabled: false, chatId: '', hasToken: false });
    expect(config.email).toMatchObject({ enabled: false, hasPassword: false });
  });

  it('setConfig persiste y getConfig refleja los secretos guardados', async () => {
    const { deps, secrets, config } = makeDeps();
    const service = createDeliveryService(deps);
    secrets.set(DELIVERY_SECRET_KEYS.telegramBotToken, 'token-secreto');
    secrets.set(DELIVERY_SECRET_KEYS.emailPassword, 'pass-secreta');

    const input = structuredClone(DELIVERY_CONFIG_DEFAULTS);
    input.telegram = { enabled: true, chatId: '9988', events: ['senal-aprobada'] };
    const saved = await service.setConfig(input);

    expect(saved.telegram).toMatchObject({ enabled: true, chatId: '9988', hasToken: true });
    expect(saved.email.hasPassword).toBe(true);
    expect(config.current.telegram.chatId).toBe('9988');
  });
});

describe('createDeliveryService · notificación de escritorio', () => {
  it('avisa una señal aprobada con activo, dirección, motivo, confianza y exención', () => {
    const { deps, notifications } = makeDeps();
    const service = createDeliveryService(deps);
    service.handleSignal(makeSignal());

    expect(notifications).toHaveLength(1);
    const n = notifications[0]!;
    expect(n.level).toBe('info');
    expect(n.title).toBe('Señal aprobada · AAPL compra');
    expect(n.body).toContain('Cruce de medias 50/200 alcista');
    expect(n.body).toContain('Confianza: 72 %');
    expect(n.body).toContain('posición simulada de 12');
    expect(n.body).toContain('Aviso informativo: Tradia no ejecuta órdenes reales.');
    expect(n.navigateTo).toBe('inicio');
  });

  it('avisa una señal vetada con el motivo del veto', () => {
    const { deps, notifications } = makeDeps();
    const service = createDeliveryService(deps);
    service.handleSignal(
      makeSignal({
        direction: 'corto',
        decision: {
          status: 'vetada',
          size: 0,
          sizeFactor: 1,
          riskAmount: 0,
          notional: 0,
          reasons: [
            {
              code: 'RR_TOO_LOW',
              message: VETO_REASON_MESSAGES.RR_TOO_LOW,
              details: { limite: 2, ratio: 1.4 },
            },
          ],
          decidedAt: '2026-10-08T20:00:00.000Z',
        },
      }),
    );

    const n = notifications[0]!;
    expect(n.level).toBe('alerta');
    expect(n.title).toBe('Señal vetada · AAPL venta');
    expect(n.body).toContain(VETO_REASON_MESSAGES.RR_TOO_LOW);
    expect(n.body).toContain('observado 1.40, límite 2');
    expect(n.body).toContain('Aviso informativo');
  });

  it('agrupa los vetos de límite del mismo activo en un solo aviso', async () => {
    const { deps, notifications } = makeDeps();
    const service = createDeliveryService(deps);
    service.handleRiskVeto(makeVeto());
    service.handleRiskVeto(
      makeVeto({
        code: 'MAX_DRAWDOWN',
        message: VETO_REASON_MESSAGES.MAX_DRAWDOWN,
        details: { limite: 10, drawdown: 11.5 },
      }),
    );
    service.handleRiskVeto(
      makeVeto({ code: 'RR_TOO_LOW', message: VETO_REASON_MESSAGES.RR_TOO_LOW }),
    );
    await flush();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.title).toBe('Límites alcanzados · AAPL');
    expect(notifications[0]!.body).toContain(VETO_REASON_MESSAGES.DAILY_LOSS);
    expect(notifications[0]!.body).toContain(VETO_REASON_MESSAGES.MAX_DRAWDOWN);
    expect(notifications[0]!.body).toContain('4.20 frente al límite 3');
    expect(notifications[0]!.navigateTo).toBe('riesgo');
    expect(notifications[0]!.level).toBe('alerta');
  });

  it('deduplica la misma regla y reparte un aviso por activo', async () => {
    const { deps, notifications } = makeDeps();
    const service = createDeliveryService(deps);
    service.handleRiskVeto(makeVeto());
    service.handleRiskVeto(makeVeto());
    service.handleRiskVeto(makeVeto({ ticker: 'MSFT' }));
    await flush();

    expect(notifications).toHaveLength(2);
    expect(notifications[0]!.title).toBe(`Límite alcanzado · ${VETO_REASON_MESSAGES.DAILY_LOSS}`);
  });
});

describe('createDeliveryService · canales externos', () => {
  it('envía por Telegram solo los eventos suscritos y con canal activo', async () => {
    const { deps, secrets, config, fetchImpl, captures } = makeDeps();
    const service = createDeliveryService(deps);
    secrets.set(DELIVERY_SECRET_KEYS.telegramBotToken, 'token-1');
    enableTelegram(config, ['senal-aprobada']);

    service.handleSignal(makeSignal());
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, { body: string }];
    expect(url).toContain('/bottoken-1/sendMessage');
    expect(JSON.parse(init.body)).toMatchObject({ chat_id: '12345' });
    expect(captures.at(-1)).toMatchObject({
      channel: 'telegram',
      event: 'senal-aprobada',
      ok: true,
    });

    // 'senal-vetada' no está suscrita: no hay segundo envío.
    service.handleSignal(
      makeSignal({
        decision: {
          status: 'vetada',
          size: 0,
          sizeFactor: 1,
          riskAmount: 0,
          notional: 0,
          reasons: [],
          decidedAt: '2026-10-08T20:00:00.000Z',
        },
      }),
    );
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('no llama a Telegram con el canal desactivado', async () => {
    const { deps, secrets, fetchImpl } = makeDeps();
    const service = createDeliveryService(deps);
    secrets.set(DELIVERY_SECRET_KEYS.telegramBotToken, 'token-1');
    service.handleSignal(makeSignal());
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('envía el correo por el transporte configurado', async () => {
    const { deps, secrets, config, sentMails } = makeDeps();
    const service = createDeliveryService(deps);
    secrets.set(DELIVERY_SECRET_KEYS.emailPassword, 'pw');
    config.current.email = {
      enabled: true,
      host: 'smtp.local',
      port: 2525,
      security: 'ninguna',
      user: 'tradia@local',
      to: 'user@local',
      events: ['senal-aprobada', 'senal-vetada', 'limite-alcanzado', 'resumen-diario'],
    };

    service.handleSignal(makeSignal());
    await flush();
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]).toMatchObject({ subject: 'Señal aprobada · AAPL compra' });
  });

  it('registra el fallo en el log, el diario y la captura sin exponer el token', async () => {
    const { deps, secrets, config, fetchImpl, journal, captures, logger } = makeDeps();
    fetchImpl.mockRejectedValue(new Error('falló la conexión con bottoken-supersecreto'));
    const service = createDeliveryService(deps);
    secrets.set(DELIVERY_SECRET_KEYS.telegramBotToken, 'token-supersecreto');
    enableTelegram(config);

    service.handleSignal(makeSignal());
    await flush();

    expect(logger.error).toHaveBeenCalledTimes(1);
    const logged = String(logger.error.mock.calls[0]![0]);
    expect(logged).not.toContain('token-supersecreto');
    expect(logged).toContain('•••');

    expect(journal).toHaveLength(1);
    expect(journal[0]).toMatchObject({ type: 'error', result: 'error' });
    expect(JSON.stringify(journal[0])).not.toContain('token-supersecreto');

    const failed = captures.find((c) => c.channel === 'telegram');
    expect(failed).toMatchObject({ ok: false });
    expect(failed?.error).not.toContain('token-supersecreto');
  });

  it('registra la falta de credencial como fallo del canal', async () => {
    const { deps, config, journal } = makeDeps();
    const service = createDeliveryService(deps);
    enableTelegram(config); // sin token en secretos

    service.handleSignal(makeSignal());
    await flush();
    expect(journal[0]?.errors?.[0]).toContain('token del bot');
  });
});

describe('createDeliveryService · Enviar prueba', () => {
  it('exige el chat configurado para Telegram', async () => {
    const { deps, secrets } = makeDeps();
    secrets.set(DELIVERY_SECRET_KEYS.telegramBotToken, 'token-1');
    const service = createDeliveryService(deps);
    const result = await service.test('telegram');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('chat');
  });

  it('envía la prueba por Telegram y mide la latencia', async () => {
    const { deps, secrets, config, fetchImpl, captures } = makeDeps();
    secrets.set(DELIVERY_SECRET_KEYS.telegramBotToken, 'token-1');
    enableTelegram(config);
    const service = createDeliveryService(deps);

    const result = await service.test('telegram');
    expect(result).toMatchObject({ ok: true, error: null });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(captures.at(-1)).toMatchObject({ channel: 'telegram', event: 'prueba', ok: true });
  });

  it('devuelve el error saneado cuando la prueba falla', async () => {
    const { deps, secrets, config, fetchImpl } = makeDeps();
    fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 }),
    );
    secrets.set(DELIVERY_SECRET_KEYS.telegramBotToken, 'token-1');
    enableTelegram(config);
    const service = createDeliveryService(deps);

    const result = await service.test('telegram');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('chat not found');
    expect(result.error).not.toContain('token-1');
  });
});

describe('wrapBroadcastForDelivery', () => {
  it('enruta signals:new y risk:vetoed y deja pasar el resto', async () => {
    const { deps, notifications } = makeDeps();
    const service = createDeliveryService(deps);
    const inner = vi.fn();
    const wrapped = wrapBroadcastForDelivery(service, inner);

    wrapped(IPC_CHANNELS.signals.new, { signal: makeSignal() });
    wrapped(IPC_CHANNELS.risk.vetoed, makeVeto());
    wrapped('otro:canal', { cualquier: 'cosa' });
    wrapped(IPC_CHANNELS.risk.vetoed, null);

    await flush();
    expect(inner).toHaveBeenCalledTimes(4);
    const titles = notifications.map((n) => n.title);
    expect(titles).toContain('Señal aprobada · AAPL compra');
    expect(titles.some((t) => t.startsWith('Límite alcanzado'))).toBe(true);
  });
});

describe('redactSecrets', () => {
  it('oculta las credenciales y no toca cadenas cortas o ausentes', () => {
    const out = redactSecrets('fallo con abc12345 y otro dato', ['abc12345', null, 'xy']);
    expect(out).toBe('fallo con ••• y otro dato');
  });
});
