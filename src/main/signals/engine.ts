/**
 * Motor de señales programado al cierre de vela — Fase 4 (núcleo puro).
 *
 * `createSignalEngine` es testeable sin Electron: todo lo externo va
 * inyectado (datos de mercado, fichas e implementaciones de estrategias,
 * pasarela de riesgo, diario, difusión, guardas y reloj). `index.ts` lo
 * cablea en la app.
 *
 * Reglas de negocio (ver docs/senales.md):
 * - Disparo: cada vela nueva guardada de un activo del seguimiento (evento
 *   interno `onBarsStored` de market/ingestion) evalúa las estrategias en
 *   estado 'activa' o 'paper' que cubren ese activo, con su versión
 *   vigente y los mismos módulos ejecutables del backtest (sonda de
 *   `probe.ts`).
 * - Guardas: no evalúa con los agentes en pausa, sin conexión ni con la
 *   parada de emergencia activa.
 * - Agregación por activo: una propuesta 'buy' vota 'largo' y una 'sell'
 *   vota 'corto'. Si las estrategias se contradicen no hay señal: va al
 *   diario como 'contradiccion'. Si coinciden, una señal con la confianza
 *   media de los votos.
 * - Confianza de cada voto: la tasa de acierto del backtest
 *   representativo de la versión (`winRatePct` / 100, acotada a 0–1) o
 *   `SIGNAL_DEFAULT_CONFIDENCE` cuando la versión aún no tiene métricas.
 * - Toda señal pasa por la pasarela única `risk:submit-signal`
 *   (`deps.submitSignal`, que es `services.risk.submitSignal`): ninguna
 *   otra puerta existe para llegar al motor de riesgo.
 * - Persistencia en `signals`: votos con versión, datos usados (ventana,
 *   lote y versión limpia, fuente), motivo, confianza y decisión
 *   completa. Idempotente: (ticker, vela_fecha) no produce dos filas.
 * - Emite `signals:new` (por el `broadcast` perezoso, que delivery
 *   intercepta para los avisos) y registra la entrada del diario.
 */
import type { Strategy as ExecutableStrategy } from '../backtest/types';
import { DEFAULT_MAX_POSITIONS } from '../backtest/types';
import type { SessionDate } from '../market/providers/types';
import { TICKER_PATTERN } from '../market/providers/types';
import type {
  JournalRecordInput,
  JournalResult,
  JournalRuleCheck,
  JournalStrategyRef,
} from '../../shared/journal';
import type { MarketUpdatedEvent } from '../../shared/ipc';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { RiskDecision, SignalDirection, SignalIntent } from '../../shared/risk';
import type {
  Signal,
  SignalDataUsed,
  SignalEngineRunResult,
  SignalNewEvent,
  SignalStrategyOutcome,
  SignalStrategyState,
  SignalStrategyVote,
  SignalsListQuery,
} from '../../shared/signals';
import type { Strategy } from '../../shared/strategy';
import { collectLastBarOrders } from './probe';
import type { NewSignal, SignalsRepository } from './repository';

// ---------------------------------------------------------------------------
// Dependencias
// ---------------------------------------------------------------------------

/** Confianza de un voto cuando la versión aún no tiene métricas de backtest. */
export const SIGNAL_DEFAULT_CONFIDENCE = 0.5;
/** Tope de marcas de «vela ya evaluada» conservadas en settings. */
export const SIGNAL_PROCESSED_MARKS_LIMIT = 2_000;
/** Tope de caracteres del motivo por voto y del motivo agregado. */
export const SIGNAL_REASON_MAX_LENGTH = 400;

/** Estrategia evaluable: ficha vigente + factoría de su implementación. */
export interface EvaluableStrategy {
  ficha: Strategy;
  /** Devuelve una instancia fresca de la implementación (init propio). */
  create(): ExecutableStrategy;
}

/** Vela almacenada tal como la necesita la sonda. */
export interface SignalSourceBar {
  date: SessionDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Lote del que procede la vela. */
  batchId: number;
  /** Fuente (proveedor) de la vela. */
  source: string;
}

export interface SignalEngineLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface SignalEngineDeps {
  repo: SignalsRepository;
  /** Estrategias 'activa'/'paper' ejecutables, reevaluadas en cada pasada. */
  listEvaluables(): EvaluableStrategy[];
  /** Tickers del seguimiento (watchlist). */
  listWatchlistTickers(): string[];
  /**
   * Velas del ticker hasta `hasta` inclusive, de la fuente preferida si la
   * tiene, si no de su fuente más reciente (una sola fuente por serie).
   */
  barsFor(ticker: string, hasta: SessionDate, preferSource: string | null): SignalSourceBar[];
  /** Fecha de la última vela guardada del ticker (de su fuente más reciente). */
  lastBarDate(ticker: string): SessionDate | null;
  /** Versión limpia del lote (`data_batches.version`); null si no consta. */
  getBatchVersion(batchId: number): number | null;
  /** Pasarela única del motor de riesgo (`services.risk.submitSignal`). */
  submitSignal(intent: SignalIntent): RiskDecision;
  /** Entrada del diario automático (`services.journal.record`). */
  recordJournal(input: JournalRecordInput): void;
  /** `ctx.broadcast` perezoso (delivery lo intercepta para los avisos). */
  broadcast(channel: string, payload: unknown): void;
  /** Guardas: agentes en pausa / sin conexión / parada activa. */
  isAgentsPaused(): boolean;
  isOffline(): boolean;
  isKillSwitchActive(): boolean;
  /** Marcas persistentes de «vela ya evaluada» (deduplicación). */
  wasProcessed(ticker: string, barDate: SessionDate): boolean;
  markProcessed(ticker: string, barDate: SessionDate): void;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
  logger?: Partial<SignalEngineLogger>;
}

// ---------------------------------------------------------------------------
// Resultados internos
// ---------------------------------------------------------------------------

export type TickerEvaluationOutcome =
  | 'emitted'
  | 'contradiction'
  | 'no-votes'
  | 'already-processed'
  | 'blocked';

export interface SignalEngine {
  /** Entrada del evento interno «vela guardada» de market/ingestion. */
  handleBarStored(event: MarketUpdatedEvent): void;
  /** Evalúa un activo al cierre de su vela `barDate`; idempotente. */
  evaluateTicker(
    ticker: string,
    barDate: SessionDate,
    preferSource?: string | null,
  ): TickerEvaluationOutcome;
  /** Pasada completa sobre la lista de seguimiento (gancho de desarrollo). */
  evaluateNow(): SignalEngineRunResult;
  /** Estado de evaluación por estrategia para `signals:strategies`. */
  listStrategyStates(): SignalStrategyState[];
  /** Lectura para `signals:list`/`signals:get`. */
  listSignals(query?: SignalsListQuery): Signal[];
  getSignal(id: number): Signal | null;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Utilidades de dominio
// ---------------------------------------------------------------------------

/** Tickers ejecutables de la ficha (misma regla que backtest/service.ts). */
export function executableMarkets(markets: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const market of markets) {
    const ticker = market.trim().toUpperCase();
    if (TICKER_PATTERN.test(ticker)) seen.add(ticker);
  }
  return [...seen];
}

const clampConfidence = (value: number): number => Math.min(1, Math.max(0, value));

/** Confianza del voto: tasa de acierto del backtest representativo, o 0,5. */
export function voteConfidence(ficha: Strategy): number {
  const winRatePct = ficha.metricsSummary?.winRatePct;
  if (typeof winRatePct !== 'number' || !Number.isFinite(winRatePct)) {
    return SIGNAL_DEFAULT_CONFIDENCE;
  }
  return clampConfidence(winRatePct / 100);
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** Motivo legible del voto: la regla de la ficha que explica la propuesta. */
export function voteReason(ficha: Strategy, kind: 'buy' | 'sell'): string {
  const rule = kind === 'buy' ? ficha.rules.entry : ficha.rules.exit;
  return truncate(rule.trim().replace(/\s+/g, ' '), SIGNAL_REASON_MAX_LENGTH);
}

/** Motivo agregado: razones distintas unidas, acotado. */
function aggregateReason(votes: readonly SignalStrategyVote[]): string {
  const unique = [...new Set(votes.map((vote) => vote.reason))];
  return truncate(unique.join(' · '), SIGNAL_REASON_MAX_LENGTH * 2);
}

/** Stop agregado prudente: largo → el más bajo; corto → el más alto. */
function aggregateStop(direction: SignalDirection, stops: number[]): number | null {
  if (stops.length === 0) return null;
  return direction === 'largo' ? Math.min(...stops) : Math.max(...stops);
}

/** Objetivo agregado prudente: el más cercano a la entrada en ambos casos. */
function aggregateTarget(direction: SignalDirection, targets: number[]): number | null {
  if (targets.length === 0) return null;
  return direction === 'largo' ? Math.min(...targets) : Math.max(...targets);
}

const toStrategyRef = (vote: SignalStrategyVote): JournalStrategyRef => ({
  strategyId: vote.strategyId,
  name: vote.name,
  version: vote.version,
});

function riskRuleChecks(decision: RiskDecision): JournalRuleCheck[] {
  return decision.reasons.map((reason) => {
    const details = Object.entries(reason.details);
    const limitEntry = details.find(([key]) => key === 'limite');
    const observed = details
      .filter(([key]) => key !== 'limite' && key !== 'desde')
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(', ');
    return {
      code: reason.code,
      label: reason.message,
      cumplida: false,
      observed: observed === '' ? null : observed,
      limit: limitEntry === undefined ? null : String(limitEntry[1]),
    };
  });
}

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------

export function createSignalEngine(deps: SignalEngineDeps): SignalEngine {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());
  const isoNow = (): string => new Date(now()).toISOString();

  let stopped = false;
  /** Última evaluación por estrategia (bloque «Estrategias» del panel). */
  const strategyStates = new Map<
    number,
    {
      lastBarDate: SessionDate;
      lastEvaluatedAt: string;
      lastOutcome: SignalStrategyOutcome;
      lastSignalId: number | null;
    }
  >();

  const markState = (
    strategyId: number,
    barDate: SessionDate,
    outcome: SignalStrategyOutcome,
    signalId: number | null,
  ): void => {
    strategyStates.set(strategyId, {
      lastBarDate: barDate,
      lastEvaluatedAt: isoNow(),
      lastOutcome: outcome,
      lastSignalId: signalId,
    });
  };

  const blocked = (): boolean =>
    deps.isAgentsPaused() || deps.isOffline() || deps.isKillSwitchActive();

  const recordJournal = (input: JournalRecordInput): void => {
    try {
      deps.recordJournal(input);
    } catch (error: unknown) {
      logger.warn?.(`[signals] no se pudo escribir en el diario: ${String(error)}`);
    }
  };

  /** Los votos de una estrategia sobre el activo al cierre de `barDate`. */
  const collectVotes = (
    evaluable: EvaluableStrategy,
    ticker: string,
    barDate: SessionDate,
    preferSource: string | null,
  ): SignalStrategyVote[] => {
    const markets = executableMarkets(evaluable.ficha.markets);
    const bars: Record<string, readonly SignalSourceBar[]> = {};
    for (const market of markets) {
      const rows = deps.barsFor(market, barDate, preferSource);
      if (rows.length > 0) bars[market] = rows;
    }
    if (!(ticker in bars)) return [];

    const topN = evaluable.ficha.parameters['topN'];
    const orders = collectLastBarOrders({
      strategy: evaluable.create(),
      params: evaluable.ficha.parameters,
      bars,
      maxPositions:
        Number.isInteger(topN) && (topN as number) >= 1
          ? (topN as number)
          : DEFAULT_MAX_POSITIONS,
    });

    const confidence = voteConfidence(evaluable.ficha);
    return orders
      .filter((order) => order.ticker === ticker)
      .map(
        (order): SignalStrategyVote => ({
          strategyId: evaluable.ficha.id,
          name: evaluable.ficha.name,
          version: evaluable.ficha.version,
          direction: order.kind === 'buy' ? 'largo' : 'corto',
          confidence,
          reason: voteReason(evaluable.ficha, order.kind),
        }),
      )
      .slice(0, 1)
      .map((vote) => vote);
  };

  /** Ventana y lote que originan la señal (trazabilidad de SignalDataUsed). */
  const dataUsedFor = (
    ticker: string,
    barDate: SessionDate,
    preferSource: string | null,
  ): SignalDataUsed => {
    const rows = deps.barsFor(ticker, barDate, preferSource);
    const first = rows[0];
    const last = rows[rows.length - 1];
    return {
      barDate,
      desde: first?.date ?? barDate,
      hasta: last?.date ?? barDate,
      barCount: rows.length,
      batchId: last?.batchId ?? null,
      batchVersion: last ? deps.getBatchVersion(last.batchId) : null,
      source: last?.source ?? preferSource,
    };
  };

  const persistSignal = (input: NewSignal): Signal | null => {
    const { signal, inserted } = deps.repo.insertSignal(input);
    if (!inserted) return null;
    const event: SignalNewEvent = { signal };
    deps.broadcast(IPC_CHANNELS.signals.new, event);
    return signal;
  };

  const evaluateTicker = (
    rawTicker: string,
    barDate: SessionDate,
    preferSource: string | null = null,
  ): TickerEvaluationOutcome => {
    if (stopped || blocked()) return 'blocked';
    const ticker = rawTicker.trim().toUpperCase();
    if (deps.wasProcessed(ticker, barDate) || deps.repo.signalExists(ticker, barDate)) {
      return 'already-processed';
    }

    const evaluables = deps
      .listEvaluables()
      .filter((evaluable) => executableMarkets(evaluable.ficha.markets).includes(ticker));

    const votes: SignalStrategyVote[] = [];
    /** Estrategias que votaron, pendientes de la decisión agregada. */
    const voters = new Set<number>();
    for (const evaluable of evaluables) {
      try {
        const own = collectVotes(evaluable, ticker, barDate, preferSource);
        if (own.length === 0) {
          markState(evaluable.ficha.id, barDate, 'sin-senal', null);
          continue;
        }
        votes.push(...own);
        voters.add(evaluable.ficha.id);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error?.(
          `[signals] falló la evaluación de '${evaluable.ficha.name}' v${evaluable.ficha.version} en ${ticker}: ${message}`,
        );
        markState(evaluable.ficha.id, barDate, 'error', null);
        recordJournal({
          type: 'error',
          ticker,
          strategies: [
            {
              strategyId: evaluable.ficha.id,
              name: evaluable.ficha.name,
              version: evaluable.ficha.version,
            },
          ],
          reason: `Error al evaluar '${evaluable.ficha.name}' v${evaluable.ficha.version} sobre ${ticker}`,
          dataUsed: { barDate },
          result: 'error',
          errors: [message],
        });
      }
    }

    deps.markProcessed(ticker, barDate);

    if (votes.length === 0) return 'no-votes';

    const directions = new Set(votes.map((vote) => vote.direction));
    const dataUsed = dataUsedFor(ticker, barDate, preferSource);
    const strategies = votes.map(toStrategyRef);

    if (directions.size > 1) {
      // Contradicción: no hay señal; queda en el diario con las propuestas.
      const summary = (['largo', 'corto'] as const)
        .map((direction) => {
          const names = votes
            .filter((vote) => vote.direction === direction)
            .map((vote) => `${vote.name} v${vote.version}`);
          return names.length === 0
            ? null
            : `${direction === 'largo' ? 'largos' : 'cortos'}: ${names.join(', ')}`;
        })
        .filter((part): part is string => part !== null)
        .join(' · ');
      for (const strategyId of voters) markState(strategyId, barDate, 'sin-senal', null);
      recordJournal({
        type: 'contradiccion',
        ticker,
        strategies,
        reason: `Estrategias en desacuerdo sobre ${ticker} (${summary}); no se emite señal`,
        dataUsed: { ...(dataUsed as unknown as Record<string, unknown>), propuestas: votes },
        result: 'sin-senal',
      });
      logger.info?.(`[signals] ${ticker} ${barDate}: contradicción (${summary})`);
      return 'contradiction';
    }

    const direction = votes[0]!.direction;
    const lastBar = deps.barsFor(ticker, barDate, preferSource).at(-1);
    const entry = lastBar?.close ?? 0;
    const intent: SignalIntent = {
      ticker,
      direction,
      entry,
      stop: aggregateStop(
        direction,
        votes.flatMap(() => [] as number[]),
      ),
      target: null,
      confidence: votes.reduce((acc, vote) => acc + vote.confidence, 0) / votes.length,
      origin: 'estrategia',
    };
    return intent, emitSignal(intent, votes, dataUsed, strategies, barDate);
  };

  return { evaluateTicker } as never;
}
