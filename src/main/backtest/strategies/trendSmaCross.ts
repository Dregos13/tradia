/**
 * Seguimiento de tendencia: cruce de medias con stop ATR — Fase 2.
 *
 * Regla ejecutable (la ficha semilla la describe en texto):
 * - Entrada: SMA(fastPeriod) cruza al alza a SMA(slowPeriod) al cierre; la
 *   orden llena en la apertura siguiente (lo garantiza el motor). La compra
 *   lleva stop a `stopAtr` × ATR(atrPeriod) bajo el cierre de la señal, que
 *   además dimensiona la posición por riesgo (1 % del capital por defecto).
 * - Salida: cruce a la baja de las medias, o el stop.
 * - Stop dinámico: con posición abierta se sube a `cierre − stopAtr × ATR`
 *   cada sesión en la que suba; nunca baja (trailing clásico).
 *
 * Cruce estricto: solo hay señal cuando ambas medias tienen valor la sesión
 * anterior y la actual. Si la serie arranca ya cruzada (p. ej. datos que
 * empiezan en plena tendencia) no se compra hasta el siguiente cruce.
 */
import {
  DEFAULT_STRATEGY_COSTS,
  type CreateStrategyRequest,
} from '../../../shared/strategy';
import type {
  EngineBar,
  Strategy,
  StrategyContext,
  StrategyParams,
} from '../types';
import { requireIntegerParam, requireParamRange, resolveParams } from './params';
import { RollingSma, WilderAtr } from './rolling';

/** Valores por defecto; `TREND_SMA_CROSS_SEED.parameters` los replica. */
export const TREND_SMA_CROSS_DEFAULTS = {
  fastPeriod: 50,
  slowPeriod: 200,
  atrPeriod: 14,
  stopAtr: 3,
};

interface TrendState {
  seen: number;
  fast: RollingSma;
  slow: RollingSma;
  atr: WilderAtr;
}

export function createTrendSmaCrossStrategy(): Strategy {
  let params = { ...TREND_SMA_CROSS_DEFAULTS };
  let states = new Map<string, TrendState>();

  const evaluate = (
    ctx: StrategyContext,
    ticker: string,
    st: TrendState,
    bar: EngineBar,
    prevFast: number | null,
    prevSlow: number | null,
  ): void => {
    const fast = st.fast.value;
    const slow = st.slow.value;
    const atr = st.atr.value;
    const position = ctx.position(ticker);

    if (position === null) {
      if (prevFast === null || prevSlow === null || fast === null || slow === null) return;
      if (prevFast <= prevSlow && fast > slow) {
        const stop = atr === null ? undefined : bar.close - params.stopAtr * atr;
        ctx.buy(ticker, stop !== undefined && stop > 0 ? { stop } : undefined);
      }
      return;
    }

    if (
      prevFast !== null &&
      prevSlow !== null &&
      fast !== null &&
      slow !== null &&
      prevFast >= prevSlow &&
      fast < slow
    ) {
      ctx.sell(ticker);
      return;
    }

    // Stop ATR dinámico: solo sube.
    if (atr !== null) {
      const trail = bar.close - params.stopAtr * atr;
      if (trail > 0 && (position.stopPrice === null || trail > position.stopPrice)) {
        ctx.setStop(ticker, trail);
      }
    }
  };

  return {
    init(raw: StrategyParams) {
      params = resolveParams(TREND_SMA_CROSS_DEFAULTS, raw);
      requireIntegerParam(params.fastPeriod, 'fastPeriod');
      requireIntegerParam(params.slowPeriod, 'slowPeriod');
      requireIntegerParam(params.atrPeriod, 'atrPeriod');
      requireParamRange(params.stopAtr, 'stopAtr', 0.1, 20);
      if (params.fastPeriod >= params.slowPeriod) {
        throw new RangeError(
          `estrategia cruce de medias: fastPeriod (${params.fastPeriod}) debe ser < slowPeriod (${params.slowPeriod})`,
        );
      }
      states = new Map();
    },
    onBar(ctx) {
      for (const ticker of ctx.tickers()) {
        const w = ctx.bars(ticker);
        let st = states.get(ticker);
        if (st === undefined) {
          st = {
            seen: 0,
            fast: new RollingSma(params.fastPeriod),
            slow: new RollingSma(params.slowPeriod),
            atr: new WilderAtr(params.atrPeriod),
          };
          states.set(ticker, st);
        }
        while (st.seen < w.length) {
          const bar = w.at(st.seen);
          const prevFast = st.fast.value;
          const prevSlow = st.slow.value;
          st.fast.push(bar.close);
          st.slow.push(bar.close);
          st.atr.push(bar);
          st.seen++;
          if (st.seen === w.length && bar.date === ctx.date && !ctx.warmup) {
            evaluate(ctx, ticker, st, bar, prevFast, prevSlow);
          }
        }
      }
    },
  };
}

/** Ficha semilla completa, lista para `strategies:create`. */
export const TREND_SMA_CROSS_SEED: CreateStrategyRequest = {
  name: 'Cruce de medias',
  hypothesis:
    'Las tendencias de los índices persisten durante meses: la información se incorpora despacio y el posicionamiento colectivo amplifica el movimiento. Una media rápida cruzando a una lenta identifica el cambio de régimen sin intentar predecir techos ni suelos.',
  rules: {
    entry:
      'Compra cuando SMA(fastPeriod) del cierre cruza al alza a SMA(slowPeriod); la señal se confirma al cierre y la orden se ejecuta en la apertura de la sesión siguiente.',
    exit:
      'Vende cuando SMA(fastPeriod) cruza a la baja a SMA(slowPeriod), o antes si salta el stop dinámico; ejecución en la apertura siguiente.',
    stop:
      'Stop de protección a stopAtr (3) × ATR(atrPeriod) bajo el cierre de la señal; cada sesión se arrastra al alza hasta cierre − stopAtr × ATR y nunca retrocede.',
    target:
      'Sin objetivo fijo: la posición se mantiene mientras dure la tendencia y sale por el cruce contrario o por el stop.',
  },
  parameters: { ...TREND_SMA_CROSS_DEFAULTS },
  parameterRanges: {
    fastPeriod: { min: 20, max: 100, step: 10 },
    slowPeriod: { min: 100, max: 300, step: 25 },
    atrPeriod: { min: 7, max: 28, step: 7 },
    stopAtr: { min: 1.5, max: 5, step: 0.5 },
  },
  markets: ['SPY', 'QQQ', 'DIA', 'IWM'],
  trainingPeriod: { desde: '2000-01-03', hasta: '2014-12-31' },
  outOfSamplePeriod: { desde: '2015-01-02', hasta: '2024-12-31' },
  regime:
    'Mercados tendenciales sostenidos, alcistas o bajistas; pierde por sierra en laterales prolongados.',
  assumedCosts: DEFAULT_STRATEGY_COSTS,
  note: 'Semilla de la fase 2: seguimiento de tendencia clásico (SMA 50/200 con stop ATR).',
};
