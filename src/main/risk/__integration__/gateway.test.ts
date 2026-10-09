/**
 * Integración de la pasarela única del motor de riesgo: compone sobre una
 * base real en memoria el repositorio (límites, vetos, cartera, equity), la
 * parada de emergencia y la fuente de contexto de cautela, y recorre los
 * cuatro caminos del motor sin Electron:
 *
 *   veto · aprobación · reducción por cautela · veto por parada activa
 *
 * más la parada automática que se dispara en medio de la evaluación cuando
 * la pérdida diaria de la cartera supera el umbral anómalo.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IPC_CHANNELS,
  type RiskOverview,
  type RiskVeto,
  type SignalIntent,
} from '../../../shared/ipc';
import { openDatabase } from '../../db/database';
import { createCautionContextSource } from '../caution';
import { createKillSwitchService, createKillSwitchStore } from '../killSwitch';
import { createRiskRepository } from '../repository';
import { createRiskService, type RiskService } from '../service';

const NOW = Date.parse('2026-10-09T15:00:00.000Z'); // viernes, NYSE abierta

let db: Database.Database;
let repo: ReturnType<typeof createRiskRepository>;
let killSwitch: ReturnType<typeof createKillSwitchService>;
let service: RiskService;
let sent: { channel: string; payload: unknown }[];

const vetoesEmitted = (): RiskVeto[] =>
  sent.filter((s) => s.channel === IPC_CHANNELS.risk.vetoed).map((s) => s.payload as RiskVeto);

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

/** Barras diarias suficientes para que el límite de liquidez disponga de volumen. */
const seedBars = (ticker: string, closes: number[], volume = 5_000_000): void => {
  const batchId = Number(
    db
      .prepare(
        `INSERT INTO data_batches (version, hash, proveedor, ambito, ticker, desde, hasta, recibido_en)
         VALUES (1, 'h', 'test', 'bars', ?, '2026-01-01', '2026-12-31', ?)`,
      )
      .run(ticker, new Date(NOW).toISOString()).lastInsertRowid,
  );
  const insert = db.prepare(
    `INSERT INTO bars (ticker, fecha, fuente, lote_id, open, high, low, close, volume)
     VALUES (?, ?, 'test', ?, ?, ?, ?, ?, ?)`,
  );
  closes.forEach((close, i) => {
    const fecha = `2026-09-${String(i + 1).padStart(2, '0')}`;
    insert.run(ticker, fecha, batchId, close, close, close, close, volume);
  });
};

beforeEach(() => {
  db = openDatabase(':memory:');
  sent = [];
  repo = createRiskRepository(db);
  killSwitch = createKillSwitchService({
    store: createKillSwitchStore(db),
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    pauseAgents: () => undefined,
    resumeAgents: () => undefined,
    now: () => NOW,
  });
  const cautionSource = createCautionContextSource({
    listEvents: () => [],
    getPortfolioTickers: () => repo.openTickers(),
    getVix: () => repo.lastVix(),
  });
  service = createRiskService({
    repo,
    cautionSource,
    killSwitch,
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    now: () => NOW,
  });
  seedBars('AAPL', [98, 99, 100, 101]);
});

afterEach(() => {
  service.stop();
  db.close();
});

describe('pasarela del motor de riesgo (integración)', () => {
  it('veta una señal sin stop y deja constancia en risk_vetoes', () => {
    const decision = service.submitSignal(signal({ stop: null, target: null }));

    expect(decision.status).toBe('vetada');
    expect(decision.reasons.map((r) => r.code)).toContain('STOP_MISSING');
    expect(decision.size).toBe(0);

    const logged = repo.listVetoes({ rule: 'STOP_MISSING' });
    expect(logged).toHaveLength(1);
    expect(logged[0]?.message).toBe('La señal no tiene stop de protección');
    expect(logged[0]?.signal.ticker).toBe('AAPL');
    expect(logged[0]?.decision).toBe('vetada');
    // Cada motivo de la señal genera su fila y su evento risk:vetoed.
    expect(vetoesEmitted()).toHaveLength(decision.reasons.length);
  });

  it('aprueba una señal limpia con el tamaño de la distancia al stop', () => {
    // Capital papel 100 000 · riesgo 0,5 % = 500 · distancia 5 → 100 unidades.
    const decision = service.submitSignal(signal());

    expect(decision).toMatchObject({
      status: 'aprobada',
      size: 100,
      sizeFactor: 1,
      riskAmount: 500,
      notional: 10_000,
      reasons: [],
    });
    expect(repo.listVetoes()).toHaveLength(0);
  });

  it('reduce el tamaño cuando la cautela aplica (vencimiento)', () => {
    // El gancho E2E inyecta el evento en la fuente de contexto real.
    const caution = service.simulateCalendarEvent({
      kind: 'vencimiento',
      title: 'Vencimiento mensual de opciones',
      dateUtc: '2026-10-09T20:00:00.000Z',
      impact: 'alto',
    });
    expect(caution).toMatchObject({ effect: 'reducir', cause: 'vencimiento' });

    const decision = service.submitSignal(signal());
    expect(decision.status).toBe('reducida');
    expect(decision.sizeFactor).toBe(0.5);
    expect(decision.size).toBe(50); // 100 × 0,5
    expect(decision.reasons[0]?.code).toBe('CAUTION_MODE');
    expect(decision.reasons[0]?.details['evento']).toBe('Vencimiento mensual de opciones');

    const logged = repo.listVetoes({ decision: 'reducida' });
    expect(logged).toHaveLength(1);
    expect(logged[0]?.size).toBe(50);
  });

  it('veta cualquier señal con la parada activa, con el motivo legible', () => {
    expect(service.submitSignal(signal()).status).toBe('aprobada');

    // Como la haría el botón de la cabecera o la bandeja.
    killSwitch.activate('manual', 'usuario');

    const decision = service.submitSignal(signal());
    expect(decision.status).toBe('vetada');
    expect(decision.reasons[0]?.code).toBe('KILL_SWITCH_ACTIVE');
    expect(decision.reasons[0]?.message).toBe('Parada activa');
    expect(decision.reasons[0]?.details['causa']).toBe('manual');

    const logged = repo.listVetoes({ rule: 'KILL_SWITCH_ACTIVE' });
    expect(logged).toHaveLength(1);
    expect(logged[0]?.signal.ticker).toBe('AAPL');
  });

  it('dispara la parada automática al observar una pérdida diaria anómala', () => {
    // Pérdida diaria del 3,5 % ≥ 1,5 × límite (2 %) → 'perdida-anomala'.
    service.seedPortfolio({
      equity: 96_500,
      equityHistory: [{ at: '2026-10-09T00:00:00.000Z', equity: 100_000 }],
    });

    const decision = service.submitSignal(signal());
    expect(decision.status).toBe('vetada');
    expect(decision.reasons[0]?.code).toBe('KILL_SWITCH_ACTIVE');
    expect(decision.reasons[0]?.details['causa']).toBe('perdida-anomala');

    const lastEvent = db
      .prepare(`SELECT * FROM kill_switch_events ORDER BY id DESC LIMIT 1`)
      .get() as { causa: string; actor: string };
    expect(lastEvent).toMatchObject({ causa: 'perdida-anomala', actor: 'automatico' });
  });

  it('risk:changed lleva los límites y la cautela reales tras setLimits', () => {
    service.setLimits({ ...service.getLimits(), riskPerTradePct: 1 });
    const last = sent.filter((s) => s.channel === IPC_CHANNELS.risk.changed).at(-1)
      ?.payload as RiskOverview;
    expect(last.limits.riskPerTradePct).toBe(1);
    expect(last.caution.active).toBe(false);
    expect(last.killSwitch.active).toBe(false);
  });
});
