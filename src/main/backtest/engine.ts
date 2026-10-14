/**
 * Motor de backtest vela a vela sin look-ahead — Fase 2.
 *
 * Módulo puro: sin Electron, sin Node, sin estado global. Recibe velas por
 * ticker, una `Strategy` y la configuración de costes; devuelve las
 * operaciones cerradas y la curva de capital diaria (ver `types.ts`).
 *
 * Recorrido de cada sesión d (línea temporal = unión ordenada de las fechas
 * de vela de todos los activos, recortada a `endDate`):
 *
 * 1. Se revelan las velas de fecha d — la estrategia nunca puede leer más
 *    allá: `BarWindow` trunca la serie y lanza `LookAheadError` ante
 *    cualquier índice fuera de lo revelado.
 * 2. Si d está dentro del periodo operable (>= `startDate`):
 *    a. Se ejecutan las órdenes pendientes de cada activo a su apertura
 *       (las señales del cierre anterior se llenan hoy, nunca en la misma
 *       vela). Compra y recompra de corto: precio × (1 + coste); venta y
 *       apertura en corto: precio × (1 − coste), donde coste =
 *       (slippageBp + spreadBp) / 10 000. Si en la misma señal llegan una
 *       apertura en largo y una en corto del mismo activo, se anulan: no
 *       hay largo y corto simultáneos ni cambio de lado en una orden.
 *    b. Se evalúan stop y objetivo con el high/low intrabarra —en el
 *       corto el stop está por encima y el objetivo por debajo—. Si la
 *       vela toca los dos, gana el stop (conservador). Un hueco de
 *       apertura más allá del nivel ejecuta a la apertura, no al nivel.
 *    c. Si la vela procesada es la última del activo y la simulación
 *       continúa, la posición abierta se cierra al cierre ('delisted').
 * 3. Se marca el capital al cierre (efectivo + posiciones a último cierre
 *    conocido) y se añade el punto a la curva de capital.
 * 4. Se llama a `strategy.onBar` con el contexto truncado; las órdenes que
 *    emita quedan pendientes para la próxima vela de cada activo.
 *
 * Costes por activo: un par de divisas (EURUSD…) usa los costes de
 * divisas (`fxCosts`, por defecto `DEFAULT_FX_COSTS`: deslizamiento fijo
 * de 2 pb, sin comisión ni spread aparte); el resto de activos, `costs`.
 * Así un universo mixto cobra a cada activo su coste propio.
 *
 * Antes de `startDate` las sesiones son de calentamiento: la estrategia ve
 * las velas (`context.warmup === true`) pero sus órdenes se descartan y la
 * curva no registra puntos.
 */
import { REGIME_LABELS, REGIME_MARKET_TICKER, type RegimeLabel } from '../../shared/ai';
import { isFxSymbol } from '../../shared/fxTrading';
import { TICKER_PATTERN, type SessionDate } from '../market/providers/types';
import { createRegimeClassifier } from '../ai/regime/classifier';
import { resolveStrategyRegime } from '../ai/regime/enablement';
import {
  DEFAULT_COSTS,
  DEFAULT_FX_COSTS,
  DEFAULT_INITIAL_CASH,
  DEFAULT_MAX_POSITIONS,
  DEFAULT_RISK_PER_TRADE,
  LookAheadError,
  MAX_RISK_PER_TRADE,
  MIN_RISK_PER_TRADE,
  type BacktestInput,
  type BacktestResult,
  type BarWindow,
  type BuyOptions,
  type CostConfig,
  type EngineBar,
  type EquityPoint,
  type ExitReason,
  type PositionSide,
  type PositionView,
  type ShortOptions,
  type StrategyContext,
  type Trade,
} from './types';

// ---------------------------------------------------------------------------
// Validación y normalización de la entrada
// ---------------------------------------------------------------------------

interface NormalizedConfig {
  initialCash: number;
  costs: CostConfig;
  /** Costes de los pares de divisas. */
  fxCosts: CostConfig;
  riskPerTrade: number;
  maxPositions: number;
  startDate: SessionDate | null;
  endDate: SessionDate | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertFinite(value: number, field: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`backtest: '${field}' no es un número finito (${String(value)})`);
  }
}

function normalizeCosts(costs: CostConfig, field: 'costs' | 'fxCosts'): CostConfig {
  for (const [key, value] of Object.entries(costs)) {
    assertFinite(value, `${field}.${key}`);
    if (value < 0) {
      throw new RangeError(`backtest: '${field}.${key}' no puede ser negativo (${value})`);
    }
  }
  if (costs.commissionPct >= 1) {
    throw new RangeError(
      `backtest: '${field}.commissionPct' debe ser < 1 (${costs.commissionPct})`,
    );
  }
  if (costs.slippageBp + costs.spreadBp >= 10_000) {
    throw new RangeError(
      `backtest: slippage + spread debe ser < 10 000 pb (${costs.slippageBp + costs.spreadBp})`,
    );
  }
  return costs;
}

function normalizeConfig(input: BacktestInput): NormalizedConfig {
  const costs = normalizeCosts({ ...DEFAULT_COSTS, ...input.costs }, 'costs');
  const fxCosts = normalizeCosts({ ...DEFAULT_FX_COSTS, ...input.fxCosts }, 'fxCosts');

  const initialCash = input.initialCash ?? DEFAULT_INITIAL_CASH;
  assertFinite(initialCash, 'initialCash');
  if (initialCash <= 0) {
    throw new RangeError(`backtest: 'initialCash' debe ser > 0 (${initialCash})`);
  }

  const riskPerTrade = input.riskPerTrade ?? DEFAULT_RISK_PER_TRADE;
  assertFinite(riskPerTrade, 'riskPerTrade');
  if (riskPerTrade < MIN_RISK_PER_TRADE || riskPerTrade > MAX_RISK_PER_TRADE) {
    throw new RangeError(
      `backtest: 'riskPerTrade' debe estar entre ${MIN_RISK_PER_TRADE} y ${MAX_RISK_PER_TRADE} (${riskPerTrade})`,
    );
  }

  const maxPositions = input.maxPositions ?? DEFAULT_MAX_POSITIONS;
  if (!Number.isInteger(maxPositions) || maxPositions < 1) {
    throw new RangeError(`backtest: 'maxPositions' debe ser un entero >= 1 (${maxPositions})`);
  }

  const startDate = input.startDate ?? null;
  const endDate = input.endDate ?? null;
  for (const [field, value] of [
    ['startDate', startDate],
    ['endDate', endDate],
  ] as const) {
    if (value !== null && !ISO_DATE.test(value)) {
      throw new RangeError(`backtest: '${field}' inválida (${JSON.stringify(value)})`);
    }
  }
  if (startDate !== null && endDate !== null && startDate > endDate) {
    throw new RangeError(
      `backtest: rango invertido, startDate (${startDate}) > endDate (${endDate})`,
    );
  }

  return { initialCash, costs, fxCosts, riskPerTrade, maxPositions, startDate, endDate };
}

interface ListingWindow {
  from: SessionDate | null;
  until: SessionDate | null;
}

function normalizeUniverse(input: BacktestInput): Map<string, ListingWindow> {
  const members = new Map<string, ListingWindow>();
  if (input.universe === undefined) {
    for (const ticker of Object.keys(input.bars)) {
      members.set(normalizeTicker(ticker), { from: null, until: null });
    }
    return members;
  }
  for (const member of input.universe) {
    const ticker = normalizeTicker(member.ticker);
    const { listedFrom = null, listedUntil = null } = member;
    if (listedFrom !== null && !ISO_DATE.test(listedFrom)) {
      throw new RangeError(`backtest: 'listedFrom' de ${ticker} inválida (${listedFrom})`);
    }
    if (listedUntil !== null && !ISO_DATE.test(listedUntil)) {
      throw new RangeError(`backtest: 'listedUntil' de ${ticker} inválida (${listedUntil})`);
    }
    if (listedFrom !== null && listedUntil !== null && listedFrom > listedUntil) {
      throw new RangeError(
        `backtest: ventana de cotización de ${ticker} invertida (${listedFrom} > ${listedUntil})`,
      );
    }
    members.set(ticker, { from: listedFrom, until: listedUntil });
  }
  return members;
}

function normalizeTicker(ticker: string): string {
  const normalized = typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';
  if (!TICKER_PATTERN.test(normalized)) {
    throw new RangeError(`backtest: ticker inválido (${JSON.stringify(ticker)})`);
  }
  return normalized;
}

/**
 * Valida la opción `regimeFilter`: objeto con dos listas de etiquetas de
 * régimen conocidas (la regla worksIn/failsIn la resuelve el motor con
 * `resolveStrategyRegime`, igual que la página «IA»).
 */
function assertRegimeLabels(labels: unknown, field: string): asserts labels is RegimeLabel[] {
  if (!Array.isArray(labels)) {
    throw new TypeError(`backtest: 'regimeFilter.${field}' debe ser una lista de etiquetas`);
  }
  for (const label of labels) {
    if (!(REGIME_LABELS as readonly string[]).includes(label as string)) {
      throw new RangeError(
        `backtest: 'regimeFilter.${field}' tiene una etiqueta desconocida (${JSON.stringify(label)})`,
      );
    }
  }
}

interface AssetState {
  ticker: string;
  /** Velas revelables: copias congeladas dentro de la ventana de cotización. */
  bars: EngineBar[];
  /** Velas ya reveladas (las que tienen fecha <= la fecha actual). */
  revealed: number;
}

/**
 * Copia, filtra y valida las velas de un miembro del universo. Las velas se
 * congelan para que la estrategia no pueda alterar su propio historial.
 */
function buildAsset(
  ticker: string,
  rawBars: readonly EngineBar[],
  window: ListingWindow,
  endDate: SessionDate | null,
): AssetState {
  const bars: EngineBar[] = [];
  let previousDate: SessionDate | null = null;
  for (const raw of rawBars) {
    const { date, open, high, low, close } = raw;
    if (!ISO_DATE.test(date)) {
      throw new RangeError(
        `backtest: ${ticker} tiene una fecha inválida (${JSON.stringify(date)})`,
      );
    }
    if (previousDate !== null && date <= previousDate) {
      throw new RangeError(
        `backtest: ${ticker} tiene velas desordenadas o duplicadas (${date} tras ${previousDate})`,
      );
    }
    for (const [field, value] of [
      ['open', open],
      ['high', high],
      ['low', low],
      ['close', close],
    ] as const) {
      assertFinite(value, `${ticker} ${date} ${field}`);
      if (value <= 0) {
        throw new RangeError(`backtest: ${ticker} ${date} '${field}' debe ser > 0 (${value})`);
      }
    }
    if (high < low) {
      throw new RangeError(`backtest: ${ticker} ${date} high (${high}) < low (${low})`);
    }
    previousDate = date;
    if (window.from !== null && date < window.from) continue;
    if (window.until !== null && date > window.until) continue;
    if (endDate !== null && date > endDate) continue;
    bars.push(Object.freeze({ ...raw }));
  }
  return { ticker, bars, revealed: 0 };
}

// ---------------------------------------------------------------------------
// Estado interno de la simulación
// ---------------------------------------------------------------------------

interface Position {
  ticker: string;
  /** 'largo' comprada; 'corto' vendida (el nominal cuenta como exposición). */
  side: PositionSide;
  shares: number;
  entryPrice: number;
  entryDate: SessionDate;
  signalDate: SessionDate;
  entryCommission: number;
  /** Coste monetario de slippage+spread ya pagado en la entrada. */
  entrySlippage: number;
  stop: number | null;
  target: number | null;
}

type PendingOrder =
  | { kind: 'buy'; signalDate: SessionDate; stop: number | null; target: number | null }
  | { kind: 'sell'; signalDate: SessionDate }
  | { kind: 'short'; signalDate: SessionDate; stop: number | null; target: number | null }
  | { kind: 'cover'; signalDate: SessionDate };

// ---------------------------------------------------------------------------
// Vista truncada de velas (barrera anti look-ahead)
// ---------------------------------------------------------------------------

class TruncatedBarWindow implements BarWindow {
  constructor(private readonly asset: AssetState) {}

  get length(): number {
    return this.asset.revealed;
  }

  get lastDate(): SessionDate | null {
    return this.asset.revealed > 0 ? this.asset.bars[this.asset.revealed - 1]!.date : null;
  }

  at(index: number): EngineBar {
    if (!Number.isInteger(index) || index < 0 || index >= this.asset.revealed) {
      throw new LookAheadError(
        `backtest: ${this.asset.ticker} índice ${String(index)} fuera del historial visible (0..${this.asset.revealed - 1})`,
      );
    }
    return this.asset.bars[index]!;
  }

  back(offset = 0): EngineBar {
    return this.at(this.asset.revealed - 1 - offset);
  }

  last(): EngineBar {
    return this.at(this.asset.revealed - 1);
  }

  slice(): EngineBar[] {
    return this.asset.bars.slice(0, this.asset.revealed);
  }
}

// ---------------------------------------------------------------------------
// Contexto entregado a la estrategia
// ---------------------------------------------------------------------------

interface ContextDeps {
  assets: Map<string, AssetState>;
  windows: Map<string, ListingWindow>;
  pending: Map<string, PendingOrder[]>;
  positions: Map<string, Position>;
  /**
   * Filtro de régimen (fase 6): por sesión, si la estrategia puede abrir
   * operaciones (`false` = desactivada por el régimen de la referencia en
   * esa fecha). null sin filtro: el motor se comporta como en la fase 2.
   */
  regimeEnabled: Map<SessionDate, boolean> | null;
}

class EngineContext implements StrategyContext {
  date: SessionDate = '';
  index = 0;
  warmup = false;
  cash = 0;
  equity = 0;

  private readonly sortedMembers: string[];

  constructor(private readonly deps: ContextDeps) {
    this.sortedMembers = [...deps.assets.keys()].sort();
  }

  tickers(): string[] {
    const window = this.deps.windows;
    return this.sortedMembers.filter((ticker) => {
      const w = window.get(ticker)!;
      return (w.from === null || this.date >= w.from) && (w.until === null || this.date <= w.until);
    });
  }

  universeTickers(): string[] {
    return [...this.sortedMembers];
  }

  isListed(ticker: string): boolean {
    const w = this.deps.windows.get(normalizeTicker(ticker));
    if (w === undefined) return false;
    return (w.from === null || this.date >= w.from) && (w.until === null || this.date <= w.until);
  }

  bars(ticker: string): BarWindow {
    const asset = this.deps.assets.get(normalizeTicker(ticker));
    if (asset === undefined) {
      throw new RangeError(`backtest: '${ticker}' no pertenece al universo del backtest`);
    }
    return new TruncatedBarWindow(asset);
  }

  position(ticker: string): PositionView | null {
    const position = this.deps.positions.get(normalizeTicker(ticker));
    return position === undefined ? null : positionView(position);
  }

  positions(): PositionView[] {
    return [...this.deps.positions.values()].map(positionView);
  }

  buy(ticker: string, options: BuyOptions = {}): void {
    const key = this.requireMember(ticker);
    if (this.warmup || !this.isListed(key)) return;
    // Filtro de régimen: la señal de entrada de una sesión desactivada se
    // descarta. Las salidas y los stops nunca se bloquean.
    if (this.deps.regimeEnabled?.get(this.date) === false) return;
    const stop = optionalPrice(options.stop, 'stop');
    const target = optionalPrice(options.target, 'target');
    this.enqueue(key, { kind: 'buy', signalDate: this.date, stop, target });
  }

  sell(ticker: string): void {
    const key = this.requireMember(ticker);
    if (this.warmup || !this.isListed(key)) return;
    this.enqueue(key, { kind: 'sell', signalDate: this.date });
  }

  short(ticker: string, options: ShortOptions = {}): void {
    const key = this.requireMember(ticker);
    if (this.warmup || !this.isListed(key)) return;
    // La apertura en corto es una entrada: el filtro de régimen la
    // bloquea igual que la compra.
    if (this.deps.regimeEnabled?.get(this.date) === false) return;
    const stop = optionalPrice(options.stop, 'stop');
    const target = optionalPrice(options.target, 'target');
    this.enqueue(key, { kind: 'short', signalDate: this.date, stop, target });
  }

  cover(ticker: string): void {
    const key = this.requireMember(ticker);
    if (this.warmup || !this.isListed(key)) return;
    this.enqueue(key, { kind: 'cover', signalDate: this.date });
  }

  setStop(ticker: string, price: number): void {
    const position = this.deps.positions.get(this.requireMember(ticker));
    if (position === undefined) return;
    assertFinite(price, 'stop');
    if (price <= 0) throw new RangeError(`backtest: 'stop' debe ser > 0 (${price})`);
    position.stop = price;
  }

  setTarget(ticker: string, price: number): void {
    const position = this.deps.positions.get(this.requireMember(ticker));
    if (position === undefined) return;
    assertFinite(price, 'target');
    if (price <= 0) throw new RangeError(`backtest: 'target' debe ser > 0 (${price})`);
    position.target = price;
  }

  private requireMember(ticker: string): string {
    const key = normalizeTicker(ticker);
    if (!this.deps.assets.has(key)) {
      throw new RangeError(`backtest: '${ticker}' no pertenece al universo del backtest`);
    }
    return key;
  }

  private enqueue(ticker: string, order: PendingOrder): void {
    const list = this.deps.pending.get(ticker) ?? [];
    list.push(order);
    this.deps.pending.set(ticker, list);
  }
}

function optionalPrice(value: number | undefined, field: string): number | null {
  if (value === undefined) return null;
  assertFinite(value, field);
  if (value <= 0) throw new RangeError(`backtest: '${field}' debe ser > 0 (${value})`);
  return value;
}

function positionView(position: Position): PositionView {
  return {
    ticker: position.ticker,
    side: position.side,
    shares: position.shares,
    entryPrice: position.entryPrice,
    entryDate: position.entryDate,
    stopPrice: position.stop,
    targetPrice: position.target,
  };
}

// ---------------------------------------------------------------------------
// Motor
// ---------------------------------------------------------------------------

export function runBacktest(input: BacktestInput): BacktestResult {
  if (
    input === null ||
    typeof input !== 'object' ||
    typeof input.strategy?.init !== 'function' ||
    typeof input.strategy?.onBar !== 'function'
  ) {
    throw new TypeError('backtest: se espera una estrategia con init(params) y onBar(context)');
  }

  const config = normalizeConfig(input);
  const windows = normalizeUniverse(input);
  const barsByTicker = new Map<string, readonly EngineBar[]>();
  for (const [ticker, bars] of Object.entries(input.bars)) {
    barsByTicker.set(normalizeTicker(ticker), bars);
  }
  const assets = new Map<string, AssetState>();
  for (const [ticker, window] of windows) {
    assets.set(ticker, buildAsset(ticker, barsByTicker.get(ticker) ?? [], window, config.endDate));
  }

  // Línea temporal: unión ordenada de las fechas de vela de todos los activos.
  const tickersOfDate = new Map<SessionDate, AssetState[]>();
  for (const asset of assets.values()) {
    for (const bar of asset.bars) {
      const list = tickersOfDate.get(bar.date) ?? [];
      list.push(asset);
      tickersOfDate.set(bar.date, list);
    }
  }
  const timeline = [...tickersOfDate.keys()].sort();
  const lastTimelineDate = timeline.length > 0 ? timeline[timeline.length - 1]! : null;

  // Filtro de régimen (fase 6): la etiqueta de cada sesión se calcula solo
  // con las velas de la referencia reveladas hasta ella (`refIndex` avanza
  // con la línea temporal y `classifyAt` es causal por construcción). La
  // misma regla que la página «IA»: la ficha queda desactivada si una
  // etiqueta vigente está en `failsIn`, o si `worksIn` no está vacío y no
  // contiene ninguna. El estado del ciclo de vida no participa en el
  // backtest —'degradada' es un diagnóstico de salud, no histórico—, así
  // que se resuelve siempre con 'activa'.
  let regimeEnabled: Map<SessionDate, boolean> | null = null;
  if (input.regimeFilter !== undefined) {
    const filter = input.regimeFilter;
    if (filter === null || typeof filter !== 'object') {
      throw new TypeError('backtest: se esperaba regimeFilter con worksIn y failsIn');
    }
    assertRegimeLabels(filter.worksIn, 'worksIn');
    assertRegimeLabels(filter.failsIn, 'failsIn');
    const refTicker = normalizeTicker(filter.referenceTicker ?? REGIME_MARKET_TICKER);
    const refRaw = barsByTicker.get(refTicker);
    if (refRaw === undefined || refRaw.length === 0) {
      throw new RangeError(
        `backtest: el filtro de régimen necesita velas de la referencia '${refTicker}' ` +
          "en 'bars' (puede no pertenecer al universo)",
      );
    }
    const refBars = buildAsset(refTicker, refRaw, { from: null, until: null }, config.endDate).bars;
    const classifier = createRegimeClassifier(refBars);
    regimeEnabled = new Map<SessionDate, boolean>();
    let refIndex = 0;
    for (const date of timeline) {
      while (refIndex < refBars.length && refBars[refIndex]!.date <= date) {
        refIndex++;
      }
      const current = refIndex === 0 ? null : classifier.classifyAt(refIndex - 1);
      regimeEnabled.set(
        date,
        resolveStrategyRegime(filter, 'activa', current).regimeState !== 'desactivada',
      );
    }
  }

  const pending = new Map<string, PendingOrder[]>();
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  const context = new EngineContext({ assets, windows, pending, positions, regimeEnabled });

  let cash = config.initialCash;
  let lastEquity = config.initialCash;

  /** Costes del activo: los de divisas para un par, los generales para el resto. */
  const costsOf = (ticker: string): CostConfig =>
    isFxSymbol(ticker) ? config.fxCosts : config.costs;
  const buyFactorOf = (ticker: string): number => {
    const costs = costsOf(ticker);
    return 1 + (costs.slippageBp + costs.spreadBp) / 10_000;
  };
  const sellFactorOf = (ticker: string): number => {
    const costs = costsOf(ticker);
    return 1 - (costs.slippageBp + costs.spreadBp) / 10_000;
  };

  const commission = (ticker: string, notional: number): number => {
    const costs = costsOf(ticker);
    return Math.max(costs.commissionMin, notional * costs.commissionPct);
  };

  /**
   * Nominal comprometido en cortos abiertos (acciones × precio de
   * entrada): es la garantía retenida y cuenta para la exposición, así
   * que ni sus cobros inflan el capital disponible ni se puede abrir un
   * corto por encima del capital.
   */
  const openShortNotional = (): number => {
    let total = 0;
    for (const position of positions.values()) {
      if (position.side === 'corto') {
        total += position.shares * position.entryPrice;
      }
    }
    return total;
  };

  /**
   * Capital usable para una posición nueva: el efectivo, pero nunca más
   * que el capital menos el nominal corto ya comprometido (el cobro de
   * una venta en corto se queda de garantía, no es libre). Con solo
   * largos equivale a `cash`.
   */
  const affordCapital = (): number => Math.max(0, Math.min(cash, lastEquity - openShortNotional()));

  /** Máximo de acciones que el capital disponible permite, comisión incluida. */
  const affordableShares = (ticker: string, fill: number): number => {
    const base = affordCapital();
    const costs = costsOf(ticker);
    const byPct =
      costs.commissionPct > 0
        ? base / (fill * (1 + costs.commissionPct))
        : Number.POSITIVE_INFINITY;
    const byMin = costs.commissionMin > 0 ? (base - costs.commissionMin) / fill : base / fill;
    return Math.max(0, Math.floor(Math.min(byPct, byMin)));
  };

  /** Máximo de acciones de un corto: la comisión sale del cobro de la venta. */
  const shortAffordableShares = (fill: number): number =>
    Math.max(0, Math.floor(affordCapital() / fill));

  /** Acciones por riesgo si el stop es válido; si no, un slot de equity/maxPositions. */
  const desiredShares = (
    fill: number,
    order: Extract<PendingOrder, { kind: 'buy' } | { kind: 'short' }>,
  ): number => {
    const perShareRisk =
      order.stop !== null ? (order.kind === 'buy' ? fill - order.stop : order.stop - fill) : 0;
    if (perShareRisk > 0) {
      return Math.floor((lastEquity * config.riskPerTrade) / perShareRisk);
    }
    return Math.floor(lastEquity / config.maxPositions / fill);
  };

  const lastCloseOf = (ticker: string): number => {
    const asset = assets.get(ticker)!;
    return asset.bars[asset.revealed - 1]!.close;
  };

  const closePosition = (
    position: Position,
    date: SessionDate,
    basePrice: number,
    reason: ExitReason,
  ): void => {
    const isLong = position.side === 'largo';
    // El coste siempre en contra: el largo vende por debajo del precio y
    // el corto recompra por encima.
    const exitPrice =
      basePrice * (isLong ? sellFactorOf(position.ticker) : buyFactorOf(position.ticker));
    const value = position.shares * exitPrice;
    const exitCommission = commission(position.ticker, value);
    const exitSlippage = Math.abs(exitPrice - basePrice) * position.shares;
    if (isLong) {
      cash += value - exitCommission;
    } else {
      cash -= value + exitCommission;
    }
    positions.delete(position.ticker);
    const totalCommission = position.entryCommission + exitCommission;
    const grossPnl = isLong
      ? (exitPrice - position.entryPrice) * position.shares
      : (position.entryPrice - exitPrice) * position.shares;
    trades.push({
      ticker: position.ticker,
      side: position.side,
      signalDate: position.signalDate,
      entryDate: position.entryDate,
      entryPrice: position.entryPrice,
      exitDate: date,
      exitPrice,
      shares: position.shares,
      commission: totalCommission,
      slippage: position.entrySlippage + exitSlippage,
      grossPnl,
      pnl: grossPnl - totalCommission,
      exitReason: reason,
    });
  };

  const fillBuy = (
    asset: AssetState,
    bar: EngineBar,
    order: Extract<PendingOrder, { kind: 'buy' }>,
  ): void => {
    if (positions.has(asset.ticker) || positions.size >= config.maxPositions) return;
    const fill = bar.open * buyFactorOf(asset.ticker);
    const shares = Math.min(desiredShares(fill, order), affordableShares(asset.ticker, fill));
    if (shares < 1) return;
    const notional = shares * fill;
    const entryCommission = commission(asset.ticker, notional);
    cash -= notional + entryCommission;
    positions.set(asset.ticker, {
      ticker: asset.ticker,
      side: 'largo',
      shares,
      entryPrice: fill,
      entryDate: bar.date,
      signalDate: order.signalDate,
      entryCommission,
      entrySlippage: (fill - bar.open) * shares,
      stop: order.stop,
      target: order.target,
    });
  };

  const fillShort = (
    asset: AssetState,
    bar: EngineBar,
    order: Extract<PendingOrder, { kind: 'short' }>,
  ): void => {
    if (positions.has(asset.ticker) || positions.size >= config.maxPositions) return;
    // Abrir un corto es vender: el precio ejecutado queda por debajo de la
    // apertura (slippage + spread en contra) y el cobro entra en caja como
    // garantía retenida —`openShortNotional` lo descuenta de la exposición—.
    const fill = bar.open * sellFactorOf(asset.ticker);
    const shares = Math.min(desiredShares(fill, order), shortAffordableShares(fill));
    if (shares < 1) return;
    const notional = shares * fill;
    const entryCommission = commission(asset.ticker, notional);
    if (notional - entryCommission <= 0) return;
    cash += notional - entryCommission;
    positions.set(asset.ticker, {
      ticker: asset.ticker,
      side: 'corto',
      shares,
      entryPrice: fill,
      entryDate: bar.date,
      signalDate: order.signalDate,
      entryCommission,
      entrySlippage: (bar.open - fill) * shares,
      stop: order.stop,
      target: order.target,
    });
  };

  input.strategy.init(input.params ?? {});

  for (let index = 0; index < timeline.length; index++) {
    const date = timeline[index]!;
    const warmup = config.startDate !== null && date < config.startDate;

    for (const asset of tickersOfDate.get(date)!) {
      const bar = asset.bars[asset.revealed]!;
      asset.revealed++;
      if (warmup) continue;

      // (a) Órdenes pendientes: se llenan a la apertura de esta vela.
      // Si la misma señal trae una apertura en largo y una en corto del
      // activo se anulan entre sí: no hay largo y corto a la vez ni una
      // entrada que dependa del orden de emisión.
      const orders = pending.get(asset.ticker) ?? [];
      pending.delete(asset.ticker);
      const conflictedEntry =
        orders.some((order) => order.kind === 'buy') &&
        orders.some((order) => order.kind === 'short');
      for (const order of orders) {
        if (conflictedEntry && (order.kind === 'buy' || order.kind === 'short')) continue;
        switch (order.kind) {
          case 'buy':
            fillBuy(asset, bar, order);
            break;
          case 'short':
            fillShort(asset, bar, order);
            break;
          case 'sell': {
            const position = positions.get(asset.ticker);
            if (position !== undefined && position.side === 'largo') {
              closePosition(position, bar.date, bar.open, 'signal');
            }
            break;
          }
          case 'cover': {
            const position = positions.get(asset.ticker);
            if (position !== undefined && position.side === 'corto') {
              closePosition(position, bar.date, bar.open, 'signal');
            }
            break;
          }
        }
      }

      // (b) Stop y objetivo con high/low intrabarra; si toca los dos, el
      // stop primero. En el corto el stop está por encima (lo toca el
      // high) y el objetivo por debajo (lo toca el low).
      const position = positions.get(asset.ticker);
      if (position !== undefined) {
        if (position.side === 'largo') {
          if (position.stop !== null && bar.low <= position.stop) {
            closePosition(position, bar.date, Math.min(bar.open, position.stop), 'stop');
          } else if (position.target !== null && bar.high >= position.target) {
            closePosition(position, bar.date, Math.max(bar.open, position.target), 'target');
          }
        } else {
          if (position.stop !== null && bar.high >= position.stop) {
            closePosition(position, bar.date, Math.max(bar.open, position.stop), 'stop');
          } else if (position.target !== null && bar.low <= position.target) {
            closePosition(position, bar.date, Math.min(bar.open, position.target), 'target');
          }
        }
      }

      // (c) Si esta es la última vela del activo y la simulación continúa, la
      // posición se cierra al cierre: el activo dejó de cotizar.
      if (asset.revealed === asset.bars.length) {
        pending.delete(asset.ticker);
        const open = positions.get(asset.ticker);
        if (open !== undefined && date < lastTimelineDate!) {
          closePosition(open, bar.date, bar.close, 'delisted');
        }
      }
    }

    // Marca al cierre: último precio conocido de cada posición. El corto
    // resta: recomprarlo al último cierre es un pasivo.
    let equity = cash;
    for (const position of positions.values()) {
      const lastClose = lastCloseOf(position.ticker);
      equity +=
        position.side === 'largo' ? position.shares * lastClose : -position.shares * lastClose;
    }
    lastEquity = equity;
    if (!warmup) {
      equityCurve.push({ date, cash, equity, positions: positions.size });
    }

    context.date = date;
    context.index = index;
    context.warmup = warmup;
    context.cash = cash;
    context.equity = equity;
    input.strategy.onBar(context);
  }

  // Cierre forzoso de lo que siga abierto en la última vela de cada activo.
  if (lastTimelineDate !== null) {
    for (const position of [...positions.values()]) {
      closePosition(position, lastTimelineDate, lastCloseOf(position.ticker), 'end-of-data');
    }
    // El último punto de la curva refleja el capital tras las liquidaciones.
    if (equityCurve.length > 0) {
      equityCurve[equityCurve.length - 1] = {
        date: lastTimelineDate,
        cash,
        equity: cash,
        positions: 0,
      };
      lastEquity = cash;
    }
  }

  return {
    trades,
    equityCurve,
    initialCash: config.initialCash,
    finalEquity: equityCurve.length > 0 ? lastEquity : config.initialCash,
  };
}
