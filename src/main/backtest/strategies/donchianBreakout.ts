/**
 * Ruptura de rangos: canal de Donchian 55/20 — Fase 2.
 *
 * Sistema «tortuga» (S2): la pareja 20/55 de la ficha fija los dos canales.
 * - Canal superior: máximo de los `entryPeriod` (55) máximos anteriores a la
 *   vela actual. Entrada cuando el cierre lo supera; la orden llena en la
 *   apertura siguiente.
 * - Canal inferior: mínimo de los `exitPeriod` (20) mínimos anteriores.
 *   Salida cuando el cierre lo perfora.
 * - Stop fijo a stopAtr × ATR(atrPeriod) bajo el cierre de la señal.
 *
 * El canal se calcula siempre con las sesiones anteriores a la vela que
 * evalúa (índices length-1-period .. length-2): la propia vela no entra en
 * su canal, que es lo que convierte el máximo en una ruptura de verdad.
 */
import {
  DEFAULT_STRATEGY_COSTS,
  type CreateStrategyRequest,
} from '../../../shared/strategy';
import type { EngineBar, Strategy, StrategyContext } from '../types';
import { requireIntegerParam, requireParamRange, resolveParams } from './params';
import { WilderAtr } from './rolling';

/** Valores por defecto; `DONCHIAN_BREAKOUT_SEED.parameters` los replica. */
export const DONCHIAN_BREAKOUT_DEFAULTS = {
  entryPeriod: 55,
  exitPeriod: 20,
  atrPeriod: 20,
  stopAtr: 2,
};

interface BreakoutState {
  seen: number;
  atr: WilderAtr;
}

/** Máximo de los `period` high anteriores a la última vela (canal superior). */
function upperChannel(ctx: StrategyContext, ticker: string, period: number): number | null {
  const w = ctx.bars(ticker);
  if (w.length - 1 < period) return null;
  let upper = -Infinity;
  for (let i = w.length - 1 - period; i < w.length - 1; i++) {
    upper = Math.max(upper, w.at(i).high);
  }
  return upper;
}

/** Mínimo de los `period` low anteriores a la última vela (canal inferior). */
function lowerChannel(ctx: StrategyContext, ticker: string, period: number): number | null {
  const w = ctx.bars(ticker);
  if (w.length - 1 < period) return null;
  let lower = Infinity;
  for (let i = w.length - 1 - period; i < w.length - 1; i++) {
    lower = Math.min(lower, w.at(i).low);
  }
  return lower;
}

export function createDonchianBreakoutStrategy(): Strategy {
  let params = { ...DONCHIAN_BREAKOUT_DEFAULTS };
  let states = new Map<string, BreakoutState>();

  const evaluate = (
    ctx: StrategyContext,
    ticker: string,
    st: BreakoutState,
    bar: EngineBar,
  ): void => {
    const position = ctx.position(ticker);
    if (position === null) {
      const upper = upperChannel(ctx, ticker, params.entryPeriod);
      if (upper !== null && bar.close > upper) {
        const atr = st.atr.value;
        const stop = atr === null ? undefined : bar.close - params.stopAtr * atr;
        ctx.buy(ticker, stop !== undefined && stop > 0 ? { stop } : undefined);
      }
      return;
    }
    const lower = lowerChannel(ctx, ticker, params.exitPeriod);
    if (lower !== null && bar.close < lower) {
      ctx.sell(ticker);
    }
  };

  return {
    init(raw) {
      params = resolveParams(DONCHIAN_BREAKOUT_DEFAULTS, raw);
      requireIntegerParam(params.entryPeriod, 'entryPeriod');
      requireIntegerParam(params.exitPeriod, 'exitPeriod');
      requireIntegerParam(params.atrPeriod, 'atrPeriod');
      requireParamRange(params.stopAtr, 'stopAtr', 0.1, 20);
      states = new Map();
    },
    onBar(ctx) {
      for (const ticker of ctx.tickers()) {
        const w = ctx.bars(ticker);
        let st = states.get(ticker);
        if (st === undefined) {
          st = { seen: 0, atr: new WilderAtr(params.atrPeriod) };
          states.set(ticker, st);
        }
        while (st.seen < w.length) {
          const bar = w.at(st.seen);
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
export const DONCHIAN_BREAKOUT_SEED: CreateStrategyRequest = {
  name: 'Ruptura de rangos',
  hypothesis:
    'Las rupturas de rangos largos marcan el inicio de tendencias: al superar un máximo de meses el posicionamiento se reacomoda y el movimiento continúa. Es el sistema «tortuga»: pocas operaciones, beneficios que corren y pérdidas cortadas por el canal contrario.',
  rules: {
    entry:
      'Compra cuando el cierre supera el máximo de las entryPeriod (55) sesiones anteriores — canal superior de Donchian; la orden se ejecuta en la apertura siguiente.',
    exit:
      'Vende cuando el cierre perfora el mínimo de las exitPeriod (20) sesiones anteriores — canal inferior de Donchian; ejecución en la apertura siguiente.',
    stop:
      'Stop de protección fijo a stopAtr (2) × ATR(atrPeriod) bajo el cierre de la señal; no se mueve durante la operación.',
    target:
      'Sin objetivo fijo: la salida la marca el canal contrario (exitPeriod) o el stop.',
  },
  parameters: { ...DONCHIAN_BREAKOUT_DEFAULTS },
  parameterRanges: {
    entryPeriod: { min: 20, max: 60, step: 5 },
    exitPeriod: { min: 10, max: 30, step: 5 },
    atrPeriod: { min: 10, max: 30, step: 5 },
    stopAtr: { min: 1, max: 4, step: 0.5 },
  },
  markets: ['SPY', 'QQQ', 'TLT'],
  trainingPeriod: { desde: '2000-01-03', hasta: '2014-12-31' },
  outOfSamplePeriod: { desde: '2015-01-02', hasta: '2024-12-31' },
  regime:
    'Mercados que rompen rangos y continúan (índices y bonos en regímenes direccionales); pierde con falsas rupturas en laterales.',
  assumedCosts: DEFAULT_STRATEGY_COSTS,
  note: 'Semilla de la fase 2: ruptura de rangos con canal de Donchian 55/20 (sistema tortuga).',
};
