import { describe, expect, it } from 'vitest';

import { LIVE_FIXED_CAPS, type LiveLimits } from '../../shared/live';
import type { BrokerOrderRequest } from '../broker/types';
import {
  estimateOrderNotionalUsd,
  liveOrderBlockReason,
  type LiveOrderSnapshot,
} from './orderGuard';

const LIMITS: LiveLimits = {
  capitalUsd: 500,
  orderUsd: 100,
  dailyLossUsd: 10,
  openPositions: 2,
};

const snapshot = (patch: Partial<LiveOrderSnapshot> = {}): LiveOrderSnapshot => ({
  mode: 'activo',
  limits: { ...LIMITS },
  openTickers: [],
  capitalInUseUsd: 0,
  realizedLossTodayUsd: 0,
  ...patch,
});

const request = (patch: Partial<BrokerOrderRequest> = {}): BrokerOrderRequest => ({
  clientOrderId: 'tradia-1-entrada',
  ticker: 'SPY',
  type: 'market',
  side: 'buy',
  quantity: 1,
  ...patch,
});

describe('estimateOrderNotionalUsd', () => {
  it('estima con el limit/stop del tipo o la referencia del pedido', () => {
    expect(estimateOrderNotionalUsd(request({ quantity: 2 }), 50)).toBe(100);
    expect(
      estimateOrderNotionalUsd(request({ type: 'limit', limitPrice: 10, quantity: 3 }), 50),
    ).toBe(30);
    expect(
      estimateOrderNotionalUsd(request({ type: 'stop', stopPrice: 8, quantity: 2 }), null),
    ).toBe(16);
  });

  it('sin precio conocido devuelve null', () => {
    expect(estimateOrderNotionalUsd(request(), null)).toBeNull();
    expect(estimateOrderNotionalUsd(request({ limitPrice: 0 }), null)).toBeNull();
  });
});

describe('liveOrderBlockReason — puerta de los techos reales', () => {
  it('una orden dentro de los límites pasa', () => {
    const reason = liveOrderBlockReason(snapshot(), request({ quantity: 1 }), {
      leg: 'entrada',
      requestedPrice: 50,
    });
    expect(reason).toBeNull();
  });

  it('la pata de salida pasa siempre, incluso sin límites ni modo activo', () => {
    const reason = liveOrderBlockReason(
      snapshot({ mode: 'suspendido', limits: null }),
      request({ side: 'sell', type: 'oco', limitPrice: 999_999, stopPrice: 0.01, quantity: 999 }),
      { leg: 'salida', requestedPrice: 999_999 },
    );
    expect(reason).toBeNull();
  });

  it.each(['bloqueado', 'listo', 'suspendido'] as const)(
    'con el modo real %s no se envían órdenes nuevas',
    (mode) => {
      const reason = liveOrderBlockReason(snapshot({ mode }), request(), {
        leg: 'entrada',
        requestedPrice: 50,
      });
      expect(reason).toContain('no se envían órdenes nuevas');
    },
  );

  it('sin límites confirmados se bloquea aunque el modo sea activo', () => {
    const reason = liveOrderBlockReason(snapshot({ limits: null }), request(), {
      leg: 'entrada',
      requestedPrice: 50,
    });
    expect(reason).toContain('límites escritos');
  });

  it('una de mercado sin precio de referencia se bloquea (nunca a ciegas)', () => {
    const reason = liveOrderBlockReason(snapshot(), request(), {
      leg: 'entrada',
      requestedPrice: null,
    });
    expect(reason).toContain('importe');
  });

  it('un nocional por encima del límite por orden se bloquea con el motivo', () => {
    const reason = liveOrderBlockReason(snapshot(), request({ quantity: 3 }), {
      leg: 'entrada',
      requestedPrice: 50,
    });
    expect(reason).toContain('150');
    expect(reason).toContain('100');
    // Justo en el límite sí pasa.
    expect(
      liveOrderBlockReason(snapshot(), request({ quantity: 2 }), {
        leg: 'entrada',
        requestedPrice: 50,
      }),
    ).toBeNull();
  });

  it('una posición nueva por encima del máximo se bloquea; ampliar una existente no', () => {
    const withTwo = snapshot({ openTickers: ['SPY', 'AAPL'] });
    expect(
      liveOrderBlockReason(withTwo, request({ ticker: 'MSFT' }), {
        leg: 'entrada',
        requestedPrice: 10,
      }),
    ).toContain('posición');
    expect(
      liveOrderBlockReason(withTwo, request({ ticker: 'SPY' }), {
        leg: 'entrada',
        requestedPrice: 10,
      }),
    ).toBeNull();
  });

  it('capital en uso + orden por encima del límite de capital se bloquea', () => {
    const state = snapshot({ capitalInUseUsd: 450 });
    const reason = liveOrderBlockReason(state, request({ quantity: 2 }), {
      leg: 'entrada',
      requestedPrice: 50,
    });
    expect(reason).toContain('capital real');
    expect(reason).toContain('450');
    expect(reason).toContain('500');
  });

  it('la pérdida diaria realizada alcanzando el límite bloquea nuevas entradas', () => {
    const reason = liveOrderBlockReason(
      snapshot({ realizedLossTodayUsd: 10 }),
      request({ quantity: 0.5 }),
      { leg: 'entrada', requestedPrice: 50 },
    );
    expect(reason).toContain('pérdida realizada');
    expect(reason).toContain('10');
  });

  it('una entrada en corto con dinero real se bloquea siempre (hasta la tarea del corto real)', () => {
    // El corto de las propias solo corre en backtest y en paper: con dinero
    // real la puerta lo rechaza aunque la orden entre dentro de los techos.
    const blocked = liveOrderBlockReason(snapshot(), request({ side: 'sell', quantity: 1 }), {
      leg: 'entrada',
      requestedPrice: 50,
    });
    expect(blocked).toContain('corto');
    // Vender una posición abierta sí pasa por esta regla (cierra el largo).
    expect(
      liveOrderBlockReason(
        snapshot({ openTickers: ['SPY'] }),
        request({ side: 'sell', quantity: 1 }),
        { leg: 'entrada', requestedPrice: 50 },
      ),
    ).toBeNull();
  });

  it('los techos fijos de la fase son los del contrato (los límites no pueden excederlos)', () => {
    // Coherencia con shared/live.ts: si los techos cambiaran, esta prueba avisa.
    expect(LIVE_FIXED_CAPS).toEqual({
      capitalUsd: 1_000,
      orderUsd: 200,
      dailyLossUsd: 20,
      openPositions: 2,
    });
  });
});
