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
  type CautionState,
  type KillSwitchState,
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
import type { ServiceContext } from '../services';
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

export const RISK_SERVICE_ERROR_CODES = ['limites-invalidos', 'limites-fuera-de-margen'] as const;
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
  stop(): void;
}

export function createRiskService(deps: RiskServiceDeps): RiskService {
  const now = deps.now ?? (() => Date.now());

  const caution = (): CautionState => deps.cautionSource.evaluate(now());

  const overview = (): RiskOverview => ({
    limits: deps.repo.getLimits(),
    killSwitch: deps.killSwitch.getState(),
    caution: caution(),
  });

  const emitChanged = (): void => {
    deps.broadcast(IPC_CHANNELS.risk.changed, overview());
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

    stop: () => {
      deps.cautionSource.clearSimulatedEvents();
    },
  };
}

// ---------------------------------------------------------------------------
// Registro en la app
// ---------------------------------------------------------------------------

export function registerRisk(ctx: ServiceContext): RiskService {
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
  });

  // La parada completa su risk:changed con límites y cautela reales.
  killSwitch?.setOverviewExtras(() => ({
    limits: repo.getLimits(),
    caution: cautionSource.evaluate(Date.now()),
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
