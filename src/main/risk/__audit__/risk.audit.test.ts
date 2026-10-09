/**
 * Auditoría del motor de riesgo (fase 3) — validación de cada veto y de
 * cada causa de parada sobre el servicio compuesto real.
 *
 * Recorre la pasarela completa (parada → reglas por operación → límites
 * de cartera → cautela) sobre una base SQLite en memoria, como hace la
 * app, y fuerza un escenario por regla:
 *
 * - Reglas por operación: STOP_MISSING, STOP_WRONG_SIDE, RR_TOO_LOW,
 *   SIZE_ZERO y SIGNAL_INVALID (confianza fuera de 0–1, que además
 *   dispara la parada por 'modelo-erratico').
 * - Límites de cartera: DAILY_LOSS, WEEKLY_LOSS, MONTHLY_LOSS,
 *   MAX_DRAWDOWN, MAX_POSITIONS, ASSET_EXPOSURE, SECTOR_EXPOSURE,
 *   CURRENCY_EXPOSURE, CORRELATION, LEVERAGE y LIQUIDITY (dato
 *   desconocido y límite superado).
 * - Cautela: CAUTION_MODE como 'reducida' (vencimiento) y como 'vetada'
 *   (evento de alto impacto).
 * - Parada: KILL_SWITCH_ACTIVE con el motivo «Parada activa».
 *
 * Y cada causa de la parada — 'manual', 'perdida-anomala',
 * 'dato-anomalo', 'sin-conexion' y 'modelo-erratico' — comprobando que
 * el estado queda persistido en `kill_switch_events`, que se emite la
 * notificación crítica y que la reanudación exige `confirm: true`.
 *
 * El último caso cruza los códigos producidos con `VETO_REASON_CODES` y
 * `KILL_SWITCH_CAUSES`: si en el futuro se añade una regla al contrato,
 * la auditoría falla hasta que tenga su escenario.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IPC_CHANNELS,
  KILL_SWITCH_CAUSES,
  VETO_REASON_CODES,
  VETO_REASON_MESSAGES,
  type ConnectivityState,
  type KillSwitchCause,
  type KillSwitchState,
  type NotificationPayload,
  type RiskDecision,
  type RiskVeto,
  type SignalIntent,
  type VetoReasonCode,
} from '../../../shared/ipc';
import { openDatabase } from '../../db/database';
import { createCautionContextSource, type CautionContextSource } from '../caution';
import {
  createKillSwitchService,
  createKillSwitchStore,
  KillSwitchError,
  type KillSwitchService,
} from '../killSwitch';
import { checkPortfolioLimits } from '../portfolioLimits';
import { createRiskRepository, type RiskRepository } from '../repository';
import { createRiskService, type RiskService } from '../service';
import { evaluateTradeRules } from '../tradeRules';

const NOW = Date.parse('2026-10-09T15:00:00.000Z'); // viernes, sesión NYSE en curso
const NOW_ISO = new Date(NOW).toISOString();

let db: Database.Database;
let repo: RiskRepository;
let killSwitch: KillSwitchService;
let cautionSource: CautionContextSource;
let service: RiskService;
let sent: { channel: string; payload: unknown }[];
let notifications: NotificationPayload[];
let pausedAgents: number;
let resumedAgents: number;
let nowMs: number;
let connectivity: ConnectivityState;

/** Códigos de veto y causas de parada ejercitados por esta batería. */
const seenVetoCodes = new Set<VetoReasonCode>();
const seenCauses = new Set<KillSwitchCause>();

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

/** Barras diarias para un ticker (metadatos de liquidez y rendimientos). */
const seedBars = (ticker: string, closes: number[], volume = 5_000_000): void => {
  const batchId = Number(
    db
      .prepare(
        `INSERT INTO data_batches (version, hash, proveedor, ambito, ticker, desde, hasta, recibido_en)
         VALUES (1, 'h', 'test', 'bars', ?, '2026-01-01', '2026-12-31', ?)`,
      )
      .run(ticker, NOW_ISO).lastInsertRowid,
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

const vetoesEmitted = (): RiskVeto[] =>
  sent.filter((s) => s.channel === IPC_CHANNELS.risk.vetoed).map((s) => s.payload as RiskVeto);

const lastKillSwitchEvent = (): { accion: string; causa: string; actor: string } =>
  db
    .prepare(`SELECT accion, causa, actor FROM kill_switch_events ORDER BY id DESC LIMIT 1`)
    .get() as { accion: string; causa: string; actor: string };

/**
 * Exige que la decisión esté vetada con el código pedido, que el motivo
 * sea el legible del contrato y que el veto quede persistido. Anota el
 * código para la comprobación de cobertura del final.
 */
const expectVeto = (decision: RiskDecision, code: VetoReasonCode): void => {
  expect(decision.status).toBe('vetada');
  const codes = decision.reasons.map((r) => r.code);
  codes.forEach((c) => seenVetoCodes.add(c));
  expect(codes).toContain(code);
  const reason = decision.reasons.find((r) => r.code === code)!;
  expect(reason.message).toBe(VETO_REASON_MESSAGES[code]);
  expect(repo.listVetoes({ rule: code }).length).toBeGreaterThan(0);
};

/** Anota una activación de la parada y exige el evento persistido. */
const expectActiveKillSwitch = (cause: KillSwitchCause): KillSwitchState => {
  const state = killSwitch.getState();
  expect(state.active).toBe(true);
  expect(state.cause).toBe(cause);
  seenCauses.add(cause);
  expect(lastKillSwitchEvent().causa).toBe(cause);
  return state;
};

beforeEach(() => {
  db = openDatabase(':memory:');
  sent = [];
  notifications = [];
  pausedAgents = 0;
  resumedAgents = 0;
  nowMs = NOW;
  connectivity = { status: 'online', lastCheckedAt: NOW_ISO, nextRetryAt: null, attempt: 0 };
  repo = createRiskRepository(db);
  killSwitch = createKillSwitchService({
    store: createKillSwitchStore(db),
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    pauseAgents: () => {
      pausedAgents += 1;
    },
    resumeAgents: () => {
      resumedAgents += 1;
    },
    notify: (payload) => notifications.push(payload),
    getConnectivityState: () => connectivity,
    now: () => nowMs,
  });
  cautionSource = createCautionContextSource({
    listEvents: () => [],
    getPortfolioTickers: () => repo.openTickers(),
    getVix: () => repo.lastVix(),
  });
  service = createRiskService({
    repo,
    cautionSource,
    killSwitch,
    broadcast: (channel, payload) => sent.push({ channel, payload }),
    now: () => nowMs,
  });
  seedBars('AAPL', [98, 99, 100, 101]);
});

afterEach(() => {
  service.stop();
  killSwitch.stop();
  db.close();
});

// ---------------------------------------------------------------------------
// Reglas por operación
// ---------------------------------------------------------------------------

describe('auditoría · reglas por operación', () => {
  it('STOP_MISSING: una señal sin stop queda vetada y registrada', () => {
    const decision = service.submitSignal(signal({ stop: null }));

    expectVeto(decision, 'STOP_MISSING');
    expect(decision.reasons).toHaveLength(1);
    expect(decision.size).toBe(0);
    expect(vetoesEmitted()).toHaveLength(1);
  });

  it('STOP_WRONG_SIDE: un stop del lado contrario queda vetado', () => {
    const decision = service.submitSignal(signal({ stop: 105 }));

    expectVeto(decision, 'STOP_WRONG_SIDE');
    expect(decision.reasons[0]?.details).toMatchObject({ entrada: 100, stop: 105 });
  });

  it('RR_TOO_LOW: un beneficio/riesgo menor de 1:2 queda vetado', () => {
    const decision = service.submitSignal(signal({ stop: 95, target: 105 }));

    expectVeto(decision, 'RR_TOO_LOW');
    expect(decision.reasons[0]?.details).toMatchObject({ ratio: 1, minimo: 2 });
  });

  it('SIZE_ZERO: la distancia al stop decide un tamaño cero y veta', () => {
    // Distancia 9 999 con ratio ≥ 2 (objetivo 30 000): solo puede vetar el tamaño.
    const decision = service.submitSignal(signal({ entry: 10_000, stop: 1, target: 30_000 }));

    expectVeto(decision, 'SIZE_ZERO');
    expect(decision.reasons[0]?.details['distancia']).toBe(9_999);
  });

  it('SIGNAL_INVALID: confianza fuera de 0–1 veta y dispara la parada', () => {
    const decision = service.submitSignal(signal({ confidence: 2.5 }));

    expectVeto(decision, 'SIGNAL_INVALID');
    // La anomalía del modelo se observa antes de evaluar: la parada queda
    // activa y su veto acompaña al de señal inválida.
    expect(decision.reasons.map((r) => r.code)).toContain('KILL_SWITCH_ACTIVE');
    expectActiveKillSwitch('modelo-erratico');
    expect(killSwitch.getState().actor).toBe('automatico');
  });
});

// ---------------------------------------------------------------------------
// Límites de pérdida por periodo y drawdown
// ---------------------------------------------------------------------------

describe('auditoría · límites de pérdida y drawdown', () => {
  it('DAILY_LOSS: pérdida diaria ≥ límite veta (sin disparar la parada)', () => {
    // 2,5 % de pérdida en el día: supera el límite (2 %) pero no el umbral
    // anómalo de la parada (1,5 × 2 % = 3 %).
    service.seedPortfolio({
      equity: 97_500,
      equityHistory: [{ at: '2026-10-09T00:00:00.000Z', equity: 100_000 }],
    });

    const decision = service.submitSignal(signal());
    expectVeto(decision, 'DAILY_LOSS');
    expect(decision.reasons.map((r) => r.code)).toEqual(['DAILY_LOSS']);
    expect(killSwitch.getState().active).toBe(false);
  });

  it('WEEKLY_LOSS: pérdida semanal ≥ límite veta sin ensuciar el día', () => {
    // Semana −5 % (≥ 4 %) con el día en −1,04 % (< 2 %) y el mes en −5 % (< 6 %).
    service.seedPortfolio({
      equity: 95_000,
      equityHistory: [
        { at: '2026-10-05T00:00:00.000Z', equity: 100_000 },
        { at: '2026-10-09T00:00:00.000Z', equity: 96_000 },
      ],
    });

    const decision = service.submitSignal(signal());
    expectVeto(decision, 'WEEKLY_LOSS');
    expect(decision.reasons.map((r) => r.code)).toEqual(['WEEKLY_LOSS']);
  });

  it('MONTHLY_LOSS: pérdida mensual ≥ límite veta sin tocar día ni semana', () => {
    // Mes −8 % (≥ 6 %), semana −1,6 % (< 4 %), día −1,08 % (< 2 %) y
    // drawdown 8 % (< 10 %): solo puede vetar la mensual.
    service.seedPortfolio({
      equity: 92_000,
      equityHistory: [
        { at: '2026-09-30T00:00:00.000Z', equity: 100_000 },
        { at: '2026-10-05T00:00:00.000Z', equity: 93_500 },
        { at: '2026-10-09T00:00:00.000Z', equity: 93_000 },
      ],
    });

    const decision = service.submitSignal(signal());
    expectVeto(decision, 'MONTHLY_LOSS');
    expect(decision.reasons.map((r) => r.code)).toEqual(['MONTHLY_LOSS']);
  });

  it('MAX_DRAWDOWN: el límite existe aunque la parada actúe antes en la pasarela', () => {
    // Drawdown 14,5 % ≥ 10 % con el resto de periodos limpios. A nivel de
    // regla de cartera el veto es MAX_DRAWDOWN…
    service.seedPortfolio({
      equity: 85_500,
      equityHistory: [
        { at: '2026-09-01T00:00:00.000Z', equity: 100_000 },
        { at: '2026-10-01T00:00:00.000Z', equity: 90_000 },
        { at: '2026-10-05T00:00:00.000Z', equity: 87_000 },
        { at: '2026-10-09T00:00:00.000Z', equity: 86_000 },
      ],
    });
    const snapshot = repo.buildSnapshot(NOW_ISO, ['AAPL']);
    const trade = evaluateTradeRules(signal(), snapshot.equity, service.getLimits());
    const reasons = checkPortfolioLimits(signal(), trade.size, snapshot, service.getLimits());
    expect(reasons.map((r) => r.code)).toEqual(['MAX_DRAWDOWN']);
    seenVetoCodes.add('MAX_DRAWDOWN');

    // …pero por la pasarela el mismo drawdown activa la parada de
    // emergencia ('perdida-anomala'): el veto que ve el usuario es el de
    // parada, más restrictivo por diseño.
    const decision = service.submitSignal(signal());
    expectVeto(decision, 'KILL_SWITCH_ACTIVE');
    expectActiveKillSwitch('perdida-anomala');
  });
});

// ---------------------------------------------------------------------------
// Límites de exposición
// ---------------------------------------------------------------------------

describe('auditoría · límites de exposición', () => {
  it('MAX_POSITIONS: con el máximo de posiciones abiertas no cabe otra', () => {
    service.seedPortfolio({
      positions: ['P01', 'P02', 'P03', 'P04', 'P05'].map((ticker) => ({
        ticker,
        direction: 'largo' as const,
        entry: 50,
        size: 10,
      })),
    });

    const decision = service.submitSignal(signal());
    expectVeto(decision, 'MAX_POSITIONS');
    expect(decision.reasons[0]?.details).toMatchObject({ limite: 5, abiertas: 5 });
  });

  it('ASSET_EXPOSURE: la exposición por activo supera el 20 %', () => {
    // 16 000 en AAPL + 10 000 de la candidata = 26 % del capital.
    service.seedPortfolio({
      positions: [{ ticker: 'AAPL', direction: 'largo', entry: 100, size: 160 }],
    });

    const decision = service.submitSignal(signal());
    expectVeto(decision, 'ASSET_EXPOSURE');
    expect(decision.reasons.map((r) => r.code)).toEqual(['ASSET_EXPOSURE']);
    expect(decision.reasons[0]?.details['ticker']).toBe('AAPL');
  });

  it('SECTOR_EXPOSURE: la exposición sectorial supera el 30 %', () => {
    // Tecnología: 15 000 (AAPL) + 10 000 (MSFT) + 10 000 de la candidata.
    service.seedPortfolio({
      positions: [
        { ticker: 'AAPL', direction: 'largo', entry: 100, size: 150 },
        { ticker: 'MSFT', direction: 'largo', entry: 100, size: 100 },
      ],
    });
    seedBars('NVDA', [98, 99, 100, 101]);

    const decision = service.submitSignal(signal({ ticker: 'NVDA' }));
    expectVeto(decision, 'SECTOR_EXPOSURE');
    expect(decision.reasons.map((r) => r.code)).toEqual(['SECTOR_EXPOSURE']);
    expect(decision.reasons[0]?.details['sector']).toBe('tecnologia');
  });

  it('CURRENCY_EXPOSURE: la exposición fuera de USD supera el 25 %', () => {
    // 26 000 en EUR ya supera el límite aunque la candidata sea en USD.
    service.seedPortfolio({
      positions: [
        {
          ticker: 'ASML',
          direction: 'largo',
          entry: 100,
          size: 260,
          sector: 'semiconductores',
          currency: 'EUR',
        },
      ],
    });

    const decision = service.submitSignal(signal());
    expectVeto(decision, 'CURRENCY_EXPOSURE');
    expect(decision.reasons.map((r) => r.code)).toEqual(['CURRENCY_EXPOSURE']);
    // El veto detalla la divisa de la candidata (USD): la exposición
    // superada es la de las posiciones abiertas fuera de USD.
    expect(decision.reasons[0]?.details['exposicion']).toBe(26);
  });

  it('CORRELATION: correlación alineada > 0,7 con una posición abierta', () => {
    // Rendimientos idénticos en la ventana → Pearson = 1 con misma dirección.
    const closes = Array.from({ length: 12 }, (_, i) => 100 + i);
    seedBars('AAA1', closes);
    seedBars('BBB1', closes);
    service.seedPortfolio({
      positions: [{ ticker: 'AAA1', direction: 'largo', entry: 100, size: 100 }],
    });

    const decision = service.submitSignal(signal({ ticker: 'BBB1' }));
    expectVeto(decision, 'CORRELATION');
    expect(decision.reasons.map((r) => r.code)).toEqual(['CORRELATION']);
    expect(decision.reasons[0]?.details['ticker']).toBe('AAA1');
  });

  it('LEVERAGE: el nominal bruto supera el capital (apalancamiento fijo 1x)', () => {
    // Cartera de 30 000 con 32 000 ya invertidos en sectores distintos:
    // cada sector queda bajo el 30 % pero el bruto supera el capital.
    service.seedPortfolio({
      equity: 30_000,
      positions: ['L1', 'L2', 'L3', 'L4'].map((ticker, i) => ({
        ticker,
        direction: 'largo' as const,
        entry: 100,
        size: 80,
        sector: `sector-${i}`,
      })),
    });
    seedBars('TLT', [98, 99, 100, 101]);

    const decision = service.submitSignal(signal({ ticker: 'TLT' }));
    expectVeto(decision, 'LEVERAGE');
    expect(decision.reasons.map((r) => r.code)).toEqual(['LEVERAGE']);
  });

  it('LIQUIDITY: sin volumen medio conocido la señal queda vetada', () => {
    const decision = service.submitSignal(signal({ ticker: 'ZZZZ' }));
    expectVeto(decision, 'LIQUIDITY');
    expect(decision.reasons.map((r) => r.code)).toEqual(['LIQUIDITY']);
    expect(decision.reasons[0]?.details['motivo']).toContain('desconocido');
  });

  it('LIQUIDITY: el tamaño supera el % permitido del volumen medio', () => {
    // 100 unidades sobre un volumen medio de 1 000 → 10 % > 1 %.
    seedBars('THIN', [98, 99, 100, 101], 1_000);

    const decision = service.submitSignal(signal({ ticker: 'THIN' }));
    expectVeto(decision, 'LIQUIDITY');
    expect(decision.reasons[0]?.details).toMatchObject({ limite: 1 });
  });
});

// ---------------------------------------------------------------------------
// Cautela por calendario
// ---------------------------------------------------------------------------

describe('auditoría · modo cautela', () => {
  it('CAUTION_MODE reducida: un vencimiento recorta el tamaño a la mitad', () => {
    service.simulateCalendarEvent({
      kind: 'vencimiento',
      title: 'Vencimiento mensual de opciones',
      dateUtc: NOW_ISO,
      impact: 'alto',
    });

    const decision = service.submitSignal(signal());
    expect(decision.status).toBe('reducida');
    expect(decision.sizeFactor).toBe(0.5);
    expect(decision.size).toBe(50);
    expect(decision.reasons[0]?.code).toBe('CAUTION_MODE');
    expect(decision.reasons[0]?.message).toBe('Modo cautela');
    expect(decision.reasons[0]?.details['evento']).toBe('Vencimiento mensual de opciones');
    seenVetoCodes.add('CAUTION_MODE');
    expect(repo.listVetoes({ decision: 'reducida' })).toHaveLength(1);
  });

  it('CAUTION_MODE vetada: un dato de alto impacto bloquea la entrada', () => {
    service.simulateCalendarEvent({
      kind: 'ipc',
      title: 'IPC EE. UU. (auditoría)',
      dateUtc: NOW_ISO,
      impact: 'alto',
    });

    const decision = service.submitSignal(signal());
    expectVeto(decision, 'CAUTION_MODE');
    expect(decision.reasons[0]?.details['evento']).toBe('IPC EE. UU. (auditoría)');
    expect(decision.reasons[0]?.details['causa']).toBe('alto-impacto');
  });
});

// ---------------------------------------------------------------------------
// Parada de emergencia: veto y reanudación
// ---------------------------------------------------------------------------

describe('auditoría · parada de emergencia', () => {
  it('KILL_SWITCH_ACTIVE: la parada manual veta cualquier señal al instante', () => {
    expect(service.submitSignal(signal()).status).toBe('aprobada');

    killSwitch.activate('manual', 'usuario');
    expectActiveKillSwitch('manual');
    expect(pausedAgents).toBe(1);

    const decision = service.submitSignal(signal());
    expectVeto(decision, 'KILL_SWITCH_ACTIVE');
    expect(decision.reasons[0]?.message).toBe('Parada activa');
    expect(decision.reasons[0]?.details['causa']).toBe('manual');
  });

  it('la reanudación exige confirmación explícita y vuelve a evaluar', () => {
    killSwitch.activate('manual', 'usuario');

    // Sin confirmación el servicio rechaza la reanudación.
    expect(() => killSwitch.resume({ confirm: false } as never)).toThrow(KillSwitchError);
    expect(killSwitch.getState().active).toBe(true);
    expectVeto(service.submitSignal(signal()), 'KILL_SWITCH_ACTIVE');

    const state = killSwitch.resume({ confirm: true, note: 'revisado' });
    expect(state.active).toBe(false);
    expect(resumedAgents).toBe(1);
    expect(lastKillSwitchEvent()).toMatchObject({ accion: 'reanudada', actor: 'usuario' });
    // La causa de la última activación queda visible tras reanudar.
    expect(state.cause).toBe('manual');

    expect(service.submitSignal(signal()).status).toBe('aprobada');
  });

  it('la activación es idempotente y notifica una sola vez', () => {
    killSwitch.activate('manual', 'usuario');
    killSwitch.activate('perdida-anomala', 'automatico');

    expect(killSwitch.getState().cause).toBe('manual');
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      level: 'critica',
      title: 'Tradia ha activado la parada',
      navigateTo: 'riesgo',
    });
    const events = db
      .prepare(`SELECT COUNT(*) AS n FROM kill_switch_events WHERE accion = 'activada'`)
      .get() as { n: number };
    expect(events.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Causas automáticas de la parada
// ---------------------------------------------------------------------------

describe('auditoría · causas automáticas de la parada', () => {
  it('perdida-anomala: pérdida diaria ≥ 1,5 × límite activa la parada', () => {
    // 3,5 % ≥ 1,5 × 2 %: la parada se dispara en medio de la evaluación.
    service.seedPortfolio({
      equity: 96_500,
      equityHistory: [{ at: '2026-10-09T00:00:00.000Z', equity: 100_000 }],
    });

    const decision = service.submitSignal(signal());
    expectVeto(decision, 'KILL_SWITCH_ACTIVE');
    expect(decision.reasons[0]?.details['causa']).toBe('perdida-anomala');
    expectActiveKillSwitch('perdida-anomala');
    expect(killSwitch.getState().actor).toBe('automatico');
    expect(notifications.at(-1)?.level).toBe('critica');
  });

  it('dato-anomalo: un salto de precio ≥ 20 % activa la parada', () => {
    // Último rendimiento diario del 25 % en el propio activo de la señal.
    seedBars('JUMP', [100, 100, 100, 125]);

    const decision = service.submitSignal(signal({ ticker: 'JUMP' }));
    expectVeto(decision, 'KILL_SWITCH_ACTIVE');
    expectActiveKillSwitch('dato-anomalo');
    expect(killSwitch.getState().detail).toContain('JUMP');
  });

  it('dato-anomalo: un data-status no fiable también activa la parada', () => {
    killSwitch.observeDataStatus({
      key: 'ticker:AAPL',
      state: 'no-fiable',
      lastOkAt: NOW_ISO,
      consecutiveFailures: 3,
      reason: 'valores anómalos',
      updatedAt: NOW_ISO,
    });

    expectActiveKillSwitch('dato-anomalo');
    expectVeto(service.submitSignal(signal()), 'KILL_SWITCH_ACTIVE');
  });

  it('sin-conexion: 60 s sin conexión activa la parada y no se reanuda sola', () => {
    connectivity = { ...connectivity, status: 'offline' };
    killSwitch.checkConnectivity();
    expect(killSwitch.getState().active).toBe(false);

    nowMs += 61_000; // más de KILL_SWITCH_OFFLINE_SECONDS sin conexión
    killSwitch.checkConnectivity();
    expectActiveKillSwitch('sin-conexion');
    expectVeto(service.submitSignal(signal()), 'KILL_SWITCH_ACTIVE');

    // Aunque vuelva la conexión, la parada no se levanta sola.
    connectivity = { ...connectivity, status: 'online', attempt: 0 };
    killSwitch.checkConnectivity();
    expect(killSwitch.getState().active).toBe(true);
  });

  it('modelo-erratico: una ráfaga de más de 20 señales/hora activa la parada', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(service.submitSignal(signal()).status).toBe('aprobada');
    }
    const decision = service.submitSignal(signal());
    expectVeto(decision, 'KILL_SWITCH_ACTIVE');
    expectActiveKillSwitch('modelo-erratico');
    expect(killSwitch.getState().detail).toContain('ráfaga');
  });

  it('modelo-erratico: 5 señales inválidas seguidas activan la parada', () => {
    for (let i = 0; i < 4; i += 1) {
      service.submitSignal(signal({ entry: -1 }));
      expect(killSwitch.getState().active).toBe(false);
    }
    service.submitSignal(signal({ entry: -1 }));
    expectActiveKillSwitch('modelo-erratico');
    expect(killSwitch.getState().detail).toContain('inválidas');
  });
});

// ---------------------------------------------------------------------------
// Cobertura del contrato
// ---------------------------------------------------------------------------

describe('auditoría · cobertura del contrato', () => {
  it('la batería ejercita cada código de veto y cada causa de parada', () => {
    for (const code of VETO_REASON_CODES) {
      expect(seenVetoCodes, `falta escenario de veto ${code}`).toContain(code);
    }
    for (const cause of KILL_SWITCH_CAUSES) {
      expect(seenCauses, `falta escenario de parada ${cause}`).toContain(cause);
    }
  });
});
