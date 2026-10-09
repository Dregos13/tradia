/**
 * Sonda de estrategia para el motor de señales — Fase 4.
 *
 * Reproduce la semántica del motor de backtest (`backtest/engine.ts`) con
 * la mínima maquinaria necesaria para saber «qué ordenaría hoy esta
 * estrategia»: las velas se revelan sesión a sesión (la estrategia nunca
 * ve el futuro), las órdenes llenan en la apertura de la siguiente vela
 * del activo, stop y objetivo se evalúan intrabarra (el stop primero, con
 * el hueco de apertura ejecutando a la apertura) y un activo sin más
 * velas liquida su posición. El resultado son las órdenes que la
 * estrategia emite en la última sesión de la serie: cada una es una
 * propuesta de señal ('buy' → largo, 'sell' → corto/venta).
 *
 * Módulo puro: sin Electron, sin Node, sin estado global. Las diferencias
 * deliberadas frente al backtest:
 * - Las posiciones se dimensionan a 1 unidad: la señal propone
 *   dirección/precio/stop/objetivo y el tamaño lo decide la pasarela de
 *   riesgo, no la estrategia. `cash`/`equity` del contexto son marcas
 *   aproximadas (ninguna estrategia clásica los usa para decidir).
 * - Las comisiones y el deslizamiento no alteran la presencia de las
 *   posiciones, solo su precio, así que se ignoran.
 */
import type {
  BarWindow,
  EngineBar,
  PositionView,
  Strategy,
  StrategyContext,
  StrategyParams,
} from '../backtest/types';
import { DEFAULT_INITIAL_CASH, DEFAULT_MAX_POSITIONS } from '../backtest/types';
import type { SessionDate } from '../market/providers/types';

/** Orden que la estrategia emitió en la última sesión de la serie. */
export interface ProbeOrder {
  ticker: string;
  kind: 'buy' | 'sell';
  /** Cierre de la última vela visible del activo (precio de referencia). */
  referencePrice: number;
  stop: number | null;
  target: number | null;
}

export interface ProbeInput {
  /** Instancia fresca de la estrategia (backtest/strategies). */
  strategy: Strategy;
  /** Parámetros para `strategy.init` (los de la versión vigente). */
  params?: StrategyParams;
  /** Velas por ticker, orden ascendente, ya truncadas a la fecha de corte. */
  bars: Record<string, readonly EngineBar[]>;
  /** Tope de posiciones simultáneas (def. 5, como el motor de backtest). */
  maxPositions?: number;
}

// ---------------------------------------------------------------------------
// Estado interno de la sonda
// ---------------------------------------------------------------------------

interface ProbeAsset {
  ticker: string;
  /** Copia congelada de las velas (la estrategia no puede alterarlas). */
  bars: EngineBar[];
  /** Velas ya reveladas (fecha <= sesión en curso). */
  revealed: number;
}

interface ProbePosition {
  ticker: string;
  entryPrice: number;
  entryDate: SessionDate;
  stop: number | null;
  target: number | null;
}

interface ProbePendingOrder {
  kind: 'buy' | 'sell';
  signalDate: SessionDate;
  stop: number | null;
  target: number | null;
}

class ProbeBarWindow implements BarWindow {
  constructor(private readonly asset: ProbeAsset) {}

  get length(): number {
    return this.asset.revealed;
  }

  get lastDate(): SessionDate | null {
    return this.asset.revealed > 0 ? this.asset.bars[this.asset.revealed - 1]!.date : null;
  }

  at(index: number): EngineBar {
    if (!Number.isInteger(index) || index < 0 || index >= this.asset.revealed) {
      throw new RangeError(
        `signals: ${this.asset.ticker} índice ${String(index)} fuera del historial visible ` +
          `(0..${this.asset.revealed - 1})`,
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

class ProbeContext implements StrategyContext {
  date: SessionDate = '';
  index = 0;
  readonly warmup = false;
  cash = 0;
  equity = 0;

  private readonly sortedTickers: string[];

  constructor(
    private readonly assets: Map<string, ProbeAsset>,
    private readonly pending: Map<string, ProbePendingOrder[]>,
    private readonly positions: Map<string, ProbePosition>,
    private readonly emitted: ProbeOrder[],
    private readonly lastDate: SessionDate,
  ) {
    this.sortedTickers = [...assets.keys()].sort();
  }

  tickers(): string[] {
    return [...this.sortedTickers];
  }

  universeTickers(): string[] {
    return [...this.sortedTickers];
  }

  isListed(ticker: string): boolean {
    return this.assets.has(normalize(ticker));
  }

  bars(ticker: string): BarWindow {
    const asset = this.assets.get(normalize(ticker));
    if (asset === undefined) {
      throw new RangeError(`signals: '${ticker}' no pertenece al universo de la estrategia`);
    }
    return new ProbeBarWindow(asset);
  }

  position(ticker: string): PositionView | null {
    const position = this.positions.get(normalize(ticker));
    if (position === undefined) return null;
    return toView(position);
  }

  positions(): PositionView[] {
    return [...this.positions.values()].map(toView);
  }

  buy(ticker: string, options: { stop?: number; target?: number } = {}): void {
    const key = normalize(ticker);
    if (!this.assets.has(key)) {
      throw new RangeError(`signals: '${ticker}' no pertenece al universo de la estrategia`);
    }
    const stop = optionalPrice(options.stop, 'stop');
    const target = optionalPrice(options.target, 'target');
    this.enqueue(key, { kind: 'buy', signalDate: this.date, stop, target });
  }

  sell(ticker: string): void {
    const key = normalize(ticker);
    if (!this.assets.has(key)) {
      throw new RangeError(`signals: '${ticker}' no pertenece al universo de la estrategia`);
    }
    this.enqueue(key, { kind: 'sell', signalDate: this.date, stop: null, target: null });
  }

  setStop(ticker: string, price: number): void {
    const position = this.positions.get(normalize(ticker));
    if (position === undefined) return;
    position.stop = optionalPrice(price, 'stop');
  }

  setTarget(ticker: string, price: number): void {
    const position = this.positions.get(normalize(ticker));
    if (position === undefined) return;
    position.target = optionalPrice(price, 'target');
  }

  /**
   * Las órdenes de la última sesión son las propuestas de señal; el resto
   * llena el libro de posiciones para que la estrategia vea su cartera
   * igual que en un backtest.
   */
  private enqueue(ticker: string, order: ProbePendingOrder): void {
    if (this.date === this.lastDate) {
      const asset = this.assets.get(ticker)!;
      const lastBar = asset.bars[asset.revealed - 1];
      if (lastBar !== undefined) {
        this.emitted.push({
          ticker,
          kind: order.kind,
          referencePrice: lastBar.close,
          stop: order.stop,
          target: order.target,
        });
      }
    }
    const list = this.pending.get(ticker) ?? [];
    list.push(order);
    this.pending.set(ticker, list);
  }
}

function normalize(ticker: string): string {
  return typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';
}

function optionalPrice(value: number | undefined, field: string): number | null {
  if (value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`signals: '${field}' no es un número finito (${String(value)})`);
  }
  if (value <= 0) {
    throw new RangeError(`signals: '${field}' debe ser > 0 (${value})`);
  }
  return value;
}

function toView(position: ProbePosition): PositionView {
  return {
    ticker: position.ticker,
    shares: 1,
    entryPrice: position.entryPrice,
    entryDate: position.entryDate,
    stopPrice: position.stop,
    targetPrice: position.target,
  };
}

/**
 * Rejuega la estrategia sobre las velas dadas y devuelve las órdenes que
 * emitiría al cierre de la última sesión de la serie, una por activo como
 * mucho (la primera orden de cada activo, como la llenaría el motor).
 */
export function collectLastBarOrders(input: ProbeInput): ProbeOrder[] {
  const maxPositions = input.maxPositions ?? DEFAULT_MAX_POSITIONS;

  const assets = new Map<string, ProbeAsset>();
  const tickersOfDate = new Map<SessionDate, ProbeAsset[]>();
  for (const [ticker, rawBars] of Object.entries(input.bars)) {
    const bars = rawBars.map((bar) => Object.freeze({ ...bar }));
    const asset: ProbeAsset = { ticker: normalize(ticker), bars, revealed: 0 };
    assets.set(asset.ticker, asset);
    for (const bar of bars) {
      const list = tickersOfDate.get(bar.date) ?? [];
      list.push(asset);
      tickersOfDate.set(bar.date, list);
    }
  }
  const timeline = [...tickersOfDate.keys()].sort();
  const lastDate = timeline[timeline.length - 1] ?? null;

  const emitted: ProbeOrder[] = [];
  if (lastDate === null) return emitted;

  const pending = new Map<string, ProbePendingOrder[]>();
  const positions = new Map<string, ProbePosition>();
  const context = new ProbeContext(assets, pending, positions, emitted, lastDate);

  let cash = DEFAULT_INITIAL_CASH;

  input.strategy.init(input.params ?? {});

  for (let index = 0; index < timeline.length; index++) {
    const date = timeline[index]!;

    for (const asset of tickersOfDate.get(date)!) {
      const bar = asset.bars[asset.revealed]!;
      asset.revealed++;

      // (a) Órdenes pendientes llenan a la apertura de esta vela.
      const orders = pending.get(asset.ticker) ?? [];
      pending.delete(asset.ticker);
      for (const order of orders) {
        if (order.kind === 'buy') {
          if (positions.has(asset.ticker) || positions.size >= maxPositions) continue;
          positions.set(asset.ticker, {
            ticker: asset.ticker,
            entryPrice: bar.open,
            entryDate: bar.date,
            stop: order.stop,
            target: order.target,
          });
          cash -= bar.open;
        } else {
          const position = positions.get(asset.ticker);
          if (position !== undefined) {
            cash += bar.open;
            positions.delete(asset.ticker);
          }
        }
      }

      // (b) Stop y objetivo intrabarra: si la vela toca los dos, el stop
      // primero; un hueco más allá del nivel ejecuta a la apertura.
      const position = positions.get(asset.ticker);
      if (position !== undefined) {
        if (position.stop !== null && bar.low <= position.stop) {
          cash += Math.min(bar.open, position.stop);
          positions.delete(asset.ticker);
        } else if (position.target !== null && bar.high >= position.target) {
          cash += Math.max(bar.open, position.target);
          positions.delete(asset.ticker);
        }
      }

      // (c) Activo sin más velas mientras la serie continúa: se liquida al
      // cierre de su última vela (misma regla 'delisted' del motor).
      if (asset.revealed === asset.bars.length && date < lastDate) {
        pending.delete(asset.ticker);
        const open = positions.get(asset.ticker);
        if (open !== undefined) {
          cash += bar.close;
          positions.delete(asset.ticker);
        }
      }
    }

    // Marca al cierre: último precio conocido de cada posición.
    let equity = cash;
    for (const position of positions.values()) {
      const asset = assets.get(position.ticker)!;
      equity += asset.bars[asset.revealed - 1]!.close;
    }

    context.date = date;
    context.index = index;
    context.cash = cash;
    context.equity = equity;
    input.strategy.onBar(context);
  }

  // Una propuesta por activo y dirección: la primera emitida (la que el
  // motor llenaría primero en la apertura siguiente).
  const seen = new Set<string>();
  return emitted.filter((order) => {
    const key = `${order.ticker}:${order.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
