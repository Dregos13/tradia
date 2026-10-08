import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS, dataStatusKey } from '../../../shared/ipc';
import { MIGRATIONS } from '../../db/migrations';
import { migrate } from '../../db/migrator';
import { isMarketDataError } from '../providers/types';
import { createMarketRepository, type MarketRepository } from '../repository';
import { createMacroService, type MacroService, type TimerHandle } from './service';
import { createSimulatedMacroProvider, type SimulatedMacroProvider } from './simulated';

let db: Database.Database;
let repo: MarketRepository;
let provider: SimulatedMacroProvider;
let nowMs: number;
let timers: { cb: () => void; delay: number }[];

const START = Date.parse('2026-10-08T12:00:00.000Z'); // jueves, antes del cierre de NYSE

const setTimer = (cb: () => void, delay: number): TimerHandle => {
  const handle = { cb, delay };
  timers.push(handle);
  return handle as unknown as TimerHandle;
};
const clearTimer = (handle: TimerHandle): void => {
  const index = timers.indexOf(handle as unknown as { cb: () => void; delay: number });
  if (index >= 0) timers.splice(index, 1);
};
const fireTimers = (): void => {
  for (const { cb } of timers.splice(0)) cb();
};

const makeService = (extra: Partial<Parameters<typeof createMacroService>[0]> = {}): MacroService =>
  createMacroService({
    provider,
    repository: repo,
    now: () => nowMs,
    setTimer,
    clearTimer,
    broadcast: vi.fn(),
    ...extra,
  });

const macroBatchCount = (): number =>
  (
    db.prepare("SELECT COUNT(*) AS n FROM data_batches WHERE ambito = 'macro'").get() as {
      n: number;
    }
  ).n;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  repo = createMarketRepository(db);
  nowMs = START;
  timers = [];
  provider = createSimulatedMacroProvider({
    seed: 'svc',
    now: () => nowMs,
    genesis: '2026-09-01',
  });
});

describe('servicio macro: refresco', () => {
  it('guarda el catálogo, las observaciones y un lote versionado por serie', async () => {
    const service = makeService();
    const results = await service.refreshAll();

    expect(results).toHaveLength(6);
    expect(results.every((r) => r.error === undefined && r.stored > 0)).toBe(true);

    const series = repo.listMacroSeries();
    expect(series.map((s) => s.id)).toEqual([
      'CPIAUCSL',
      'DFF',
      'DGS10',
      'DGS2',
      'T10Y2Y',
      'VIXCLS',
    ]);
    expect(series.find((s) => s.id === 'VIXCLS')).toMatchObject({
      source: 'macro-simulated',
      name: 'VIX (volatilidad CBOE)',
    });

    // Cada serie tiene su lote (ámbito macro, versión 1) y sus observaciones.
    expect(macroBatchCount()).toBe(6);
    for (const s of series) {
      const batch = repo.latestBatch('macro', provider.id, s.id);
      expect(batch).toMatchObject({ version: 1, scope: 'macro', seriesId: s.id });
      expect(batch!.hash).toMatch(/^[0-9a-f]{64}$/);
      const obs = repo.getMacroObservations(s.id);
      expect(obs.length).toBeGreaterThan(0);
      expect(obs.every((o) => o.batchId === batch!.id)).toBe(true);
    }
    // CPIAUCSL es mensual: de 2026-09-01 a 2026-10-08 hay dos puntos.
    expect(repo.getMacroObservations('CPIAUCSL').map((o) => o.date)).toEqual([
      '2026-09-01',
      '2026-10-01',
    ]);
    // Todas las series y el proveedor quedan fiables.
    expect(repo.getDataStatus(dataStatusKey.macro('DFF'))).toMatchObject({
      state: 'fiable',
      consecutiveFailures: 0,
    });
    expect(repo.getDataStatus(dataStatusKey.provider(provider.id))).toMatchObject({
      state: 'fiable',
    });
  });

  it('un refresco sin cambios no crea lotes ni sube la versión', async () => {
    const service = makeService();
    await service.refreshAll();
    await service.refreshAll();
    expect(macroBatchCount()).toBe(6);
  });

  it('un valor revisado crea un lote nuevo con versión +1', async () => {
    const service = makeService();
    await service.refreshAll();

    provider.injectValue('DFF', '2026-10-08', 9.99);
    const results = await service.refreshAll();

    expect(macroBatchCount()).toBe(7);
    const batch = repo.latestBatch('macro', provider.id, 'DFF');
    expect(batch!.version).toBe(2);
    const obs = repo.getMacroObservations('DFF');
    expect(obs.find((o) => o.date === '2026-10-08')!.value).toBe(9.99);
    expect(results.find((r) => r.seriesId === 'DFF')!.batchId).toBe(batch!.id);
  });

  it('un fallo del proveedor suma fallos seguidos y al tercero marca no-fiable', async () => {
    const service = makeService();
    provider.setFailing('network');

    await service.refreshAll();
    expect(repo.getDataStatus(dataStatusKey.macro('DFF'))).toMatchObject({
      consecutiveFailures: 1,
      state: 'desactualizado',
    });
    expect(repo.getDataStatus(dataStatusKey.provider(provider.id))).toMatchObject({
      consecutiveFailures: 1,
    });

    await service.refreshAll();
    await service.refreshAll();
    expect(repo.getDataStatus(dataStatusKey.macro('DFF'))!.state).toBe('no-fiable');
    expect(repo.getDataStatus(dataStatusKey.provider(provider.id))!.state).toBe('no-fiable');
    expect(repo.getDataStatus(dataStatusKey.macro('DFF'))!.reason).toContain('network');

    // La recuperación deja la serie fiable con su último OK.
    provider.setFailing(null);
    await service.refreshAll();
    const entry = repo.getDataStatus(dataStatusKey.macro('DFF'))!;
    expect(entry).toMatchObject({ state: 'fiable', consecutiveFailures: 0, reason: null });
    expect(entry.lastOkAt).not.toBeNull();
  });

  it('emite data-status:changed en cada cambio de estado', async () => {
    const broadcast = vi.fn();
    const service = makeService({ broadcast });
    await service.refreshAll();

    const channels = broadcast.mock.calls.map((c) => c[0]);
    expect(channels).toContain(IPC_CHANNELS.dataStatus.changed);
    const keys = broadcast.mock.calls
      .filter((c) => c[0] === IPC_CHANNELS.dataStatus.changed)
      .map((c) => (c[1] as { key: string }).key);
    expect(keys).toContain('macro:VIXCLS');
    expect(keys).toContain('provider:macro-simulated');
  });

  it('refreshSeries lanza not-found fuera del catálogo', async () => {
    const service = makeService();
    await expect(service.refreshSeries('XXXX')).rejects.toSatisfy((e: unknown) =>
      isMarketDataError(e, 'not-found'),
    );
  });

  it('sin repositorio degrada: getSeries vacío y refresco omitido', async () => {
    const service = makeService({ repository: null });
    expect(await service.refreshAll()).toEqual([]);
    expect(service.getSeries()).toEqual([]);
  });
});

describe('servicio macro: refresco programado', () => {
  it('al arrancar refresca y arma la siguiente cita en la hora de NYSE', async () => {
    const service = makeService();
    service.start();

    // Refresco de arranque: se guarda el dato del día (jueves 08-10-2026).
    await vi.waitFor(() => {
      expect(repo.lastMacroObservationDate('VIXCLS')).toBe('2026-10-08');
    });
    // Próxima cita: cierre 16:00 ET + 75 min = 21:15 UTC de hoy.
    expect(service.nextRunAt()).toBe('2026-10-08T21:15:00.000Z');
    expect(timers).toHaveLength(1);
    service.stop();
  });

  it('el temporizador programado añade la observación nueva', async () => {
    const service = makeService();
    service.start();
    await vi.waitFor(() => {
      expect(repo.lastMacroObservationDate('VIXCLS')).toBe('2026-10-08');
    });

    // El reloj avanza hasta después de la actualización del viernes.
    nowMs = Date.parse('2026-10-09T22:00:00.000Z');
    fireTimers();
    await vi.waitFor(() => {
      expect(repo.lastMacroObservationDate('VIXCLS')).toBe('2026-10-09');
    });

    // Se rearmó: siguiente sesión con actualización es el lunes 12 a las 21:15 UTC.
    expect(service.nextRunAt()).toBe('2026-10-12T21:15:00.000Z');
    service.stop();
  });

  it('sin conexión el refresco programado se pospone', async () => {
    let online = false;
    const service = makeService({ isOnline: () => online });
    service.start();

    // Espera a que el arranque (omitido por estar offline) no escriba nada.
    await new Promise((r) => setImmediate(r));
    expect(repo.lastMacroObservationDate('DFF')).toBeNull();

    nowMs = Date.parse('2026-10-08T21:30:00.000Z');
    fireTimers();
    await new Promise((r) => setImmediate(r));
    expect(repo.lastMacroObservationDate('DFF')).toBeNull();

    // Al volver la conexión, la siguiente cita recupera el refresco.
    online = true;
    fireTimers();
    await vi.waitFor(() => {
      expect(repo.lastMacroObservationDate('DFF')).toBe('2026-10-08');
    });
    service.stop();
  });
});

describe('servicio macro: getSeries (contrato IPC)', () => {
  it('devuelve los snapshots de todas las series con su estado', async () => {
    const service = makeService();
    await service.refreshAll();

    const snapshots = service.getSeries();
    expect(snapshots).toHaveLength(6);
    const vix = snapshots.find((s) => s.id === 'VIXCLS')!;
    expect(vix).toMatchObject({ name: 'VIX (volatilidad CBOE)', unit: 'índice' });
    expect(vix.observations.length).toBeGreaterThan(0);
    expect(vix.observations.at(-1)!.date).toBe('2026-10-08');
    expect(vix.status).toMatchObject({ key: 'macro:VIXCLS', state: 'fiable' });
  });

  it('el filtro desde recorta las observaciones devueltas', async () => {
    const service = makeService();
    await service.refreshAll();

    const snapshots = service.getSeries({ desde: '2026-10-05' });
    for (const s of snapshots) {
      for (const obs of s.observations) {
        expect(obs.date >= '2026-10-05').toBe(true);
      }
    }
    expect(snapshots.find((s) => s.id === 'VIXCLS')!.observations.length).toBeLessThan(
      service.getSeries().find((s) => s.id === 'VIXCLS')!.observations.length,
    );
  });
});
