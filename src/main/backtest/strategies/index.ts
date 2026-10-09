/**
 * Registro de las cuatro estrategias clásicas — Fase 2.
 *
 * Cada entrada liga una clave estable con:
 * - `seed`: la ficha semilla completa (hipótesis, reglas, parámetros con sus
 *   rangos para el mapa de sensibilidad, mercados, periodos, régimen y
 *   costes asumidos), lista para el alta vía `strategies:create` — el
 *   repositorio las crea en estado «investigacion».
 * - `create`: factoría de la estrategia ejecutable por el motor
 *   (`runBacktest`). Cada `create()` devuelve una instancia independiente;
 *   `init(params)` reinicia su estado interno.
 *
 * La ficha persistida no guarda `key` (el modelo de la migración 005 es
 * agnóstico de la implementación): quien cablee el servicio de backtest
 * resuelve la implementación por esta tabla.
 */
import type { CreateStrategyRequest } from '../../../shared/strategy';
import type { Strategy } from '../types';
import {
  createCrossAssetMomentumStrategy,
  CROSS_ASSET_MOMENTUM_SEED,
} from './crossAssetMomentum';
import {
  createDonchianBreakoutStrategy,
  DONCHIAN_BREAKOUT_SEED,
} from './donchianBreakout';
import {
  createMeanReversionRsiStrategy,
  MEAN_REVERSION_RSI_SEED,
} from './meanReversionRsi';
import {
  createTrendSmaCrossStrategy,
  TREND_SMA_CROSS_SEED,
} from './trendSmaCross';

export interface ClassicStrategyDefinition {
  /** Clave estable de la implementación. */
  readonly key: string;
  /** Ficha semilla para el alta en la biblioteca. */
  readonly seed: CreateStrategyRequest;
  /** Factoría de la estrategia ejecutable por el motor. */
  readonly create: () => Strategy;
}

export const CLASSIC_STRATEGIES: readonly ClassicStrategyDefinition[] = [
  { key: 'sma-cross', seed: TREND_SMA_CROSS_SEED, create: createTrendSmaCrossStrategy },
  {
    key: 'rsi-mean-reversion',
    seed: MEAN_REVERSION_RSI_SEED,
    create: createMeanReversionRsiStrategy,
  },
  {
    key: 'donchian-breakout',
    seed: DONCHIAN_BREAKOUT_SEED,
    create: createDonchianBreakoutStrategy,
  },
  {
    key: 'cross-asset-momentum',
    seed: CROSS_ASSET_MOMENTUM_SEED,
    create: createCrossAssetMomentumStrategy,
  },
];

export { ETF_UNIVERSE } from './crossAssetMomentum';
