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
 *       vela). Compra: precio × (1 + coste), venta: precio × (1 − coste),
 *       donde coste = (slippageBp + spreadBp) / 10 000.
 *    b. Se evalúan stop y objetivo con el high/low intrabarra. Si la vela
 *       toca los dos, gana el stop (conservador). Un hueco de apertura más
 *       allá del nivel ejecuta a la apertura, no al nivel.
 *    c. Si la vela procesada es la última del activo y la simulación
 *       continúa, la posición abierta se cierra al cierre ('delisted').
 * 3. Se marca el capital al cierre (efectivo + posiciones a último cierre
 *    conocido) y se añade el punto a la curva de capital.
 * 4. Se llama a `strategy.onBar` con el contexto truncado; las órdenes que
 *    emita quedan pendientes para la próxima vela de cada activo.
 *
 * Antes de `startDate` las sesiones son de calentamiento: la estrategia ve
 * las velas (`context.warmup === true`) pero sus órdenes se descartan y la
 * curva no registra puntos.
 */
import { TICKER_PATTERN, type SessionDate } from '../market/providers/types';
import {
  DEFAULT_COSTS,
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
  type PositionView,
  type StrategyContext,
  type Trade,
} from './types';

// ---------------------------------------------------------------------------
// Validación y normalización de la entrada
// ---------------------------------------------------------------------------

interface NormalizedConfig {
  initialCash: number;
  costs: CostConfig;
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

function normalizeConfig(input: BacktestInput): NormalizedConfig {
  const costs = { ...DEFAULT_COSTS, ...input.costs };
  for (const [field, value] of Object.entries(costs)) {
    assertFinite(value, `costs.${field}`);
    if (value < 0) {
      throw new RangeError(`backtest: 'costs.${field}' no puede ser negativo (${value})`);
    }
  }
  if (costs.commissionPct >= 1) {
    throw new RangeError(`backtest: 'costs.commissionPct' debe ser < 1 (${costs.commissionPct})`);
  }
  if (costs.slippageBp + costs.spreadBp >= 10_000) {
    throw new RangeError(
      `backtest: slippage + spread debe ser < 10 000 pb (${costs.slippageBp + costs.spreadBp})`,
    );
  }

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

  return { initialCash, costs, riskPerTrade, maxPositions, startDate, endDate };
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
  | { kind: 'sell'; signalDate: SessionDate };

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
    const stop = optionalPrice(options.stop, 'stop');
    const target = optionalPrice(options.target, 'target');
    this.enqueue(key, { kind: 'buy', signalDate: this.date, stop, target });
  }

  sell(ticker: string): void {
    const key = this.requireMember(ticker);
    if (this.warmup || !this.isListed(key)) return;
    this.enqueue(key, { kind: 'sell', signalDate: this.date });
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

  const pending = new Map<string, PendingOrder[]>();
  const positions = new Map<string, Position>();
  const trades: Trade[] = [];
  const equityCurve: EquityPoint[] = [];
  const context = new EngineContext({ assets, windows, pending, positions });

  let cash = config.initialCash;
  let lastEquity = config.initialCash;

  const buyFactor = 1 + (config.costs.slippageBp + config.costs.spreadBp) / 10_000;
  const sellFactor = 1 - (config.costs.slippageBp + config.costs.spreadBp) / 10_000;

  const commission = (notional: number): number =>
    Math.max(config.costs.commissionMin, notional * config.costs.commissionPct);

  /** Máximo de acciones que el efectivo permite, comisión incluida. */
  const affordableShares = (fill: number): number => {
    const byPct =
      config.costs.commissionPct > 0
        ? cash / (fill * (1 + config.costs.commissionPct))
        : Number.POSITIVE_INFINITY;
    const byMin =
      config.costs.commissionMin > 0 ? (cash - config.costs.commissionMin) / fill : cash / fill;
    return Math.max(0, Math.floor(Math.min(byPct, byMin)));
  };

  /** Acciones por riesgo si el stop es válido; si no, un slot de equity/maxPositions. */
  const desiredShares = (fill: number, order: Extract<PendingOrder, { kind: 'buy' }>): number => {
    const perShareRisk = order.stop !== null ? fill - order.stop : 0;
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
    const exitPrice = basePrice * sellFactor;
    const proceeds = position.shares * exitPrice;
    const exitCommission = commission(proceeds);
    const exitSlippage = (basePrice - exitPrice) * position.shares;
    cash += proceeds - exitCommission;
    positions.delete(position.ticker);
    const totalCommission = position.entryCommission + exitCommission;
    const grossPnl = (exitPrice - position.entryPrice) * position.shares;
    trades.push({
      ticker: position.ticker,
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
    const fill = bar.open * buyFactor;
    const shares = Math.min(desiredShares(fill, order), affordableShares(fill));
    if (shares < 1) return;
    const notional = shares * fill;
    const entryCommission = commission(notional);
    cash -= notional + entryCommission;
    positions.set(asset.ticker, {
      ticker: asset.ticker,
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

  input.strategy.init(input.params ?? {});

  for (let index = 0; index < timeline.length; index++) {
    const date = timeline[index]!;
    const warmup = config.startDate !== null && date < config.startDate;

    for (const asset of tickersOfDate.get(date)!) {
      const bar = asset.bars[asset.revealed]!;
      asset.revealed++;
      if (warmup) continue;

      // (a) Órdenes pendientes: se llenan a la apertura de esta vela.
      const orders = pending.get(asset.ticker) ?? [];
      pending.delete(asset.ticker);
      for (const order of orders) {
        if (order.kind === 'buy') {
          fillBuy(asset, bar, order);
        } else {
          const position = positions.get(asset.ticker);
          if (position !== undefined) closePosition(position, bar.date, bar.open, 'signal');
        }
      }

      // (b) Stop y objetivo con high/low intrabarra; si toca los dos, el stop primero.
      const position = positions.get(asset.ticker);
      if (position !== undefined) {
        if (position.stop !== null && bar.low <= position.stop) {
          closePosition(position, bar.date, Math.min(bar.open, position.stop), 'stop');
        } else if (position.target !== null && bar.high >= position.target) {
          closePosition(position, bar.date, Math.max(bar.open, position.target), 'target');
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

    // Marca al cierre: último precio conocido de cada posición.
    let equity = cash;
    for (const position of positions.values()) {
      equity += position.shares * lastCloseOf(position.ticker);
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
