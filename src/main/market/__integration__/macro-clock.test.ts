/**
 * Regresión del hallazgo E2E «las claves macro:* pasan a 'desactualizado'
 * al avanzar el reloj de mercado». `market:advance-clock` adelanta el
 * reloj compartido y reevalúa la ingesta de velas, pero el refresco de
 * las series macro va con temporizadores de tiempo real y no saltaría en
 * las semanas simuladas de una prueba: sus observaciones se quedaban en
 * el instante de arranque. El handler encadena ahora la puesta al día
 * del servicio macro, así las series del proveedor simulado siguen el
 * reloj de mercado.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dataStatusKey, IPC_CHANNELS } from '../../../shared/ipc';
import { MIGRATIONS } from '../../db/migrations';
import { migrate } from '../../db/migrator';
import type { ServiceContext } from '../../services';
import type { StorageService } from '../../services/storage';
import { createDataHealthService } from '../health';
import { createMarketClock, registerMarket, type MarketClock } from '../ingestion';
import { registerMacro, type MacroService } from '../macro';
import { createSimulatedMacroProvider } from '../macro/simulated';
import { createMarketRepository, type MarketRepository } from '../repository';

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
  },
  powerMonitor: { on: () => undefined, removeListener: () => undefined },
}));

const DAY_MS = 86_400_000;
/** Martes 08-09-2026 12:00 UTC; +30 días cae en jueves 08-10 (laborable). */
const START = Date.parse('2026-09-08T12:00:00.000Z');
const ADVANCE_30_DAYS = 30 * DAY_MS;

let db: Database.Database;

beforeEach(() => {
  electron.handlers.clear();
  vi.stubEnv('TRADIA_E2E', '1');
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

interface Fixture {
  ctx: ServiceContext;
  clock: MarketClock;
  repo: MarketRepository;
  macro: MacroService;
}

/**
 * El cableado mínimo de la app en E2E: reloj de mercado compartido, el
 * proveedor macro simulado atado a ese reloj (como en `registerMacro`)
 * y el servicio colgando de `ctx.services.macro`, que es donde
 * `market:advance-clock` lo encuentra.
 */
function setup(): Fixture {
  const clock = createMarketClock(() => START);
  const repo = createMarketRepository(db);
  const ctx = {
    broadcast: vi.fn(),
    services: {
      storage: { getDb: () => db } as unknown as StorageService,
      connectivity: { getState: () => ({ status: 'online' }) },
    },
  } as unknown as ServiceContext;
  const provider = createSimulatedMacroProvider({ seed: 'e2e', now: () => clock.now() });
  const macro = registerMacro(ctx, {
    provider,
    autoStart: false,
    now: () => clock.now(),
  });
  ctx.services.macro = macro;
  return { ctx, clock, repo, macro };
}

const macroState = (repo: MarketRepository, seriesId: string) =>
  repo.getDataStatus(dataStatusKey.macro(seriesId))?.state;

describe('reloj de mercado adelantado y series macro', () => {
  it('control: sin la puesta al día, avanzar el reloj 30 días marca macro:* desactualizado', async () => {
    const { clock, repo, macro } = setup();
    await macro.refreshAll();
    expect(repo.lastMacroObservationDate('DGS10')).toBe('2026-09-08');

    // Solo avanza el reloj (sin el encadenado del handler): la serie
    // queda un mes atrás y la salud la declara caducada.
    clock.advance(ADVANCE_30_DAYS);
    createDataHealthService({
      repo,
      broadcast: vi.fn(),
      now: () => clock.now(),
    }).evaluate();

    expect(macroState(repo, 'DGS10')).toBe('desactualizado');
  });

  it('market:advance-clock pone al día las series y quedan fiables', async () => {
    const { ctx, clock, repo, macro } = setup();
    await macro.refreshAll();
    const market = registerMarket(ctx, { clock });
    const advance = electron.handlers.get(IPC_CHANNELS.market.advanceClock);
    expect(advance).toBeTypeOf('function');

    const result = (await advance!(null, ADVANCE_30_DAYS)) as { now: string };
    expect(result.now).toBe('2026-10-08T12:00:00.000Z');

    // El refresco se esperó dentro del handler: las observaciones ya
    // llegan al nuevo «hoy» del reloj de mercado (diaria y mensual).
    expect(repo.lastMacroObservationDate('DGS10')).toBe('2026-10-08');
    expect(repo.lastMacroObservationDate('CPIAUCSL')).toBe('2026-10-01');

    createDataHealthService({
      repo,
      broadcast: vi.fn(),
      now: () => clock.now(),
    }).evaluate();
    for (const seriesId of ['DFF', 'DGS2', 'DGS10', 'T10Y2Y', 'VIXCLS', 'CPIAUCSL']) {
      expect(macroState(repo, seriesId)).toBe('fiable');
    }
    market.stop();
  });
});
