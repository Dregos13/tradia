import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import vixclsObservations from '../macro/__fixtures__/vixcls-observations.json';
import { createFredProvider } from '../macro/fred';
import { createMacroService } from '../macro/service';
import { createSimulatedProvider, type SimulatedProvider } from '../providers/simulated';
import { MIGRATIONS } from '../../db/migrations';
import { migrate } from '../../db/migrator';
import * as nyseCalendar from '../calendar';
import { createDataHealthService, type DataHealthService } from '../health';
import { createMarketIngestionService, type MarketIngestionService } from '../ingestion';
import { createMarketRepository, type MarketRepository } from '../repository';
import { createSignalEngine } from '../../signals/engine';
import { createSignalsRepository } from '../../signals/repository';
import type { RiskDecision } from '../../../shared/risk';
import type { SignalIntent } from '../../../shared/risk';
import { dataStatusKey, IPC_CHANNELS, type DataStatusEntry } from '../../../shared/ipc';
import { sessionDateLabel } from '../../../shared/dates';

const DEFAULT_NOW = Date.parse('2026-10-08T19:00:00.000Z');

interface MarketFixture {
  db: Database.Database;
  repo: MarketRepository;
  provider: SimulatedProvider;
  ingestion: MarketIngestionService;
  health: DataHealthService;
  notifications: Array<{ level: string; title: string; body: string }>;
  events: Array<{ channel: string; payload: unknown }>;
}

const marketFixtures: MarketFixture[] = [];
const macroDatabases: Database.Database[] = [];

function createMarketFixture(now = DEFAULT_NOW): MarketFixture {
  vi.setSystemTime(now);
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, MIGRATIONS);
  const repo = createMarketRepository(db);
  const provider = createSimulatedProvider({ seed: 'market-integration', now: () => Date.now() });
  const notifications: MarketFixture['notifications'] = [];
  const events: MarketFixture['events'] = [];
  const healthRef: { current: DataHealthService | null } = { current: null };
  const broadcast = (channel: string, payload: unknown): void => {
    events.push({ channel, payload });
    if (channel === IPC_CHANNELS.dataStatus.changed) {
      healthRef.current?.observe(payload as DataStatusEntry);
    }
  };
  const health = createDataHealthService({
    repo,
    now: () => Date.now(),
    broadcast: (channel, payload) => events.push({ channel, payload }),
    notify: (payload) => notifications.push(payload),
  });
  healthRef.current = health;
  const ingestion = createMarketIngestionService({
    repo,
    resolveProvider: async () => provider,
    broadcast,
    now: () => Date.now(),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const fixture = { db, repo, provider, ingestion, health, notifications, events };
  marketFixtures.push(fixture);
  return fixture;
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function crossNextUpdate(): Promise<void> {
  const updateAt = Date.parse(nyseCalendar.nextUpdateAt(Date.now() + 1).utc);
  await vi.advanceTimersByTimeAsync(updateAt - Date.now());
  await flushAsync();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(DEFAULT_NOW);
});

afterEach(() => {
  for (const fixture of marketFixtures.splice(0)) {
    fixture.ingestion.stop();
    fixture.health.stop();
    fixture.db.close();
  }
  for (const db of macroDatabases.splice(0)) db.close();
  vi.useRealTimers();
});

describe('flujo de mercado integrado', () => {
  it('al añadir un ticker descarga cinco años ajustados y persiste un lote versionado', async () => {
    const { repo, ingestion } = createMarketFixture();

    await ingestion.addTicker('aapl');

    const bars = repo.getBars('AAPL');
    expect(bars.length).toBeGreaterThan(1_200);
    expect(bars[0]!.date).toBe('2021-10-07');
    expect(bars.at(-1)!.date).toBe('2026-10-07');
    expect(bars.every((bar) => bar.adjClose !== null && bar.adjVolume !== null)).toBe(true);
    expect(repo.latestBatch('bars', 'simulated', 'AAPL')).toMatchObject({
      version: 1,
      scope: 'bars',
      ticker: 'AAPL',
      rangeStart: '2021-10-07',
      rangeEnd: '2026-10-07',
    });
  });

  it.each([
    {
      persona: 'profesional independiente',
      start: '2026-10-08T19:00:00.000Z',
      expectedSession: '2026-10-08',
      expectedMadrid: '2026-10-08T23:15:00+02:00',
    },
    {
      persona: 'responsable de equipo · desfase de marzo 2027',
      start: '2027-03-15T19:00:00.000Z',
      expectedSession: '2027-03-15',
      expectedMadrid: '2027-03-15T22:15:00+01:00',
    },
    {
      persona: 'responsable de equipo · desfase del 26-30 de octubre',
      start: '2026-10-26T19:00:00.000Z',
      expectedSession: '2026-10-26',
      expectedMadrid: '2026-10-26T22:15:00+01:00',
    },
  ])(
    '$persona recibe automáticamente la vela al cruzar el cierre NYSE',
    async ({ start, expectedSession, expectedMadrid }) => {
      const { repo, ingestion } = createMarketFixture(Date.parse(start));
      await ingestion.addTicker('SPY');
      const initialDate = repo.lastBarDate('SPY');

      await ingestion.start();
      const scheduled = nyseCalendar.nextUpdateAt(Date.now() + 1);
      expect(scheduled.madrid).toBe(expectedMadrid);
      await crossNextUpdate();

      expect(initialDate).not.toBe(expectedSession);
      expect(repo.lastBarDate('SPY')).toBe(expectedSession);
      expect(repo.latestBatch('bars', 'simulated', 'SPY')?.version).toBe(2);
      expect(repo.getBars('SPY').some((bar) => bar.date === expectedSession)).toBe(true);
    },
  );

  it('no inserta una vela para Acción de Gracias al actualizar la siguiente sesión', async () => {
    const { repo, ingestion } = createMarketFixture(Date.parse('2026-11-25T19:00:00.000Z'));
    await ingestion.addTicker('SPY');
    await ingestion.start();

    await crossNextUpdate();
    expect(repo.lastBarDate('SPY')).toBe('2026-11-25');
    await crossNextUpdate();

    expect(repo.lastBarDate('SPY')).toBe('2026-11-27');
    expect(repo.getBars('SPY').some((bar) => bar.date === '2026-11-26')).toBe(false);
  });

  it('un split inyectado reajusta toda la historia anterior en el lote guardado', async () => {
    const { repo, provider, ingestion } = createMarketFixture();
    provider.injectSplit('AAPL', '2024-06-10', 4);

    await ingestion.addTicker('AAPL');

    const bars = repo.getBars('AAPL');
    const beforeSplit = bars.find((bar) => bar.date === '2024-06-07')!;
    const onSplit = bars.find((bar) => bar.date === '2024-06-10')!;
    expect(beforeSplit.adjClose).toBeCloseTo(beforeSplit.close / 4, 4);
    expect(onSplit.adjClose).toBeCloseTo(onSplit.close, 4);
    expect(repo.getCorporateActions('AAPL')).toContainEqual(
      expect.objectContaining({ date: '2024-06-10', kind: 'split', value: 4 }),
    );
    expect(repo.getBatch(beforeSplit.batchId)?.version).toBe(1);
  });

  it('tres fallos seguidos marcan el ticker no fiable y generan una crítica', async () => {
    const { repo, provider, ingestion, notifications } = createMarketFixture(
      Date.parse('2026-10-09T19:00:00.000Z'),
    );
    await ingestion.addTicker('AAPL');
    provider.setFailing('network');
    vi.setSystemTime(Date.parse('2026-10-09T21:15:00.000Z'));

    await ingestion.refreshNow();
    await ingestion.refreshNow();
    await ingestion.refreshNow();
    await flushAsync();

    expect(repo.getDataStatus(dataStatusKey.ticker('AAPL'))).toMatchObject({
      state: 'no-fiable',
      consecutiveFailures: 3,
    });
    expect(notifications.filter((notification) => notification.level === 'critica')).toHaveLength(
      1,
    );
  });
});

describe('datos desactualizados y cálculos', () => {
  it('una vela vieja de una puesta al día atrasada no produce señal y el motivo queda en data_status', async () => {
    const { db, repo, health } = createMarketFixture();
    repo.addWatchlistTicker('AAPL');
    // El proveedor solo publicó hasta el 25-09 mientras la sesión
    // esperada es el 07-10 (caso QA: datos que llegan tarde).
    const batch = repo.createBatch({
      version: 1,
      hash: 'h-viejo',
      provider: 'simulated',
      scope: 'bars',
      ticker: 'AAPL',
      rangeStart: '2026-09-24',
      rangeEnd: '2026-09-25',
    });
    repo.upsertBars('AAPL', 'simulated', batch.id, [
      { date: '2026-09-25', open: 100, high: 101, low: 99, close: 100, volume: 1 },
    ]);
    repo.setDataStatus({
      key: dataStatusKey.ticker('AAPL'),
      state: 'fiable',
      lastOkAt: new Date(Date.now()).toISOString(),
      consecutiveFailures: 0,
    });

    // La evaluación lo ve: faltan las velas desde el lunes 28-09.
    health.evaluate();
    await flushAsync();

    const status = repo.getDataStatus(dataStatusKey.ticker('AAPL'))!;
    expect(status.state).toBe('desactualizado');
    expect(status.reason).toContain(`falta la vela del ${sessionDateLabel('2026-09-28')}`);
    expect(status.reason).toContain(`último dato: ${sessionDateLabel('2026-09-25')}`);
    expect(health.freshness()).toMatchObject({ state: 'stale' });

    // Y el motor no emite señal con la vela vieja ni la marca como evaluada.
    const signalsRepo = createSignalsRepository(db);
    const submitted: SignalIntent[] = [];
    const processedMarks = new Set<string>();
    const engine = createSignalEngine({
      repo: signalsRepo,
      listEvaluables: () => [],
      listStrategies: () => [],
      listWatchlistTickers: () => ['AAPL'],
      barsFor: (ticker, hasta, preferSource) =>
        repo
          .getBars(ticker, {
            hasta,
            ...(preferSource === null ? {} : { source: preferSource }),
          })
          .map((bar) => ({
            date: bar.date,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume,
            batchId: bar.batchId,
            source: bar.source,
          })),
      lastBarDate: (ticker) => repo.lastBarDate(ticker),
      getBatchVersion: () => 1,
      submitSignal: (intent) => {
        submitted.push(intent);
        return {
          status: 'aprobada',
          size: 1,
          sizeFactor: 1,
          riskAmount: 0,
          notional: 0,
          reasons: [],
          decidedAt: new Date().toISOString(),
        } satisfies RiskDecision;
      },
      recordJournal: () => undefined,
      broadcast: () => undefined,
      isAgentsPaused: () => false,
      isOffline: () => false,
      isKillSwitchActive: () => false,
      wasProcessed: (ticker, barDate) => processedMarks.has(`${ticker}|${barDate}`),
      markProcessed: (ticker, barDate) => {
        processedMarks.add(`${ticker}|${barDate}`);
      },
      expectedSessionDate: (nowMs) => nyseCalendar.lastExpectedSession(nowMs)?.date ?? null,
      now: () => Date.now(),
    });

    expect(engine.evaluateTicker('AAPL', '2026-09-25', 'simulated')).toBe('stale-data');
    expect(submitted).toHaveLength(0);
    expect(processedMarks.size).toBe(0);
    expect(signalsRepo.listSignals({})).toHaveLength(0);
  });
});

describe('flujo macro integrado', () => {
  it('refresca FRED y persiste VIXCLS con lote versionado', async () => {
    vi.setSystemTime(DEFAULT_NOW);
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    macroDatabases.push(db);
    const repo = createMarketRepository(db);
    const provider = createFredProvider({
      fetch: async () =>
        new Response(JSON.stringify(vixclsObservations), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      getApiKey: async () => 'integration-fixture-key',
      series: [{ id: 'VIXCLS', name: 'VIX', unit: 'índice', frequency: 'daily' }],
    });
    const macro = createMacroService({
      provider,
      repository: repo,
      now: () => Date.now(),
    });

    const results = await macro.refreshAll();

    expect(results[0]).toMatchObject({
      seriesId: 'VIXCLS',
      stored: 4,
      batchId: expect.any(Number),
    });
    expect(repo.getMacroObservations('VIXCLS').at(-1)).toMatchObject({
      date: '2026-10-08',
      value: 16.88,
    });
    expect(repo.latestBatch('macro', 'fred', 'VIXCLS')).toMatchObject({
      version: 1,
      scope: 'macro',
      seriesId: 'VIXCLS',
      rangeEnd: '2026-10-08',
    });
  });
});
