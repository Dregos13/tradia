/**
 * Motor de señales programado al cierre de vela — Fase 4 (registro).
 *
 * `createSignalEngine` (engine.ts) es el núcleo testeable; aquí se cablea
 * sobre la base de datos real y los servicios ya registrados:
 *
 * - Disparo: `market.onBarsStored` (evento interno de market/ingestion,
 *   se emite al guardarse un lote con velas nuevas de un activo).
 * - Estrategias: `services.strategies` (fichas versionadas) filtradas a
 *   estado 'activa'/'paper'; la implementación de cada ficha se resuelve
 *   por `strategy_implementations` (repositorio de backtest) contra el
 *   catálogo `CLASSIC_STRATEGIES` — los mismos módulos del backtest — y,
 *   sin implementación clásica, la ficha es una estrategia propia: sus
 *   reglas se compilan con `parseStrategyRules` a la `Strategy` del
 *   motor (`createCustomStrategy`). Una propia que no compila (reglas
 *   inválidas o parámetros que no resuelven el programa) se omite con un
 *   único aviso por versión en el registro; no detiene a las demás.
 * - Pasarela única: `services.risk.submitSignal`. Sin motor de riesgo la
 *   evaluación se bloquea (degradación segura: mejor no emitir que
 *   emitir sin veto).
 * - IA (fase 6): el régimen del mercado (`aiRegime`) habilita las fichas,
 *   el modelo apto (`aiPrediction`) aporta la probabilidad calibrada y
 *   `news_analysis` el sentimiento confirmado. Ninguno crea señales:
 *   solo filtran votos o ajustan la confianza antes de la pasarela.
 * - Diario y avisos: `journal.record` estructural (opcional mientras el
 *   diario convive con su esqueleto) y `ctx.broadcast` perezoso, que
 *   delivery intercepta para `signals:new`.
 * - Guardas: `scheduler` en pausa, `connectivity` 'offline' o parada
 *   activa bloquean la evaluación.
 * - Idempotencia: marcas persistentes en settings ('signals.processed',
 *   lista acotada) más el UNIQUE (ticker, vela_fecha) de la tabla.
 *
 * IPC: `signals:list`, `signals:get`, `signals:strategies` y, solo en
 * desarrollo/E2E sin empaquetar, `signals:evaluate-now`.
 */
import { app, ipcMain } from 'electron';

import {
  IPC_CHANNELS,
  IpcValidationError,
  isE2eEnabled,
  isSignalId,
  isSignalsListQuery,
  type MarketUpdatedEvent,
} from '../../shared/ipc';
import { SIGNAL_EMITTING_STRATEGY_STATUSES } from '../../shared/signals';
import type { JournalRecordInput } from '../../shared/journal';
import type { Strategy } from '../../shared/strategy';
import { parseStrategyRules } from '../../shared/strategyRules';
import { openDatabase } from '../db/database';
import { createBacktestRepository } from '../backtest/repository';
import { CLASSIC_STRATEGIES } from '../backtest/strategies';
import { createCustomStrategy } from '../backtest/strategies/custom';
import { createNewsAnalysisRepository } from '../ai/news/repository';
import * as nyseCalendar from '../market/calendar';
import { createMarketRepository, type StoredBar } from '../market/repository';
import { expectedSessionDateFor, previousSessionDateFor } from '../market/assetCalendar';
import { isFxSymbol } from '../../shared/fxTrading';
import { REGIME_MARKET_TICKER } from '../../shared/ai';
import type { ServiceContext } from '../services';
import {
  createSignalEngine,
  SIGNAL_NEWS_MAX_ITEMS,
  SIGNAL_PROCESSED_MARKS_LIMIT,
  type EvaluableStrategy,
  type SignalEngine,
  type SignalSourceBar,
} from './engine';
import { createPaperTracker, type PaperTracker } from './paper';
import { createSignalsRepository } from './repository';

export interface SignalsService {
  /** El núcleo, expuesto para pruebas del propio servicio. */
  engine: SignalEngine;
  /** Seguimiento de posiciones simuladas (apertura por señal, cierre por vela). */
  paper: PaperTracker;
  stop(): void;
}

/** Clave de settings con las marcas «ticker|fecha» ya evaluadas. */
const PROCESSED_SETTINGS_KEY = 'signals.processedBars';

/** La vela que evalúa la estrategia: serie ajustada, cruda de respaldo. */
function toSourceBar(bar: StoredBar): SignalSourceBar {
  return {
    date: bar.date,
    open: bar.adjOpen ?? bar.open,
    high: bar.adjHigh ?? bar.high,
    low: bar.adjLow ?? bar.low,
    close: bar.adjClose ?? bar.close,
    volume: bar.adjVolume ?? bar.volume,
    batchId: bar.batchId,
    source: bar.source,
  };
}

export interface RegisterSignalsOptions {
  /**
   * Reloj compartido con la ingesta de mercado (adelantable por
   * `market:advance-clock`): fija la sesión esperada de la guarda de
   * frescura, así una vela vieja que llega en una puesta al día atrasada
   * no se evalúa para señal. Por defecto, el reloj real.
   */
  clock?: { now(): number };
}

export function registerSignals(
  ctx: ServiceContext,
  options: RegisterSignalsOptions = {},
): SignalsService {
  // Sin base de datos el motor degrada a memoria (mismo patrón que el
  // resto de servicios del proceso principal).
  let db = ctx.services.storage?.getDb() ?? null;
  if (!db) {
    console.error('[signals] almacén no disponible: las señales solo vivirán en memoria');
    db = openDatabase(':memory:');
  }
  const repo = createSignalsRepository(db);
  const market = createMarketRepository(db);
  const runs = createBacktestRepository(db);
  // Fase 6: régimen, modelo apto y noticias confirmadas que alimentan la
  // combinación de confianza. Las noticias se leen de `news_analysis`
  // directamente (solo existen filas de titulares confirmados); los otros
  // servicios son opcionales y su ausencia deja ese factor sin efecto.
  const newsAnalyses = createNewsAnalysisRepository(db);
  const aiRegime = ctx.services.aiRegime ?? null;
  const clockNow = (): number => options.clock?.now() ?? Date.now();
  /** Sesión NYSE inmediatamente anterior a `barDate` (calendario por defecto). */
  const previousExpectedSessionNyse = (barDate: string): string | null => {
    const dayMs = Date.parse(`${barDate}T00:00:00.000Z`);
    if (!Number.isFinite(dayMs)) return null;
    return (
      nyseCalendar
        .expectedSessionsBetween(
          new Date(dayMs - 40 * 86_400_000).toISOString().slice(0, 10),
          new Date(dayMs - 86_400_000).toISOString().slice(0, 10),
        )
        .at(-1)?.date ?? null
    );
  };
  const aiPrediction = ctx.services.aiPrediction ?? null;

  const settings = ctx.services.settings;
  let processedMarks: Set<string> | null = null;

  const loadMarks = (): Set<string> => {
    if (processedMarks !== null) return processedMarks;
    processedMarks = new Set<string>();
    const raw = settings?.getValue(PROCESSED_SETTINGS_KEY);
    if (typeof raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const mark of parsed) {
            if (typeof mark === 'string') processedMarks.add(mark);
          }
        }
      } catch {
        console.warn('[signals] marcas de velas evaluadas ilegibles; se empieza de cero');
      }
    }
    return processedMarks;
  };

  const markProcessed = (ticker: string, barDate: string): void => {
    const marks = loadMarks();
    marks.add(`${ticker}|${barDate}`);
    if (settings && marks.size > SIGNAL_PROCESSED_MARKS_LIMIT) {
      // Acotado: conserva las últimas marcas (Set conserva el orden de alta).
      const keep = [...marks].slice(-SIGNAL_PROCESSED_MARKS_LIMIT);
      processedMarks = new Set(keep);
    }
    try {
      settings?.setValue(PROCESSED_SETTINGS_KEY, JSON.stringify([...processedMarks!]));
    } catch (error: unknown) {
      console.warn(`[signals] no se pudieron guardar las marcas de evaluación: ${String(error)}`);
    }
  };

  // Propias omitidas ya avisadas (id:version): la evaluación se repite en
  // cada vela y la misma ficha rota no debe llenar el registro.
  const warnedCustom = new Set<string>();
  const warnCustomSkipped = (ficha: Strategy, detail: string): void => {
    const key = `${ficha.id}:${ficha.version}`;
    if (warnedCustom.has(key)) return;
    warnedCustom.add(key);
    console.warn(
      `[signals] la estrategia propia '${ficha.name}' v${ficha.version} ` +
        `se omite de la evaluación: ${detail}`,
    );
  };

  const listEvaluables = (): EvaluableStrategy[] => {
    const strategies = ctx.services.strategies;
    if (!strategies) return [];
    const evaluables: EvaluableStrategy[] = [];
    for (const summary of strategies.list()) {
      if (!(SIGNAL_EMITTING_STRATEGY_STATUSES as readonly string[]).includes(summary.status)) {
        continue;
      }
      const ficha = strategies.get(summary.id);
      if (ficha === null) continue;
      const implKey = runs.implementationKey(ficha.id);
      const impl =
        implKey === null ? undefined : CLASSIC_STRATEGIES.find((entry) => entry.key === implKey);
      if (impl !== undefined) {
        if (ficha.executable) evaluables.push({ ficha, create: impl.create });
        continue;
      }
      // Estrategia propia: sin implementación clásica, el ejecutable es su
      // programa de reglas (el mismo que corre el backtest). La compilación
      // se revalida aquí —la ficha admite texto libre— y también el `init`
      // con sus parámetros: un periodo-parámetro inválido compila pero no
      // ejecuta, y sin esta guarda fallaría en cada vela sin marcarla.
      const parsed = parseStrategyRules(ficha.rules, ficha.parameters);
      if (!parsed.ok) {
        warnCustomSkipped(
          ficha,
          `sus reglas no compilan (${parsed.errors
            .map((error) => `${error.field}: ${error.message}`)
            .join('; ')})`,
        );
        continue;
      }
      try {
        createCustomStrategy(parsed.program, ficha.parameters).init(ficha.parameters);
      } catch (error: unknown) {
        warnCustomSkipped(
          ficha,
          `sus parámetros no resuelven el programa compilado ` +
            `(${error instanceof Error ? error.message : String(error)})`,
        );
        continue;
      }
      const program = parsed.program;
      evaluables.push({
        ficha,
        create: () => createCustomStrategy(program, ficha.parameters),
      });
    }
    return evaluables;
  };

  const barsFor = (
    ticker: string,
    hasta: string,
    preferSource: string | null,
  ): SignalSourceBar[] => {
    let rows: StoredBar[] = preferSource
      ? market.getBars(ticker, { hasta, source: preferSource })
      : [];
    if (rows.length === 0) {
      // Una sola fuente por serie: la más reciente que tenga datos.
      const all = market.getBars(ticker, { hasta });
      const source = all[all.length - 1]?.source;
      rows = source === undefined ? [] : all.filter((bar) => bar.source === source);
    }
    return rows.map(toSourceBar);
  };

  const journal = ctx.services.journal as
    { record?(input: JournalRecordInput): unknown } | undefined;

  // La cartera simulada solo la escribe el motor de riesgo (la regla de
  // imports lo exige): el tracker la usa por la interfaz de servicio y
  // queda inerte si esa API no está (degradación segura).
  const risk = ctx.services.risk;
  const gateway =
    risk !== undefined && typeof risk.openPaperPosition === 'function' ? risk : undefined;

  // La vela recién guardada que evalúan las posiciones abiertas: la de la
  // fuente del lote disparador, o la de la fuente más reciente del activo.
  const barAt = (ticker: string, date: string, source: string | null): SignalSourceBar | null => {
    const rows = market.getBars(ticker, { desde: date, hasta: date });
    if (rows.length === 0) return null;
    const effective = source ?? rows[rows.length - 1]!.source;
    const bar = rows.find((row) => row.source === effective) ?? rows[rows.length - 1]!;
    return toSourceBar(bar);
  };

  const tracker = createPaperTracker({
    gateway,
    barAt,
    getSignal: (id) => repo.getSignal(id),
    recordJournal: (input) => journal?.record?.(input),
    sendLimitAlert: (message) =>
      ctx.services.delivery?.sendEvent?.('limite-alcanzado', {
        ...message,
        navigateTo: 'riesgo',
      }),
    observeDailyLoss: (lossPct) => ctx.services.killSwitch?.observeDailyLoss?.(lossPct),
    observeDrawdown: (drawdownPct) => ctx.services.killSwitch?.observeDrawdown?.(drawdownPct),
  });

  const engine = createSignalEngine({
    repo,
    listEvaluables,
    listStrategies: () => ctx.services.strategies?.list() ?? [],
    listWatchlistTickers: () =>
      ctx.services.market?.listWatchlist().map((item) => item.ticker) ?? [],
    barsFor,
    lastBarDate: (ticker) => market.lastBarDate(ticker),
    getBatchVersion: (batchId) => market.getBatch(batchId)?.version ?? null,
    submitSignal: (intent) => {
      const risk = ctx.services.risk;
      if (!risk) {
        // Degradación segura: sin pasarela no se emite señal.
        throw new Error('la pasarela de riesgo no está disponible');
      }
      return risk.submitSignal(intent);
    },
    recordJournal: (input) => journal?.record?.(input),
    // Perezoso a propósito: delivery envuelve ctx.broadcast al registrarse
    // después y necesita ver los `signals:new`. Cada señal persistida la
    // ve también el seguimiento de posiciones (abre la simulada).
    broadcast: (channel, payload) => {
      ctx.broadcast(channel, payload);
      if (channel === IPC_CHANNELS.signals.new) tracker.handleSignalEvent(payload);
    },
    isAgentsPaused: () => ctx.services.scheduler?.getState().paused ?? false,
    isOffline: () => ctx.services.connectivity?.getState().status === 'offline',
    isKillSwitchActive: () => ctx.services.killSwitch?.getState().active ?? false,
    wasProcessed: (ticker, barDate) => loadMarks().has(`${ticker}|${barDate}`),
    markProcessed,
    // Guarda de frescura: una vela anterior a la última sesión esperada
    // no se evalúa (datos viejos de una puesta al día atrasada). El
    // calendario es el del tipo de activo: NYSE en acciones, 24/5 en
    // divisas (`assetCalendar.ts` elige).
    expectedSessionDate: (_nowMs, ticker) =>
      ticker === undefined || ticker === ''
        ? (nyseCalendar.lastExpectedSession(clockNow())?.date ?? null)
        : expectedSessionDateFor(ticker, clockNow()),
    // Sesión inmediatamente anterior a la vela evaluada: es la frescura
    // mínima que el motor exige a la predicción que ajusta la señal, con
    // el calendario del tipo de activo.
    previousExpectedSession: (barDate, ticker) =>
      ticker === undefined || ticker === ''
        ? previousExpectedSessionNyse(barDate)
        : previousSessionDateFor(barDate, ticker),
    ai: {
      // El régimen habilita o desactiva las estrategias: la referencia
      // SPY en acciones/ETF (mismo criterio que la página «IA» y el
      // filtro del backtest) y la del par en divisas (`regimeFor` lo
      // calcula con su moneda base, EUR en EUR/USD). Si el régimen
      // guardado es anterior a la sesión esperada está desactualizado y
      // no decide nada (como si no hubiera régimen).
      marketRegime: (ticker) => {
        const snapshot =
          (isFxSymbol(ticker)
            ? aiRegime?.service.regimeFor(ticker)
            : aiRegime?.service.marketRegime()) ?? null;
        if (snapshot === null) return null;
        const expected = expectedSessionDateFor(
          isFxSymbol(ticker) ? ticker : REGIME_MARKET_TICKER,
          clockNow(),
        );
        if (expected !== null && snapshot.sessionDate < expected) return null;
        return { direction: snapshot.direction, volatility: snapshot.volatility };
      },
      // Solo un modelo apto apoya señales; la predicción se usa solo si
      // casa con su versión y hash (lo decide el motor).
      eligibleModel: () => aiPrediction?.service.eligibleModel() ?? null,
      latestPrediction: (ticker) => {
        const prediction = aiPrediction?.service.latestPrediction(ticker) ?? null;
        // La sesión viaja con la predicción: el motor descarta una
        // predicción de una sesión ya pasada (serie que estuvo atrasada).
        return prediction === null
          ? null
          : {
              probUp: prediction.probUp,
              modelVersion: prediction.modelVersion,
              modelHash: prediction.modelHash,
              horizonDays: prediction.horizonDays,
              sessionDate: prediction.sessionDate,
            };
      },
      // `news_analysis` solo tiene filas de titulares confirmados: un
      // titular sin verificar nunca llega a ajustar una señal.
      newsAnalysesFor: (ticker) =>
        newsAnalyses.list({ ticker, limit: SIGNAL_NEWS_MAX_ITEMS }).map((item) => ({
          newsItemId: item.newsItemId,
          sentiment: item.sentiment,
          analyzedAt: item.analyzedAt,
          publishedAt: item.publishedAt,
        })),
    },
  });

  // Disparo: cada lote guardado de un activo cierra primero las
  // posiciones que la vela toque (stop/objetivo) y después evalúa las
  // estrategias sobre su última vela.
  const unsubscribe = ctx.services.market?.onBarsStored((event: MarketUpdatedEvent) => {
    tracker.handleBarStored(event);
    engine.handleBarStored(event);
  });

  ipcMain.handle(IPC_CHANNELS.signals.list, (_event, query: unknown) => {
    if (!isSignalsListQuery(query)) {
      throw new IpcValidationError(
        IPC_CHANNELS.signals.list,
        'se esperaba {ticker?, decision?, strategyId?, desde?, hasta?, limit?, offset?}',
      );
    }
    return engine.listSignals(query);
  });
  ipcMain.handle(IPC_CHANNELS.signals.get, (_event, id: unknown) => {
    if (!isSignalId(id)) {
      throw new IpcValidationError(IPC_CHANNELS.signals.get, 'id de señal inválido');
    }
    return engine.getSignal(id);
  });
  ipcMain.handle(IPC_CHANNELS.signals.strategies, () => engine.listStrategyStates());

  // Gancho de desarrollo/E2E: la app empaquetada no lo registra (mismo
  // patrón que risk:simulate-* y market:advance-clock).
  if (isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E)) {
    ipcMain.handle(IPC_CHANNELS.signals.evaluateNow, () => engine.evaluateNow());
  }

  return {
    engine,
    paper: tracker,
    stop: () => {
      unsubscribe?.();
      engine.stop();
      tracker.stop();
    },
  };
}
