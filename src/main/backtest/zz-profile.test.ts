/* Perfil temporal de la semilla — archivo temporal para medir etapas. */
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database';
import { createSimulatedProvider } from '../market/providers';
import { createStrategiesRepository } from '../strategies/repository';
import { createBacktestRepository } from './repository';
import { createBacktestService } from './service';
import { stressSourceFromProvider } from './stress';
import { CLASSIC_STRATEGIES } from './strategies';

const NOW = Date.parse('2025-06-30T12:00:00.000Z');

describe('perfil', () => {
  it('mide etapas de la semilla por estrategia', async () => {
    const db = openDatabase(':memory:');
    const strategies = createStrategiesRepository(db);
    const runs = createBacktestRepository(db);
    const source = stressSourceFromProvider(
      createSimulatedProvider({ seed: 'svc-test', now: () => NOW }),
    );
    const events: { stage: string; percent: number; at: number }[] = [];
    const service = createBacktestService({
      runs,
      strategies,
      resolveSource: async () => source,
      broadcast: (_c, p) =>
        events.push({ ...(p as { stage: string; percent: number }), at: Date.now() }),
      now: () => NOW,
      logger: { warn: () => undefined, error: () => undefined, info: () => undefined },
    });
    service.seedFichas();
    const t0 = Date.now();
    await service.seedResults();
    console.log(`seedResults total: ${Date.now() - t0}ms`);
    let prev = t0;
    for (const e of events) {
      if (e.percent === 0 || e.percent === 100 || e.stage === 'completado') {
        console.log(`${e.stage} ${e.percent}% +${Date.now() - prev}ms`);
      }
      prev = e.at;
    }
    expect(true).toBe(true);
    db.close();
  }, 300_000);
});
