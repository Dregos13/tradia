/**
 * Pruebas del registro `registerDrift` (`index.ts`): canales IPC propios
 * (ai:health, ai:retrain-proposals, ai:resolve-retrain), el gancho E2E
 * `ai:simulate-drift` solo sin empaquetar y el enganche con la rutina
 * (`routine.onPostMarket` dispara la revisión diaria).
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS, IpcValidationError } from '../../../shared/ipc';
import type { JournalRecordInput } from '../../../shared/journal';
import type { StrategySummary } from '../../../shared/strategy';
import { openDatabase } from '../../db/database';
import { createStrategiesRepository } from '../../strategies/repository';
import { parseModelCard } from '../prediction/modelCard';
import { createPredictionsRepository } from '../prediction/repository';
import type { ServiceContext } from '../../services';
import { registerDrift } from './index';

// electron solo aporta app/ipcMain; mismo patrón que ai/regime.
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

const HASH = 'a'.repeat(64);

const cardJson = (): Record<string, unknown> => ({
  version: '0.1.0',
  hash: HASH,
  horizonDays: 5,
  trainingPeriod: { startDate: '2020-01-01', endDate: '2021-12-31' },
  calibrationPeriod: { startDate: '2022-01-01', endDate: '2022-06-30' },
  testPeriod: { startDate: '2022-07-01', endDate: '2022-12-31' },
  dataOrigin: 'real',
  metrics: { brierOos: 0.18, logLossOos: 0.55, brierBaseline: 0.25 },
  calibration: [],
  referenceDistribution: [],
  trainedAt: '2026-01-01T00:00:00.000Z',
});

/** Ficha real en `strategies` (retrain_proposals referencia su id por FK). */
const seedFicha = (): StrategySummary => {
  const strategies = createStrategiesRepository(db);
  const created = strategies.create({
    name: 'Cruce de medias',
    hypothesis: 'h',
    rules: { entry: 'e', exit: 'x', stop: 's', target: 't' },
    parameters: {},
    markets: ['SPY'],
    regime: 'tendencia',
  });
  strategies.setStatus({ id: created.id, status: 'activa' });
  return strategies.list().find((item) => item.id === created.id)!;
};

let db: Database.Database;
let postMarketListener: ((dia: string) => void) | null;
let fichas: StrategySummary[];
let journalEntries: JournalRecordInput[];

beforeEach(() => {
  electron.handlers.clear();
  electron.isPackaged = true;
  vi.stubEnv('TRADIA_E2E', '0');
  db = openDatabase(':memory:');
  postMarketListener = null;
  fichas = [];
  journalEntries = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
});

const makeCtx = (): ServiceContext =>
  ({
    broadcast: () => undefined,
    services: {
      storage: { getDb: () => db },
      journal: { record: (input: JournalRecordInput) => journalEntries.push(input) },
      market: { listWatchlist: () => [] },
      strategies: {
        list: () => fichas,
        setStatus: ({ id, status }: { id: number; status: string }) => {
          const s = fichas.find((f) => f.id === id);
          if (s !== undefined) s.status = status as StrategySummary['status'];
          return s;
        },
      },
      backtest: { listRuns: () => [], getRun: () => null },
      notifications: { notify: () => undefined },
      connectivity: { getState: () => ({ status: 'online' }) },
      routine: {
        onPostMarket: (listener: (dia: string) => void) => {
          postMarketListener = listener;
          return () => {
            postMarketListener = null;
          };
        },
      },
    },
  }) as unknown as ServiceContext;

describe('registerDrift', () => {
  it('registra los canales de salud y propuestas', () => {
    registerDrift(makeCtx());
    expect(electron.handlers.has(IPC_CHANNELS.ai.health)).toBe(true);
    expect(electron.handlers.has(IPC_CHANNELS.ai.retrainProposals)).toBe(true);
    expect(electron.handlers.has(IPC_CHANNELS.ai.resolveRetrain)).toBe(true);

    const health = electron.handlers.get(IPC_CHANNELS.ai.health)!({}) as {
      subjects: { subject: string }[];
      counts: Record<string, number>;
    };
    expect(health.subjects.some((s) => s.subject === 'modelo')).toBe(true);
    expect(health.counts.insuficiente).toBeGreaterThan(0);
    const proposals = electron.handlers.get(IPC_CHANNELS.ai.retrainProposals)!({});
    expect(proposals).toEqual([]);
  });

  it('el gancho postmercado de la rutina ejecuta la revisión diaria', () => {
    const cardId = createPredictionsRepository(db).registerModelCard(
      parseModelCard(cardJson()),
    ).id;
    fichas = [seedFicha()];
    registerDrift(makeCtx());
    expect(postMarketListener).not.toBeNull();

    postMarketListener!('2026-10-10');
    const rows = db
      .prepare(
        "SELECT tipo FROM drift_checks WHERE ambito IN ('modelo','estrategia') ORDER BY id",
      )
      .all() as { tipo: string }[];
    // 'datos' no se crea: la ficha del fixture no tiene referencia; sí
    // 'resultados' del modelo y 'rendimiento' de la estrategia activa.
    expect(rows.map((r) => r.tipo).sort()).toEqual(['rendimiento', 'resultados']);
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM drift_checks WHERE sujeto_id = ?')
      .get(cardId) as { n: number };
    expect(count.n).toBeGreaterThan(0);
  });

  it('resolve-retrain valida la entrada y simula solo sin empaquetar', () => {
    registerDrift(makeCtx());
    const resolve = electron.handlers.get(IPC_CHANNELS.ai.resolveRetrain)!;
    expect(() => resolve({}, { id: 'x' })).toThrow(IpcValidationError);
    expect(() => resolve({}, { id: 1, action: 'posponer' })).toThrow(IpcValidationError);

    expect(electron.handlers.has(IPC_CHANNELS.ai.simulateDrift)).toBe(false);
    electron.isPackaged = false;
    vi.stubEnv('TRADIA_E2E', '1');
    electron.handlers.clear();
    registerDrift(makeCtx());
    const simulate = electron.handlers.get(IPC_CHANNELS.ai.simulateDrift);
    expect(simulate).toBeDefined();
    expect(() => simulate!({}, { kind: 'ruido' })).toThrow(IpcValidationError);
  });

  it('ai:simulate-drift rendimiento degrada la estrategia vía contrato', () => {
    createPredictionsRepository(db).registerModelCard(parseModelCard(cardJson()));
    fichas = [seedFicha()];
    electron.isPackaged = false;
    vi.stubEnv('TRADIA_E2E', '1');
    registerDrift(makeCtx());
    const view = electron.handlers.get(IPC_CHANNELS.ai.simulateDrift)!({}, {
      kind: 'rendimiento',
      subjectId: fichas[0]!.id,
      streak: 2,
    }) as { subjects: { state: string; subject: string }[]; proposals: unknown[] };
    expect(fichas[0]!.status).toBe('degradada');
    expect(view.subjects.find((s) => s.subject === 'estrategia')!.state).toBe('degradada');
    expect(view.proposals).toHaveLength(1);
  });
});
