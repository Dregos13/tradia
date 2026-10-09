import { describe, expect, it } from 'vitest';

import { createTrendSmaCrossStrategy } from '../backtest/strategies/trendSmaCross';
import type { EngineBar, Strategy, StrategyContext } from '../backtest/types';
import { collectLastBarOrders } from './probe';

const bar = (date: string, close: number, patch: Partial<EngineBar> = {}): EngineBar => ({
  date,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 1_000,
  ...patch,
});

/** Estrategia de juguete: compra cuando se cumple `when` en la última vela. */
const buyWhen = (when: (ctx: StrategyContext) => boolean, stop = 9): Strategy => ({
  init: () => undefined,
  onBar: (ctx) => {
    if (when(ctx)) ctx.buy('AAPL', { stop, target: 15 });
  },
});

describe('sonda de estrategias (collectLastBarOrders)', () => {
  it('recoge la compra emitida en la última sesión con stop, objetivo y precio de referencia', () => {
    const orders = collectLastBarOrders({
      strategy: buyWhen((ctx) => ctx.bars('AAPL').length >= 3),
      bars: { AAPL: [bar('2026-10-05', 10), bar('2026-10-06', 11), bar('2026-10-07', 12)] },
    });
    expect(orders).toEqual([
      { ticker: 'AAPL', kind: 'buy', referencePrice: 12, stop: 9, target: 15 },
    ]);
  });

  it('las órdenes de sesiones anteriores no son propuestas: llenan en la siguiente apertura', () => {
    // Compra en la primera vela posible; solo se informa de lo del último día.
    const orders = collectLastBarOrders({
      strategy: buyWhen((ctx) => ctx.bars('AAPL').length === 1),
      bars: { AAPL: [bar('2026-10-05', 10), bar('2026-10-06', 11)] },
    });
    expect(orders).toEqual([]);
  });

  it('la estrategia ve su posición: con una abierta no vuelve a comprar y puede vender al final', () => {
    const strategy: Strategy = {
      init: () => undefined,
      onBar: (ctx) => {
        const position = ctx.position('AAPL');
        const bars = ctx.bars('AAPL');
        if (position === null && bars.length === 1) ctx.buy('AAPL', { stop: 9 });
        if (position !== null && bars.last().close > 12) ctx.sell('AAPL');
      },
    };
    const orders = collectLastBarOrders({
      strategy,
      bars: { AAPL: [bar('2026-10-05', 10), bar('2026-10-06', 13)] },
    });
    // La compra del día 5 llenó a la apertura del 6; en el cierre del 6 vende.
    expect(orders).toEqual([
      { ticker: 'AAPL', kind: 'sell', referencePrice: 13, stop: null, target: null },
    ]);
  });

  it('el stop cierra la posición intrabarra y libera una venta posterior', () => {
    const strategy: Strategy = {
      init: () => undefined,
      onBar: (ctx) => {
        const bars = ctx.bars('AAPL');
        if (ctx.position('AAPL') === null && bars.length === 1) ctx.buy('AAPL', { stop: 10.5 });
        // Solo vende si ya no tiene posición (el stop la cerró).
        if (ctx.position('AAPL') === null && bars.last().date === '2026-10-07') {
          ctx.sell('AAPL');
        }
      },
    };
    const orders = collectLastBarOrders({
      strategy,
      bars: {
        AAPL: [
          bar('2026-10-05', 10),
          // Hueco a la baja que salta el stop (10.5): ejecuta a la apertura (10.2).
          bar('2026-10-06', 11, { open: 10.2, high: 10.3, low: 10.1, close: 10.2 }),
          bar('2026-10-07', 10),
        ],
      },
    });
    expect(orders).toEqual([
      { ticker: 'AAPL', kind: 'sell', referencePrice: 10, stop: null, target: null },
    ]);
  });

  it('un activo del universo sin velas no rompe la evaluación de los demás', () => {
    const strategy: Strategy = {
      init: () => undefined,
      onBar: (ctx) => {
        for (const ticker of ctx.tickers()) {
          const w = ctx.bars(ticker);
          if (w.length > 0 && w.last().close > 0 && w.lastDate === ctx.date) {
            if (ctx.position(ticker) === null) ctx.buy(ticker);
          }
        }
      },
    };
    const orders = collectLastBarOrders({
      strategy,
      bars: { AAPL: [bar('2026-10-07', 12)], MSFT: [] },
    });
    expect(orders).toEqual([
      { ticker: 'AAPL', kind: 'buy', referencePrice: 12, stop: null, target: null },
    ]);
  });

  it('una sola propuesta por activo y tipo aunque la estrategia repita la orden', () => {
    const strategy: Strategy = {
      init: () => undefined,
      onBar: (ctx) => {
        ctx.buy('AAPL');
        ctx.buy('AAPL');
      },
    };
    const orders = collectLastBarOrders({
      strategy,
      bars: { AAPL: [bar('2026-10-07', 12)] },
    });
    expect(orders).toHaveLength(1);
  });

  it('la estrategia no puede ver el futuro: leer más allá de lo revelado lanza', () => {
    const strategy: Strategy = {
      init: () => undefined,
      onBar: (ctx) => {
        ctx.bars('AAPL').at(ctx.bars('AAPL').length); // índice fuera de rango
      },
    };
    expect(() =>
      collectLastBarOrders({ strategy, bars: { AAPL: [bar('2026-10-07', 12)] } }),
    ).toThrowError(RangeError);
  });

  it('una posición en un activo sin más velas se liquida (delisted) antes del onBar', () => {
    // MSFT compra el día 5 y llena el 6; como sus velas terminan el 6 y la
    // serie sigue, la sonda liquida al cierre del 6. En la última sesión el
    // 7 la posición ya no existe: la estrategia lo comprueba comprando AAPL.
    const strategy: Strategy = {
      init: () => undefined,
      onBar: (ctx) => {
        const msft = ctx.bars('MSFT');
        if (msft.length === 1 && msft.lastDate === ctx.date) ctx.buy('MSFT');
        if (ctx.date === '2026-10-07' && ctx.position('MSFT') === null) ctx.buy('AAPL');
      },
    };
    const orders = collectLastBarOrders({
      strategy,
      bars: {
        MSFT: [bar('2026-10-05', 10), bar('2026-10-06', 10)],
        AAPL: [bar('2026-10-05', 10), bar('2026-10-06', 10), bar('2026-10-07', 10)],
      },
    });
    expect(orders).toEqual([
      { ticker: 'AAPL', kind: 'buy', referencePrice: 10, stop: null, target: null },
    ]);
  });

  it('la estrategia clásica de cruce de medias emite compra en el cruce al alza', () => {
    // Cruce en la última vela: fast(2) pasa por encima de slow(3).
    const bars = [
      bar('2026-10-01', 10),
      bar('2026-10-02', 10),
      bar('2026-10-05', 9),
      bar('2026-10-06', 10),
      bar('2026-10-07', 12),
    ];
    const orders = collectLastBarOrders({
      strategy: createTrendSmaCrossStrategy(),
      params: { fastPeriod: 2, slowPeriod: 3, atrPeriod: 2, stopAtr: 1 },
      bars: { SPY: bars },
    });
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ ticker: 'SPY', kind: 'buy', referencePrice: 12 });
    expect(orders[0]!.stop).not.toBeNull();
    expect(orders[0]!.stop!).toBeLessThan(12);
  });

  it('la estrategia clásica no repite compra si ya mantiene la posición del cruce anterior', () => {
    // Cruce el día 6; el día 7 la tendencia sigue pero no hay cruce nuevo.
    const bars = [
      bar('2026-10-01', 10),
      bar('2026-10-02', 10),
      bar('2026-10-05', 9),
      bar('2026-10-06', 12),
      bar('2026-10-07', 12.5),
    ];
    const orders = collectLastBarOrders({
      strategy: createTrendSmaCrossStrategy(),
      params: { fastPeriod: 2, slowPeriod: 3, atrPeriod: 2, stopAtr: 1 },
      bars: { SPY: bars },
    });
    expect(orders).toEqual([]);
  });
});
