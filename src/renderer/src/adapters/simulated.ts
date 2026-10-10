import {
  dataStatusKey,
  DEFAULT_STRATEGY_COSTS,
  DELIVERY_CONFIG_DEFAULTS,
  DEVIATION_MARGIN_PP_DEFAULT,
  DEVIATION_SLIPPAGE_BPS_DEFAULT,
  INITIAL_UNIVERSE_TICKERS,
  isAddSourceRequest,
  isBacktestFinalTestRequest,
  isBacktestListQuery,
  isBacktestRunId,
  isBacktestRunRequest,
  isBackupRestoreRequest,
  isBrokerConnectRequest,
  isBrokerOrdersQuery,
  isBrokerTestRequest,
  isCalendarListQuery,
  isCancelOrderRequest,
  isCreateOrderRequest,
  isCreateStrategyRequest,
  isDeliveryConfigInput,
  isDeliveryTestRequest,
  isDeviationReportQuery,
  isGetBarsRequest,
  isGetStrategyRequest,
  isIsoDate,
  isJournalEntryId,
  isJournalExportRequest,
  isJournalListQuery,
  isNewsListQuery,
  isResumeKillSwitchRequest,
  isRiskLimits,
  isRiskVetoesQuery,
  isRoutineConfig,
  isSetStrategyStatusRequest,
  isSignalId,
  isSignalIntent,
  isSignalsListQuery,
  isSourceId,
  isStrategyId,
  isStressRequest,
  isTestSourceRequest,
  isTicker,
  isUpdateSourceRequest,
  isUpdateStrategyRequest,
  BROKER_ORDER_OPEN_STATUSES,
  CAUTION_REDUCED_SIZE_FACTOR,
  JOURNAL_LIST_MAX_LIMIT,
  RISK_DEFAULTS,
  ROUTINE_DEFAULTS,
  SIGNALS_LIST_MAX_LIMIT,
  VETO_REASON_MESSAGES,
  WATCHLIST_MAX_ITEMS,
} from '../../../shared/ipc';
import type {
  AgentsState,
  AlertPrefs,
  AppSettings,
  BackupInfo,
  BacktestMetricsDto,
  BacktestProgressEvent,
  BacktestReport,
  BacktestStage,
  BrokerOrder,
  BrokerStatus,
  CalendarEvent,
  CalendarUpdatedEvent,
  CautionState,
  ConnectivityState,
  DataStatusEntry,
  DeliveryConfig,
  DeviationPeriod,
  DeviationReportRow,
  EquityPointDto,
  ExposureSlice,
  GetBarsRequest,
  JournalEntry,
  JournalListQuery,
  JournalUpdatedEvent,
  KillSwitchState,
  LoggedRiskDecision,
  MacroObservation,
  MacroSeriesQuery,
  MacroSeriesSnapshot,
  MarketBar,
  MarketUpdatedEvent,
  NewsItem,
  NewsSource,
  NewsUpdatedEvent,
  NotificationPrefs,
  NotificationRoute,
  PaperPortfolioOverview,
  PaperPosition,
  ReconcileDiscrepancy,
  ReconcileDiscrepancyEvent,
  ReconcileRun,
  RiskDecision,
  RiskDecisionReason,
  RiskLimits,
  RiskOverview,
  RiskVeto,
  RoutineConfig,
  SeedRiskPosition,
  Signal,
  SignalIntent,
  SignalNewEvent,
  SignalStrategyState,
  SignalsListQuery,
  Strategy,
  StrategyChangelogEntry,
  StrategyDraft,
  StrategyStatus,
  StressResultDto,
  TradiaApi,
  VetoReasonCode,
  WatchlistItem,
} from '../../../shared/ipc';
// El falso ejecuta el motor real: estos módulos son TS puro, sin Electron
// ni Node (contrato de src/main/backtest/).
import { runBacktest } from '../../../main/backtest/engine';
import { computeMetrics, type BacktestMetrics } from '../../../main/backtest/metrics';
import { CLASSIC_STRATEGIES } from '../../../main/backtest/strategies';
import { runMonteCarlo, splitTimeline } from '../../../main/backtest/validation';
import type { EngineBar } from '../../../main/backtest/types';

const SIMULATED_SOURCE = 'simulated';
/** Génesis de las series simuladas: da unos 7 años de velas diarias. */
const GENESIS = '2019-01-02';
const DAY_MS = 86_400_000;

/** Hash FNV-1a de texto a uint32 (misma técnica que el proveedor simulado). */
function hashSeed(text: string): number {
  let h = 2_166_136_261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

/** PRNG mulberry32: determinista por semilla, suficiente para datos de prueba. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const toDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const isWeekday = (ms: number): boolean => {
  const day = new Date(ms).getUTCDay();
  return day >= 1 && day <= 5;
};

/** Velas diarias deterministas por ticker: paseo aleatorio con semilla, solo laborables. */
function generateBars(ticker: string): MarketBar[] {
  const rng = mulberry32(hashSeed(`sim:${ticker}`));
  let close = round(20 + rng() * 480, 2);
  const baseVolume = Math.round(1_000_000 + rng() * 50_000_000);
  const bars: MarketBar[] = [];
  const end = Date.now() - DAY_MS;
  for (let ms = Date.parse(`${GENESIS}T00:00:00.000Z`); ms <= end; ms += DAY_MS) {
    if (!isWeekday(ms)) continue;
    const noise = ((rng() + rng() + rng()) / 1.5 - 1) * 0.02;
    const prev = close;
    close = round(Math.max(1, prev * (1 + noise + 0.0002)), 2);
    const open = round(prev * (1 + (rng() + rng() - 1) * 0.005), 2);
    const high = round(Math.max(open, close) * (1 + rng() * 0.01), 2);
    const low = round(Math.min(open, close) * (1 - rng() * 0.01), 2);
    const volume = Math.round(baseVolume * (0.5 + rng() * 1.5));
    bars.push({
      date: toDate(ms),
      open,
      high,
      low,
      close,
      volume,
      // En la simulación no hay acciones corporativas: ajustado = crudo.
      adjOpen: open,
      adjHigh: high,
      adjLow: low,
      adjClose: close,
      adjVolume: volume,
      batchId: 1,
    });
  }
  return bars;
}

/**
 * Serie de valores determinista: paseo con semilla que termina en `endValue`
 * (los últimos puntos se interpolan hacia él para fijar el valor visible).
 */
function generateSeries(
  seedText: string,
  points: number,
  stepDays: number,
  min: number,
  max: number,
  endValue: number,
): MacroObservation[] {
  const rng = mulberry32(hashSeed(`macro:${seedText}`));
  const raw: number[] = [];
  let value = min + rng() * (max - min);
  for (let i = 0; i < points; i++) {
    value = Math.min(max, Math.max(min, value + (rng() - 0.5) * (max - min) * 0.08));
    raw.push(round(value, 2));
  }
  // Funde los últimos ~10 % de puntos hacia endValue para un cierre conocido.
  const blend = Math.max(2, Math.floor(points * 0.1));
  for (let i = 0; i < blend; i++) {
    const idx = points - 1 - i;
    const t = i / blend;
    raw[idx] = round(endValue + (raw[idx]! - endValue) * t, 2);
  }
  const endMs = Date.now() - DAY_MS;
  return raw.map((v, i) => ({
    date: toDate(endMs - (points - 1 - i) * stepDays * DAY_MS),
    value: v,
  }));
}

/** Las 6 series macro del panel, con VIX medio y curva 10-2 invertida al final. */
function buildMacroSeries(): MacroSeriesSnapshot[] {
  const meta: Array<{ id: string; name: string; unit: string; frequency: string }> = [
    { id: 'DFF', name: 'Tipo de fondos federales', unit: '%', frequency: 'daily' },
    { id: 'CPIAUCSL', name: 'IPC interanual (EE. UU.)', unit: '%', frequency: 'monthly' },
    { id: 'DGS2', name: 'Tesoro EE. UU. 2 años', unit: '%', frequency: 'daily' },
    { id: 'DGS10', name: 'Tesoro EE. UU. 10 años', unit: '%', frequency: 'daily' },
    { id: 'T10Y2Y', name: 'Diferencial 10 años − 2 años', unit: '%', frequency: 'daily' },
    { id: 'VIXCLS', name: 'VIX (volatilidad CBOE)', unit: 'índice', frequency: 'daily' },
  ];
  const observationsById = new Map<string, MacroObservation[]>();
  observationsById.set('DFF', generateSeries('DFF', 36, 30, 0.1, 5.5, 4.33));
  observationsById.set(
    'CPIAUCSL',
    Array.from({ length: 36 }, (_, index) => {
      const date = new Date();
      date.setUTCDate(1);
      date.setUTCMonth(date.getUTCMonth() - (35 - index));
      return {
        date: date.toISOString().slice(0, 10),
        value: round(290 * 1.026 ** (index / 12), 4),
      };
    }),
  );
  observationsById.set('DGS2', generateSeries('DGS2', 120, 7, 0.5, 5.5, 4.4));
  observationsById.set('DGS10', generateSeries('DGS10', 120, 7, 0.7, 5, 4.1));
  // La curva termina invertida (T10Y2Y < 0) para que el aviso se vea en pruebas.
  observationsById.set('T10Y2Y', generateSeries('T10Y2Y', 120, 7, -1.2, 2.2, -0.3));
  observationsById.set('VIXCLS', generateSeries('VIXCLS', 120, 7, 10, 45, 18.4));

  const status: DataStatusEntry = {
    key: '',
    state: 'fiable',
    lastOkAt: new Date().toISOString(),
    consecutiveFailures: 0,
    reason: null,
    updatedAt: new Date().toISOString(),
  };
  return meta.map((item) => ({
    ...item,
    observations: observationsById.get(item.id) ?? [],
    status: { ...status, key: dataStatusKey.macro(item.id) },
  }));
}

const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 3_600_000).toISOString();

/** Fecha ilustrativa dentro de la semana UTC actual; no es una agenda oficial. */
const dayOfCurrentWeek = (days: number, utcHour: number, utcMinute = 0): string => {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7) + days);
  date.setUTCHours(utcHour, utcMinute, 0, 0);
  return date.toISOString();
};

/**
 * Fuentes simuladas de partida: una oficial, una agencia por RSS y una de
 * redes (que nunca confirma noticias por sí sola, regla de la sección 5.4).
 */
function buildSimulatedSources(): NewsSource[] {
  const now = new Date().toISOString();
  const base = {
    params: {},
    active: true,
    lastStatus: 'ok' as const,
    lastError: null,
    lastFetchedAt: now,
    createdAt: now,
  };
  return [
    {
      ...base,
      id: 1,
      name: 'Fed · comunicados',
      kind: 'oficial',
      connector: 'fed',
      url: 'https://www.federalreserve.gov/feeds/press_all.xml',
      reliability: 'oficial',
      intervalSeconds: 600,
    },
    {
      ...base,
      id: 2,
      name: 'Reuters mercados',
      kind: 'rss',
      connector: 'rss',
      url: 'https://feeds.reuters.example/mercados',
      reliability: 'agencia',
      intervalSeconds: 300,
    },
    {
      ...base,
      id: 3,
      name: 'r/wallstreetbets',
      kind: 'redes',
      connector: 'rss',
      url: 'https://www.reddit.com/r/wallstreetbets/.rss',
      reliability: 'redes',
      intervalSeconds: 300,
    },
  ];
}

/** Titulares simulados: cubren las tres prioridades y el caso «sin confirmar». */
function buildSimulatedNewsItems(sources: NewsSource[]): NewsItem[] {
  const ref = (id: number) => {
    const source = sources.find((s) => s.id === id);
    if (!source) throw new Error(`fuente simulada desconocida: ${id}`);
    return { id: source.id, name: source.name, reliability: source.reliability };
  };
  return [
    {
      id: 1,
      title: 'La Fed mantiene tipos y avisa de que la inflación sigue alta',
      url: 'https://www.federalreserve.gov/newsevents/pressreleases/monetary.htm',
      publishedAt: hoursAgo(2),
      summary: 'El FOMC deja sin cambios el rango objetivo y reitera su dependencia de los datos.',
      priority: 'maxima',
      confirmed: true,
      // La misma noticia llegó por dos fuentes: se ve una sola vez, con ambas.
      sources: [ref(1), ref(2)],
      assets: ['SPY', 'QQQ'],
    },
    {
      id: 2,
      title: 'Apple supera las expectativas de beneficios trimestrales',
      url: 'https://feeds.reuters.example/aapl-resultados',
      publishedAt: hoursAgo(5),
      summary: 'Ingresos y guía por encima del consenso; sube en el after-hours.',
      priority: 'activo',
      confirmed: true,
      sources: [ref(2)],
      assets: ['AAPL'],
    },
    {
      id: 3,
      title: 'Rumor en redes: una tecnológica prepara una compra millonaria',
      url: 'https://www.reddit.com/r/wallstreetbets/rumor',
      publishedAt: hoursAgo(1),
      summary: null,
      priority: 'baja',
      // Solo viene de redes: jamás confirmada mientras no la respalde otra fuente.
      confirmed: false,
      sources: [ref(3)],
      assets: ['NVDA'],
    },
  ];
}

/** Eventos de la semana en curso con su impacto, relativos a hoy. */
function buildSimulatedCalendar(): CalendarEvent[] {
  return [
    {
      id: 1,
      kind: 'fomc',
      title: 'Decisión de tipos del FOMC',
      dateUtc: dayOfCurrentWeek(1, 18),
      impact: 'alto',
      country: 'US',
      asset: null,
      origin: 'simulado',
    },
    {
      id: 2,
      kind: 'eia',
      title: 'Inventarios semanales de petróleo (EIA)',
      dateUtc: dayOfCurrentWeek(2, 14, 30),
      impact: 'medio',
      country: 'US',
      asset: null,
      origin: 'simulado',
    },
    {
      id: 3,
      kind: 'ipc',
      title: 'IPC de EE. UU. (mensual)',
      dateUtc: dayOfCurrentWeek(3, 12, 30),
      impact: 'alto',
      country: 'US',
      asset: null,
      origin: 'simulado',
    },
    {
      id: 4,
      kind: 'resultados',
      title: 'Resultados de AAPL',
      dateUtc: dayOfCurrentWeek(4, 20),
      impact: 'medio',
      country: 'US',
      asset: 'AAPL',
      origin: 'simulado',
    },
    {
      id: 5,
      kind: 'vencimiento',
      title: 'Triple witching: vencimiento de opciones y futuros',
      dateUtc: dayOfCurrentWeek(5, 13),
      impact: 'medio',
      country: null,
      asset: null,
      origin: 'simulado',
    },
  ];
}

/** Explicit simulation only: never substitutes the production Electron bridge. */
export function createSimulatedAdapter() {
  let connectivity: ConnectivityState = {
    status: 'checking',
    lastCheckedAt: null,
    nextRetryAt: null,
    attempt: 0,
  };
  let agents: AgentsState = { paused: false, pauseReason: null, lastHeartbeatAt: null };
  let settings: AppSettings = {
    autostart: false,
    disclaimerAcceptedVersion: null,
    disclaimerAcceptedAt: null,
    brokerExecutionEnabled: true,
    deviationMarginPp: DEVIATION_MARGIN_PP_DEFAULT,
    deviationSlippageBps: DEVIATION_SLIPPAGE_BPS_DEFAULT,
  };
  let prefs: NotificationPrefs = { info: true, alerta: true, critica: true };
  let alertPrefs: AlertPrefs = { leadMinutes: 30 };
  let watchlist: WatchlistItem[] = [];
  let newsSources = buildSimulatedSources();
  let newsItems = buildSimulatedNewsItems(newsSources);
  const calendarEvents = buildSimulatedCalendar();
  let nextSourceId = Math.max(...newsSources.map((s) => s.id)) + 1;
  let nextNewsItemId = Math.max(...newsItems.map((item) => item.id)) + 1;
  const macroSeries = buildMacroSeries();
  const statuses = new Map<string, DataStatusEntry>();
  for (const series of macroSeries) {
    if (series.status) statuses.set(series.status.key, series.status);
  }
  statuses.set(dataStatusKey.provider(SIMULATED_SOURCE), {
    key: dataStatusKey.provider(SIMULATED_SOURCE),
    state: 'fiable',
    lastOkAt: new Date().toISOString(),
    consecutiveFailures: 0,
    reason: null,
    updatedAt: new Date().toISOString(),
  });

  // Biblioteca de estrategias simulada: una entrada por versión guardada;
  // `status` vive en cada fila porque el estado es de la estrategia, no de
  // la versión (setStatus lo actualiza en todas sus versiones).
  let strategyVersions: Strategy[] = [];
  const strategyChangelog: StrategyChangelogEntry[] = [];
  let nextStrategyId = 1;
  let nextChangelogId = 1;
  const latestStrategyVersion = (id: number): Strategy | null =>
    strategyVersions.filter((v) => v.id === id).sort((a, b) => b.version - a.version)[0] ?? null;
  /** Replica strategies.actualizado_en: todos los get de una estrategia lo ven. */
  const touchStrategy = (id: number, at: string, status?: StrategyStatus) => {
    strategyVersions = strategyVersions.map((v) =>
      v.id === id ? { ...v, updatedAt: at, ...(status ? { status } : {}) } : v,
    );
  };
  const addChangelog = (
    strategyId: number,
    kind: StrategyChangelogEntry['kind'],
    note: string,
    extra: Partial<Pick<StrategyChangelogEntry, 'version' | 'fromStatus' | 'toStatus'>> = {},
  ): void => {
    strategyChangelog.push({
      id: nextChangelogId++,
      strategyId,
      kind,
      version: extra.version ?? null,
      fromStatus: extra.fromStatus ?? null,
      toStatus: extra.toStatus ?? null,
      note,
      createdAt: new Date().toISOString(),
    });
  };
  const mergeStrategyDraft = (base: Strategy, patch: Partial<StrategyDraft>): StrategyDraft => {
    const merged: StrategyDraft = {
      name: patch.name ?? base.name,
      hypothesis: patch.hypothesis ?? base.hypothesis,
      rules: patch.rules ?? base.rules,
      parameters: patch.parameters ?? base.parameters,
      parameterRanges: patch.parameterRanges ?? base.parameterRanges,
      markets: patch.markets ?? base.markets,
      trainingPeriod:
        patch.trainingPeriod === undefined ? base.trainingPeriod : patch.trainingPeriod,
      outOfSamplePeriod:
        patch.outOfSamplePeriod === undefined ? base.outOfSamplePeriod : patch.outOfSamplePeriod,
      regime: patch.regime ?? base.regime,
      assumedCosts: patch.assumedCosts ?? base.assumedCosts,
    };
    // Como en el repositorio: si cambian los parámetros sin tocar los rangos,
    // los rangos huérfanos no pasan a la versión nueva.
    if (patch.parameters !== undefined && patch.parameterRanges === undefined) {
      merged.parameterRanges = Object.fromEntries(
        Object.entries(merged.parameterRanges ?? {}).filter(([key]) => key in merged.parameters),
      );
    }
    return merged;
  };

  // — Backtest y pruebas de estrés (fase 2) ----------------------------------
  // El falso ejecuta el motor real sobre las velas generadas, así el informe
  // es verídico en estructura y razonable en valores. Los bloques pesados
  // (walk-forward y sensibilidad) se omiten: el informe los muestra
  // «Sin datos», como un run que los tenga desactivados. Monte Carlo sí se
  // calcula (es barato). La versión reducida del pipeline vive en
  // src/main/backtest/service.ts — este falso le sigue de cerca.
  let nextBacktestRunId = 1;
  const backtestRuns: BacktestReport[] = [];
  const stressRowsByKey = new Map<string, StressResultDto[]>();
  const finalTestRunByKey = new Map<string, number>();
  const progressListeners = new Set<(event: BacktestProgressEvent) => void>();
  let progressSeq = 0;

  const emitProgress = (
    ticket: string,
    strategyId: number,
    stage: BacktestStage,
    percent: number,
    detail: string | null = null,
  ): void => {
    const event: BacktestProgressEvent = {
      ticket,
      strategyId,
      stage,
      percent,
      detail,
      elapsedMs: 0,
    };
    progressListeners.forEach((listener) => listener(event));
  };

  // El adaptador no registra implementaciones para las fichas creadas por el usuario.
  const implementations = new Map<number, (typeof CLASSIC_STRATEGIES)[number]>();
  const implForStrategy = (strategy: Strategy) => implementations.get(strategy.id) ?? null;

  const findStrategyVersion = (id: number, version?: number): Strategy | null =>
    version !== undefined
      ? (strategyVersions.find((v) => v.id === id && v.version === version) ?? null)
      : latestStrategyVersion(id);

  /** Velas generadas del ticker recortadas a [desde, hasta] (EngineBar). */
  const fakeBars = (ticker: string, desde: string, hasta: string): EngineBar[] =>
    generateBars(ticker)
      .filter((b) => b.date >= desde && b.date <= hasta)
      .map((b) => ({
        date: b.date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      }));

  /** ~300 sesiones de calentamiento ≈ 430 días naturales antes del inicio. */
  const warmupDesde = (desde: string): string => toDate(Date.parse(desde) - 430 * DAY_MS);

  /** Métricas JSON-safe (misma normalización que service.ts: ±Inf → null). */
  const toMetricsDto = (m: BacktestMetrics): BacktestMetricsDto => ({
    totalReturn: m.totalReturn,
    annualizedReturn: m.annualizedReturn,
    maxDrawdown: m.maxDrawdown,
    sharpe: m.sharpe !== null && Number.isFinite(m.sharpe) ? m.sharpe : null,
    sharpeInfinite: m.sharpe === Infinity ? 'positive' : m.sharpe === -Infinity ? 'negative' : null,
    profitFactor:
      m.profitFactor !== null && Number.isFinite(m.profitFactor) ? m.profitFactor : null,
    profitFactorInfinite: m.profitFactor === Infinity,
    winRate: m.winRate,
    expectancy: m.expectancy,
    maxLosingStreak: m.maxLosingStreak,
    tradeCount: m.tradeCount,
    winningTrades: m.winningTrades,
    losingTrades: m.losingTrades,
    grossProfit: m.grossProfit,
    grossLoss: m.grossLoss,
  });

  /** Curva comprar-y-mantener del benchmark sobre el tramo dado. */
  const fakeBenchmark = (
    initialCash: number,
    desde: string,
    hasta: string,
  ): BacktestReport['benchmark'] => {
    const inside = fakeBars('SPY', desde, hasta);
    if (inside.length === 0 || inside[0]!.close <= 0) return null;
    const first = inside[0]!.close;
    const curve: EquityPointDto[] = inside.map((b) => ({
      date: b.date,
      cash: initialCash,
      equity: (initialCash * b.close) / first,
      positions: 1,
    }));
    return { ticker: 'SPY', totalReturn: inside.at(-1)!.close / first - 1, curve };
  };

  const fakeWarnings = (tradeCount: number) => [
    ...(tradeCount > 0 && tradeCount < 30
      ? [
          {
            rule: 'pocas-operaciones',
            severity: 'method' as const,
            message: `El run cerró ${tradeCount} operaciones; el plan pide al menos 30 para que las métricas sean representativas.`,
          },
        ]
      : []),
    {
      rule: 'sesgo-supervivencia',
      severity: 'method' as const,
      message:
        'Sesgo de supervivencia residual: el universo no registra altas ni bajas históricas.',
    },
    {
      rule: 'rendimientos-pasados',
      severity: 'method' as const,
      message: 'Los rendimientos pasados no garantizan resultados futuros.',
    },
    {
      rule: 'datos-simulados',
      severity: 'info' as const,
      message: "Datos simulados (proveedor 'simulated').",
    },
  ];

  /** Run del motor real sobre datos simulados; devuelve el informe persistido. */
  const runFakeBacktest = (
    strategy: Strategy,
    request: { params?: Record<string, number>; initialCash?: number },
    range: { desde: string; hasta: string },
    kind: 'completo' | 'prueba-final',
    progress: { ticket: string; percentBase: number },
  ): BacktestReport => {
    const impl = implForStrategy(strategy);
    if (impl === null) {
      throw new Error(
        `La estrategia ${strategy.id} no tiene una implementación ejecutable registrada.`,
      );
    }
    const markets = strategy.markets.map((m) => m.trim().toUpperCase()).filter(isTicker);
    if (markets.length === 0) {
      throw new Error('La ficha no tiene mercados ejecutables (ningún ticker válido).');
    }
    const params = { ...strategy.parameters, ...request.params };
    const initialCash = request.initialCash ?? 10_000;
    const costs = strategy.assumedCosts;
    emitProgress(progress.ticket, strategy.id, 'descargando', progress.percentBase + 5);
    const bars = Object.fromEntries(
      markets.map((ticker) => [ticker, fakeBars(ticker, warmupDesde(range.desde), range.hasta)]),
    );
    emitProgress(progress.ticket, strategy.id, 'backtest', progress.percentBase + 40);
    const result = runBacktest({
      strategy: impl.create(),
      params,
      bars,
      universe: markets.map((ticker) => ({ ticker })),
      initialCash,
      costs: {
        // La ficha guarda la comisión en %; el motor la espera en fracción.
        commissionPct: costs.commissionPct / 100,
        commissionMin: costs.commissionMin,
        slippageBp: costs.slippageBps,
        spreadBp: costs.spreadBps,
      },
      riskPerTrade: 0.01,
      maxPositions: Number.isInteger(params['topN']) && params['topN']! >= 1 ? params['topN']! : 5,
      startDate: range.desde,
      endDate: range.hasta,
    });
    const metrics = toMetricsDto(computeMetrics(result.equityCurve, result.trades));
    emitProgress(progress.ticket, strategy.id, 'monte-carlo', progress.percentBase + 70);
    const monteCarlo = runMonteCarlo({
      trades: result.trades,
      initialCash,
      seed: 1,
      simulations: 200,
      method: 'permutation',
    });
    emitProgress(progress.ticket, strategy.id, 'guardando', progress.percentBase + 90);
    const id = nextBacktestRunId++;
    const key = `${strategy.id}:${strategy.version}`;
    const report: BacktestReport = {
      id,
      strategyId: strategy.id,
      version: strategy.version,
      kind,
      dataSource: 'simulated',
      providerId: 'simulated',
      totalReturn: metrics.totalReturn,
      maxDrawdownPct: metrics.maxDrawdown?.pct ?? null,
      sharpe: metrics.sharpe,
      tradeCount: metrics.tradeCount,
      durationMs: 0,
      createdAt: new Date().toISOString(),
      config: {
        desde: range.desde,
        hasta: range.hasta,
        ejecutadoHasta: range.hasta,
        markets,
        initialCash,
        riskPerTrade: 0.01,
        maxPositions:
          Number.isInteger(params['topN']) && params['topN']! >= 1 ? params['topN']! : 5,
        parameters: params,
        warmupSessions: 300,
        split: { train: 0.6, validation: 0.2, test: 0.2 },
        walkForward: null,
        sensitivity: null,
        monteCarlo: { seed: 1, simulations: 200, method: 'permutation' },
      },
      costs,
      split: null,
      metrics,
      equityCurve: result.equityCurve,
      trades: result.trades,
      walkForward: null,
      sensitivity: null,
      monteCarlo,
      warnings: fakeWarnings(metrics.tradeCount),
      benchmark: fakeBenchmark(initialCash, range.desde, range.hasta),
      finalTest: {
        status: finalTestRunByKey.has(key) ? 'ejecutada' : 'disponible',
        runId: finalTestRunByKey.get(key) ?? null,
        executedAt: null,
      },
    };
    backtestRuns.push(report);
    if (kind === 'prueba-final') {
      report.finalTest = { status: 'ejecutada', runId: id, executedAt: report.createdAt };
    } else {
      // El run 'completo' refresca las métricas resumen de la ficha.
      const summary = {
        totalReturnPct: (metrics.totalReturn ?? 0) * 100,
        maxDrawdownPct: (metrics.maxDrawdown?.pct ?? 0) * 100,
        sharpe: metrics.sharpe,
        profitFactor: metrics.profitFactor,
        winRatePct: metrics.winRate === null ? null : metrics.winRate * 100,
        expectancy: metrics.expectancy,
        maxLosingStreak: metrics.maxLosingStreak,
        trades: metrics.tradeCount,
      };
      strategyVersions = strategyVersions.map((v) =>
        v.id === strategy.id && v.version === strategy.version
          ? { ...v, metricsSummary: summary }
          : v,
      );
    }
    return report;
  };

  /** Periodo resuelto como en el servicio real: petición → ficha → 5 años. */
  const resolveRunRange = (
    strategy: Strategy,
    request: { desde?: string; hasta?: string },
  ): { desde: string; hasta: string } => {
    const today = toDate(Date.now());
    const hasta = request.hasta ?? strategy.outOfSamplePeriod?.hasta ?? today;
    const desde =
      request.desde ??
      strategy.trainingPeriod?.desde ??
      toDate(Date.parse(hasta) - 5 * 365 * DAY_MS);
    return { desde: desde < GENESIS ? GENESIS : desde, hasta };
  };

  const CRISIS_WINDOWS_FAKE = [
    { id: '2008', name: 'Crisis financiera 2008', desde: '2007-10-09', hasta: '2009-03-09' },
    { id: '2020', name: 'Choque del covid 2020', desde: '2020-02-19', hasta: '2020-06-30' },
    { id: '2022', name: 'Mercado bajista 2022', desde: '2022-01-03', hasta: '2022-10-12' },
  ];

  /** Ejecuta las tres crisis con el motor real sobre datos simulados. */
  const runFakeStress = (strategy: Strategy): StressResultDto[] => {
    const impl = implForStrategy(strategy);
    if (!impl)
      throw new Error(
        `La estrategia ${strategy.id} no tiene una implementación ejecutable registrada.`,
      );
    const markets = strategy.markets.map((m) => m.trim().toUpperCase()).filter(isTicker);
    const params = strategy.parameters;
    const rows: StressResultDto[] = CRISIS_WINDOWS_FAKE.map((crisis) => {
      const bars = Object.fromEntries(
        markets.map((ticker) => [
          ticker,
          fakeBars(ticker, warmupDesde(crisis.desde), crisis.hasta),
        ]),
      );
      const bench = fakeBars('SPY', crisis.desde, crisis.hasta);
      let sessions = 0;
      let metrics: BacktestMetricsDto | null = null;
      let curve: EquityPointDto[] = [];
      if (impl !== null && Object.values(bars).some((b) => b.length > 0)) {
        const result = runBacktest({
          strategy: impl.create(),
          params,
          bars,
          universe: markets.map((ticker) => ({ ticker })),
          initialCash: 10_000,
          costs: {
            commissionPct: strategy.assumedCosts.commissionPct / 100,
            commissionMin: strategy.assumedCosts.commissionMin,
            slippageBp: strategy.assumedCosts.slippageBps,
            spreadBp: strategy.assumedCosts.spreadBps,
          },
          riskPerTrade: 0.01,
          maxPositions:
            Number.isInteger(params['topN']) && params['topN']! >= 1 ? params['topN']! : 5,
          startDate: crisis.desde,
          endDate: crisis.hasta,
        });
        metrics = toMetricsDto(computeMetrics(result.equityCurve, result.trades));
        sessions = result.equityCurve.length;
        curve = result.equityCurve;
      }
      return {
        crisisId: crisis.id,
        crisisName: crisis.name,
        desde: crisis.desde,
        hasta: crisis.hasta,
        sessions,
        totalReturn: metrics?.totalReturn ?? null,
        maxDrawdown: metrics?.maxDrawdown?.pct ?? null,
        trades: metrics?.tradeCount ?? 0,
        benchmarkTicker: 'SPY',
        benchmarkReturn:
          bench.length > 0 && bench[0]!.close > 0
            ? bench.at(-1)!.close / bench[0]!.close - 1
            : null,
        dataSource: 'simulated',
        providerId: 'simulated',
        equityCurve: curve,
        createdAt: new Date().toISOString(),
      };
    });
    stressRowsByKey.set(`${strategy.id}:${strategy.version}`, rows);
    return rows;
  };

  const connectionListeners = new Set<(value: ConnectivityState) => void>();
  const agentListeners = new Set<(value: AgentsState) => void>();
  const heartbeatListeners = new Set<(value: string) => void>();
  const dataStatusListeners = new Set<(value: DataStatusEntry) => void>();
  const marketUpdatedListeners = new Set<(value: MarketUpdatedEvent) => void>();
  const newsUpdatedListeners = new Set<(value: NewsUpdatedEvent) => void>();
  const calendarUpdatedListeners = new Set<(value: CalendarUpdatedEvent) => void>();
  const alertNavigateListeners = new Set<(value: NotificationRoute) => void>();
  const subscribe = <T>(listeners: Set<(value: T) => void>, listener: (value: T) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const emitConnectivity = (value: ConnectivityState) => {
    connectivity = value;
    connectionListeners.forEach((listener) => listener(value));
  };
  const emitAgents = (value: AgentsState) => {
    agents = value;
    agentListeners.forEach((listener) => listener(value));
  };
  const setStatus = (entry: DataStatusEntry, notify: boolean) => {
    statuses.set(entry.key, entry);
    if (notify) dataStatusListeners.forEach((listener) => listener(entry));
  };
  const touchTickerStatus = (ticker: string) => {
    const key = dataStatusKey.ticker(ticker);
    if (!statuses.has(key)) {
      setStatus(
        {
          key,
          state: 'fiable',
          lastOkAt: new Date().toISOString(),
          consecutiveFailures: 0,
          reason: null,
          updatedAt: new Date().toISOString(),
        },
        false,
      );
    }
  };
  const unsupported = async () => {
    throw new Error('Operación nativa no disponible en la simulación.');
  };

  // — Motor de riesgo simulado (fase 3) ------------------------------------
  // Réplica en memoria de la pasarela: parada → reglas por operación →
  // posiciones abiertas → cautela. Cuando el motor real aterrice en
  // src/main/risk/ este bloque lo usará, como ya hace el backtest.
  let riskLimits: RiskLimits = { ...RISK_DEFAULTS };
  let killSwitch: KillSwitchState = {
    active: false,
    cause: null,
    actor: null,
    activatedAt: null,
    detail: null,
  };
  const caution: CautionState = {
    active: false,
    effect: 'ninguno',
    sizeFactor: 1,
    cause: null,
    eventTitle: null,
    until: null,
  };
  const riskEquity = 100_000;
  const riskPositions: SeedRiskPosition[] = [];
  let riskVetoes: RiskVeto[] = [];
  let nextVetoId = 1;
  const riskChangedListeners = new Set<(overview: RiskOverview) => void>();
  const riskVetoedListeners = new Set<(veto: RiskVeto) => void>();
  const riskOverview = (): RiskOverview => ({
    limits: riskLimits,
    killSwitch,
    caution,
  });
  const emitRiskChanged = () => {
    const overview = riskOverview();
    riskChangedListeners.forEach((listener) => listener(overview));
  };
  const vetoReason = (
    code: VetoReasonCode,
    details: Record<string, number | string> = {},
  ): RiskDecisionReason => ({ code, message: VETO_REASON_MESSAGES[code], details });
  const recordVeto = (
    signal: SignalIntent,
    decision: LoggedRiskDecision,
    reason: RiskDecisionReason,
    size: number,
  ): void => {
    const veto: RiskVeto = {
      id: nextVetoId++,
      signal,
      ticker: signal.ticker,
      decision,
      code: reason.code,
      message: reason.message,
      details: reason.details,
      size,
      createdAt: new Date().toISOString(),
    };
    riskVetoes = [veto, ...riskVetoes];
    riskVetoedListeners.forEach((listener) => listener(veto));
  };

  // -- Fase 4: señales, diario, canales, rutina y copias (en memoria) ----
  const signalsList: Signal[] = [];
  const signalNewListeners = new Set<(event: SignalNewEvent) => void>();
  const journalEntries: JournalEntry[] = [];
  const journalUpdatedListeners = new Set<(event: JournalUpdatedEvent) => void>();
  let deliveryConfig: DeliveryConfig = {
    telegram: { ...DELIVERY_CONFIG_DEFAULTS.telegram, hasToken: false },
    email: { ...DELIVERY_CONFIG_DEFAULTS.email, hasPassword: false },
  };
  let routineConfig: RoutineConfig = { ...ROUTINE_DEFAULTS };
  const backups: BackupInfo[] = [];

  // -- Fase 5: broker paper, órdenes, conciliación y desviación (en memoria) --
  const brokerOrderUpdatedListeners = new Set<(order: BrokerOrder) => void>();
  const reconcileDiscrepancyListeners = new Set<(event: ReconcileDiscrepancyEvent) => void>();
  let brokerStatus: BrokerStatus = {
    state: 'desconectada',
    adapter: null,
    account: null,
    executionEnabled: true,
    error: null,
    checkedAt: null,
  };
  let brokerOrderSeq = 0;
  let reconcileSeq = 0;
  let discrepancySeq = 0;
  let lastReconcileRun: ReconcileRun | null = null;
  let openDiscrepancies: ReconcileDiscrepancy[] = [];
  const nowIso = () => new Date().toISOString();
  const fakeAccount = () => ({
    accountId: 'SIM-PAPER-001',
    status: 'ACTIVE',
    currency: 'USD',
    cash: 100_000,
    equity: 100_000,
    buyingPower: 100_000,
    paper: true as const,
  });
  const makeFakeOrder = (patch: Partial<BrokerOrder> = {}): BrokerOrder => ({
    id: ++brokerOrderSeq,
    clientOrderId: `tradia-fake-${brokerOrderSeq}`,
    brokerOrderId: `sim-${brokerOrderSeq}`,
    signalId: null,
    strategyId: null,
    leg: null,
    ticker: 'AAPL',
    type: 'market',
    side: 'buy',
    quantity: 10,
    filledQuantity: 0,
    limitPrice: null,
    stopPrice: null,
    ocoGroupId: null,
    execution: {
      requestedAt: nowIso(),
      requestedPrice: null,
      executedAt: null,
      executedPrice: null,
      slippageBps: null,
    },
    status: 'pendiente',
    attempts: 1,
    rejectReason: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    ...patch,
  });
  // Semilla visible en la página «Órdenes»: una ejecutada con slippage,
  // un OCO de salida y una limitada pendiente cancelable.
  const brokerOrders: BrokerOrder[] = [
    makeFakeOrder({
      clientOrderId: 'tradia-1-entrada',
      leg: 'entrada',
      signalId: 1,
      strategyId: 1,
      filledQuantity: 10,
      status: 'ejecutada',
      execution: {
        requestedAt: hoursAgo(26),
        requestedPrice: 200,
        executedAt: hoursAgo(26),
        executedPrice: 200.2,
        slippageBps: 10,
      },
    }),
    makeFakeOrder({
      clientOrderId: 'tradia-1-salida',
      leg: 'salida',
      signalId: 1,
      strategyId: 1,
      type: 'oco',
      side: 'sell',
      limitPrice: 220,
      stopPrice: 190,
      ocoGroupId: 'sim-oco-1',
      status: 'enviada',
    }),
    makeFakeOrder({
      clientOrderId: 'tradia-manual-1',
      type: 'limit',
      limitPrice: 150,
      status: 'enviada',
      execution: {
        requestedAt: hoursAgo(1),
        requestedPrice: 150,
        executedAt: null,
        executedPrice: null,
        slippageBps: null,
      },
    }),
  ];

  /** Filas del informe real vs backtest: 8 semanas o 2 meses por estrategia. */
  const fakeDeviationRows = (period: DeviationPeriod): DeviationReportRow[] => {
    const strategies = [
      { strategyId: 1, strategyName: 'Cruce de medias', drift: 0.1 },
      { strategyId: 2, strategyName: 'RSI sobreventa', drift: -0.9 },
    ];
    const rows: DeviationReportRow[] = [];
    const day = 86_400_000;
    for (const s of strategies) {
      const count = period === 'semanal' ? 8 : 2;
      const span = period === 'semanal' ? 7 : 30;
      for (let i = 0; i < count; i++) {
        const hastaMs =
          period === 'semanal'
            ? Date.now() - (i + 1) * span * day
            : Date.now() - (i + 1) * span * day;
        const hasta = toDate(hastaMs);
        const desde = toDate(hastaMs - (span - 1) * day);
        const real = round(1.2 + s.drift + (i % 3) * 0.3, 2);
        const expected = 1.2;
        const deviation = round(real - expected, 2);
        const slippage = s.strategyId === 2 && i === 1 ? 14 : 6;
        rows.push({
          strategyId: s.strategyId,
          strategyName: s.strategyName,
          desde,
          hasta,
          trades: 3 + (i % 2),
          expectedReturnPct: expected,
          realReturnPct: real,
          deviationPp: deviation,
          expectedWinRate: 0.55,
          realWinRate: round(0.55 + s.drift / 10, 2),
          avgSlippageBps: slippage,
          outOfMargin:
            Math.abs(deviation) > settings.deviationMarginPp ||
            slippage > settings.deviationSlippageBps,
        });
      }
    }
    return rows.sort((a, b) => b.hasta.localeCompare(a.hasta));
  };

  /** Señales filtradas según SignalsListQuery (fecha sobre la vela). */
  const filterSignals = (query?: SignalsListQuery): Signal[] => {
    let rows = [...signalsList].sort((a, b) => b.id - a.id);
    if (query?.ticker) rows = rows.filter((s) => s.ticker === query.ticker!.trim().toUpperCase());
    if (query?.decision) rows = rows.filter((s) => s.decision.status === query.decision);
    if (query?.strategyId !== undefined) {
      rows = rows.filter((s) => s.strategies.some((st) => st.strategyId === query.strategyId));
    }
    if (query?.desde) rows = rows.filter((s) => s.dataUsed.barDate >= query.desde!);
    if (query?.hasta) rows = rows.filter((s) => s.dataUsed.barDate <= query.hasta!);
    const offset = query?.offset ?? 0;
    return rows.slice(offset, offset + (query?.limit ?? SIGNALS_LIST_MAX_LIMIT));
  };

  /** Entradas del diario filtradas según JournalListQuery (fecha de creación). */
  const filterJournal = (query?: JournalListQuery): JournalEntry[] => {
    let rows = [...journalEntries].sort((a, b) => b.id - a.id);
    if (query?.desde) rows = rows.filter((e) => e.createdAt.slice(0, 10) >= query.desde!);
    if (query?.hasta) rows = rows.filter((e) => e.createdAt.slice(0, 10) <= query.hasta!);
    if (query?.type) rows = rows.filter((e) => e.type === query.type);
    if (query?.ticker) rows = rows.filter((e) => e.ticker === query.ticker!.trim().toUpperCase());
    if (query?.strategyId !== undefined) {
      rows = rows.filter((e) => e.strategies.some((st) => st.strategyId === query.strategyId));
    }
    if (query?.result) rows = rows.filter((e) => e.result === query.result);
    return rows;
  };

  /** Evaluación del falso: mismo orden que la pasarela del contrato. */
  const evaluateSignal = (signal: SignalIntent): RiskDecision => {
    const decidedAt = new Date().toISOString();
    const reasons: RiskDecisionReason[] = [];
    if (killSwitch.active) {
      reasons.push(vetoReason('KILL_SWITCH_ACTIVE', { causa: killSwitch.cause ?? 'manual' }));
    }
    if (signal.confidence < 0 || signal.confidence > 1) {
      reasons.push(vetoReason('SIGNAL_INVALID', { confianza: signal.confidence }));
    }
    if (signal.stop === null) {
      reasons.push(vetoReason('STOP_MISSING'));
    } else {
      const wrongSide =
        (signal.direction === 'largo' && signal.stop >= signal.entry) ||
        (signal.direction === 'corto' && signal.stop <= signal.entry);
      if (wrongSide) {
        reasons.push(vetoReason('STOP_WRONG_SIDE', { entrada: signal.entry, stop: signal.stop }));
      }
    }
    if (signal.target === null) {
      reasons.push(
        vetoReason('RR_TOO_LOW', { ratio: 'sin objetivo', minimo: riskLimits.minRewardRiskRatio }),
      );
    } else if (signal.stop !== null) {
      const riskDistance = Math.abs(signal.entry - signal.stop);
      const ratio = riskDistance > 0 ? Math.abs(signal.target - signal.entry) / riskDistance : 0;
      if (ratio < riskLimits.minRewardRiskRatio) {
        reasons.push(
          vetoReason('RR_TOO_LOW', {
            ratio: round(ratio, 2),
            minimo: riskLimits.minRewardRiskRatio,
          }),
        );
      }
    }
    const openPositions = riskPositions.filter((p) => p.closedAt === undefined);
    if (openPositions.length >= riskLimits.maxOpenPositions) {
      reasons.push(
        vetoReason('MAX_POSITIONS', {
          posiciones: openPositions.length,
          maximo: riskLimits.maxOpenPositions,
        }),
      );
    }
    if (reasons.length > 0) {
      reasons.forEach((reason) => recordVeto(signal, 'vetada', reason, 0));
      return {
        status: 'vetada',
        size: 0,
        sizeFactor: 1,
        riskAmount: 0,
        notional: 0,
        reasons,
        decidedAt,
      };
    }

    const stop = signal.stop as number;
    const distance = Math.abs(signal.entry - stop);
    const factor =
      caution.effect === 'bloquear'
        ? 0
        : caution.effect === 'reducir'
          ? CAUTION_REDUCED_SIZE_FACTOR
          : 1;
    const size = Math.floor((riskEquity * (riskLimits.riskPerTradePct / 100) * factor) / distance);
    const riskAmount = size * distance;
    const notional = size * signal.entry;
    if (factor === 0) {
      const reason = vetoReason('CAUTION_MODE', {
        evento: caution.eventTitle ?? caution.cause ?? '',
      });
      recordVeto(signal, 'vetada', reason, 0);
      return {
        status: 'vetada',
        size: 0,
        sizeFactor: 0,
        riskAmount: 0,
        notional: 0,
        reasons: [reason],
        decidedAt,
      };
    }
    if (size === 0) {
      const reason = vetoReason('SIZE_ZERO', {
        capital: riskEquity,
        riesgoPct: riskLimits.riskPerTradePct,
      });
      recordVeto(signal, 'vetada', reason, 0);
      return {
        status: 'vetada',
        size: 0,
        sizeFactor: factor,
        riskAmount: 0,
        notional: 0,
        reasons: [reason],
        decidedAt,
      };
    }
    if (factor < 1) {
      const reason = vetoReason('CAUTION_MODE', {
        evento: caution.eventTitle ?? caution.cause ?? '',
        factor,
      });
      recordVeto(signal, 'reducida', reason, size);
      return {
        status: 'reducida',
        size,
        sizeFactor: factor,
        riskAmount,
        notional,
        reasons: [reason],
        decidedAt,
      };
    }
    return {
      status: 'aprobada',
      size,
      sizeFactor: 1,
      riskAmount,
      notional,
      reasons: [],
      decidedAt,
    };
  };

  const api: TradiaApi = {
    connectivity: {
      getState: async () => connectivity,
      checkNow: async () => connectivity,
      onChanged: (listener) => subscribe(connectionListeners, listener),
    },
    agents: {
      getState: async () => agents,
      pause: async () => {
        emitAgents({ ...agents, paused: true, pauseReason: 'usuario' });
        return agents;
      },
      resume: async () => {
        emitAgents({ ...agents, paused: false, pauseReason: null });
        return agents;
      },
      onChanged: (listener) => subscribe(agentListeners, listener),
      onHeartbeat: (listener) => subscribe(heartbeatListeners, listener),
    },
    settings: {
      get: async () => settings,
      set: async (patch) => {
        settings = {
          ...settings,
          ...patch,
          ...(patch.disclaimerAcceptedVersion !== undefined
            ? {
                disclaimerAcceptedAt: patch.disclaimerAcceptedVersion
                  ? new Date().toISOString()
                  : null,
              }
            : {}),
        };
        return settings;
      },
    },
    notifications: {
      send: unsupported,
      test: unsupported,
      getPrefs: async () => prefs,
      setPrefs: async (value) => {
        prefs = value;
        return prefs;
      },
    },
    secrets: { setKey: unsupported, hasKey: async () => false, deleteKey: unsupported },
    watchlist: {
      list: async () => [...watchlist],
      add: async (ticker) => {
        const key = typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';
        if (!isTicker(key)) {
          throw new Error('Introduce un símbolo bursátil válido (ej. AAPL, SPY, NVDA).');
        }
        if (watchlist.some((item) => item.ticker === key)) {
          throw new Error(`El activo ${key} ya está presente en tu lista de seguimiento.`);
        }
        if (watchlist.length >= WATCHLIST_MAX_ITEMS) {
          throw new Error(
            `Límite alcanzado: Tradia admite un máximo de ${WATCHLIST_MAX_ITEMS} activos simultáneos.`,
          );
        }
        watchlist = [
          ...watchlist,
          { ticker: key, addedAt: new Date().toISOString(), position: watchlist.length },
        ];
        touchTickerStatus(key);
        return [...watchlist];
      },
      remove: async (ticker) => {
        const key = ticker.trim().toUpperCase();
        watchlist = watchlist
          .filter((item) => item.ticker !== key)
          .map((item, index) => ({ ...item, position: index }));
        return [...watchlist];
      },
      addUniverse: async () => {
        for (const ticker of INITIAL_UNIVERSE_TICKERS) {
          if (watchlist.length >= WATCHLIST_MAX_ITEMS) break;
          if (watchlist.some((item) => item.ticker === ticker)) continue;
          watchlist = [
            ...watchlist,
            { ticker, addedAt: new Date().toISOString(), position: watchlist.length },
          ];
          touchTickerStatus(ticker);
        }
        return [...watchlist];
      },
    },
    market: {
      getBars: async (request: GetBarsRequest) => {
        if (!isGetBarsRequest(request)) {
          throw new Error('Petición de velas inválida (ticker o rango de fechas).');
        }
        const key = request.ticker.trim().toUpperCase();
        let bars = generateBars(key);
        if (request.desde) bars = bars.filter((bar) => bar.date >= request.desde!);
        if (request.hasta) bars = bars.filter((bar) => bar.date <= request.hasta!);
        return { ticker: key, source: SIMULATED_SOURCE, bars };
      },
      refreshNow: async () => ({ accepted: true, reason: null }),
      onUpdated: (listener) => subscribe(marketUpdatedListeners, listener),
    },
    macro: {
      getSeries: async (query?: MacroSeriesQuery) => {
        const desde = query && isIsoDate(query.desde) ? query.desde : null;
        return macroSeries.map((series) => ({
          ...series,
          observations: desde
            ? series.observations.filter((obs) => obs.date >= desde)
            : series.observations,
          status: statuses.get(dataStatusKey.macro(series.id)) ?? series.status,
        }));
      },
    },
    dataStatus: {
      get: async () => [...statuses.values()].sort((a, b) => a.key.localeCompare(b.key)),
      onChanged: (listener) => subscribe(dataStatusListeners, listener),
    },
    sources: {
      list: async () => [...newsSources],
      add: async (request) => {
        if (!isAddSourceRequest(request)) {
          throw new Error('Alta de fuente inválida (nombre, tipo, conector, fiabilidad o URL).');
        }
        const source: NewsSource = {
          id: nextSourceId++,
          name: request.name.trim(),
          kind: request.kind,
          connector: request.connector,
          url: request.url ?? null,
          params: request.params ?? {},
          reliability: request.reliability,
          intervalSeconds: request.intervalSeconds ?? 300,
          active: true,
          lastStatus: 'pendiente',
          lastError: null,
          lastFetchedAt: null,
          createdAt: new Date().toISOString(),
        };
        newsSources = [...newsSources, source];
        // La simulación trae un primer titular de la fuente nueva, como haría
        // la primera pasada del programador.
        const item: NewsItem = {
          id: nextNewsItemId++,
          title: `Primer titular de ${source.name}`,
          url: source.url,
          publishedAt: new Date().toISOString(),
          summary: null,
          priority: 'media',
          confirmed: source.reliability === 'oficial' || source.reliability === 'agencia',
          sources: [{ id: source.id, name: source.name, reliability: source.reliability }],
          assets: [],
        };
        newsItems = [item, ...newsItems];
        const event: NewsUpdatedEvent = { newItems: 1, updatedAt: item.publishedAt };
        newsUpdatedListeners.forEach((listener) => listener(event));
        return source;
      },
      update: async (request) => {
        if (!isUpdateSourceRequest(request)) {
          throw new Error('Cambio de fuente inválido.');
        }
        const index = newsSources.findIndex((s) => s.id === request.id);
        if (index === -1) {
          throw new Error(`No existe la fuente ${request.id}.`);
        }
        const updated: NewsSource = {
          ...newsSources[index]!,
          ...(request.name !== undefined ? { name: request.name.trim() } : {}),
          ...(request.url !== undefined ? { url: request.url } : {}),
          ...(request.params !== undefined ? { params: request.params } : {}),
          ...(request.reliability !== undefined ? { reliability: request.reliability } : {}),
          ...(request.intervalSeconds !== undefined
            ? { intervalSeconds: request.intervalSeconds }
            : {}),
          ...(request.active !== undefined ? { active: request.active } : {}),
        };
        newsSources = newsSources.map((s) => (s.id === updated.id ? updated : s));
        return updated;
      },
      remove: async (id) => {
        if (!isSourceId(id)) {
          throw new Error('Identificador de fuente inválido.');
        }
        newsSources = newsSources.filter((s) => s.id !== id);
        // Los titulares ya guardados se quedan, pero pierden esta fuente.
        newsItems = newsItems.map((item) => ({
          ...item,
          sources: item.sources.filter((s) => s.id !== id),
        }));
        return [...newsSources];
      },
      test: async (request) => {
        if (!isTestSourceRequest(request)) {
          throw new Error('Prueba de conexión inválida.');
        }
        if ('id' in request && !newsSources.some((s) => s.id === request.id)) {
          throw new Error(`No existe la fuente ${request.id}.`);
        }
        // En la simulación toda petición válida responde OK.
        return { ok: true, itemsFound: 3, latencyMs: 42, error: null };
      },
    },
    news: {
      list: async (query) => {
        if (query !== undefined && !isNewsListQuery(query)) {
          throw new Error('Filtros de noticias inválidos.');
        }
        let items = [...newsItems].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
        if (query?.desde) items = items.filter((i) => i.publishedAt.slice(0, 10) >= query.desde!);
        if (query?.hasta) items = items.filter((i) => i.publishedAt.slice(0, 10) <= query.hasta!);
        if (query?.priority) items = items.filter((i) => i.priority === query.priority);
        if (query?.reliability) {
          items = items.filter((i) => i.sources.some((s) => s.reliability === query.reliability));
        }
        if (query?.ticker) {
          const ticker = query.ticker.trim().toUpperCase();
          items = items.filter((i) => i.assets.includes(ticker));
        }
        if (query?.confirmed !== undefined) {
          items = items.filter((i) => i.confirmed === query.confirmed);
        }
        if (query?.sourceId)
          items = items.filter((i) => i.sources.some((s) => s.id === query.sourceId));
        if (query?.limit) items = items.slice(0, query.limit);
        return items;
      },
      onUpdated: (listener) => subscribe(newsUpdatedListeners, listener),
    },
    calendar: {
      list: async (query) => {
        if (!isCalendarListQuery(query)) {
          throw new Error('Rango de calendario inválido (desde/hasta).');
        }
        return calendarEvents
          .filter((event) => {
            const day = event.dateUtc.slice(0, 10);
            return day >= query.desde && day <= query.hasta;
          })
          .sort((a, b) => a.dateUtc.localeCompare(b.dateUtc));
      },
      onUpdated: (listener) => subscribe(calendarUpdatedListeners, listener),
    },
    alerts: {
      getPrefs: async () => alertPrefs,
      setPrefs: async (value) => {
        alertPrefs = value;
        return alertPrefs;
      },
      onNavigate: (listener) => subscribe(alertNavigateListeners, listener),
    },
    strategies: {
      list: async () =>
        [...new Set(strategyVersions.map((v) => v.id))].map((id) => {
          const latest = latestStrategyVersion(id)!;
          return {
            id,
            name: latest.name,
            version: latest.version,
            status: latest.status,
            regime: latest.regime,
            markets: latest.markets,
            metricsSummary: latest.metricsSummary,
            updatedAt: latest.updatedAt,
          };
        }),
      get: async (request) => {
        if (!isGetStrategyRequest(request)) {
          throw new Error('Consulta de ficha inválida (id o versión).');
        }
        if (request.version !== undefined) {
          return (
            strategyVersions.find((v) => v.id === request.id && v.version === request.version) ??
            null
          );
        }
        return latestStrategyVersion(request.id);
      },
      create: async (request) => {
        if (!isCreateStrategyRequest(request)) {
          throw new Error('Alta de estrategia inválida (revisa los campos de la ficha).');
        }
        const now = new Date().toISOString();
        const note = request.note?.trim() || 'Alta de la estrategia';
        const strategy: Strategy = {
          id: nextStrategyId++,
          executable: false,
          version: 1,
          name: request.name.trim(),
          hypothesis: request.hypothesis,
          rules: request.rules,
          parameters: request.parameters,
          parameterRanges: request.parameterRanges ?? {},
          markets: request.markets,
          trainingPeriod: request.trainingPeriod ?? null,
          outOfSamplePeriod: request.outOfSamplePeriod ?? null,
          metricsSummary: null,
          regime: request.regime,
          assumedCosts: request.assumedCosts ?? DEFAULT_STRATEGY_COSTS,
          status: 'investigacion',
          changeNote: note,
          createdAt: now,
          updatedAt: now,
          versionCreatedAt: now,
        };
        strategyVersions.push(strategy);
        addChangelog(strategy.id, 'version', note, { version: 1 });
        return strategy;
      },
      update: async (request) => {
        if (!isUpdateStrategyRequest(request)) {
          throw new Error(
            'Edición de estrategia inválida (nota obligatoria y al menos un campo de la ficha).',
          );
        }
        const current = latestStrategyVersion(request.id);
        if (!current) {
          throw new Error(`No existe la estrategia ${request.id}.`);
        }
        const { id: _id, note, ...patch } = request;
        const merged = mergeStrategyDraft(current, patch);
        const now = new Date().toISOString();
        const version: Strategy = {
          ...current,
          version: current.version + 1,
          name: merged.name.trim(),
          hypothesis: merged.hypothesis,
          rules: merged.rules,
          parameters: merged.parameters,
          parameterRanges: merged.parameterRanges ?? {},
          markets: merged.markets,
          trainingPeriod: merged.trainingPeriod ?? null,
          outOfSamplePeriod: merged.outOfSamplePeriod ?? null,
          metricsSummary: null,
          regime: merged.regime,
          assumedCosts: merged.assumedCosts ?? DEFAULT_STRATEGY_COSTS,
          changeNote: note.trim(),
          updatedAt: now,
          versionCreatedAt: now,
        };
        strategyVersions.push(version);
        touchStrategy(request.id, now);
        addChangelog(request.id, 'version', note.trim(), { version: version.version });
        return strategyVersions.find((v) => v.id === request.id && v.version === version.version)!;
      },
      setStatus: async (request) => {
        if (!isSetStrategyStatusRequest(request)) {
          throw new Error('Cambio de estado inválido.');
        }
        const current = latestStrategyVersion(request.id);
        if (!current) {
          throw new Error(`No existe la estrategia ${request.id}.`);
        }
        if (request.status === current.status) {
          throw new Error(`La estrategia ${request.id} ya está en estado '${request.status}'.`);
        }
        const now = new Date().toISOString();
        touchStrategy(request.id, now, request.status);
        addChangelog(
          request.id,
          'estado',
          request.note?.trim() || `Cambio de estado: ${current.status} → ${request.status}`,
          {
            fromStatus: current.status,
            toStatus: request.status,
          },
        );
        return latestStrategyVersion(request.id)!;
      },
      history: async (id) => {
        if (!isStrategyId(id)) {
          throw new Error('Identificador de estrategia inválido.');
        }
        return strategyChangelog
          .filter((entry) => entry.strategyId === id)
          .sort((a, b) => b.id - a.id);
      },
    },
    backtest: {
      run: async (request) => {
        if (!isBacktestRunRequest(request)) {
          throw new Error('Petición de backtest inválida.');
        }
        const strategy = findStrategyVersion(request.strategyId, request.version);
        if (strategy === null) {
          throw new Error(`No existe la estrategia ${request.strategyId}.`);
        }
        const ticket = `fake-${++progressSeq}`;
        const range = resolveRunRange(strategy, request);
        // El informe cubre entrenamiento + validación (división 60/20/20):
        // el tramo de prueba queda bloqueado como en el servicio real.
        const dates = Object.values(
          strategy.markets.reduce<Record<string, EngineBar[]>>((acc, m) => {
            const ticker = m.trim().toUpperCase();
            if (isTicker(ticker)) acc[ticker] = fakeBars(ticker, range.desde, range.hasta);
            return acc;
          }, {}),
        ).flatMap((series) => series.map((b) => b.date));
        const ejecutadoHasta =
          dates.length >= 3
            ? splitTimeline([...new Set(dates)].sort()).validation.endDate
            : range.hasta;
        const report = runFakeBacktest(
          strategy,
          request,
          { desde: range.desde, hasta: ejecutadoHasta },
          'completo',
          { ticket, percentBase: 0 },
        );
        // La división usada sí se guarda en el informe del falso.
        if (dates.length >= 3) {
          report.split = splitTimeline([...new Set(dates)].sort());
          report.config.ejecutadoHasta = ejecutadoHasta;
        }
        emitProgress(ticket, strategy.id, 'completado', 100);
        return report;
      },
      list: async (query) => {
        if (!isBacktestListQuery(query)) {
          throw new Error('Filtros de ejecuciones inválidos.');
        }
        let runs = [...backtestRuns].sort((a, b) => b.id - a.id);
        if (query?.strategyId !== undefined) {
          runs = runs.filter((r) => r.strategyId === query.strategyId);
        }
        if (query?.version !== undefined) {
          runs = runs.filter((r) => r.version === query.version);
        }
        return runs.slice(0, query?.limit ?? 100);
      },
      get: async (id) => {
        if (!isBacktestRunId(id)) {
          throw new Error('Identificador de ejecución inválido.');
        }
        return backtestRuns.find((r) => r.id === id) ?? null;
      },
      runFinalTest: async (request) => {
        if (!isBacktestFinalTestRequest(request)) {
          throw new Error('Petición de prueba final inválida.');
        }
        const strategy = findStrategyVersion(request.strategyId, request.version);
        if (strategy === null) {
          throw new Error(`No existe la estrategia ${request.strategyId}.`);
        }
        const key = `${strategy.id}:${strategy.version}`;
        if (finalTestRunByKey.has(key)) {
          throw new Error(
            `La prueba final ya se ejecutó para la estrategia ${strategy.id} v${strategy.version}; ` +
              'repetirla exige crear una versión nueva.',
          );
        }
        const ticket = `fake-${++progressSeq}`;
        const range = resolveRunRange(strategy, {});
        const dates = Object.values(
          strategy.markets.reduce<Record<string, EngineBar[]>>((acc, m) => {
            const ticker = m.trim().toUpperCase();
            if (isTicker(ticker)) acc[ticker] = fakeBars(ticker, range.desde, range.hasta);
            return acc;
          }, {}),
        ).flatMap((series) => series.map((b) => b.date));
        if (dates.length < 3) {
          throw new Error('No hay suficientes sesiones para dividir el periodo.');
        }
        const split = splitTimeline([...new Set(dates)].sort());
        const report = runFakeBacktest(
          strategy,
          {},
          { desde: split.test.startDate, hasta: split.test.endDate },
          'prueba-final',
          { ticket, percentBase: 0 },
        );
        report.split = split;
        report.config.ejecutadoHasta = split.test.endDate;
        finalTestRunByKey.set(key, report.id);
        emitProgress(ticket, strategy.id, 'completado', 100);
        return report;
      },
      onProgress: (listener) => subscribe(progressListeners, listener),
    },
    stress: {
      get: async (request) => {
        if (!isStressRequest(request)) {
          throw new Error('Consulta de estrés inválida.');
        }
        const strategy = findStrategyVersion(request.strategyId, request.version);
        if (strategy === null || !strategy.executable) return [];
        // Como la semilla real: la primera lectura calcula las tres crisis.
        return stressRowsByKey.get(`${strategy.id}:${strategy.version}`) ?? runFakeStress(strategy);
      },
      run: async (request) => {
        if (!isStressRequest(request)) {
          throw new Error('Petición de estrés inválida.');
        }
        const strategy = findStrategyVersion(request.strategyId, request.version);
        if (strategy === null) {
          throw new Error(`No existe la estrategia ${request.strategyId}.`);
        }
        const ticket = `fake-${++progressSeq}`;
        emitProgress(ticket, strategy.id, 'estres', 10);
        const rows = runFakeStress(strategy);
        emitProgress(ticket, strategy.id, 'completado', 100);
        return rows;
      },
    },
    risk: {
      getLimits: async () => ({ ...riskLimits }),
      setLimits: async (limits) => {
        if (!isRiskLimits(limits)) {
          throw new Error(
            'Límites fuera de los márgenes permitidos (revisa los valores contra sus mínimos y máximos).',
          );
        }
        riskLimits = { ...limits };
        emitRiskChanged();
        return { ...riskLimits };
      },
      listVetoes: async (query) => {
        if (query !== undefined && !isRiskVetoesQuery(query)) {
          throw new Error('Filtros de vetos inválidos.');
        }
        let rows = riskVetoes;
        if (query?.rule) rows = rows.filter((v) => v.code === query.rule);
        if (query?.decision) rows = rows.filter((v) => v.decision === query.decision);
        if (query?.ticker)
          rows = rows.filter((v) => v.ticker === query.ticker!.trim().toUpperCase());
        const offset = query?.offset ?? 0;
        return rows.slice(offset, offset + (query?.limit ?? 100));
      },
      submitSignal: async (signal) => {
        if (!isSignalIntent(signal)) {
          throw new Error('Señal inválida (ticker, dirección, precios u origen).');
        }
        return evaluateSignal(signal);
      },
      getKillSwitch: async () => ({ ...killSwitch }),
      activateKillSwitch: async () => {
        if (!killSwitch.active) {
          killSwitch = {
            active: true,
            cause: 'manual',
            actor: 'usuario',
            activatedAt: new Date().toISOString(),
            detail: null,
          };
          emitRiskChanged();
        }
        return { ...killSwitch };
      },
      resumeKillSwitch: async (request) => {
        if (!isResumeKillSwitchRequest(request)) {
          throw new Error('La reanudación exige una confirmación explícita.');
        }
        killSwitch = { ...killSwitch, active: false };
        emitRiskChanged();
        return { ...killSwitch };
      },
      getCaution: async () => ({ ...caution }),
      getPortfolio: async (): Promise<PaperPortfolioOverview> => {
        const open = riskPositions.filter((p) => p.closedAt === undefined);
        const positions: PaperPosition[] = open.map((p, index) => {
          const mark = generateBars(p.ticker.trim().toUpperCase()).at(-1)?.close ?? null;
          const sign = p.direction === 'largo' ? 1 : -1;
          const pnl = mark === null ? null : round((mark - p.entry) * p.size * sign, 2);
          return {
            id: index + 1,
            ticker: p.ticker.trim().toUpperCase(),
            direction: p.direction,
            size: p.size,
            entry: p.entry,
            markPrice: mark,
            pnl,
            pnlPct: mark === null ? null : round(((mark - p.entry) / p.entry) * 100 * sign, 2),
            sector: p.sector ?? null,
            currency: p.currency ?? 'USD',
            signalId: null,
            openedAt: p.openedAt ?? new Date().toISOString(),
          };
        });
        const notionalBy = (key: (p: PaperPosition) => string): ExposureSlice[] => {
          const totals = new Map<string, number>();
          for (const p of positions) {
            totals.set(key(p), (totals.get(key(p)) ?? 0) + p.size * p.entry);
          }
          return [...totals.entries()]
            .map(([k, notional]) => ({
              key: k,
              notional: round(notional, 2),
              pct: round((notional / riskEquity) * 100, 2),
              limitPct: null,
            }))
            .sort((a, b) => b.pct - a.pct);
        };
        return {
          equity: riskEquity,
          currency: 'USD',
          positions,
          drawdownPct: 0,
          drawdownLimitPct: riskLimits.maxDrawdownPct,
          dailyLossPct: 0,
          dailyLossLimitPct: riskLimits.maxDailyLossPct,
          exposureByAsset: notionalBy((p) => p.ticker).map((s) => ({
            ...s,
            limitPct: riskLimits.maxAssetExposurePct,
          })),
          exposureBySector: notionalBy((p) => p.sector ?? 'desconocido').map((s) => ({
            ...s,
            limitPct: riskLimits.maxSectorExposurePct,
          })),
          openPositions: positions.length,
          maxOpenPositions: riskLimits.maxOpenPositions,
          updatedAt: new Date().toISOString(),
        };
      },
      onChanged: (listener) => subscribe(riskChangedListeners, listener),
      onVetoed: (listener) => subscribe(riskVetoedListeners, listener),
    },
    signals: {
      list: async (query) => {
        if (query !== undefined && !isSignalsListQuery(query)) {
          throw new Error('Filtros de señales inválidos.');
        }
        return filterSignals(query);
      },
      get: async (id) => {
        if (!isSignalId(id)) {
          throw new Error('Id de señal inválido.');
        }
        return signalsList.find((s) => s.id === id) ?? null;
      },
      strategies: async (): Promise<SignalStrategyState[]> =>
        [...new Set(strategyVersions.map((v) => v.id))].map((id) => {
          const latest = latestStrategyVersion(id)!;
          return {
            strategyId: id,
            name: latest.name,
            version: latest.version,
            status: latest.status,
            lastBarDate: null,
            lastEvaluatedAt: null,
            lastOutcome: null,
            lastSignalId: null,
          };
        }),
      onNew: (listener) => subscribe(signalNewListeners, listener),
    },
    journal: {
      list: async (query) => {
        if (query !== undefined && !isJournalListQuery(query)) {
          throw new Error('Filtros del diario inválidos.');
        }
        const rows = filterJournal(query);
        const offset = query?.offset ?? 0;
        return {
          entries: rows.slice(offset, offset + (query?.limit ?? JOURNAL_LIST_MAX_LIMIT)),
          total: rows.length,
          limit: query?.limit ?? JOURNAL_LIST_MAX_LIMIT,
          offset,
        };
      },
      get: async (id) => {
        if (!isJournalEntryId(id)) {
          throw new Error('Id de entrada inválido.');
        }
        return journalEntries.find((e) => e.id === id) ?? null;
      },
      exportCsv: async (request) => {
        if (request !== undefined && !isJournalExportRequest(request)) {
          throw new Error('Petición de exportación inválida.');
        }
        const rows = filterJournal(request?.query);
        return {
          canceled: false,
          path: request?.path ?? '/tmp/tradia-diario.csv',
          entries: rows.length,
        };
      },
      onUpdated: (listener) => subscribe(journalUpdatedListeners, listener),
    },
    delivery: {
      getConfig: async () => ({
        telegram: { ...deliveryConfig.telegram, events: [...deliveryConfig.telegram.events] },
        email: { ...deliveryConfig.email, events: [...deliveryConfig.email.events] },
      }),
      setConfig: async (config) => {
        if (!isDeliveryConfigInput(config)) {
          throw new Error('Configuración de canales inválida.');
        }
        deliveryConfig = {
          telegram: { ...config.telegram, hasToken: deliveryConfig.telegram.hasToken },
          email: { ...config.email, hasPassword: deliveryConfig.email.hasPassword },
        };
        return api.delivery.getConfig();
      },
      test: async (request) => {
        if (!isDeliveryTestRequest(request)) {
          throw new Error('Canal de prueba inválido.');
        }
        return { ok: true, error: null, latencyMs: 12 };
      },
    },
    routine: {
      getConfig: async () => ({ ...routineConfig }),
      setConfig: async (config) => {
        if (!isRoutineConfig(config)) {
          throw new Error('Horarios de la rutina inválidos (HH:MM).');
        }
        routineConfig = { ...config };
        return { ...routineConfig };
      },
    },
    backup: {
      list: async () => [...backups],
      create: async () => {
        const backup: BackupInfo = {
          fileName: `tradia-${new Date().toISOString().replace(/[:.]/g, '-')}.db`,
          sizeBytes: 0,
          createdAt: new Date().toISOString(),
          schemaVersion: 8,
          integrityOk: true,
        };
        backups.unshift(backup);
        return backup;
      },
      restore: async (request) => {
        if (!isBackupRestoreRequest(request)) {
          throw new Error('La restauración exige {fileName, confirm: true}.');
        }
        return { accepted: true };
      },
    },
    broker: {
      connect: async (request) => {
        if (!isBrokerConnectRequest(request)) {
          throw new Error('Claves del broker inválidas (alfanuméricas, sin espacios).');
        }
        brokerStatus = {
          state: 'conectada',
          adapter: 'simulado',
          account: fakeAccount(),
          executionEnabled: settings.brokerExecutionEnabled,
          error: null,
          checkedAt: nowIso(),
        };
        return { ...brokerStatus };
      },
      disconnect: async () => {
        brokerStatus = { ...brokerStatus, state: 'desconectada', account: null, error: null };
        return { ...brokerStatus };
      },
      status: async () => ({
        ...brokerStatus,
        executionEnabled: settings.brokerExecutionEnabled,
      }),
      test: async (request) => {
        if (!isBrokerTestRequest(request)) {
          throw new Error('Petición de prueba inválida (las dos claves o ninguna).');
        }
        if (request?.apiKeyId !== undefined && !isBrokerConnectRequest(request)) {
          return { ok: false, account: null, error: 'Claves inválidas.', latencyMs: 5 };
        }
        if (brokerStatus.state !== 'conectada' && request?.apiKeyId === undefined) {
          return { ok: false, account: null, error: 'No hay cuenta conectada.', latencyMs: 5 };
        }
        return { ok: true, account: fakeAccount(), error: null, latencyMs: 21 };
      },
      onOrderUpdated: (listener) => subscribe(brokerOrderUpdatedListeners, listener),
    },
    orders: {
      list: async (query) => {
        if (query !== undefined && !isBrokerOrdersQuery(query)) {
          throw new Error('Filtros de órdenes inválidos.');
        }
        let rows = [...brokerOrders].sort((a, b) => b.id - a.id);
        if (query?.status) rows = rows.filter((o) => o.status === query.status);
        if (query?.strategyId !== undefined) {
          rows = rows.filter((o) => o.strategyId === query.strategyId);
        }
        if (query?.ticker) {
          rows = rows.filter((o) => o.ticker === query.ticker!.trim().toUpperCase());
        }
        const offset = query?.offset ?? 0;
        return rows.slice(offset, offset + (query?.limit ?? rows.length));
      },
      create: async (request) => {
        if (!isCreateOrderRequest(request)) {
          throw new Error('Orden a crear inválida.');
        }
        if (brokerStatus.state !== 'conectada') {
          throw new Error('No hay cuenta conectada.');
        }
        const order = makeFakeOrder({
          clientOrderId: `tradia-manual-fake-${brokerOrderSeq + 1}`,
          ticker: request.ticker.trim().toUpperCase(),
          type: 'limit',
          side: request.side,
          quantity: request.quantity,
          limitPrice: request.limitPrice,
          status: 'enviada',
          execution: {
            requestedAt: nowIso(),
            requestedPrice: request.limitPrice,
            executedAt: null,
            executedPrice: null,
            slippageBps: null,
          },
        });
        brokerOrders.unshift(order);
        brokerOrderUpdatedListeners.forEach((listener) => listener({ ...order }));
        return { ...order };
      },
      cancel: async (request) => {
        if (!isCancelOrderRequest(request)) {
          throw new Error('Orden a cancelar inválida.');
        }
        const order = brokerOrders.find((o) => o.id === request.id);
        if (order === undefined) {
          throw new Error(`No existe la orden ${request.id}.`);
        }
        if (!(BROKER_ORDER_OPEN_STATUSES as readonly string[]).includes(order.status)) {
          throw new Error(`La orden ${request.id} ya está ${order.status} y no se puede cancelar.`);
        }
        order.status = 'cancelada';
        order.updatedAt = nowIso();
        brokerOrderUpdatedListeners.forEach((listener) => listener({ ...order }));
        return { ...order };
      },
    },
    reconcile: {
      run: async () => {
        const run: ReconcileRun = {
          id: ++reconcileSeq,
          trigger: 'manual',
          startedAt: nowIso(),
          finishedAt: nowIso(),
          result: 'ok',
          positionsApp: 0,
          positionsBroker: 0,
          ordersApp: brokerOrders.filter((o) =>
            (BROKER_ORDER_OPEN_STATUSES as readonly string[]).includes(o.status),
          ).length,
          ordersBroker: brokerOrders.filter((o) =>
            (BROKER_ORDER_OPEN_STATUSES as readonly string[]).includes(o.status),
          ).length,
          discrepancies: 0,
          error: null,
        };
        lastReconcileRun = run;
        // Una ejecución limpia cierra los descuadres abiertos y avisa.
        if (openDiscrepancies.length > 0) {
          const event: ReconcileDiscrepancyEvent = {
            runId: run.id,
            at: nowIso(),
            discrepancies: [],
          };
          openDiscrepancies = [];
          reconcileDiscrepancyListeners.forEach((listener) => listener(event));
        }
        return run;
      },
      status: async () => ({ lastRun: lastReconcileRun, openDiscrepancies }),
      onDiscrepancy: (listener) => subscribe(reconcileDiscrepancyListeners, listener),
    },
    deviation: {
      report: async (query) => {
        if (!isDeviationReportQuery(query)) {
          throw new Error('Consulta del informe inválida (periodo semanal o mensual).');
        }
        return {
          period: query.period,
          marginPp: settings.deviationMarginPp,
          maxSlippageBps: settings.deviationSlippageBps,
          generatedAt: nowIso(),
          rows: fakeDeviationRows(query.period),
        };
      },
    },
    logs: {
      openFolder: async () => ({ ok: true, path: '/tmp/tradia-logs' }),
    },
  };
  return {
    api,
    emitConnectivity,
    emitAgents,
    emitHeartbeat(at: string) {
      agents = { ...agents, lastHeartbeatAt: at };
      heartbeatListeners.forEach((listener) => listener(at));
    },
    /** Fusiona el estado del dato y notifica por dataStatus:changed. */
    emitDataStatus(entry: DataStatusEntry) {
      setStatus({ ...statuses.get(entry.key), ...entry }, true);
    },
    /** Notifica un market:updated, p. ej. tras el refresco diario. */
    emitMarketUpdated(event: MarketUpdatedEvent) {
      marketUpdatedListeners.forEach((listener) => listener(event));
    },
    /** Notifica un news:updated, p. ej. tras una pasada del lector. */
    emitNewsUpdated(event: NewsUpdatedEvent) {
      newsUpdatedListeners.forEach((listener) => listener(event));
    },
    /** Notifica un calendar:updated. */
    emitCalendarUpdated(event: CalendarUpdatedEvent) {
      calendarUpdatedListeners.forEach((listener) => listener(event));
    },
    /** Notifica un broker:order-updated (fase 5). */
    emitOrderUpdated(order: BrokerOrder) {
      brokerOrderUpdatedListeners.forEach((listener) => listener(order));
    },
    /** Notifica un reconcile:discrepancy y deja el descuadre abierto (fase 5). */
    emitReconcileDiscrepancy(discrepancies: ReconcileDiscrepancy[]) {
      openDiscrepancies = discrepancies.map((d) => ({ ...d, id: ++discrepancySeq }));
      const event: ReconcileDiscrepancyEvent = {
        runId: lastReconcileRun?.id ?? 0,
        at: new Date().toISOString(),
        discrepancies: openDiscrepancies,
      };
      reconcileDiscrepancyListeners.forEach((listener) => listener(event));
    },
    listenerCount: () =>
      connectionListeners.size +
      agentListeners.size +
      heartbeatListeners.size +
      dataStatusListeners.size +
      marketUpdatedListeners.size +
      newsUpdatedListeners.size +
      calendarUpdatedListeners.size +
      alertNavigateListeners.size +
      brokerOrderUpdatedListeners.size +
      reconcileDiscrepancyListeners.size,
  };
}
