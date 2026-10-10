/**
 * Servicio de régimen de mercado — Fase 6 (núcleo testeable).
 *
 * Recalcula el régimen cuando la ingesta guarda velas nuevas
 * (`handleBarStored`, mismo disparo que el motor de señales):
 *
 * - Para el ticker del lote recalcula el ámbito 'activo' desde la última
 *   sesión guardada (incluida, por si la vela llegó corregida) hasta el
 *   último cierre, clasificando cada sesión solo con los datos
 *   disponibles en ella.
 * - Si el ticker es la referencia del mercado (SPY) recalcula también el
 *   ámbito 'mercado'.
 * - Persistir es idempotente: un recálculo de la misma vela con el mismo
 *   resultado no escribe ni emite nada. Cuando la última sesión guardada
 *   cambia de etiqueta respecto a la anterior, se anota en el Diario
 *   (solo el ámbito 'mercado': es el régimen que habilita estrategias) y
 *   cualquier escritura emite `ai:changed` {kind:'regimen'} una vez por
 *   pasada.
 * - El servicio no clasifica series con menos de `REGIME_MIN_BARS`
 *   velas: sin pendiente de la SMA50 la etiqueta sería solo el valor por
 *   defecto.
 */
import {
  IPC_CHANNELS,
  type MarketUpdatedEvent,
  type SimulateRegimeRequest,
} from '../../../shared/ipc';
import {
  REGIME_MARKET_TICKER,
  type RegimeLabel,
  type RegimeMetrics,
  type RegimeOverview,
  type RegimeScope,
  type RegimeSnapshot,
  type StrategyRegimeStatus,
} from '../../../shared/ai';
import type { JournalRecordInput } from '../../../shared/journal';
import type { StrategyStatus } from '../../../shared/strategy';
import type { Candle } from '../../../shared/indicators';
import { createRegimeClassifier, REGIME_MIN_BARS } from './classifier';
import { REGIME_LABEL_TEXT, resolveStrategyRegime } from './enablement';
import type { RegimesRepository, RegimeRowLabels } from './repository';

/** Vela mínima que necesita el clasificador (fecha + OHLC). */
export interface RegimeCandle extends Candle {
  date: string;
}

/** Campos de la ficha que gobiernan la habilitación por régimen. */
export interface RegimeStrategyCard {
  id: number;
  name: string;
  version: number;
  status: StrategyStatus;
  worksIn: RegimeLabel[];
  failsIn: RegimeLabel[];
}

export interface RegimeServiceLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface RegimeServiceDeps {
  repo: RegimesRepository;
  /**
   * Serie completa del ticker (ordenada de antigua a reciente, una sola
   * fuente: `preferSource` si existe, si no la más reciente del activo).
   */
  barsFor(ticker: string, preferSource: string | null): RegimeCandle[];
  /** Última sesión con vela del ticker; null si no hay datos. */
  lastBarDate(ticker: string): string | null;
  /** Tickers del seguimiento (vista «por activo» del overview). */
  listWatchlistTickers(): string[];
  /** Fichas de la biblioteca (versión vigente) para el bloque por régimen. */
  listStrategies(): RegimeStrategyCard[];
  /** Entrada del Diario automático (`services.journal.record`). */
  recordJournal(input: JournalRecordInput): void;
  /** `ctx.broadcast` perezoso para `ai:changed`. */
  broadcast(channel: string, payload: unknown): void;
  /** Reloj inyectable (ms epoch); por defecto Date.now. */
  now?(): number;
  logger?: Partial<RegimeServiceLogger>;
}

export interface RegimeService {
  /** Evento interno «lote guardado»: recalcula el ticker (y el mercado). */
  handleBarStored(event: MarketUpdatedEvent): void;
  /** Recalcula todos los tickers del seguimiento y la referencia SPY. */
  recalculateAll(): void;
  /** Recalcula un ticker concreto (ámbito 'activo'; 'mercado' si es SPY). */
  recalculateTicker(ticker: string, preferSource?: string | null): void;
  /** Vista de la página «IA»: mercado, activos y estrategias por régimen. */
  overview(): RegimeOverview;
  /** Último régimen 'activo' del ticker (o el de `session` si se pasa). */
  regimeFor(ticker: string, session?: string): RegimeSnapshot | null;
  /** Último régimen del mercado (referencia SPY). */
  marketRegime(): RegimeSnapshot | null;
  /** Historial guardado del ámbito/ticker (para el backtest con filtro). */
  history(
    scope: RegimeScope,
    ticker: string,
    filter?: { desde?: string; hasta?: string },
  ): RegimeSnapshot[];
  /** Gancho E2E `ai:simulate-regime`: fija el régimen como si se hubiera calculado. */
  simulateRegime(request: SimulateRegimeRequest): RegimeSnapshot;
}

const metricsEqual = (a: RegimeMetrics, b: RegimeMetrics): boolean =>
  a.adx === b.adx &&
  a.smaSlope === b.smaSlope &&
  a.realizedVolatility === b.realizedVolatility &&
  a.volatilityMedian === b.volatilityMedian;

const labelsOf = (snapshot: RegimeSnapshot): RegimeRowLabels => ({
  direction: snapshot.direction,
  volatility: snapshot.volatility,
});

const sameLabels = (a: RegimeRowLabels, b: RegimeRowLabels): boolean =>
  a.direction === b.direction && a.volatility === b.volatility;

/** Descripción legible del cambio, solo de los ejes que cambiaron. */
function describeChange(before: RegimeRowLabels, after: RegimeRowLabels): string {
  const parts: string[] = [];
  if (before.direction !== after.direction) {
    parts.push(`${REGIME_LABEL_TEXT[before.direction]} → ${REGIME_LABEL_TEXT[after.direction]}`);
  }
  if (before.volatility !== after.volatility) {
    parts.push(`${REGIME_LABEL_TEXT[before.volatility]} → ${REGIME_LABEL_TEXT[after.volatility]}`);
  }
  return parts.join(' · ');
}

export function createRegimeService(deps: RegimeServiceDeps): RegimeService {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => Date.now());
  const isoNow = (): string => new Date(now()).toISOString();

  const emitChanged = (): void => {
    try {
      deps.broadcast(IPC_CHANNELS.ai.changed, { kind: 'regimen', at: isoNow() });
    } catch (error: unknown) {
      logger.warn?.(`[ai/regime] no se pudo difundir ai:changed: ${String(error)}`);
    }
  };

  const recordJournal = (input: JournalRecordInput): void => {
    try {
      deps.recordJournal(input);
    } catch (error: unknown) {
      logger.warn?.(`[ai/regime] no se pudo escribir en el diario: ${String(error)}`);
    }
  };

  const journalMarketChange = (
    before: RegimeRowLabels,
    after: RegimeSnapshot,
    ticker: string,
  ): void => {
    recordJournal({
      type: 'resumen',
      ticker,
      reason:
        `Cambio de régimen del mercado (${ticker}, cierre ${after.sessionDate}): ` +
        describeChange(before, labelsOf(after)),
      dataUsed: {
        ambito: 'mercado',
        sesion: after.sessionDate,
        anterior: { direccion: before.direction, volatilidad: before.volatility },
        actual: { direccion: after.direction, volatilidad: after.volatility },
        metricas: { ...after.metrics },
      },
      result: 'completado',
    });
  };

  /**
   * Recalcula las sesiones pendientes de un ámbito/ticker. Devuelve true
   * si se escribió o actualizó alguna fila. Regla del Diario: entra una
   * entrada cuando la sesión que cambia es la última guardada del
   * ámbito (la que representa el régimen vigente) y su etiqueta difiere
   * de la sesión anterior — una sola entrada por cambio real.
   */
  const recompute = (scope: RegimeScope, ticker: string, preferSource: string | null): boolean => {
    const candles = deps.barsFor(ticker, preferSource);
    if (candles.length < REGIME_MIN_BARS) return false;

    const lastStored = deps.repo.latestSession(scope, ticker);
    let startIndex = REGIME_MIN_BARS - 1;
    if (lastStored !== null) {
      const storedIndex = candles.findIndex((candle) => candle.date === lastStored);
      // Recalcula también la última sesión guardada: la vela pudo llegar
      // corregida. Si ya no está en la serie se recalcula desde el inicio.
      if (storedIndex >= startIndex) startIndex = storedIndex;
    }

    const classifier = createRegimeClassifier(candles);
    let written = false;
    for (let i = startIndex; i < candles.length; i++) {
      const session = candles[i]!.date;
      const classification = classifier.classifyAt(i);
      const existing = deps.repo.get(scope, ticker, session);
      if (
        existing !== null &&
        sameLabels(labelsOf(existing), classification) &&
        metricsEqual(existing.metrics, classification.metrics)
      ) {
        continue; // mismo cierre recalculado: ni escritura ni evento
      }
      const previous = deps.repo.previousSession(scope, ticker, session);
      const snapshot = deps.repo.upsert({
        scope,
        ticker,
        session,
        direction: classification.direction,
        volatility: classification.volatility,
        metrics: classification.metrics,
        computedAt: isoNow(),
      });
      written = true;
      if (
        scope === 'mercado' &&
        previous !== null &&
        !sameLabels(labelsOf(previous), classification) &&
        deps.repo.latestSession(scope, ticker) === session
      ) {
        journalMarketChange(labelsOf(previous), snapshot, ticker);
      }
    }
    return written;
  };

  const recalculateTicker = (rawTicker: string, preferSource: string | null = null): void => {
    const ticker = rawTicker.trim().toUpperCase();
    let written = false;
    try {
      written = recompute('activo', ticker, preferSource);
      if (ticker === REGIME_MARKET_TICKER) {
        written = recompute('mercado', ticker, preferSource) || written;
      }
    } catch (error: unknown) {
      logger.error?.(`[ai/regime] falló el recálculo de ${ticker}: ${String(error)}`);
      return;
    }
    if (written) emitChanged();
  };

  const service: RegimeService = {
    handleBarStored: (event) => {
      recalculateTicker(event.ticker, event.source ?? null);
    },

    recalculateAll: () => {
      let written = false;
      const tickers = new Set(deps.listWatchlistTickers().map((t) => t.trim().toUpperCase()));
      for (const ticker of tickers) {
        try {
          written = recompute('activo', ticker, null) || written;
        } catch (error: unknown) {
          logger.error?.(`[ai/regime] falló el recálculo de ${ticker}: ${String(error)}`);
        }
      }
      try {
        written = recompute('mercado', REGIME_MARKET_TICKER, null) || written;
      } catch (error: unknown) {
        logger.error?.(`[ai/regime] falló el recálculo del mercado: ${String(error)}`);
      }
      if (written) emitChanged();
    },

    recalculateTicker,

    overview: () => {
      const market = deps.repo.latest('mercado', REGIME_MARKET_TICKER);
      const assets = deps
        .listWatchlistTickers()
        .map((ticker) => deps.repo.latest('activo', ticker.trim().toUpperCase()))
        .filter((snapshot): snapshot is RegimeSnapshot => snapshot !== null);
      const current =
        market === null
          ? null
          : { direction: market.direction, volatility: market.volatility };
      const strategies: StrategyRegimeStatus[] = deps
        .listStrategies()
        .filter((strategy) => strategy.status !== 'retirada')
        .map((strategy) => ({
          strategyId: strategy.id,
          name: strategy.name,
          version: strategy.version,
          status: strategy.status,
          worksIn: strategy.worksIn,
          failsIn: strategy.failsIn,
          ...resolveStrategyRegime(strategy, strategy.status, current),
        }));
      const computedAt =
        [market, ...assets]
          .filter((snapshot): snapshot is RegimeSnapshot => snapshot !== null)
          .map((snapshot) => snapshot.computedAt)
          .sort()
          .pop() ?? null;
      return { market, assets, strategies, computedAt };
    },

    regimeFor: (ticker, session) => {
      const key = ticker.trim().toUpperCase();
      return session === undefined
        ? deps.repo.latest('activo', key)
        : deps.repo.get('activo', key, session);
    },

    marketRegime: () => deps.repo.latest('mercado', REGIME_MARKET_TICKER),

    history: (scope, ticker, filter) => deps.repo.list(scope, ticker, filter),

    simulateRegime: (request) => {
      const scope: RegimeScope = request.scope ?? (request.ticker ? 'activo' : 'mercado');
      const ticker =
        scope === 'mercado' ? REGIME_MARKET_TICKER : (request.ticker ?? '').trim().toUpperCase();
      if (scope === 'activo' && ticker === '') {
        throw new Error('simulate-regime: el ámbito activo exige ticker');
      }
      const session =
        request.sessionDate ??
        deps.repo.latestSession(scope, ticker) ??
        deps.lastBarDate(ticker);
      if (session === null) {
        throw new Error(`simulate-regime: ${ticker} no tiene sesiones que fijar`);
      }
      const existing = deps.repo.get(scope, ticker, session);
      const direction = request.direction ?? existing?.direction ?? 'lateral';
      const volatility = request.volatility ?? existing?.volatility ?? 'volatilidad-baja';
      const previous = deps.repo.previousSession(scope, ticker, session);
      const snapshot = deps.repo.upsert({
        scope,
        ticker,
        session,
        direction,
        volatility,
        metrics: existing?.metrics ?? {
          adx: null,
          smaSlope: null,
          realizedVolatility: null,
          volatilityMedian: null,
        },
        computedAt: isoNow(),
      });
      if (
        scope === 'mercado' &&
        previous !== null &&
        !sameLabels(labelsOf(previous), labelsOf(snapshot))
      ) {
        journalMarketChange(labelsOf(previous), snapshot, ticker);
      }
      emitChanged();
      return snapshot;
    },
  };
  return service;
}
