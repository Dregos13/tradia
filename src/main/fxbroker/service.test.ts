/**
 * Servicio de divisas (OANDA) contra el servidor falso con estado: sin
 * red, con la base en memoria (migración 021) y un motor de riesgo
 * inyectado para comprobar que toda orden pasa por la pasarela única.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FX_BROKER_SECRET_KEYS,
  FX_DEFAULT_LIMITS,
  fxLiveConfirmationPhrase,
  type FxBrokerEnvironment,
} from '../../shared/fxBroker';
import type { RiskDecision, SignalIntent } from '../../shared/risk';
import {
  createOandaFakeServer,
  type OandaFakeServer,
} from '../broker/__fixtures__/oanda-fake-server';
import { createOandaBroker, OANDA_BASE_URLS } from '../broker/oanda';
import { createBrokerRepository } from '../broker/repository';
import { openDatabase } from '../db/database';
import { createFxBrokerService, FX_SETTINGS_KEYS, type FxBrokerService } from './service';

const TOKEN = '0123456789abcdef0123456789abcdef-fedcba9876543210fedcba9876543210';
const OTHER_TOKEN = 'f'.repeat(32) + '-' + 'e'.repeat(32);
const PRACTICE_ACCOUNT = '101-004-1234567-001';
const LIVE_ACCOUNT = '001-004-1234567-001';

const approve = (intent: SignalIntent): RiskDecision => ({
  status: 'aprobada',
  size: 100_000,
  sizeFactor: 1,
  riskAmount: 0,
  notional: intent.entry,
  reasons: [],
  decidedAt: '2026-11-23T15:00:00.000Z',
});

let db: ReturnType<typeof openDatabase>;
let secrets: Map<string, string>;
let settings: Map<string, string>;
let servers: Record<FxBrokerEnvironment, OandaFakeServer>;
let gate: boolean;
let killSwitch: boolean;
let submitSignal: ReturnType<typeof vi.fn<(intent: SignalIntent) => RiskDecision | null>>;
let service: FxBrokerService;

beforeEach(() => {
  db = openDatabase(':memory:');
  secrets = new Map();
  settings = new Map();
  gate = false;
  killSwitch = false;
  servers = {
    practice: createOandaFakeServer({
      baseUrl: OANDA_BASE_URLS.practice,
      token: TOKEN,
      accountId: PRACTICE_ACCOUNT,
    }),
    live: createOandaFakeServer({
      baseUrl: OANDA_BASE_URLS.live,
      token: OTHER_TOKEN,
      accountId: LIVE_ACCOUNT,
    }),
  };
  submitSignal = vi.fn(approve);
  service = createFxBrokerService({
    secrets: {
      setKey: async (k, v) => void secrets.set(k, v),
      hasKey: async (k) => secrets.has(k),
      deleteKey: async (k) => void secrets.delete(k),
      getKey: async (k) => secrets.get(k) ?? null,
    },
    repositories: {
      practice: createBrokerRepository(db, { ordersTable: 'broker_orders_fx_practice' }),
      live: createBrokerRepository(db, { ordersTable: 'broker_orders_fx_live' }),
    },
    createAdapter: (environment, getCredentials) =>
      createOandaBroker(environment, {
        fetch: servers[environment].fetch,
        getCredentials,
        isLiveGateOpen: () => gate,
      }),
    submitSignal,
    isLiveGateOpen: () => gate,
    isKillSwitchActive: () => killSwitch,
    isOnline: () => true,
    settings: {
      get: (k) => settings.get(k) ?? null,
      set: (k, v) => void settings.set(k, v),
    },
    now: () => Date.parse('2026-11-23T15:00:00.000Z'),
    logger: { warn: () => {} },
  });
});

afterEach(() => db.close());

const connectPractice = () =>
  service.connect({ environment: 'practice', token: TOKEN, accountId: PRACTICE_ACCOUNT });

describe('conexión', () => {
  it('verifica con OANDA, guarda token y cuenta cifrados y muestra el saldo', async () => {
    const status = await connectPractice();
    expect(status.practice).toMatchObject({
      state: 'conectada',
      hasCredentials: true,
      error: null,
      account: { accountMasked: '•••-001', currency: 'EUR', balance: 100 },
    });
    expect(secrets.get(FX_BROKER_SECRET_KEYS.practice.token)).toBe(TOKEN);
    expect(secrets.get(FX_BROKER_SECRET_KEYS.practice.accountId)).toBe(PRACTICE_ACCOUNT);
    // El estado que ve la interfaz nunca lleva el token.
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  it('rechaza una cuenta de práctica en la ranura real y una real en la de práctica', async () => {
    gate = true;
    const live = await service.connect({
      environment: 'live',
      token: TOKEN,
      accountId: PRACTICE_ACCOUNT,
    });
    expect(live.live.state).toBe('error');
    expect(live.live.error).toContain('cuenta es de práctica');
    const practice = await service.connect({
      environment: 'practice',
      token: TOKEN,
      accountId: LIVE_ACCOUNT,
    });
    expect(practice.practice.error).toContain('cuenta es real');
    expect(secrets.size).toBe(0);
  });

  it('un token de práctica no autentica en el servidor real: no se guarda nada', async () => {
    gate = true;
    const status = await service.connect({
      environment: 'live',
      token: TOKEN,
      accountId: LIVE_ACCOUNT,
    });
    expect(status.live.state).toBe('error');
    expect(status.live.error).toContain('un token de práctica no sirve en la real');
    expect(status.live.error).not.toContain(TOKEN);
    expect(secrets.size).toBe(0);
  });

  it('la cuenta real no se conecta sin la lista de comprobación completa', async () => {
    const status = await service.connect({
      environment: 'live',
      token: OTHER_TOKEN,
      accountId: LIVE_ACCOUNT,
    });
    expect(status.live.error).toContain('lista de comprobación');
    expect(servers.live.requests).toHaveLength(0);
  });

  it('desconectar borra la ranura', async () => {
    await connectPractice();
    const status = await service.disconnect('practice');
    expect(status.practice).toMatchObject({
      state: 'desconectada',
      hasCredentials: false,
      account: null,
    });
    expect(secrets.size).toBe(0);
  });
});

describe('órdenes', () => {
  it('pasa por el motor de riesgo, dimensiona por euros de riesgo y adjunta stop y objetivo', async () => {
    await connectPractice();
    // Stop a 20 pips: 1 € de riesgo cabe en ≈ 542 unidades.
    const result = await service.placeOrder({
      environment: 'practice',
      instrument: 'EURUSD',
      side: 'buy',
      size: { riskEur: 1 },
      stopPrice: 1.08262,
      targetPrice: 1.08862,
    });
    expect(submitSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        ticker: 'EURUSD',
        direction: 'largo',
        stop: 1.08262,
        target: 1.08862,
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.units).toBe(542);
    expect(result.riskEur).toBeLessThanOrEqual(1);
    const sent = servers.practice.requests.find((r) => r.method === 'POST');
    expect(sent?.body).toMatchObject({
      order: {
        type: 'MARKET',
        units: '542',
        stopLossOnFill: { price: '1.08262' },
        takeProfitOnFill: { price: '1.08862' },
      },
    });
    expect(result.status.practice.positions).toMatchObject([{ instrument: 'EURUSD', units: 542 }]);
  });

  it('un veto del motor de riesgo para la orden sin tocar OANDA', async () => {
    await connectPractice();
    submitSignal.mockReturnValueOnce({
      ...approve({} as SignalIntent),
      status: 'vetada',
      size: 0,
      reasons: [
        {
          code: 'RR_TOO_LOW',
          message: 'El ratio beneficio/riesgo es menor que 2.',
          details: {},
        },
      ],
    } as RiskDecision);
    const result = await service.placeOrder({
      environment: 'practice',
      instrument: 'EURUSD',
      side: 'buy',
      size: { units: 1 },
      stopPrice: 1.08,
      targetPrice: 1.09,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain('Motor de riesgo');
    expect(servers.practice.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('aplica los techos: riesgo por orden, unidades máximas y una posición por activo', async () => {
    await connectPractice();
    const tooRisky = await service.placeOrder({
      environment: 'practice',
      instrument: 'EURUSD',
      side: 'buy',
      size: { units: 5000 },
      stopPrice: 1.07,
      targetPrice: 1.1,
    });
    expect(tooRisky.ok).toBe(false);
    expect(tooRisky.reasons.join(' ')).toContain('tu límite por orden es 1 €');

    const gold = await service.placeOrder({
      environment: 'practice',
      instrument: 'XAUUSD',
      side: 'buy',
      size: { units: 3 },
      stopPrice: 2650,
      targetPrice: 2652,
    });
    expect(gold.reasons.join(' ')).toContain('máximo por orden en Oro (XAU/USD) es de 2 unidades');

    await service.placeOrder({
      environment: 'practice',
      instrument: 'EURUSD',
      side: 'buy',
      size: { units: 1 },
      stopPrice: 1.08,
      targetPrice: 1.09,
    });
    const second = await service.placeOrder({
      environment: 'practice',
      instrument: 'EURUSD',
      side: 'sell',
      size: { units: 1 },
      stopPrice: 1.09,
      targetPrice: 1.08,
    });
    expect(second.reasons.join(' ')).toContain('Ya tienes una posición abierta en EUR/USD');
  });

  it('con la parada activa no abre nada y al saltar cierra todas las posiciones', async () => {
    await connectPractice();
    await service.placeOrder({
      environment: 'practice',
      instrument: 'EURUSD',
      side: 'buy',
      size: { units: 10 },
      stopPrice: 1.08,
      targetPrice: 1.09,
    });
    killSwitch = true;
    const blocked = await service.placeOrder({
      environment: 'practice',
      instrument: 'GBPUSD',
      side: 'buy',
      size: { units: 1 },
      stopPrice: 1.26,
      targetPrice: 1.28,
    });
    expect(blocked.reasons[0]).toContain('parada de emergencia');
    service.handleRiskChanged({ killSwitch: { active: true, cause: 'manual' } });
    await vi.waitFor(async () => {
      expect((await service.getStatus()).practice.positions).toEqual([]);
    });
    expect((await service.reconcile('practice')).ok).toBe(true);
  });

  it('la cuenta real exige la frase escrita con los límites exactos', async () => {
    gate = true;
    await service.connect({ environment: 'live', token: OTHER_TOKEN, accountId: LIVE_ACCOUNT });
    const order = {
      environment: 'live' as const,
      instrument: 'EURUSD' as const,
      side: 'buy' as const,
      size: { units: 1 },
      stopPrice: 1.08,
      targetPrice: 1.09,
    };
    expect((await service.placeOrder(order)).reasons.join(' ')).toContain('frase escrita');
    await expect(service.confirmLive({ phrase: 'ACTIVO' })).rejects.toThrow('no coincide');
    const status = await service.confirmLive({
      phrase: fxLiveConfirmationPhrase(FX_DEFAULT_LIMITS),
    });
    expect(status.liveConfirmed).toBe(true);
    expect((await service.placeOrder(order)).ok).toBe(true);
    // Cambiar los límites invalida la confirmación.
    await service.setLimits({ ...FX_DEFAULT_LIMITS, dailyLossEur: 2 });
    expect((await service.getStatus()).liveConfirmed).toBe(false);
  });

  it('la pérdida del día bloquea nuevas órdenes', async () => {
    await connectPractice();
    settings.set(
      FX_SETTINGS_KEYS.dayStart,
      JSON.stringify({ practice: { day: '2026-11-23', navEur: 104 } }),
    );
    const result = await service.placeOrder({
      environment: 'practice',
      instrument: 'EURUSD',
      side: 'buy',
      size: { units: 1 },
      stopPrice: 1.08,
      targetPrice: 1.09,
    });
    expect(result.reasons.join(' ')).toContain('Hoy ya llevas 4 € de pérdida');
  });

  it('un tiempo agotado se resuelve buscando la orden por su id', async () => {
    await connectPractice();
    servers.practice.failNext('timeout');
    const result = await service.placeOrder({
      environment: 'practice',
      instrument: 'EURUSD',
      side: 'buy',
      size: { units: 1 },
      stopPrice: 1.08,
      targetPrice: 1.09,
    });
    // El falso pierde la respuesta antes de crear la orden: no existe y se rechaza.
    expect(result.ok).toBe(false);
    const orders = createBrokerRepository(db, {
      ordersTable: 'broker_orders_fx_practice',
    }).listOrders();
    expect(orders[0]?.status).toBe('rechazada');
  });
});

describe('orden mínima de prueba', () => {
  it('compra 1 unidad de EUR/USD, la cierra y concilia', async () => {
    await connectPractice();
    const result = await service.runTestOrder({ environment: 'practice', confirm: true });
    expect(result.ok).toBe(true);
    expect(result.steps).toEqual(['precio', 'riesgo', 'compra', 'cierre', 'conciliacion']);
    expect(result.buyPrice).toBe(1.08462);
    expect(result.closePrice).toBe(1.0845);
    expect(result.pnl).toBeLessThan(0);
    expect(result.summary).toContain('Todo funciona');
    expect(result.status.practice.positions).toEqual([]);
    expect(result.status.lastReconcile.practice?.ok).toBe(true);
  });

  it('sin cuenta conectada lo explica sin enviar nada', async () => {
    const result = await service.runTestOrder({ environment: 'practice', confirm: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Conecta primero');
  });
});

describe('pasarela del motor de riesgo', () => {
  it('ignora los vetos por el tamaño de la cartera simulada y respeta los cualitativos', async () => {
    await connectPractice();
    const veto = (codes: string[]): RiskDecision =>
      ({
        ...approve({ entry: 1 } as SignalIntent),
        status: 'vetada',
        size: 0,
        reasons: codes.map((code) => ({ code, message: code, details: {} })),
      }) as unknown as RiskDecision;
    const order = {
      environment: 'practice' as const,
      instrument: 'USDJPY' as const,
      side: 'buy' as const,
      size: { units: 10 },
      stopPrice: 150.5,
      targetPrice: 153,
    };
    submitSignal.mockReturnValueOnce(veto(['ASSET_EXPOSURE', 'LEVERAGE', 'ANALYSIS_ONLY']));
    expect((await service.placeOrder(order)).ok).toBe(true);
    submitSignal.mockReturnValueOnce(veto(['ASSET_EXPOSURE', 'CAUTION_MODE']));
    const blocked = await service.placeOrder({
      ...order,
      instrument: 'GBPUSD',
      stopPrice: 1.26,
      targetPrice: 1.29,
    });
    expect(blocked.reasons).toEqual(['Motor de riesgo: CAUTION_MODE']);
  });

  it('la reducción por cautela se aplica como factor a las unidades', async () => {
    await connectPractice();
    submitSignal.mockReturnValueOnce({
      ...approve({ entry: 1 } as SignalIntent),
      status: 'reducida',
      sizeFactor: 0.5,
    });
    const result = await service.placeOrder({
      environment: 'practice',
      instrument: 'EURUSD',
      side: 'buy',
      size: { units: 100 },
      stopPrice: 1.08,
      targetPrice: 1.09,
    });
    expect(result.units).toBe(50);
  });
});

describe('conciliación', () => {
  it('detecta una posición que OANDA ya no tiene', async () => {
    await connectPractice();
    await service.placeOrder({
      environment: 'practice',
      instrument: 'EURUSD',
      side: 'buy',
      size: { units: 1 },
      stopPrice: 1.08,
      targetPrice: 1.09,
    });
    servers.practice.forgetPosition('EUR_USD');
    const summary = await service.reconcile('practice');
    expect(summary.ok).toBe(false);
    expect(summary.discrepancies.join(' ')).toContain('EURUSD');
  });
});
