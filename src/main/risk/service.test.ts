import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IPC_CHANNELS,
  IpcValidationError,
  RISK_DEFAULTS,
  type KillSwitchState,
  type RiskOverview,
  type SignalIntent,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import type { ServiceContext } from '../services';
import { createCautionContextSource } from './caution';
import type { KillSwitchService } from './killSwitch';
import { createRiskRepository } from './repository';
import { assertRiskLimits, createRiskService, registerRisk, RiskServiceError } from './service';

// electron solo aporta app/ipcMain a registerRisk; mismo patrón que las
// demás pruebas de servicios del proceso principal.
const electron = vi.hoisted(() => ({
  isPackaged: true,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return electron.isPackaged;
    },
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
}));

const NOW = Date.parse('2026-10-09T15:00:00.000Z');

let db: Database.Database;
let sent: { channel: string; payload: unknown }[];
let overviewExtrasCalls: number;

const signal = (patch: Partial<SignalIntent> = {}): SignalIntent => ({
  ticker: 'AAPL',
  direction: 'largo',
  entry: 100,
  stop: 95,
  target: 115,
  confidence: 0.7,
  origin: 'probador',
  ...patch,
});

const inactive: KillSwitchState = {
  active: false,
  cause: null,
  actor: null,
  activatedAt: null,
  detail: null,
};

const stubKillSwitch = (): KillSwitchService => ({
  getState: () => ({ ...inactive }),
  activate: () => ({ ...inactive, active: true, cause: 'manual' }),
  resume: () => ({ ...inactive }),
  observeDailyLoss: () => undefined,
  observeDrawdown: () => undefined,
  observeDataStatus: () => undefined,
  observePriceJump: () => undefined,
  observeSignal: () => undefined,
  checkConnectivity: () => undefined,
  setOverviewExtras: () => {
    overviewExtrasCalls += 1;
  },
  onChanged: () => () => undefined,
  start: () => undefined,
  stop: () => undefined,
});

const makeCtx = (): ServiceContext => ({
  broadcast: (channel, payload) => sent.push({ channel, payload }),
  services: {
    storage: { getDb: () => db },
    killSwitch: stubKillSwitch(),
    calendar: { list: () => [] },
  } as unknown as ServiceContext['services'],
});

beforeEach(() => {
  electron.handlers.clear();
  electron.isPackaged = true;
  db = openDatabase(':memory:');
  sent = [];
  overviewExtrasCalls = 0;
});

afterEach(() => {
  db.close();
});

describe('assertRiskLimits', () => {
  it('acepta los valores prudentes por defecto', () => {
    expect(() => assertRiskLimits(RISK_DEFAULTS)).not.toThrow();
  });

  it('rechaza un riesgo por operación del 3 % con error legible', () => {
    try {
      assertRiskLimits({ ...RISK_DEFAULTS, riskPerTradePct: 3 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(RiskServiceError);
      expect((error as RiskServiceError).code).toBe('limites-fuera-de-margen');
      expect((error as Error).message).toContain('riesgo por operación');
      expect((error as Error).message).toContain('0,5–2');
    }
  });

  it('rechaza un ratio beneficio/riesgo de 1:1,5', () => {
    expect(() => assertRiskLimits({ ...RISK_DEFAULTS, minRewardRiskRatio: 1.5 })).toThrowError(
      /ratio beneficio\/riesgo mínimo fuera de margen/,
    );
  });

  it('rechaza formas rotas: claves desconocidas, campos ausentes, no números', () => {
    expect(() => assertRiskLimits(null)).toThrowError(RiskServiceError);
    expect(() => assertRiskLimits({ ...RISK_DEFAULTS, extra: 1 })).toThrowError(
      /límites desconocidos: extra/,
    );
    const { maxLeverage: _drop, ...without } = RISK_DEFAULTS;
    expect(() => assertRiskLimits(without)).toThrowError(/apalancamiento/);
    expect(() => assertRiskLimits({ ...RISK_DEFAULTS, maxDailyLossPct: '2' })).toThrowError(
      /no son numéricos/,
    );
  });
});

describe('createRiskService', () => {
  const makeService = () => {
    const repo = createRiskRepository(db);
    const cautionSource = createCautionContextSource({
      listEvents: () => [],
      getPortfolioTickers: () => repo.openTickers(),
      getVix: () => null,
    });
    return createRiskService({
      repo,
      cautionSource,
      killSwitch: stubKillSwitch(),
      broadcast: (channel, payload) => sent.push({ channel, payload }),
      now: () => NOW,
    });
  };

  it('setLimits guarda y emite risk:changed con la vista completa', () => {
    const service = makeService();
    const saved = service.setLimits({ ...RISK_DEFAULTS, maxOpenPositions: 3 });
    expect(saved.maxOpenPositions).toBe(3);

    const overview = sent.filter((s) => s.channel === IPC_CHANNELS.risk.changed).at(-1)
      ?.payload as RiskOverview;
    expect(overview.limits.maxOpenPositions).toBe(3);
    expect(overview.killSwitch.active).toBe(false);
  });

  it('setLimits rechaza fuera de margen sin tocar los límites vigentes', () => {
    const service = makeService();
    expect(() => service.setLimits({ ...RISK_DEFAULTS, riskPerTradePct: 3 })).toThrowError(
      RiskServiceError,
    );
    expect(service.getLimits().riskPerTradePct).toBe(RISK_DEFAULTS.riskPerTradePct);
    expect(sent.filter((s) => s.channel === IPC_CHANNELS.risk.changed)).toHaveLength(0);
  });

  it('submitSignal vetada se persiste y emite risk:vetoed', () => {
    const service = makeService();
    const decision = service.submitSignal(signal({ stop: null }));
    expect(decision.status).toBe('vetada');
    const vetoed = sent.filter((s) => s.channel === IPC_CHANNELS.risk.vetoed);
    expect(vetoed.length).toBeGreaterThan(0);
    expect(service.listVetoes({ rule: 'STOP_MISSING' })).toHaveLength(1);
  });

  it('simulateCalendarEvent actualiza la cautela y stop() la limpia', () => {
    const service = makeService();
    const caution = service.simulateCalendarEvent({
      kind: 'vencimiento',
      title: 'Vencimiento mensual',
      dateUtc: '2026-10-09T20:00:00.000Z',
      impact: 'alto',
    });
    expect(caution.active).toBe(true);
    expect(service.getCaution().cause).toBe('vencimiento');
    expect(sent.filter((s) => s.channel === IPC_CHANNELS.risk.changed)).toHaveLength(1);

    service.stop();
    expect(service.getCaution().active).toBe(false);
  });
});

describe('cartera simulada (fase 4)', () => {
  const makeService = () => {
    const repo = createRiskRepository(db);
    const cautionSource = createCautionContextSource({
      listEvents: () => [],
      getPortfolioTickers: () => repo.openTickers(),
      getVix: () => null,
    });
    return createRiskService({
      repo,
      cautionSource,
      killSwitch: stubKillSwitch(),
      broadcast: (channel, payload) => sent.push({ channel, payload }),
      now: () => NOW,
    });
  };

  /** Una barra diaria para que la posición tenga precio de marca. */
  const seedBar = (ticker: string, close: number): void => {
    const batch = db
      .prepare(
        `INSERT INTO data_batches (version, hash, proveedor, ambito, ticker, desde, hasta, recibido_en)
         VALUES (1, 'h', 'test', 'bars', ?, '2026-01-01', '2026-12-31', ?)`,
      )
      .run(ticker, '2026-10-09T00:00:00.000Z');
    db.prepare(
      `INSERT INTO bars (ticker, fecha, fuente, lote_id, open, high, low, close, volume)
       VALUES (?, '2026-10-09', 'test', ?, ?, ?, ?, ?, 1000)`,
    ).run(ticker, Number(batch.lastInsertRowid), close, close, close, close);
  };

  const openInput = {
    ticker: 'AAPL',
    direction: 'largo' as const,
    entry: 100,
    stop: 95,
    target: 120,
    size: 10,
    sector: null,
    currency: 'USD',
    signalId: null,
    openedOnBar: '2026-10-08',
    openedAt: '2026-10-09T14:00:00.000Z',
  };

  it('openPaperPosition valida y persiste la posición con su trazabilidad', () => {
    const service = makeService();
    const position = service.openPaperPosition({ ...openInput, signalId: null });
    expect(position).toMatchObject({
      ticker: 'AAPL',
      direction: 'largo',
      entry: 100,
      size: 10,
      sector: 'tecnologia',
      signalId: null,
      openedOnBar: '2026-10-08',
      closedAt: null,
    });
    expect(service.listPaperPositions()).toHaveLength(1);
    expect(service.listPaperPositions('MSFT')).toHaveLength(0);
    expect(service.listPaperPositions('AAPL')[0]!.id).toBe(position.id);

    for (const bad of [
      { ...openInput, ticker: 'no es un ticker!' },
      { ...openInput, entry: 0 },
      { ...openInput, size: -1 },
      { ...openInput, stop: Number.NaN },
      { ...openInput, openedOnBar: 'ayer' },
      { ...openInput, signalId: -3 },
    ]) {
      expect(() => service.openPaperPosition(bad)).toThrowError(RiskServiceError);
    }
    expect(service.listPaperPositions()).toHaveLength(1);
  });

  it('closePaperPosition anota el P&L en la curva de capital y es idempotente', () => {
    const service = makeService();
    const position = service.openPaperPosition(openInput);
    const closed = service.closePaperPosition({
      positionId: position.id,
      exit: 95,
      exitReason: 'stop',
      closedAt: '2026-10-09T21:00:00.000Z',
    });
    // 10 uds × (95 − 100) = −50 sobre los 100 000 por defecto.
    expect(closed).toMatchObject({ exit: 95, exitReason: 'stop', pnl: -50, equity: 99_950 });
    expect(closed?.position.closedAt).toBe('2026-10-09T21:00:00.000Z');
    expect(service.listPaperPositions()).toHaveLength(0);

    // Segunda llamada sobre la misma posición: null, sin otro punto de capital.
    expect(
      service.closePaperPosition({
        positionId: position.id,
        exit: 95,
        exitReason: 'stop',
        closedAt: '2026-10-09T22:00:00.000Z',
      }),
    ).toBeNull();
    const count = db.prepare('SELECT COUNT(*) AS n FROM risk_equity_history').get() as {
      n: number;
    };
    expect(count.n).toBe(1);

    expect(() =>
      service.closePaperPosition({ positionId: 1.5, exit: 1, exitReason: 'stop', closedAt: 'x' }),
    ).toThrowError(RiskServiceError);
  });

  it('getPortfolio devuelve posiciones con marca, drawdown y exposición', () => {
    seedBar('AAPL', 110);
    const service = makeService();
    service.seedPortfolio({
      equity: 100_000,
      equityHistory: [{ at: '2026-10-01T00:00:00.000Z', equity: 120_000 }],
    });
    service.openPaperPosition(openInput);

    const portfolio = service.getPortfolio();
    expect(portfolio.openPositions).toBe(1);
    expect(portfolio.maxOpenPositions).toBe(RISK_DEFAULTS.maxOpenPositions);
    const [position] = portfolio.positions;
    expect(position).toMatchObject({
      ticker: 'AAPL',
      markPrice: 110,
      pnl: 100,
      pnlPct: 10,
      sector: 'tecnologia',
      signalId: null,
    });
    // Drawdown: 100 000 frente al pico de 120 000 = 16,67 %.
    expect(portfolio.drawdownPct).toBeCloseTo(16.67, 1);
    expect(portfolio.drawdownLimitPct).toBe(RISK_DEFAULTS.maxDrawdownPct);
    // Exposición: 10 × 110 = 1 100 sobre 100 000 = 1,1 %.
    expect(portfolio.exposureByAsset[0]).toMatchObject({
      key: 'AAPL',
      notional: 1100,
      pct: 1.1,
      limitPct: RISK_DEFAULTS.maxAssetExposurePct,
    });
    expect(portfolio.exposureBySector[0]).toMatchObject({
      key: 'tecnologia',
      limitPct: RISK_DEFAULTS.maxSectorExposurePct,
    });
    expect(portfolio.dailyLossLimitPct).toBe(RISK_DEFAULTS.maxDailyLossPct);
  });

  it('getPaperRiskState mide pérdidas por periodo y drawdown sobre la curva', () => {
    const service = makeService();
    service.seedPortfolio({
      equity: 90_000,
      equityHistory: [
        { at: '2026-10-01T00:00:00.000Z', equity: 100_000 },
        { at: '2026-10-08T00:00:00.000Z', equity: 95_000 },
      ],
    });
    const state = service.getPaperRiskState();
    expect(state.equity).toBe(90_000);
    expect(state.dailyLossPct).toBeCloseTo(5.26, 1);
    expect(state.weeklyLossPct).toBeCloseTo(10, 0);
    expect(state.monthlyLossPct).toBeCloseTo(10, 0);
    expect(state.drawdownPct).toBeCloseTo(10, 0);
  });
});

describe('registerRisk · IPC y cableado', () => {
  it('registra los handlers del contrato y enlaza los extras de la parada', () => {
    registerRisk(makeCtx());
    for (const channel of [
      IPC_CHANNELS.risk.getLimits,
      IPC_CHANNELS.risk.setLimits,
      IPC_CHANNELS.risk.listVetoes,
      IPC_CHANNELS.risk.submitSignal,
      IPC_CHANNELS.risk.getCaution,
      IPC_CHANNELS.risk.getPortfolio,
    ]) {
      expect(electron.handlers.has(channel)).toBe(true);
    }
    expect(overviewExtrasCalls).toBe(1);
  });

  it('risk:set-limits rechaza en el proceso principal con error legible', () => {
    registerRisk(makeCtx());
    const set = electron.handlers.get(IPC_CHANNELS.risk.setLimits)!;
    expect(() => set(null, { ...RISK_DEFAULTS, riskPerTradePct: 3 })).toThrowError(
      /riesgo por operación \(.*?\) fuera de margen/,
    );
    const get = electron.handlers.get(IPC_CHANNELS.risk.getLimits)!;
    expect((get(null) as RiskOverview['limits']).riskPerTradePct).toBe(
      RISK_DEFAULTS.riskPerTradePct,
    );
  });

  it('risk:submit-signal y risk:list-vetoes validan la entrada en el borde', () => {
    registerRisk(makeCtx());
    const submit = electron.handlers.get(IPC_CHANNELS.risk.submitSignal)!;
    expect(() => submit(null, { ticker: 'AAPL' })).toThrowError(IpcValidationError);

    const list = electron.handlers.get(IPC_CHANNELS.risk.listVetoes)!;
    expect(() => list(null, { rule: 'INVENTADA' })).toThrowError(IpcValidationError);
    expect(() => list(null, { limit: 0 })).toThrowError(IpcValidationError);
    expect(list(null, undefined)).toEqual([]);
  });

  it('los ganchos E2E solo existen con TRADIA_E2E y sin empaquetar', () => {
    registerRisk(makeCtx());
    expect(electron.handlers.has(IPC_CHANNELS.risk.simulateCalendarEvent)).toBe(false);
    expect(electron.handlers.has(IPC_CHANNELS.risk.seedPortfolio)).toBe(false);

    electron.handlers.clear();
    electron.isPackaged = false;
    process.env.TRADIA_E2E = '1';
    registerRisk(makeCtx());
    expect(electron.handlers.has(IPC_CHANNELS.risk.simulateCalendarEvent)).toBe(true);
    const seed = electron.handlers.get(IPC_CHANNELS.risk.seedPortfolio)!;
    expect(seed(null, { equity: 80_000 })).toEqual({ openPositions: 0, equityPoints: 1 });
    expect(() => seed(null, { equity: -1 })).toThrowError(IpcValidationError);
    delete process.env.TRADIA_E2E;
  });
});
