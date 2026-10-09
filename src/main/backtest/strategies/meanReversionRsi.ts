/**
 * Reversión a la media: RSI(2) con filtro de tendencia — Fase 2.
 *
 * Variante Connors del sistema RSI/Bollinger:
 * - Entrada: RSI(rsiPeriod) ≤ oversold con el cierre por encima de
 *   SMA(trendPeriod) — solo se compran sobreventas dentro de régimen
 *   alcista. La orden llena en la apertura siguiente.
 * - Salida: RSI(rsiPeriod) rebota por encima de exitRsi; también sirve de
 *   «objetivo» implícito de la reversión.
 * - Stop fijo a stopAtr × ATR(atrPeriod) bajo el cierre de la señal: si la
 *   caída no revierte, la pérdida queda acotada.
 */
import {
  DEFAULT_STRATEGY_COSTS,
  type CreateStrategyRequest,
} from '../../../shared/strategy';
import type { EngineBar, Strategy, StrategyContext } from '../types';
import { requireIntegerParam, requireParamRange, resolveParams } from './params';
import { RollingSma, WilderAtr, WilderRsi } from './rolling';

/** Valores por defecto; `MEAN_REVERSION_RSI_SEED.parameters` los replica. */
export const MEAN_REVERSION_RSI_DEFAULTS = {
  rsiPeriod: 2,
  oversold: 5,
  exitRsi: 70,
  trendPeriod: 200,
  atrPeriod: 14,
  stopAtr: 2.5,
};

interface ReversionState {
  seen: number;
  rsi: WilderRsi;
  trend: RollingSma;
  atr: WilderAtr;
}

export function createMeanReversionRsiStrategy(): Strategy {
  let params = { ...MEAN_REVERSION_RSI_DEFAULTS };
  let states = new Map<string, ReversionState>();

  const evaluate = (
    ctx: StrategyContext,
    ticker: string,
    st: ReversionState,
    bar: EngineBar,
  ): void => {
    const rsiValue = st.rsi.value;
    const position = ctx.position(ticker);
    if (position === null) {
      const trend = st.trend.value;
      if (trend !== null && rsiValue !== null && bar.close > trend && rsiValue <= params.oversold) {
        const atr = st.atr.value;
        const stop = atr === null ? undefined : bar.close - params.stopAtr * atr;
        ctx.buy(ticker, stop !== undefined && stop > 0 ? { stop } : undefined);
      }
      return;
    }
    if (rsiValue !== null && rsiValue >= params.exitRsi) {
      ctx.sell(ticker);
    }
  };

  return {
    init(raw) {
      params = resolveParams(MEAN_REVERSION_RSI_DEFAULTS, raw);
      requireIntegerParam(params.rsiPeriod, 'rsiPeriod');
      requireIntegerParam(params.trendPeriod, 'trendPeriod');
      requireIntegerParam(params.atrPeriod, 'atrPeriod');
      requireParamRange(params.oversold, 'oversold', 0, 50);
      requireParamRange(params.exitRsi, 'exitRsi', 50, 100);
      requireParamRange(params.stopAtr, 'stopAtr', 0.1, 20);
      if (params.oversold >= params.exitRsi) {
        throw new RangeError(
          `estrategia reversión: oversold (${params.oversold}) debe ser < exitRsi (${params.exitRsi})`,
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
            rsi: new WilderRsi(params.rsiPeriod),
            trend: new RollingSma(params.trendPeriod),
            atr: new WilderAtr(params.atrPeriod),
          };
          states.set(ticker, st);
        }
        while (st.seen < w.length) {
          const bar = w.at(st.seen);
          st.rsi.push(bar.close);
          st.trend.push(bar.close);
          st.atr.push(bar);
          st.seen++;
          if (st.seen === w.length && bar.date === ctx.date && !ctx.warmup) {
            evaluate(ctx, ticker, st, bar);
          }
        }
      }
    },
  };
}

/** Ficha semilla completa, lista para `strategies:create`. */
export const MEAN_REVERSION_RSI_SEED: CreateStrategyRequest = {
  name: 'Reversión RSI/Bollinger',
  hypothesis:
    'En índices con tendencia alcista, las caídas bruscas de una o dos sesiones suelen ser sobre-reacciones que revierten a la media. Un RSI de dos sesiones en niveles extremos detecta esos agotamientos con alta tasa de acierto y exposición breve al mercado.',
  rules: {
    entry:
      'Compra cuando RSI(rsiPeriod) ≤ oversold (5) y el cierre sigue por encima de SMA(trendPeriod) — filtro de régimen alcista; la orden se ejecuta en la apertura siguiente.',
    exit:
      'Vende cuando RSI(rsiPeriod) rebota por encima de exitRsi (70), lo que marca la reversión consumada; ejecución en la apertura siguiente.',
    stop:
      'Stop de protección fijo a stopAtr (2,5) × ATR(atrPeriod) bajo el cierre de la señal; no se mueve durante la operación.',
    target:
      'Sin objetivo fijo: la salida la marca el rebote del RSI por encima de exitRsi o el stop.',
  },
  parameters: { ...MEAN_REVERSION_RSI_DEFAULTS },
  parameterRanges: {
    rsiPeriod: { min: 2, max: 7, step: 1 },
    oversold: { min: 1, max: 20, step: 2 },
    exitRsi: { min: 55, max: 90, step: 5 },
    trendPeriod: { min: 50, max: 250, step: 50 },
    atrPeriod: { min: 7, max: 28, step: 7 },
    stopAtr: { min: 1, max: 4, step: 0.5 },
  },
  markets: ['SPY', 'QQQ'],
  trainingPeriod: { desde: '2000-01-03', hasta: '2014-12-31' },
  outOfSamplePeriod: { desde: '2015-01-02', hasta: '2024-12-31' },
  regime:
    'Retrocesos dentro de tendencia alcista y mercados laterales suaves; sufre en bajistas persistentes, donde la sobreventa no implica suelo.',
  assumedCosts: DEFAULT_STRATEGY_COSTS,
  note: 'Semilla de la fase 2: reversión a la media con RSI(2) y filtro de tendencia (variante Connors del sistema RSI/Bollinger).',
};
