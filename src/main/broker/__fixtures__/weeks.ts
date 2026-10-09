/**
 * Semilla determinista de operaciones paper — informe real vs backtest.
 *
 * Genera las `broker_orders` (entradas `NewBrokerOrder` del repositorio)
 * de `weeks` semanas cerradas hacia atrás desde `now`: por defecto 8,
 * que es lo que siembra el gancho E2E `broker:seed-weeks` y lo que
 * comprueba el criterio «8 filas semanales y 2 mensuales por estrategia».
 *
 * Por semana y estrategia cierra dos operaciones completas (entrada de
 * mercado ejecutada el lunes 10:00 ET y salida OCO ejecutada el jueves
 * 15:00 ET), repartidas entre tickers fijos:
 *
 * - Estrategia 1 («dentro de margen»): entra a 100,00 y sale a 101,00,
 *   +1,00 % por operación; slippage de entrada +4,00 pb.
 * - Estrategia 2 («sembrada para desviarse»): sale a 96,00, −4,00 % por
 *   operación; slippage de entrada ≈ +16,03 pb, por encima del tope de
 *   10 pb por defecto, así sale del margen con cualquier expectativa.
 *
 * Los precios pididos se eligen para que el slippage cuadre con
 * `slippageBpsOf`; la salida OCO lleva `requestedPrice` null (su precio
 * de referencia no existe hasta saber qué pata ejecuta) y no entra en
 * la media de slippage. `senal_id` va a null para no depender de la
 * tabla `signals` (FK): el emparejamiento usa la raíz del
 * `client_order_id`, que sigue el formato 'tradia-<clave>-<pata>'.
 */
import { slippageBpsOf } from '../../../shared/broker';
import { NYSE_ZONE, zonedToUtcMs } from '../../market/calendar';
import { addDays, nyToday } from '../deviation';
import type { NewBrokerOrder } from '../repository';

/** Estrategias que siembra el fixture (ids históricos, sin FK). */
export const SEEDED_STRATEGY_IDS = [1, 2] as const;

const TICKERS = ['AAPL', 'MSFT', 'NVDA', 'AMZN'] as const;
const TRADES_PER_WEEK = 2;

/** Rentabilidad por operación sembrada (en %): +1,00 y −4,00. */
export const SEEDED_TRADE_RETURN_PCT: Record<(typeof SEEDED_STRATEGY_IDS)[number], number> = {
  1: 1,
  2: -4,
};

/** Precios del plan por estrategia (entrada ejecutada a 100,00 en las dos). */
const SEED_PLAN: Record<
  (typeof SEEDED_STRATEGY_IDS)[number],
  {
    /** Precio pedido de la entrada: produce el slippage buscado al ejecutar a 100. */
    entryRequested: number;
    entryExecuted: number;
    /** Precio ejecutado de la salida (la pata ganadora del OCO). */
    exitExecuted: number;
    /** Objetivo y stop del OCO de salida. */
    limitPrice: number;
    stopPrice: number;
  }
> = {
  // +4,00 pb de slippage en la entrada (99,96 → 100,00), salida a 101,00 (+1 %).
  1: { entryRequested: 99.96, entryExecuted: 100, exitExecuted: 101, limitPrice: 104, stopPrice: 96 },
  // ≈ +16,03 pb en la entrada (99,84 → 100,00), salida a 96,00 (−4 %).
  2: { entryRequested: 99.84, entryExecuted: 100, exitExecuted: 96, limitPrice: 105, stopPrice: 96 },
};

const parseDay = (date: string): { year: number; month: number; day: number } => ({
  year: Number(date.slice(0, 4)),
  month: Number(date.slice(5, 7)),
  day: Number(date.slice(8, 10)),
});

/** Instante ISO 8601 de las `hour`:`minute` del día civil `date` en Nueva York. */
const atNy = (date: string, hour: number, minute: number): string => {
  const { year, month, day } = parseDay(date);
  return new Date(zonedToUtcMs(year, month, day, hour, minute, NYSE_ZONE)).toISOString();
};

/**
 * Domingo más reciente anterior a `todayNy` (fecha 'YYYY-MM-DD' en
 * Nueva York): cierra la última semana completa del informe.
 */
const lastClosedSunday = (todayNy: string): string => {
  const dow = new Date(
    Date.UTC(Number(todayNy.slice(0, 4)), Number(todayNy.slice(5, 7)) - 1, Number(todayNy.slice(8, 10))),
  ).getUTCDay();
  return addDays(todayNy, dow === 0 ? -7 : -dow);
};

export interface SeedWeeksOptions {
  /** Instante de referencia (ms epoch); las semanas cierran antes de hoy-NY. */
  now: number;
  /** Semanas cerradas a sembrar (def. y tope del gancho: 8 / 1–52). */
  weeks?: number;
  /** Cantidad por operación (def. 10). */
  quantity?: number;
}

/**
 * Órdenes sembradas de `weeks` semanas cerradas: `TRADES_PER_WEEK`
 * operaciones por estrategia y semana, es decir `weeks × 2 estrategias ×
 * 2 operaciones × 2 patas` filas para el valor por defecto (64 órdenes).
 */
export function buildSeedWeeksOrders(options: SeedWeeksOptions): NewBrokerOrder[] {
  const weeks = Math.max(1, Math.min(52, Math.floor(options.weeks ?? 8)));
  const quantity = options.quantity ?? 10;
  const sunday = lastClosedSunday(nyToday(options.now));

  const orders: NewBrokerOrder[] = [];
  for (let w = 0; w < weeks; w += 1) {
    const monday = addDays(sunday, -6 - w * 7);
    const thursday = addDays(monday, 3);
    for (const strategyId of SEEDED_STRATEGY_IDS) {
      const plan = SEED_PLAN[strategyId];
      for (let t = 0; t < TRADES_PER_WEEK; t += 1) {
        const key = `seed-w${w}-s${strategyId}-t${t}`;
        const ticker = TICKERS[(w + t) % TICKERS.length]!;
        const entrySlippage = slippageBpsOf('buy', plan.entryRequested, plan.entryExecuted);
        orders.push({
          clientOrderId: `tradia-${key}-entrada`,
          brokerOrderId: `seed-${key}-in`,
          signalId: null,
          strategyId,
          leg: 'entrada',
          ticker,
          type: 'market',
          side: 'buy',
          quantity,
          filledQuantity: quantity,
          requestedPrice: plan.entryRequested,
          executedPrice: plan.entryExecuted,
          requestedAt: atNy(monday, 9, 55),
          executedAt: atNy(monday, 10, 0),
          slippageBps: entrySlippage,
          status: 'ejecutada',
          attempts: 1,
        });
        orders.push({
          clientOrderId: `tradia-${key}-salida`,
          brokerOrderId: `seed-${key}-out`,
          signalId: null,
          strategyId,
          leg: 'salida',
          ticker,
          type: 'oco',
          side: 'sell',
          quantity,
          filledQuantity: quantity,
          limitPrice: plan.limitPrice,
          stopPrice: plan.stopPrice,
          ocoGroupId: `seed-oco-${key}`,
          requestedPrice: null,
          executedPrice: plan.exitExecuted,
          requestedAt: atNy(monday, 10, 5),
          executedAt: atNy(thursday, 15, 0),
          slippageBps: null,
          status: 'ejecutada',
          attempts: 1,
        });
      }
    }
  }
  return orders;
}
