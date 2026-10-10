/**
 * Servicio del motor de riesgo (fase 3) — registro IPC y cableado.
 *
 * `createRiskService` es el núcleo testeable (todo inyectado: repositorio,
 * fuente de cautela, parada y difusión). `registerRisk` lo monta sobre la
 * base de datos real y registra los handlers:
 *
 * - `risk:get-limits` / `risk:set-limits`: los límites solo entran por
 *   aquí; `setLimits` valida los márgenes duros en el proceso principal y
 *   rechaza con un error legible que la pantalla muestra literalmente.
 * - `risk:list-vetoes`: registro con paginación (`limit`/`offset`) y
 *   filtro por regla, decisión o activo.
 * - `risk:submit-signal`: la pasarela única (`engine.ts`).
 * - `risk:get-caution`: estado de cautela de la vista global.
 * - Ganchos E2E (solo TRADIA_E2E sin empaquetar, como `simulateOffline`):
 *   `risk:simulate-calendar-event` y `risk:seed-portfolio`. El de la
 *   parada (`risk:simulate-cause`) lo registra `killSwitch.ts`.
 *
 * Al registrarse instala en la parada los `overviewExtras` reales
 * (límites del repositorio y cautela evaluada) para que `risk:changed`
 * no emita los valores por defecto, y emite `risk:changed` propio cuando
 * cambian los límites o entra un evento de calendario simulado.
 */

import { app, ipcMain } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isE2eEnabled,
  isRiskVetoesQuery,
  isSeedPortfolioRequest,
  isSignalIntent,
  isSimulateCalendarEventRequest,
  RISK_BOUNDS,
  riskLimitViolations,
  SIGNAL_DIRECTIONS,
  type CautionState,
  type ExposureSlice,
  type KillSwitchState,
  type PaperPortfolioOverview,
  type PaperPosition,
  type RiskDecision,
  type RiskLimits,
  type RiskOverview,
  type RiskVeto,
  type RiskVetoesQuery,
  type SeedPortfolioRequest,
  type SeedPortfolioResult,
  type SignalIntent,
  type SimulateCalendarEventRequest,
} from '../../shared/ipc';
import { openDatabase } from '../db/database';
import { TICKER_PATTERN } from '../market/providers/types';
import type { ServiceContext } from '../services';
import {
  drawdownPct,
  lossPctSince,
  pctOfEquity,
  periodStartUtc,
  TRADIA_UNIVERSE_SECTORS,
  UNIVERSE_CURRENCY,
  UNKNOWN_SECTOR,
  type LossPeriod,
  type NewPaperPosition,
  type PaperCloseRequest,
  type PaperCloseResult,
  type PaperPositionRecord,
  type PaperRiskState,
} from './portfolio';
import {
  createCautionContextSource,
  type CautionContextSource,
  type CautionEvent,
} from './caution';
import { createRiskEngine } from './engine';
import type { KillSwitchService } from './killSwitch';
import { createRiskRepository, type RiskRepository } from './repository';

// ---------------------------------------------------------------------------
// Errores y etiquetas legibles
// ---------------------------------------------------------------------------

export const RISK_SERVICE_ERROR_CODES = [
  'limites-invalidos',
  'limites-fuera-de-margen',
  'posicion-invalida',
] as const;
export type RiskServiceErrorCode = (typeof RISK_SERVICE_ERROR_CODES)[number];

export class RiskServiceError extends Error {
  readonly code: RiskServiceErrorCode;

  constructor(code: RiskServiceErrorCode, message: string) {
    super(message);
    this.name = 'RiskServiceError';
    this.code = code;
  }
}

/** Etiqueta legible de cada límite para el error en línea de la pantalla. */
export const RISK_LIMIT_LABELS: Record<keyof RiskLimits, string> = {
  riskPerTradePct: 'riesgo por operación (%)',
  minRewardRiskRatio: 'ratio beneficio/riesgo mínimo',
  maxDailyLossPct: 'pérdida diaria máxima (%)',
  maxWeeklyLossPct: 'pérdida semanal máxima (%)',
  maxMonthlyLossPct: 'pérdida mensual máxima (%)',
  maxDrawdownPct: 'drawdown máximo (%)',
  maxOpenPositions: 'posiciones abiertas máximas',
  maxAssetExposurePct: 'exposición por activo (%)',
  maxSectorExposurePct: 'exposición por sector (%)',
  maxCurrencyExposurePct: 'exposición por divisa (%)',
  maxCorrelation: 'correlación máxima',
  maxLeverage: 'apalancamiento',
  maxLiquidityPct: 'límite de liquidez (%)',
};

const formatBound = (value: number): string => String(value).replace('.', ',');

/**
 * Valida un objeto de límites completo en el proceso principal: forma
 * (todas las claves, ninguna extra, números finitos) y márgenes duros.
 * Rechaza con `RiskServiceError` cuyo mensaje enumera cada violación en
 * lenguaje legible; la pantalla lo muestra literalmente.
 */
export function assertRiskLimits(input: unknown): asserts input is RiskLimits {
  if (typeof input !== 'object' || input === null) {
    throw new RiskServiceError('limites-invalidos', 'los límites no son un objeto');
  }
  const record = input as Record<string, unknown>;
  const keys = Object.keys(RISK_BOUNDS) as (keyof RiskLimits)[];
  const unknown = Object.keys(record).filter((k) => !keys.includes(k as keyof RiskLimits));
  if (unknown.length > 0) {
    throw new RiskServiceError('limites-invalidos', `límites desconocidos: ${unknown.join(', ')}`);
  }
  const missing = keys.filter(
    (key) => typeof record[key] !== 'number' || !Number.isFinite(record[key]),
  );
  if (missing.length > 0) {
    throw new RiskServiceError(
      'limites-invalidos',
      `faltan límites o no son numéricos: ${missing.map((k) => RISK_LIMIT_LABELS[k]).join(', ')}`,
    );
  }
  const violations = riskLimitViolations(input as RiskLimits);
  if (violations.length > 0) {
    const detail = violations
      .map(
        (v) =>
          `${RISK_LIMIT_LABELS[v.key]} fuera de margen: ${formatBound(v.value)} ` +
          `(permitido ${formatBound(v.min)}–${formatBound(v.max)})`,
      )
      .join('; ');
    throw new RiskServiceError('limites-fuera-de-margen', detail);
  }
}

// ---------------------------------------------------------------------------
// Núcleo del servicio (sin Electron)
// ---------------------------------------------------------------------------

export interface RiskServiceDeps {
  repo: RiskRepository;
  cautionSource: CautionContextSource;
  killSwitch: KillSwitchService;
  broadcast(channel: string, payload: unknown): void;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
}

export interface RiskService {
  /** Pasarela única: evalúa la señal y devuelve la decisión del motor. */
  submitSignal(signal: SignalIntent): RiskDecision;
  /** Límites vigentes (RISK_DEFAULTS si el usuario nunca los cambió). */
  getLimits(): RiskLimits;
  /**
   * Sustituye los límites tras validar los márgenes duros. Rechaza con
   * `RiskServiceError` legible los valores fuera de margen.
   */
  setLimits(limits: unknown): RiskLimits;
  /** Registro de vetos con filtros y paginación del contrato. */
  listVetoes(query?: RiskVetoesQuery): RiskVeto[];
  /** Estado de cautela de la vista global (sin activo concreto). */
  getCaution(): CautionState;
  /** Siembra E2E de la cartera simulada. */
  seedPortfolio(request: SeedPortfolioRequest): SeedPortfolioResult;
  /** Gancho E2E: inyecta un evento y devuelve la cautela resultante. */
  simulateCalendarEvent(event: SimulateCalendarEventRequest): CautionState;
  /**
   * Cartera simulada para el panel (`risk:get-portfolio`): posiciones con
   * marca, P&L no realizado, drawdown y pérdida diaria frente a su límite
   * y exposición por activo y por sector.
   */
  getPortfolio(): PaperPortfolioOverview;
  /**
   * Abre una posición simulada a partir de una señal aprobada (el
   * seguimiento de `signals/paper.ts` la llama; nunca envía orden real).
   * Rechaza datos inválidos con `RiskServiceError` 'posicion-invalida'.
   */
  openPaperPosition(input: NewPaperPosition): PaperPositionRecord;
  /** Posiciones abiertas de la cartera simulada, opcionalmente de un activo. */
  listPaperPositions(ticker?: string): PaperPositionRecord[];
  /**
   * Liquida una posición simulada: anota el P&L en la curva de capital y
   * cierra la fila. Devuelve null si no existe o ya estaba cerrada.
   */
  closePaperPosition(request: PaperCloseRequest): PaperCloseResult | null;
  /** Pérdidas por periodo y drawdown de la cartera (límites del seguimiento). */
  getPaperRiskState(): PaperRiskState;
  stop(): void;
}

export function createRiskService(deps: RiskServiceDeps): RiskService {
  const now = deps.now ?? (() => Date.now());
  const isoNow = (): string => new Date(now()).toISOString();
  const round2 = (value: number): number => Math.round(value * 100) / 100;

  const caution = (): CautionState => deps.cautionSource.evaluate(now());

  const overview = (): RiskOverview => ({
    limits: deps.repo.getLimits(),
    killSwitch: deps.killSwitch.getState(),
    caution: caution(),
  });

  const emitChanged = (): void => {
    deps.broadcast(IPC_CHANNELS.risk.changed, overview());
  };

  // -- Cartera simulada (fase 4): seguimiento y lectura para el panel ---------

  const paperRiskState = (): PaperRiskState => {
    const snapshot = deps.repo.buildSnapshot(isoNow());
    const lossPct = (period: LossPeriod): number => {
      const start = periodStartUtc(snapshot.now, period);
      return start === null
        ? 0
        : lossPctSince(snapshot.equityHistory, snapshot.equity, start.toISOString());
    };
    return {
      equity: snapshot.equity,
      dailyLossPct: lossPct('day'),
      weeklyLossPct: lossPct('week'),
      monthlyLossPct: lossPct('month'),
      drawdownPct: drawdownPct(snapshot.equityHistory, snapshot.equity),
    };
  };

  const invalidPosition = (message: string): RiskServiceError =>
    new RiskServiceError('posicion-invalida', message);

  const assertFinitePositive = (value: number, name: string): void => {
    if (!Number.isFinite(value) || value <= 0) {
      throw invalidPosition(`${name} debe ser un número finito mayor que 0`);
    }
  };

  const exposureSlices = (
    positions: readonly PaperPosition[],
    equity: number,
    keyOf: (position: PaperPosition) => string,
    limitPct: number,
  ): ExposureSlice[] => {
    const totals = new Map<string, number>();
    for (const position of positions) {
      const notional = Math.abs(position.size * (position.markPrice ?? position.entry));
      totals.set(keyOf(position), (totals.get(keyOf(position)) ?? 0) + notional);
    }
    return [...totals.entries()]
      .map(([key, notional]) => ({
        key,
        notional: round2(notional),
        pct: round2(pctOfEquity(notional, equity)),
        limitPct,
      }))
      .sort((a, b) => b.pct - a.pct);
  };

  const engine = createRiskEngine({
    getLimits: () => deps.repo.getLimits(),
    getKillSwitchState: () => deps.killSwitch.getState(),
    observeSignal: (signal) => deps.killSwitch.observeSignal(signal),
    observeDailyLoss: (lossPct) => deps.killSwitch.observeDailyLoss(lossPct),
    observeDrawdown: (dd) => deps.killSwitch.observeDrawdown(dd),
    observePriceJump: (ticker, changePct) => deps.killSwitch.observePriceJump(ticker, changePct),
    getSnapshot: (extraTickers) =>
      deps.repo.buildSnapshot(new Date(now()).toISOString(), extraTickers),
    evaluateCaution: (ticker) => deps.cautionSource.evaluate(now(), ticker),
    recordVeto: (record) => deps.repo.appendVeto(record),
    emitVetoed: (veto) => deps.broadcast(IPC_CHANNELS.risk.vetoed, veto),
    now,
  });

  return {
    submitSignal: (signal) => engine.submitSignal(signal),

    getLimits: () => deps.repo.getLimits(),

    setLimits: (input) => {
      assertRiskLimits(input);
      const saved = deps.repo.setLimits(input);
      emitChanged();
      return saved;
    },

    listVetoes: (query) => deps.repo.listVetoes(query),

    getCaution: caution,

    seedPortfolio: (request) => deps.repo.seedPortfolio(request, new Date(now()).toISOString()),

    simulateCalendarEvent: (event) => {
      const cautionEvent: CautionEvent = { ...event, asset: event.asset ?? null };
      deps.cautionSource.addSimulatedEvent(cautionEvent);
      emitChanged();
      return caution();
    },

    getPortfolio: () => {
      const nowIso = isoNow();
      const snapshot = deps.repo.buildSnapshot(nowIso);
      const limits = deps.repo.getLimits();
      const state = paperRiskState();
      const marks = new Map(snapshot.positions.map((p) => [p.ticker, p.markPrice]));
      const positions: PaperPosition[] = deps.repo.listPaperPositions().map((row) => {
        const mark = marks.get(row.ticker) ?? null;
        const sign = row.direction === 'largo' ? 1 : -1;
        return {
          id: row.id,
          ticker: row.ticker,
          direction: row.direction,
          size: row.size,
          entry: row.entry,
          markPrice: mark,
          pnl: mark === null ? null : round2((mark - row.entry) * row.size * sign),
          pnlPct:
            mark === null || !(row.entry > 0)
              ? null
              : round2(((mark - row.entry) / row.entry) * 100 * sign),
          sector: row.sector ?? TRADIA_UNIVERSE_SECTORS[row.ticker] ?? null,
          currency: row.currency,
          signalId: row.signalId,
          openedAt: row.openedAt,
        };
      });
      return {
        equity: snapshot.equity,
        currency: UNIVERSE_CURRENCY,
        positions,
        drawdownPct: state.drawdownPct,
        drawdownLimitPct: limits.maxDrawdownPct,
        dailyLossPct: state.dailyLossPct,
        dailyLossLimitPct: limits.maxDailyLossPct,
        exposureByAsset: exposureSlices(
          positions,
          snapshot.equity,
          (p) => p.ticker,
          limits.maxAssetExposurePct,
        ),
        exposureBySector: exposureSlices(
          positions,
          snapshot.equity,
          (p) => p.sector ?? UNKNOWN_SECTOR,
          limits.maxSectorExposurePct,
        ),
        openPositions: positions.length,
        maxOpenPositions: limits.maxOpenPositions,
        updatedAt: nowIso,
      };
    },

    openPaperPosition: (input) => {
      const ticker = input.ticker.trim().toUpperCase();
      if (!TICKER_PATTERN.test(ticker)) {
        throw invalidPosition(`activo inválido: ${input.ticker}`);
      }
      if (!(SIGNAL_DIRECTIONS as readonly string[]).includes(input.direction)) {
        throw invalidPosition(`dirección inválida: ${input.direction}`);
      }
      assertFinitePositive(input.entry, 'la entrada');
      assertFinitePositive(input.size, 'el tamaño');
      if (input.stop !== null) assertFinitePositive(input.stop, 'el stop');
      if (input.target !== null) assertFinitePositive(input.target, 'el objetivo');
      if (input.signalId !== null && !(Number.isInteger(input.signalId) && input.signalId > 0)) {
        throw invalidPosition('senal_id debe ser un entero positivo');
      }
      if (input.openedOnBar !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.openedOnBar)) {
        throw invalidPosition('vela_apertura debe tener formato YYYY-MM-DD');
      }
      return deps.repo.openPaperPosition({
        ...input,
        ticker,
        sector: input.sector ?? TRADIA_UNIVERSE_SECTORS[ticker] ?? null,
        currency: input.currency || UNIVERSE_CURRENCY,
      });
    },

    listPaperPositions: (ticker) => deps.repo.listPaperPositions(ticker),

    closePaperPosition: (request) => {
      if (!Number.isInteger(request.positionId) || request.positionId <= 0) {
        throw invalidPosition('positionId debe ser un entero positivo');
      }
      assertFinitePositive(request.exit, 'la salida');
      return deps.repo.settlePaperPosition(request);
    },

    getPaperRiskState: paperRiskState,

    stop: () => {
      deps.cautionSource.clearSimulatedEvents();
    },
  };
}

// ---------------------------------------------------------------------------
// Registro en la app
// ---------------------------------------------------------------------------

export function registerRisk(
  ctx: ServiceContext,
  options: { now?: () => number } = {},
): RiskService {
  // Mismo patrón de degradación que registerKillSwitch: sin base de datos
  // el motor funciona en memoria y la app sigue arrancando.
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[risk] almacén no disponible: el motor de riesgo solo vivirá en memoria');
    db = openDatabase(':memory:');
  }
  const repo = createRiskRepository(db);

  const cautionSource = createCautionContextSource({
    listEvents: (desde, hasta) =>
      (ctx.services.calendar?.list({ desde, hasta }) ?? []).map((event): CautionEvent => ({
        kind: event.kind,
        title: event.title,
        dateUtc: event.dateUtc,
        impact: event.impact,
        asset: event.asset,
      })),
    getPortfolioTickers: () => repo.openTickers(),
    getVix: () => repo.lastVix(),
  });

  const killSwitch = ctx.services.killSwitch;
  if (!killSwitch) {
    console.error('[risk] parada de emergencia no registrada: el motor evalúa sin veto total');
  }

  const service = createRiskService({
    repo,
    cautionSource,
    killSwitch: killSwitch ?? createNullKillSwitch(),
    broadcast: (channel, payload) => ctx.broadcast(channel, payload),
    // La app la evalúa con el reloj de mercado: así la cautela (festivos,
    // apertura, eventos) se decide sobre el instante simulado en E2E y es
    // el tiempo real en producción (sin desfase, offset 0).
    now: options.now,
  });

  const overviewNow = options.now ?? (() => Date.now());
  // La parada completa su risk:changed con límites y cautela reales.
  killSwitch?.setOverviewExtras(() => ({
    limits: repo.getLimits(),
    caution: cautionSource.evaluate(overviewNow()),
  }));

  ipcMain.handle(IPC_CHANNELS.risk.getLimits, () => service.getLimits());
  ipcMain.handle(IPC_CHANNELS.risk.setLimits, (_event, limits: unknown) =>
    service.setLimits(limits),
  );
  ipcMain.handle(IPC_CHANNELS.risk.listVetoes, (_event, query: unknown) => {
    if (!isRiskVetoesQuery(query)) {
      throw new IpcValidationError(
        IPC_CHANNELS.risk.listVetoes,
        'se esperaba {rule?, decision?, ticker?, limit?, offset?}',
      );
    }
    return service.listVetoes(query);
  });
  ipcMain.handle(IPC_CHANNELS.risk.submitSignal, (_event, signal: unknown) => {
    if (!isSignalIntent(signal)) {
      throw new IpcValidationError(IPC_CHANNELS.risk.submitSignal, 'se esperaba SignalIntent');
    }
    return service.submitSignal(signal);
  });
  ipcMain.handle(IPC_CHANNELS.risk.getCaution, () => service.getCaution());
  ipcMain.handle(IPC_CHANNELS.risk.getPortfolio, () => service.getPortfolio());

  // Ganchos E2E: la app empaquetada no los registra (mismo patrón que
  // simulateOffline y risk:simulate-cause de killSwitch).
  if (isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E)) {
    ipcMain.handle(IPC_CHANNELS.risk.simulateCalendarEvent, (_event, event: unknown) => {
      if (!isSimulateCalendarEventRequest(event)) {
        throw new IpcValidationError(
          IPC_CHANNELS.risk.simulateCalendarEvent,
          'se esperaba {kind, title, dateUtc, impact, asset?}',
        );
      }
      return service.simulateCalendarEvent(event);
    });
    ipcMain.handle(IPC_CHANNELS.risk.seedPortfolio, (_event, request: unknown) => {
      if (!isSeedPortfolioRequest(request)) {
        throw new IpcValidationError(
          IPC_CHANNELS.risk.seedPortfolio,
          'se esperaba {equity?, positions?, equityHistory?}',
        );
      }
      return service.seedPortfolio(request);
    });
  }

  return service;
}

/**
 * Parada inerte cuando `killSwitch` no está registrado (arranque
 * degradado): nunca vetada, nunca activa. La pasarela sigue evaluando el
 * resto de reglas.
 */
function createNullKillSwitch(): KillSwitchService {
  const inactive: KillSwitchState = {
    active: false,
    cause: null,
    actor: null,
    activatedAt: null,
    detail: null,
  };
  return {
    getState: () => ({ ...inactive }),
    activate: () => ({ ...inactive }),
    resume: () => ({ ...inactive }),
    observeDailyLoss: () => undefined,
    observeDrawdown: () => undefined,
    observeDataStatus: () => undefined,
    observePriceJump: () => undefined,
    observeSignal: () => undefined,
    checkConnectivity: () => undefined,
    setOverviewExtras: () => undefined,
    onChanged: () => () => undefined,
    start: () => undefined,
    stop: () => undefined,
  };
}
