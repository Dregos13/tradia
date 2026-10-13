import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS, IpcValidationError, type MarketUpdatedEvent } from '../../shared/ipc';
import type { JournalRecordInput } from '../../shared/journal';
import type { RiskDecision } from '../../shared/risk';
import type { CreateStrategyRequest, StrategyStatus } from '../../shared/strategy';
import { createBacktestRepository } from '../backtest/repository';
import { openDatabase } from '../db/database';
import { createMarketRepository } from '../market/repository';
import type { ServiceContext } from '../services';
import { createStrategiesRepository } from '../strategies/repository';
import { registerSignals } from './index';

// electron solo aporta app/ipcMain a registerSignals; mismo patrón que las
// demás pruebas de servicios del proceso principal.
const electron = vi.hoisted(() => ({
  isPackaged: true,
  e2e: '0' as string | undefined,
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

const NOW = Date.parse('2026-10-09T21:00:00.000Z');
// Reloj del mercado para la guarda de frescura: jueves 08-10 tras el
// cierre, así la vela del 08-10 sigue siendo la sesión esperada.
const SIGNAL_CLOCK = { clock: { now: () => Date.parse('2026-10-08T21:00:00.000Z') } };

const DECISION: RiskDecision = {
  status: 'aprobada',
  size: 8,
  sizeFactor: 1,
  riskAmount: 40,
  notional: 1600,
  reasons: [],
  decidedAt: new Date(NOW).toISOString(),
};

let db: Database.Database;
let journalEntries: JournalRecordInput[];
let broadcasted: { channel: string; payload: unknown }[];
let submitted: unknown[];
let barsStoredListener: ((event: MarketUpdatedEvent) => void) | null;
let settingsStore: Map<string, string>;
let flags: { paused: boolean; offline: boolean; killSwitch: boolean };

/** Serie con cruce al alza justo en la última vela para SMA(2)/SMA(3). */
const seedAaplBars = (): void => {
  const market = createMarketRepository(db);
  const batch = market.createBatch({
    version: 1,
    hash: 'h',
    provider: 'simulado',
    scope: 'bars',
    ticker: 'AAPL',
    rangeStart: '2026-10-01',
    rangeEnd: '2026-10-08',
  });
  market.upsertBars(
    'AAPL',
    'simulado',
    batch.id,
    [
      ['2026-10-01', 10],
      ['2026-10-02', 10],
      ['2026-10-05', 9],
      ['2026-10-06', 9],
      ['2026-10-07', 9],
      ['2026-10-08', 12],
    ].map(([date, close]) => ({
      date: date as string,
      open: close as number,
      high: (close as number) + 1,
      low: (close as number) - 1,
      close: close as number,
      volume: 1_000,
    })),
  );
};

/** Ficha ejecutable 'activa' de cruce de medias sobre AAPL. */
const seedStrategy = (): number => {
  const runs = createBacktestRepository(db);
  const strategies = createStrategiesRepository(db, (id) => runs.implementationKey(id) !== null);
  const created = strategies.create({
    name: 'Cruce rápido',
    hypothesis: 'La tendencia corta persiste.',
    rules: {
      entry: 'Compra cuando SMA(2) cruza al alza a SMA(3).',
      exit: 'Vende en el cruce a la baja.',
      stop: 'Stop a 1 × ATR(2) bajo el cierre.',
      target: 'Sin objetivo fijo.',
    },
    parameters: { fastPeriod: 2, slowPeriod: 3, atrPeriod: 2, stopAtr: 1 },
    markets: ['AAPL'],
    regime: 'tendencial',
  });
  runs.setImplementation(created.id, 'sma-cross');
  strategies.setStatus({ id: created.id, status: 'activa' });
  return created.id;
};

/**
 * Ficha propia (sin implementación clásica) con reglas del DSL sobre
 * AAPL: por defecto el mismo cruce que dispara la clásica en la última
 * vela de `seedAaplBars`. `executable` queda a false en el repositorio —
 * el ejecutable de una propia son sus reglas compiladas, no una fila de
 * `strategy_implementations`.
 */
const seedCustomStrategy = (
  overrides: {
    name?: string;
    rules?: Partial<CreateStrategyRequest['rules']>;
    parameters?: Record<string, number>;
    status?: StrategyStatus;
    failsIn?: CreateStrategyRequest['failsIn'];
  } = {},
): number => {
  const runs = createBacktestRepository(db);
  const strategies = createStrategiesRepository(db, (id) => runs.implementationKey(id) !== null);
  const created = strategies.create({
    name: overrides.name ?? 'Propia cruce',
    hypothesis: 'La tendencia corta persiste.',
    rules: {
      entry: 'cruza_arriba(sma(2), sma(3))',
      exit: 'cruza_abajo(sma(2), sma(3))',
      stop: '5%',
      target: 'ninguno',
      ...overrides.rules,
    },
    parameters: overrides.parameters ?? {},
    markets: ['AAPL'],
    regime: 'tendencial',
    ...(overrides.failsIn === undefined ? {} : { failsIn: overrides.failsIn }),
  });
  const status = overrides.status ?? 'activa';
  if (status !== 'investigacion') {
    strategies.setStatus({ id: created.id, status });
  }
  return created.id;
};

/** Avisos `[signals]` de estrategia propia omitida captados por el espía. */
const customSkipWarnings = (warn: { mock: { calls: unknown[][] } }): string[] =>
  warn.mock.calls
    .map((call) => String(call[0]))
    .filter((message) => message.includes('estrategia propia'));

const makeCtx = (): ServiceContext => {
  const runs = createBacktestRepository(db);
  const strategies = createStrategiesRepository(db, (id) => runs.implementationKey(id) !== null);
  return {
    broadcast: (channel, payload) => {
      broadcasted.push({ channel, payload });
    },
    services: {
      storage: { getDb: () => db },
      strategies,
      market: {
        listWatchlist: () => [{ ticker: 'AAPL', addedAt: '', position: 0 }],
        onBarsStored: (listener: (event: MarketUpdatedEvent) => void) => {
          barsStoredListener = listener;
          return () => {
            barsStoredListener = null;
          };
        },
      },
      risk: { submitSignal: (intent: unknown) => (submitted.push(intent), DECISION) },
      journal: { record: (input: JournalRecordInput) => journalEntries.push(input) },
      scheduler: {
        getState: () => ({ paused: flags.paused, pauseReason: null, lastHeartbeatAt: null }),
      },
      connectivity: {
        getState: () => ({
          status: flags.offline ? 'offline' : 'online',
          lastCheckedAt: null,
          nextRetryAt: null,
          attempt: 0,
        }),
      },
      killSwitch: {
        getState: () => ({
          active: flags.killSwitch,
          cause: null,
          actor: null,
          activatedAt: null,
          detail: null,
        }),
      },
      settings: {
        getValue: (key: string) => settingsStore.get(key) ?? null,
        setValue: (key: string, value: string) => void settingsStore.set(key, value),
      },
    } as unknown as ServiceContext['services'],
  };
};

const fireBarStored = (ticker = 'AAPL', lastDate = '2026-10-08'): void => {
  barsStoredListener?.({
    ticker,
    source: 'simulado',
    lastDate,
    updatedAt: new Date(NOW).toISOString(),
  });
};

const invoke = (channel: string, ...args: unknown[]): unknown => {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`handler no registrado: ${channel}`);
  return handler({}, ...args);
};

beforeEach(() => {
  electron.handlers.clear();
  electron.isPackaged = true;
  electron.e2e = undefined;
  db = openDatabase(':memory:');
  journalEntries = [];
  broadcasted = [];
  submitted = [];
  barsStoredListener = null;
  settingsStore = new Map();
  flags = { paused: false, offline: false, killSwitch: false };
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('registerSignals: cableado en la app', () => {
  it('al guardarse una vela nueva se evalúa la estrategia activa y se emite la señal', () => {
    seedAaplBars();
    const strategyId = seedStrategy();
    const service = registerSignals(makeCtx(), SIGNAL_CLOCK);

    fireBarStored();

    const signals = invoke(IPC_CHANNELS.signals.list, {}) as { id: number; ticker: string }[];
    expect(signals).toHaveLength(1);
    expect(signals[0]!.ticker).toBe('AAPL');
    // Pasó por la pasarela única con origen 'estrategia'.
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      ticker: 'AAPL',
      direction: 'largo',
      origin: 'estrategia',
    });
    // Aviso signals:new al renderer (delivery lo intercepta a través de broadcast).
    expect(broadcasted.filter((e) => e.channel === IPC_CHANNELS.signals.new)).toHaveLength(1);
    // Diario automático.
    expect(journalEntries[0]).toMatchObject({ type: 'senal', ticker: 'AAPL', result: 'aprobada' });
    // Estado por estrategia.
    const states = invoke(IPC_CHANNELS.signals.strategies) as {
      strategyId: number;
      lastOutcome: string | null;
      lastSignalId: number | null;
    }[];
    expect(states[0]).toMatchObject({
      strategyId,
      lastOutcome: 'senal',
      lastSignalId: signals[0]!.id,
      lastBarDate: '2026-10-08',
    });
    service.stop();
  });

  it('es idempotente: la misma vela no genera dos señales (ni con la marca, ni sin ella)', () => {
    seedAaplBars();
    seedStrategy();
    const service = registerSignals(makeCtx(), SIGNAL_CLOCK);

    fireBarStored();
    fireBarStored();
    expect(invoke(IPC_CHANNELS.signals.list, {})).toHaveLength(1);
    expect(submitted).toHaveLength(1);

    // Las marcas persisten en settings: un «reinicio» (servicio nuevo sobre
    // la misma base) tampoco reevalúa la vela.
    const service2 = registerSignals(makeCtx(), SIGNAL_CLOCK);
    fireBarStored();
    expect(invoke(IPC_CHANNELS.signals.list, {})).toHaveLength(1);
    service2.stop();
    service.stop();
  });

  it('no evalúa con los agentes en pausa, sin conexión ni con la parada activa', () => {
    seedAaplBars();
    seedStrategy();
    const service = registerSignals(makeCtx(), SIGNAL_CLOCK);

    flags.paused = true;
    fireBarStored();
    flags.paused = false;
    flags.offline = true;
    fireBarStored('AAPL', '2026-10-09');
    flags.offline = false;
    flags.killSwitch = true;
    fireBarStored('AAPL', '2026-10-10');

    expect(invoke(IPC_CHANNELS.signals.list, {})).toHaveLength(0);
    expect(submitted).toHaveLength(0);
    service.stop();
  });

  it('signals:get devuelve el detalle y rechaza ids inválidos', () => {
    seedAaplBars();
    seedStrategy();
    const service = registerSignals(makeCtx(), SIGNAL_CLOCK);
    fireBarStored();

    const detail = invoke(IPC_CHANNELS.signals.get, 1) as { ticker: string; dataUsed: unknown };
    expect(detail.ticker).toBe('AAPL');
    expect(detail.dataUsed).toMatchObject({
      barDate: '2026-10-08',
      batchVersion: 1,
      source: 'simulado',
    });
    expect(invoke(IPC_CHANNELS.signals.get, 999)).toBeNull();
    expect(() => invoke(IPC_CHANNELS.signals.get, 'x')).toThrowError(IpcValidationError);
    expect(() => invoke(IPC_CHANNELS.signals.list, { limit: 0 })).toThrowError(IpcValidationError);
    service.stop();
  });

  it('signals:evaluate-now solo existe en modo E2E sin empaquetar', () => {
    seedAaplBars();
    seedStrategy();

    electron.isPackaged = true;
    vi.stubEnv('TRADIA_E2E', '1');
    const prod = registerSignals(makeCtx(), SIGNAL_CLOCK);
    expect(electron.handlers.has(IPC_CHANNELS.signals.evaluateNow)).toBe(false);
    prod.stop();

    electron.handlers.clear();
    electron.isPackaged = false;
    const dev = registerSignals(makeCtx(), SIGNAL_CLOCK);
    expect(electron.handlers.has(IPC_CHANNELS.signals.evaluateNow)).toBe(true);
    const result = invoke(IPC_CHANNELS.signals.evaluateNow) as { emitted: number };
    expect(result.emitted).toBe(1);
    dev.stop();
  });

  it('stop() desuscribe del evento de velas guardadas', () => {
    seedAaplBars();
    seedStrategy();
    const service = registerSignals(makeCtx(), SIGNAL_CLOCK);
    service.stop();
    fireBarStored();
    expect(invoke(IPC_CHANNELS.signals.list, {})).toHaveLength(0);
  });

  it('la señal aprobada abre posición simulada y la vela siguiente la cierra por stop', () => {
    seedAaplBars();
    seedStrategy();

    // Pasarela simulada (decisión fija) + cartera paper en memoria con la
    // interfaz de services.risk: el tracker la usa vía ctx.services.risk.
    const positions = new Map<
      number,
      { ticker: string; signalId: number | null; closedAt: string | null; exit: number | null }
    >();
    let nextPositionId = 1;
    const openedInputs: unknown[] = [];
    const ctx = makeCtx();
    ctx.services.risk = {
      submitSignal: (intent: unknown) => (submitted.push(intent), DECISION),
      openPaperPosition: (input: {
        ticker: string;
        signalId: number | null;
        openedOnBar: string | null;
      }) => {
        openedInputs.push(input);
        const position = {
          ticker: input.ticker,
          signalId: input.signalId,
          openedOnBar: input.openedOnBar,
          closedAt: null as string | null,
          exit: null as number | null,
        };
        positions.set(nextPositionId, position);
        return { ...position, id: nextPositionId++ };
      },
      listPaperPositions: (ticker?: string) =>
        [...positions.entries()]
          .filter(([, p]) => p.closedAt === null && (ticker === undefined || p.ticker === ticker))
          .map(([id, p]) => ({ ...p, id, direction: 'largo', entry: 12, stop: 10, target: 20 })),
      closePaperPosition: (request: { positionId: number; exit: number; closedAt: string }) => {
        const position = positions.get(request.positionId);
        if (position === undefined || position.closedAt !== null) return null;
        position.closedAt = request.closedAt;
        position.exit = request.exit;
        return { position, exit: request.exit, exitReason: 'stop', pnl: -14, equity: 99_986 };
      },
      getPaperRiskState: () => ({
        equity: 100_000,
        dailyLossPct: 0,
        weeklyLossPct: 0,
        monthlyLossPct: 0,
        drawdownPct: 0,
      }),
      getLimits: () => ({}),
    } as unknown as ServiceContext['services']['risk'];
    const service = registerSignals(ctx, SIGNAL_CLOCK);

    // Vela que genera la señal (entrada = cierre 12, tamaño DECISION.size).
    fireBarStored();
    expect(openedInputs).toHaveLength(1);
    expect(openedInputs[0]).toMatchObject({
      ticker: 'AAPL',
      openedOnBar: '2026-10-08',
    });
    const { signalId } = openedInputs[0] as { signalId: number };
    expect(signalId).toBeGreaterThan(0);

    // Vela siguiente: el tracker la pide al repositorio y cierra la
    // posición abierta (el stop del fake queda por encima de la apertura).
    const market = createMarketRepository(db);
    market.upsertBars('AAPL', 'simulado', 1, [
      { date: '2026-10-09', open: 5, high: 6, low: 4, close: 5, volume: 1_000 },
    ]);
    fireBarStored('AAPL', '2026-10-09');

    expect(positions.get(1)?.closedAt).not.toBeNull();
    expect(journalEntries.some((e) => e.type === 'operacion' && e.result === 'perdida')).toBe(true);
    service.stop();
  });
});

describe('registerSignals: estrategias propias', () => {
  it('una propia en estado emisor genera la señal de su regla de entrada por la pasarela', () => {
    seedAaplBars();
    const strategyId = seedCustomStrategy();
    const service = registerSignals(makeCtx(), SIGNAL_CLOCK);

    fireBarStored();

    const signals = invoke(IPC_CHANNELS.signals.list, {}) as {
      id: number;
      ticker: string;
      direction: string;
      reason: string;
      strategies: { strategyId: number }[];
    }[];
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ ticker: 'AAPL', direction: 'largo' });
    expect(signals[0]!.strategies.map((vote) => vote.strategyId)).toEqual([strategyId]);
    // El motivo cita la regla de entrada de la ficha (texto del DSL).
    expect(signals[0]!.reason).toContain('cruza_arriba');
    // La señal pasó por la pasarela única con origen 'estrategia'.
    expect(submitted).toHaveLength(1);
    const intent = submitted[0] as { entry: number; stop: number };
    expect(submitted[0]).toMatchObject({
      ticker: 'AAPL',
      direction: 'largo',
      origin: 'estrategia',
    });
    expect(intent.entry).toBe(12);
    // Stop del 5 % bajo el cierre de la señal, en largo.
    expect(intent.stop).toBeCloseTo(11.4, 10);
    service.stop();
  });

  it('una propia con reglas de corto emite la propuesta en corto por la pasarela', () => {
    seedAaplBars();
    seedCustomStrategy({
      rules: {
        entry: 'cierre > 100',
        exit: 'cierre < 9',
        entryShort: 'cierre > 11',
        exitShort: 'cierre < 9',
      },
    });
    const service = registerSignals(makeCtx(), SIGNAL_CLOCK);

    fireBarStored();

    expect(submitted).toHaveLength(1);
    const intent = submitted[0] as { direction: string; entry: number; stop: number };
    expect(submitted[0]).toMatchObject({
      ticker: 'AAPL',
      direction: 'corto',
      origin: 'estrategia',
    });
    expect(intent.entry).toBe(12);
    // El mismo stop del 5 % queda por encima de la entrada en corto.
    expect(intent.stop).toBeCloseTo(12.6, 10);
    service.stop();
  });

  it('una propia que no compila se omite con un único aviso y no rompe a las demás', () => {
    seedAaplBars();
    seedStrategy();
    seedCustomStrategy({ name: 'Propia rota', rules: { entry: 'cruza_arriba(sma(2)' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = registerSignals(makeCtx(), SIGNAL_CLOCK);

    fireBarStored();

    // La clásica siguió evaluando y emitiendo: la propia rota no la detiene.
    expect(submitted).toHaveLength(1);
    expect(invoke(IPC_CHANNELS.signals.list, {})).toHaveLength(1);
    expect(customSkipWarnings(warn)).toHaveLength(1);
    expect(customSkipWarnings(warn)[0]).toContain('no compilan');

    // Otra vela nueva vuelve a listar evaluables: el aviso sigue siendo único.
    const market = createMarketRepository(db);
    market.upsertBars('AAPL', 'simulado', 1, [
      { date: '2026-10-09', open: 13, high: 14, low: 12, close: 13, volume: 1_000 },
    ]);
    fireBarStored('AAPL', '2026-10-09');

    expect(customSkipWarnings(warn)).toHaveLength(1);
    service.stop();
  });

  it('una propia con un periodo-parámetro inválido no compila: se omite con aviso', () => {
    seedAaplBars();
    seedStrategy();
    seedCustomStrategy({
      name: 'Propia sin periodo',
      rules: { entry: 'cruza_arriba(sma(rapida), sma(lenta))' },
      parameters: { rapida: 0, lenta: 3 },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = registerSignals(makeCtx(), SIGNAL_CLOCK);

    fireBarStored();

    expect(submitted).toHaveLength(1);
    expect(customSkipWarnings(warn)).toHaveLength(1);
    expect(customSkipWarnings(warn)[0]).toContain('rapida');
    service.stop();
  });

  it('con el régimen fuera de la ficha la propia no vota ni emite', () => {
    seedAaplBars();
    seedCustomStrategy({ failsIn: ['lateral'] });
    const ctx = makeCtx();
    ctx.services.aiRegime = {
      service: {
        marketRegime: () => ({
          sessionDate: '2026-10-08',
          direction: 'lateral',
          volatility: 'volatilidad-baja',
        }),
      },
    } as unknown as ServiceContext['services']['aiRegime'];
    const service = registerSignals(ctx, SIGNAL_CLOCK);

    fireBarStored();

    expect(invoke(IPC_CHANNELS.signals.list, {})).toHaveLength(0);
    expect(submitted).toHaveLength(0);
    expect(
      journalEntries.some(
        (entry) => entry.type === 'resumen' && String(entry.reason).includes('no vota'),
      ),
    ).toBe(true);
    service.stop();
  });

  it('con datos desactualizados no se emite ninguna señal de propias', () => {
    seedAaplBars();
    seedCustomStrategy();
    const service = registerSignals(makeCtx(), SIGNAL_CLOCK);

    // La vela del 01-10 es anterior a la última sesión esperada (08-10):
    // llegó de una puesta al día atrasada y no se evalúa.
    fireBarStored('AAPL', '2026-10-01');

    expect(submitted).toHaveLength(0);
    expect(invoke(IPC_CHANNELS.signals.list, {})).toHaveLength(0);
    service.stop();
  });

  it('una propia fuera de los estados que emiten no se evalúa ni se avisa', () => {
    seedAaplBars();
    seedCustomStrategy({ status: 'investigacion', rules: { entry: '(' } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const service = registerSignals(makeCtx(), SIGNAL_CLOCK);

    fireBarStored();

    expect(submitted).toHaveLength(0);
    expect(customSkipWarnings(warn)).toHaveLength(0);
    service.stop();
  });
});
