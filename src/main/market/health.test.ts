import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dataStatusKey,
  IPC_CHANNELS,
  type DataStatusEntry,
  type DataStatusState,
  type NotificationPayload,
} from '../../shared/ipc';
import { MIGRATIONS } from '../db/migrations';
import { migrate } from '../db/migrator';
import {
  createDataHealthService,
  HEALTH_MAX_CONSECUTIVE_FAILURES,
  HEALTH_NOTIFY_COOLDOWN_MS,
  registerHealth,
  type DataHealthDeps,
  type DataHealthService,
} from './health';
import { createMarketRepository, type MarketRepository } from './repository';

const electron = vi.hoisted(() => ({
  isPackaged: false,
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

/**
 * Jueves 08-10-2026 a las 19:00 UTC: la última sesión cerrada es el
 * miércoles 07-10 (cierre 20:00 UTC, actualización 21:15 UTC). El plazo de
 * 12 h desde la hora de actualización vence el jueves a las 09:15 UTC.
 */
const NOW = Date.parse('2026-10-08T19:00:00.000Z');
const LAST_SESSION = '2026-10-07';
const PREV_SESSION = '2026-10-06';

let db: Database.Database;
let repo: MarketRepository;
let nowMs: number;
let service: DataHealthService;
let sent: { channel: string; payload: unknown }[];
let notifications: NotificationPayload[];
let timers: { cb: () => void; delayMs: number }[];

const status = (key: string) => repo.getDataStatus(key);

const entry = (partial: Partial<DataStatusEntry> & { key: string }): DataStatusEntry => ({
  state: 'fiable',
  lastOkAt: null,
  consecutiveFailures: 0,
  reason: null,
  updatedAt: new Date(nowMs).toISOString(),
  ...partial,
});

/** Drena la evaluación diferida que observe() encola por microtask. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const setup = (deps: Partial<DataHealthDeps> = {}): DataHealthService =>
  createDataHealthService({
    repo,
    now: () => nowMs,
    broadcast: (channel, payload) => {
      sent.push({ channel, payload });
      // Mismo cableado que registerHealth: las emisiones se observan.
      if (channel === IPC_CHANNELS.dataStatus.changed) {
        service.observe(payload as DataStatusEntry);
      }
    },
    notify: (payload) => notifications.push(payload),
    setTimer: (cb, delayMs) => {
      timers.push({ cb, delayMs });
      return {} as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => undefined,
    ...deps,
  });

/** Guarda velas de prueba hasta `lastDate` inclusive en un lote. */
const seedBars = (ticker: string, lastDate: string, dates?: string[]) => {
  const list = dates ?? [PREV_SESSION, lastDate];
  const batch = repo.createBatch({
    version: 1,
    hash: `hash-${ticker}-${lastDate}`,
    provider: 'test',
    scope: 'bars',
    ticker,
    rangeStart: list[0]!,
    rangeEnd: list[list.length - 1]!,
  });
  repo.upsertBars(
    ticker,
    'test',
    batch.id,
    list.map((date) => ({ date, open: 10, high: 11, low: 9, close: 10.5, volume: 1_000 })),
  );
  return batch;
};

const seedMacro = (id: string, frequency: string, lastObs: string | null) => {
  repo.upsertMacroSeries([{ id, source: 'test', name: `Serie ${id}`, frequency }]);
  if (lastObs !== null) {
    repo.upsertMacroObservations(id, null, [{ date: lastObs, value: 4.5 }]);
  }
};

beforeEach(() => {
  electron.handlers.clear();
  electron.isPackaged = false;
  vi.unstubAllEnvs();
  nowMs = NOW;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  repo = createMarketRepository(db);
  sent = [];
  notifications = [];
  timers = [];
  service = setup();
});

describe('vigilancia de tickers', () => {
  it('marca fiable cuando hay vela de la última sesión esperada', async () => {
    repo.addWatchlistTicker('AAPL');
    seedBars('AAPL', LAST_SESSION);

    const written = service.evaluate();
    await flush();

    expect(status(dataStatusKey.ticker('AAPL'))).toMatchObject({
      state: 'fiable',
      consecutiveFailures: 0,
      reason: null,
    });
    expect(status(dataStatusKey.ticker('AAPL'))!.lastOkAt).not.toBeNull();
    expect(written.map((e) => e.key)).toEqual([dataStatusKey.ticker('AAPL')]);
    expect(notifications).toEqual([]);
  });

  it('conserva fiable dentro del plazo de 12 h aunque falte la última vela', async () => {
    repo.addWatchlistTicker('AAPL');
    seedBars('AAPL', PREV_SESSION);
    // Jueves 08:00 UTC: aún no vence el plazo de las 09:15 UTC.
    nowMs = Date.parse('2026-10-08T08:00:00.000Z');

    service.evaluate();
    await flush();

    expect(status(dataStatusKey.ticker('AAPL'))).toMatchObject({ state: 'fiable' });
    expect(notifications).toEqual([]);
  });

  it('pasadas 12 h sin la vela esperada la marca desactualizado y avisa con alerta', async () => {
    repo.addWatchlistTicker('AAPL');
    seedBars('AAPL', PREV_SESSION);
    // Jueves 19:00 UTC: pasadas las 09:15 UTC sin la vela del miércoles.

    service.evaluate();
    await flush();

    const s = status(dataStatusKey.ticker('AAPL'))!;
    expect(s).toMatchObject({ state: 'desactualizado' });
    expect(s.reason).toContain(LAST_SESSION);
    expect(notifications).toEqual([
      expect.objectContaining({ level: 'alerta', title: expect.stringContaining('AAPL') }),
    ]);
  });

  it('la caducidad la marca la primera sesión que falta, no la más reciente', async () => {
    repo.addWatchlistTicker('AAPL');
    seedBars('AAPL', PREV_SESSION);
    // Viernes 09-10 20:30 UTC: faltan las velas del miércoles, jueves y viernes.
    nowMs = Date.parse('2026-10-09T20:30:00.000Z');

    service.evaluate();
    await flush();

    const s = status(dataStatusKey.ticker('AAPL'))!;
    expect(s.state).toBe('desactualizado');
    expect(s.reason).toContain('2026-10-07');
    expect(s.reason).toContain('+2 más');
  });

  it('tres fallos seguidos del proveedor la marcan no-fiable con aviso crítica', async () => {
    repo.addWatchlistTicker('AAPL');
    repo.setDataStatus({
      key: dataStatusKey.ticker('AAPL'),
      state: 'desactualizado',
      consecutiveFailures: HEALTH_MAX_CONSECUTIVE_FAILURES,
      reason: 'network: fallo simulado',
    });

    service.evaluate();
    await flush();

    expect(status(dataStatusKey.ticker('AAPL'))).toMatchObject({ state: 'no-fiable' });
    expect(notifications).toEqual([expect.objectContaining({ level: 'critica' })]);
  });

  it('un valor anómalo grave en el último lote la marca no-fiable', async () => {
    repo.addWatchlistTicker('AAPL');
    const batch = seedBars('AAPL', LAST_SESSION);
    repo.addQualityFlags([
      {
        batchId: batch.id,
        ticker: 'AAPL',
        date: LAST_SESSION,
        kind: 'anomalo',
        detail: 'non-positive-price: close <= 0',
      },
    ]);

    service.evaluate();
    await flush();

    const s = status(dataStatusKey.ticker('AAPL'))!;
    expect(s).toMatchObject({ state: 'no-fiable' });
    expect(s.reason).toContain('anómalo');
    expect(notifications).toEqual([expect.objectContaining({ level: 'critica' })]);
  });

  it('no degrada un no-fiable aunque el dato esté completo', async () => {
    repo.addWatchlistTicker('AAPL');
    seedBars('AAPL', LAST_SESSION);
    repo.setDataStatus({
      key: dataStatusKey.ticker('AAPL'),
      state: 'no-fiable',
      consecutiveFailures: 0,
      reason: 'lote con incidencias de calidad',
    });

    service.evaluate();
    await flush();

    expect(status(dataStatusKey.ticker('AAPL'))).toMatchObject({ state: 'no-fiable' });
  });

  it('respeta actualizando reciente aunque falten velas', async () => {
    repo.addWatchlistTicker('AAPL');
    repo.setDataStatus({ key: dataStatusKey.ticker('AAPL'), state: 'actualizando' });

    service.evaluate();
    await flush();

    expect(status(dataStatusKey.ticker('AAPL'))).toMatchObject({ state: 'actualizando' });
    expect(notifications).toEqual([]);
  });

  it('al recuperar el dato vuelve a fiable y avisa con info', async () => {
    repo.addWatchlistTicker('AAPL');
    seedBars('AAPL', PREV_SESSION);
    service.evaluate();
    await flush();
    expect(status(dataStatusKey.ticker('AAPL'))!.state).toBe('desactualizado');
    expect(notifications.map((n) => n.level)).toEqual(['alerta']);

    // Llega la vela que faltaba.
    seedBars('AAPL', LAST_SESSION, ['2026-10-06', '2026-10-07']);
    service.evaluate();
    await flush();

    expect(status(dataStatusKey.ticker('AAPL'))).toMatchObject({ state: 'fiable' });
    expect(notifications.map((n) => n.level)).toEqual(['alerta', 'info']);
  });

  it('un ticker sin velas ni estado previo no se escribe hasta la primera ingesta', async () => {
    repo.addWatchlistTicker('NUEVO');
    const written = service.evaluate();
    await flush();
    expect(written).toEqual([]);
    expect(status(dataStatusKey.ticker('NUEVO'))).toBeNull();
  });
});

describe('vigilancia de series macro', () => {
  it('una serie diaria al día (una sesión de desfase FRED) queda fiable', async () => {
    seedMacro('DGS10', 'daily', PREV_SESSION);

    service.evaluate();
    await flush();

    expect(status(dataStatusKey.macro('DGS10'))).toMatchObject({ state: 'fiable' });
  });

  it('una serie diaria atrás dos sesiones pasado el plazo queda desactualizado', async () => {
    seedMacro('DGS10', 'daily', '2026-10-05');

    service.evaluate();
    await flush();

    const s = status(dataStatusKey.macro('DGS10'))!;
    expect(s.state).toBe('desactualizado');
    expect(s.reason).toContain('2026-10-05');
    expect(notifications).toEqual([expect.objectContaining({ level: 'alerta' })]);
  });

  it('una serie mensual con el dato del mes anterior queda fiable', async () => {
    // CPIAUCSL publica el mes anterior; en octubre vale la cifra de septiembre.
    seedMacro('CPIAUCSL', 'monthly', '2026-09-01');

    service.evaluate();
    await flush();

    expect(status(dataStatusKey.macro('CPIAUCSL'))).toMatchObject({ state: 'fiable' });
    expect(notifications).toEqual([]);
  });

  it('los fallos seguidos de una serie también escalan a no-fiable', async () => {
    seedMacro('VIXCLS', 'daily', LAST_SESSION);
    repo.setDataStatus({
      key: dataStatusKey.macro('VIXCLS'),
      state: 'desactualizado',
      consecutiveFailures: HEALTH_MAX_CONSECUTIVE_FAILURES,
    });

    service.evaluate();
    await flush();

    expect(status(dataStatusKey.macro('VIXCLS'))).toMatchObject({ state: 'no-fiable' });
  });
});

describe('notificaciones al observar cambios', () => {
  const stale = (key: string): DataStatusEntry =>
    entry({ key, state: 'desactualizado', reason: 'falta la vela del 2026-10-07' });

  it('empeorar el estado avisa: alerta para desactualizado, crítica para no-fiable', async () => {
    const key = dataStatusKey.provider('tiingo');

    service.observe(stale(key));
    service.observe(entry({ key, state: 'no-fiable', consecutiveFailures: 3 }));
    await flush();

    expect(notifications.map((n) => n.level)).toEqual(['alerta', 'critica']);
    expect(notifications[1]!.title).toContain('proveedor');
  });

  it('una entrada con 3 fallos se escala a no-fiable aunque venga desactualizado', async () => {
    const key = dataStatusKey.provider('tiingo');
    service.observe(
      entry({ key, state: 'desactualizado', consecutiveFailures: HEALTH_MAX_CONSECUTIVE_FAILURES }),
    );
    await flush();

    expect(status(key)).toMatchObject({ state: 'no-fiable' });
    expect(notifications).toEqual([expect.objectContaining({ level: 'critica' })]);
  });

  it('agrupa el fallo del ticker y su proveedor sin perder sus estados', async () => {
    const reason = 'fallo de red de Tiingo';
    const ticker = repo.setDataStatus({
      key: dataStatusKey.ticker('AAPL'),
      state: 'no-fiable',
      consecutiveFailures: 3,
      reason,
    });
    service.observe(ticker);
    // Las dos escrituras reales pueden caer en milisegundos distintos.
    nowMs += 1;
    const provider = repo.setDataStatus({
      key: dataStatusKey.provider('tiingo'),
      state: 'no-fiable',
      consecutiveFailures: 3,
      reason,
    });
    service.observe(provider);
    await flush();

    expect(status(ticker.key)?.state).toBe('no-fiable');
    expect(status(provider.key)?.state).toBe('no-fiable');
    expect(notifications).toEqual([expect.objectContaining({ level: 'critica' })]);
    expect(notifications[0]?.title).toContain('proveedor');
  });

  it('un fallo independiente del ticker sigue notificándose', async () => {
    repo.setDataStatus({
      key: dataStatusKey.provider('tiingo'),
      state: 'no-fiable',
      consecutiveFailures: 3,
      reason: 'credencial rechazada',
    });
    service.observe(
      entry({
        key: dataStatusKey.ticker('AAPL'),
        state: 'no-fiable',
        consecutiveFailures: 3,
        reason: 'ticker no encontrado',
      }),
    );
    await flush();
    expect(notifications).toEqual([expect.objectContaining({ level: 'critica' })]);
    expect(notifications[0]?.title).toContain('AAPL');
  });

  it('actualizando no notifica', async () => {
    service.observe(entry({ key: dataStatusKey.provider('x'), state: 'actualizando' }));
    await flush();
    expect(notifications).toEqual([]);
  });

  it('las repeticiones del mismo estado se agrupan como máximo una cada 6 h', async () => {
    const key = dataStatusKey.provider('tiingo');

    service.observe(stale(key));
    service.observe(stale(key));
    await flush();
    expect(notifications).toHaveLength(1);

    // Dentro de la ventana de 6 h no hay segundo aviso.
    nowMs += HEALTH_NOTIFY_COOLDOWN_MS - 1;
    service.observe(stale(key));
    await flush();
    expect(notifications).toHaveLength(1);

    // Cumplida la ventana vuelve a avisar una vez.
    nowMs += 2;
    service.observe(stale(key));
    await flush();
    expect(notifications).toHaveLength(2);
    expect(notifications.every((n) => n.level === 'alerta')).toBe(true);
  });

  it('la recuperación tras un estado malo envía un aviso info y rearmar el ciclo', async () => {
    const key = dataStatusKey.provider('tiingo');

    service.observe(stale(key));
    service.observe(entry({ key, state: 'fiable' }));
    await flush();
    expect(notifications.map((n) => n.level)).toEqual(['alerta', 'info']);

    // Un nuevo deterioro vuelve a notificar (el ciclo se rearmó).
    service.observe(stale(key));
    await flush();
    expect(notifications.map((n) => n.level)).toEqual(['alerta', 'info', 'alerta']);
  });

  it('un estado malo previo al arranque avisa de su recuperación sin alerta inicial', async () => {
    const key = dataStatusKey.provider('tiingo');
    repo.setDataStatus({ key, state: 'desactualizado', reason: 'viejo' });
    service.start();
    await flush();

    service.observe(entry({ key, state: 'fiable' }));
    await flush();

    expect(notifications.map((n) => n.level)).toEqual(['info']);
    service.stop();
  });
});

describe('ciclo de vida', () => {
  it('start evalúa una vez y rearma el temporizador periódico', async () => {
    repo.addWatchlistTicker('AAPL');
    seedBars('AAPL', PREV_SESSION);
    service.start();
    await flush();

    expect(timers).toHaveLength(1);
    expect(status(dataStatusKey.ticker('AAPL'))!.state).toBe('desactualizado');

    // La siguiente pasada no reescribe un estado ya correcto.
    timers[0]!.cb();
    await flush();
    expect(timers).toHaveLength(2);
    const changes = sent.filter((s) => s.channel === IPC_CHANNELS.dataStatus.changed);
    expect(changes).toHaveLength(1);
    service.stop();
  });
});

describe('registro en la app', () => {
  const ctx = () => ({
    broadcast: vi.fn(),
    services: { storage: { getDb: () => db } } as Record<string, unknown>,
  });

  it('registra data-status:get y devuelve los estados guardados', () => {
    repo.setDataStatus({ key: 'ticker:AAPL', state: 'fiable' });
    const context = ctx();
    registerHealth(context as never, { autoStart: false });

    const handler = electron.handlers.get(IPC_CHANNELS.dataStatus.get)!;
    expect(handler).toBeDefined();
    expect((handler(null) as DataStatusEntry[]).map((e) => e.key)).toEqual(['ticker:AAPL']);
  });

  it('el gancho simulateProviderFailure solo existe con TRADIA_E2E sin empaquetar', () => {
    vi.stubEnv('TRADIA_E2E', '1');
    const context = ctx();
    registerHealth(context as never, { autoStart: false });
    expect(electron.handlers.has(IPC_CHANNELS.dataStatus.simulateProviderFailure)).toBe(true);

    electron.handlers.clear();
    electron.isPackaged = true;
    registerHealth(ctx() as never, { autoStart: false });
    expect(electron.handlers.has(IPC_CHANNELS.dataStatus.simulateProviderFailure)).toBe(false);

    electron.isPackaged = false;
    electron.handlers.clear();
    vi.stubEnv('TRADIA_E2E', '0');
    registerHealth(ctx() as never, { autoStart: false });
    expect(electron.handlers.has(IPC_CHANNELS.dataStatus.simulateProviderFailure)).toBe(false);
    vi.unstubAllEnvs();
  });

  it('el gancho activa el fallo en los proveedores y fuerza una pasada', async () => {
    vi.stubEnv('TRADIA_E2E', '1');
    const market = {
      setProviderFailure: vi.fn(),
      refreshNow: vi.fn(async () => ({ accepted: true, reason: null })),
    };
    const macro = { setProviderFailure: vi.fn(), refreshAll: vi.fn(async () => []) };
    const context = ctx();
    context.services.market = market;
    context.services.macro = macro;
    registerHealth(context as never, { autoStart: false });

    const handler = electron.handlers.get(IPC_CHANNELS.dataStatus.simulateProviderFailure)!;
    await handler(null, true);
    expect(market.setProviderFailure).toHaveBeenCalledWith('network');
    expect(macro.setProviderFailure).toHaveBeenCalledWith('network');
    expect(market.refreshNow).toHaveBeenCalled();
    expect(macro.refreshAll).toHaveBeenCalled();

    await handler(null, false);
    expect(market.setProviderFailure).toHaveBeenCalledWith(null);
    await expect(handler(null, 'sí')).rejects.toThrow(/entrada inválida/);
    vi.unstubAllEnvs();
  });

  it('envuelve ctx.broadcast: los cambios ajenos pasan por observe y notifican', async () => {
    const context = ctx();
    const original = context.broadcast;
    registerHealth(context as never, { autoStart: false });
    const notificationsSpy = vi.fn();
    context.services.notifications = { notify: notificationsSpy };

    expect(context.broadcast).not.toBe(original);
    context.broadcast(
      IPC_CHANNELS.dataStatus.changed,
      entry({ key: dataStatusKey.provider('tiingo'), state: 'no-fiable', consecutiveFailures: 3 }),
    );
    await flush();

    expect(notificationsSpy).toHaveBeenCalledWith(expect.objectContaining({ level: 'critica' }));
  });
});

describe('constantes del contrato', () => {
  it('los estados del dominio son los esperados', () => {
    const states: DataStatusState[] = ['fiable', 'actualizando', 'desactualizado', 'no-fiable'];
    expect(states).toHaveLength(4);
  });
});
