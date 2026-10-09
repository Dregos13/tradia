/**
 * Momentum entre activos: rotación mensual al top N — Fase 2.
 *
 * Regla ejecutable:
 * - La primera sesión operable de cada mes se ordena el universo por
 *   rentabilidad de los últimos `lookbackSessions` (126 ≈ 6 meses) cierres:
 *   score = último cierre / cierre de hace lookbackSessions − 1.
 * - Se venden las posiciones que salen del top `topN` y se compran los
 *   clasificados que falten; todas las órdenes llenan en la apertura
 *   siguiente.
 * - Solo puntúan activos que cotizan y tienen vela en la fecha de la
 *   rotación (sin datos obsoletos en el ranking) y con historial suficiente.
 * - Sin stop por activo: el riesgo lo limitan la diversificación del top N
 *   y la rotación; conviene lanzar el run con maxPositions = topN para que
 *   el capital quede repartido entre las posiciones elegidas.
 *
 * Desempates deterministas: mismo score → orden alfabético de ticker.
 * Durante el calentamiento no se consume el mes: la primera sesión real
 * siempre evalúa la rotación, aunque caiga a mitad de mes.
 */
import {
  DEFAULT_STRATEGY_COSTS,
  type CreateStrategyRequest,
} from '../../../shared/strategy';
import type { Strategy } from '../types';
import { requireIntegerParam, resolveParams } from './params';

/** Valores por defecto; `CROSS_ASSET_MOMENTUM_SEED.parameters` los replica. */
export const CROSS_ASSET_MOMENTUM_DEFAULTS = {
  lookbackSessions: 126,
  topN: 3,
};

/** ETF del universo inicial de Tradia (docs/alcance.md): índice y sectoriales. */
export const ETF_UNIVERSE = [
  'SPY',
  'QQQ',
  'DIA',
  'IWM',
  'VTI',
  'XLF',
  'XLK',
  'XLE',
  'XLV',
  'TLT',
];

export function createCrossAssetMomentumStrategy(): Strategy {
  let params = { ...CROSS_ASSET_MOMENTUM_DEFAULTS };
  let lastMonth: string | null = null;

  return {
    init(raw) {
      params = resolveParams(CROSS_ASSET_MOMENTUM_DEFAULTS, raw);
      requireIntegerParam(params.lookbackSessions, 'lookbackSessions');
      requireIntegerParam(params.topN, 'topN');
      lastMonth = null;
    },
    onBar(ctx) {
      if (ctx.warmup) return;
      const month = ctx.date.slice(0, 7);
      if (month === lastMonth) return;
      lastMonth = month;

      const scored: { ticker: string; score: number }[] = [];
      for (const ticker of ctx.tickers()) {
        const w = ctx.bars(ticker);
        if (w.lastDate !== ctx.date || w.length <= params.lookbackSessions) continue;
        const base = w.back(params.lookbackSessions).close;
        scored.push({ ticker, score: w.last().close / base - 1 });
      }
      scored.sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
      const target = new Set(scored.slice(0, params.topN).map((s) => s.ticker));

      for (const position of ctx.positions()) {
        if (!target.has(position.ticker)) ctx.sell(position.ticker);
      }
      for (const ticker of target) {
        if (ctx.position(ticker) === null) ctx.buy(ticker);
      }
    },
  };
}

/** Ficha semilla completa, lista para `strategies:create`. */
export const CROSS_ASSET_MOMENTUM_SEED: CreateStrategyRequest = {
  name: 'Momentum entre activos',
  hypothesis:
    'La prima de momentum relativo persiste a escala mensual entre clases de activos: los ETF que mejor rindieron en los últimos 6–12 meses tienden a seguir haciéndolo el mes siguiente, por inercia de flujos y difusión lenta de la información.',
  rules: {
    entry:
      'En la primera sesión de cada mes se ordena el universo por rentabilidad de los últimos lookbackSessions (126) cierres y se compran los topN (3) mejores; la orden se ejecuta en la apertura siguiente.',
    exit:
      'En la misma rotación mensual se vende cualquier posición que haya salido del top topN; ejecución en la apertura siguiente.',
    stop:
      'Sin stop por activo: el riesgo lo limita la diversificación del top N y la propia rotación mensual (lanzar el backtest con maxPositions = topN reparte el capital entre los elegidos).',
    target:
      'Sin objetivo fijo: la posición se mantiene mientras el activo siga clasificado entre los topN.',
  },
  parameters: { ...CROSS_ASSET_MOMENTUM_DEFAULTS },
  parameterRanges: {
    lookbackSessions: { min: 63, max: 252, step: 21 },
    topN: { min: 1, max: 5, step: 1 },
  },
  markets: [...ETF_UNIVERSE],
  trainingPeriod: { desde: '2000-01-03', hasta: '2014-12-31' },
  outOfSamplePeriod: { desde: '2015-01-02', hasta: '2024-12-31' },
  regime:
    'Mercados con tendencias sectoriales o entre activos persistentes; sufre en rotaciones bruscas de liderazgo y en caídas correladas.',
  assumedCosts: DEFAULT_STRATEGY_COSTS,
  note: 'Semilla de la fase 2: rotación mensual al top 3 por momentum de 6 meses sobre el universo de ETF.',
};
