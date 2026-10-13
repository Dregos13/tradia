import { describe, expect, it } from 'vitest';

import { FX_BROKER_REJECTION_MESSAGE } from '../../shared/fxTrading';
import { LIVE_FIXED_CAPS, LIVE_FIXED_SHORT_CAPS, type LiveLimits } from '../../shared/live';
import type { BrokerOrderRequest } from '../broker/types';
import {
  estimateOrderNotionalUsd,
  liveOrderBlockReason,
  liveOrderWirePrice,
  type LiveOrderContext,
  type LiveOrderSnapshot,
} from './orderGuard';

const LIMITS: LiveLimits = {
  capitalUsd: 500,
  orderUsd: 100,
  dailyLossUsd: 10,
  openPositions: 2,
  shortOrderUsd: 0,
  shortExposureUsd: 0,
  shortPositions: 0,
};

/** Límites con el corto habilitado en sus techos escritos. */
const LIMITS_CON_CORTO: LiveLimits = {
  ...LIMITS,
  shortOrderUsd: 100,
  shortExposureUsd: 200,
  shortPositions: 1,
};

const snapshot = (patch: Partial<LiveOrderSnapshot> = {}): LiveOrderSnapshot => ({
  mode: 'activo',
  limits: { ...LIMITS },
  openPositions: [],
  shortExposureUsd: null,
  pendingShortUsd: 0,
  accountShorting: null,
  asset: null,
  capitalInUseUsd: 0,
  realizedLossTodayUsd: 0,
  shortRequirementsBlockReason: null,
  ...patch,
});

/** Snapshot con todo lo que el corto necesita: límites, cuenta y título. */
const shortSnapshot = (patch: Partial<LiveOrderSnapshot> = {}): LiveOrderSnapshot =>
  snapshot({
    limits: { ...LIMITS_CON_CORTO },
    accountShorting: true,
    asset: { shortable: true, easyToBorrow: true },
    shortExposureUsd: 0,
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

const context = (patch: Partial<LiveOrderContext> = {}): LiveOrderContext => ({
  leg: 'entrada',
  requestedPrice: 50,
  ...patch,
});

/** Entrada en corto ya limitada y con su stop de protección a < 5 %. */
const shortContext = (patch: Partial<LiveOrderContext> = {}): LiveOrderContext =>
  context({ requestedPrice: 50, entryStopPrice: 52, ...patch });

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
    const withTwo = snapshot({
      openPositions: [
        { ticker: 'SPY', side: 'long', quantity: 1 },
        { ticker: 'AAPL', side: 'long', quantity: 1 },
      ],
    });
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

  it('los techos fijos de la fase son los del contrato (los límites no pueden excederlos)', () => {
    // Coherencia con shared/live.ts: si los techos cambiaran, esta prueba avisa.
    expect(LIVE_FIXED_CAPS).toEqual({
      capitalUsd: 1_000,
      orderUsd: 200,
      dailyLossUsd: 20,
      openPositions: 2,
      shortOrderUsd: 100,
      shortExposureUsd: 200,
      shortPositions: 1,
    });
    expect(LIVE_FIXED_SHORT_CAPS).toEqual({
      shortOrderUsd: 100,
      shortExposureUsd: 200,
      shortPositions: 1,
      shortMaxStopPct: 5,
    });
  });
});

describe('liveOrderBlockReason — puerta propia del corto real', () => {
  const shortSell = (patch: Partial<BrokerOrderRequest> = {}): BrokerOrderRequest =>
    request({ side: 'sell', type: 'limit', limitPrice: 50, quantity: 1, ...patch });

  it('una entrada en corto válida pasa por la misma guarda', () => {
    const reason = liveOrderBlockReason(shortSnapshot(), shortSell(), shortContext());
    expect(reason).toBeNull();
  });

  it.each([{ shortOrderUsd: 0 }, { shortExposureUsd: 0 }, { shortPositions: 0 }] as const)(
    'con los límites del corto a 0 (%o) el corto no está habilitado',
    (patch) => {
      const state = shortSnapshot({ limits: { ...LIMITS_CON_CORTO, ...patch } });
      const reason = liveOrderBlockReason(state, shortSell(), shortContext());
      expect(reason).toContain('no está habilitado');
    },
  );

  it('una venta a mercado en corto se rechaza (la entrada va siempre acotada)', () => {
    const reason = liveOrderBlockReason(
      shortSnapshot(),
      request({ side: 'sell', type: 'market', quantity: 1 }),
      shortContext(),
    );
    expect(reason).toContain('acotado');
    expect(reason).toContain('nunca a mercado');
  });

  it('una entrada en corto como venta stop a la referencia también pasa', () => {
    const reason = liveOrderBlockReason(
      shortSnapshot(),
      request({ side: 'sell', type: 'stop', stopPrice: 50, quantity: 1 }),
      shortContext(),
    );
    expect(reason).toBeNull();
  });

  it('sin stop de protección se rechaza; por debajo de la entrada o a más del 5 % también', () => {
    expect(
      liveOrderBlockReason(shortSnapshot(), shortSell(), context({ entryStopPrice: null })),
    ).toContain('stop de compra de protección');
    // Stop por debajo de la entrada.
    expect(
      liveOrderBlockReason(shortSnapshot(), shortSell(), shortContext({ entryStopPrice: 49 })),
    ).toContain('por encima de la entrada');
    // Stop a más del 5 % por encima (52.6 > 50 × 1.05).
    expect(
      liveOrderBlockReason(shortSnapshot(), shortSell(), shortContext({ entryStopPrice: 52.6 })),
    ).toContain('5 %');
    // Justo en el 5 % sí pasa.
    expect(
      liveOrderBlockReason(shortSnapshot(), shortSell(), shortContext({ entryStopPrice: 52.5 })),
    ).toBeNull();
  });

  it('sin lectura del broker (cuenta, título o exposición) el corto no sale', () => {
    expect(
      liveOrderBlockReason(shortSnapshot({ accountShorting: null }), shortSell(), shortContext()),
    ).toContain('no se pudo comprobar');
    expect(
      liveOrderBlockReason(shortSnapshot({ asset: null }), shortSell(), shortContext()),
    ).toContain('prestado');
    expect(
      liveOrderBlockReason(shortSnapshot({ shortExposureUsd: null }), shortSell(), shortContext()),
    ).toContain('exposición');
  });

  it('cuenta sin margen o título no prestable se rechaza con motivo claro', () => {
    expect(
      liveOrderBlockReason(shortSnapshot({ accountShorting: false }), shortSell(), shortContext()),
    ).toContain('margen');
    expect(
      liveOrderBlockReason(
        shortSnapshot({ asset: { shortable: false, easyToBorrow: true } }),
        shortSell(),
        shortContext(),
      ),
    ).toContain('no admite cortarlo');
    expect(
      liveOrderBlockReason(
        shortSnapshot({ asset: { shortable: true, easyToBorrow: false } }),
        shortSell(),
        shortContext(),
      ),
    ).toContain('tomar prestado');
  });

  it('un corto por encima del límite por orden del corto se bloquea con margen de hueco', () => {
    // 1.9 × 50 = 95 USD de nominal; con el margen del 5 % queda en 99,75 ≤ 100.
    expect(
      liveOrderBlockReason(shortSnapshot(), shortSell({ quantity: 1.9 }), shortContext()),
    ).toBeNull();
    // 2 × 50 = 100 USD; con margen queda en 105 > 100.
    expect(
      liveOrderBlockReason(shortSnapshot(), shortSell({ quantity: 2 }), shortContext()),
    ).toContain('límite por orden en corto');
  });

  it('la exposición corta a precio actual más el pedido se acota por su límite', () => {
    // Corto abierto de 150 USD + uno pendiente de 30 + este de 50 = 230 > 200.
    const state = shortSnapshot({
      openPositions: [{ ticker: 'AAPL', side: 'short', quantity: 3 }],
      shortExposureUsd: 150,
      pendingShortUsd: 30,
    });
    const reason = liveOrderBlockReason(state, shortSell(), shortContext());
    expect(reason).toContain('exposición en corto');
    expect(reason).toContain('230');
    expect(reason).toContain('200');
  });

  it('con un corto abierto no cabe un segundo corto en otro ticker', () => {
    const state = shortSnapshot({
      openPositions: [{ ticker: 'AAPL', side: 'short', quantity: 1 }],
      shortExposureUsd: 50,
    });
    const reason = liveOrderBlockReason(state, shortSell({ ticker: 'MSFT' }), shortContext());
    expect(reason).toContain('posición(es) en corto');
  });

  it('ampliar un corto abierto no cuenta como una posición nueva pero suma exposición', () => {
    const state = shortSnapshot({
      openPositions: [{ ticker: 'SPY', side: 'short', quantity: 1 }],
      shortExposureUsd: 50,
    });
    // Otro corto en SPY dentro del límite de exposición pasa.
    expect(liveOrderBlockReason(state, shortSell({ quantity: 0.5 }), shortContext())).toBeNull();
    // Pero si la exposición se pasa (160 + 50 > 200), se bloquea.
    expect(
      liveOrderBlockReason(
        shortSnapshot({
          openPositions: [{ ticker: 'SPY', side: 'short', quantity: 1 }],
          shortExposureUsd: 160,
        }),
        shortSell(),
        shortContext(),
      ),
    ).toContain('exposición en corto');
  });

  it('el total de posiciones (largos + cortos) sigue acotado', () => {
    // Dos largos llenan el total; un corto nuevo en SPY no cabe aunque no
    // haya todavía ningún corto abierto.
    const state = shortSnapshot({
      openPositions: [
        { ticker: 'AAPL', side: 'long', quantity: 1 },
        { ticker: 'MSFT', side: 'long', quantity: 1 },
      ],
      shortExposureUsd: 0,
    });
    const reason = liveOrderBlockReason(state, shortSell({ ticker: 'SPY' }), shortContext());
    expect(reason).toContain('posición(es) abierta(s)');
  });

  it('la pérdida diaria del corto también frena la entrada', () => {
    const reason = liveOrderBlockReason(
      shortSnapshot({ realizedLossTodayUsd: 10 }),
      shortSell({ quantity: 0.5 }),
      shortContext(),
    );
    expect(reason).toContain('pérdida realizada');
  });

  it('vender sobre un largo en cartera sigue siendo cierre, no corto', () => {
    const state = snapshot({
      openPositions: [{ ticker: 'SPY', side: 'long', quantity: 2 }],
    });
    // Hasta la cantidad en cartera pasa como cierre/reducción del largo.
    expect(
      liveOrderBlockReason(state, request({ side: 'sell', quantity: 2 }), {
        leg: 'entrada',
        requestedPrice: 50,
      }),
    ).toBeNull();
  });

  it('la recompra de un corto nunca se bloquea, ni con el modo suspendido', () => {
    const state = snapshot({
      mode: 'suspendido',
      limits: null,
      openPositions: [{ ticker: 'SPY', side: 'short', quantity: 2 }],
    });
    expect(
      liveOrderBlockReason(state, request({ side: 'buy', quantity: 2 }), {
        leg: 'entrada',
        requestedPrice: 55,
      }),
    ).toBeNull();
    // El stop del corto (compra 'salida') tampoco.
    expect(
      liveOrderBlockReason(
        state,
        request({ side: 'buy', type: 'oco', limitPrice: 40, stopPrice: 55, quantity: 2 }),
        { leg: 'salida', requestedPrice: 40 },
      ),
    ).toBeNull();
  });
});

describe('liveOrderBlockReason — anti-vuelta de posición', () => {
  it('vender más que el largo en cartera se bloquea (abriría un corto)', () => {
    const state = shortSnapshot({
      openPositions: [{ ticker: 'SPY', side: 'long', quantity: 1 }],
    });
    const reason = liveOrderBlockReason(state, request({ side: 'sell', quantity: 2 }), {
      leg: 'entrada',
      requestedPrice: 50,
    });
    expect(reason).toContain('vuelta');
    expect(reason).toContain('corto');
  });

  it('comprar más que el corto abierto se bloquea (abriría un largo)', () => {
    const state = shortSnapshot({
      openPositions: [{ ticker: 'SPY', side: 'short', quantity: 1 }],
    });
    const reason = liveOrderBlockReason(state, request({ side: 'buy', quantity: 2 }), {
      leg: 'entrada',
      requestedPrice: 50,
    });
    expect(reason).toContain('vuelta');
    expect(reason).toContain('largo');
  });

  it('la entrada en corto sobre un ticker con largo no llega a la puerta del corto', () => {
    // Con un largo abierto la venta es cierre/reducción, nunca un corto.
    const state = snapshot({
      openPositions: [{ ticker: 'SPY', side: 'long', quantity: 3 }],
    });
    expect(
      liveOrderBlockReason(state, request({ side: 'sell', quantity: 1 }), {
        leg: 'entrada',
        requestedPrice: 50,
      }),
    ).toBeNull();
  });
});

describe('liveOrderWirePrice — tope en la red', () => {
  it('una entrada en corto de señal sale acotada a la referencia', () => {
    const price = liveOrderWirePrice(
      shortSnapshot(),
      request({ side: 'sell', type: 'market', quantity: 1 }),
      shortContext(),
    );
    expect(price).toBe(50);
  });

  it('una venta sobre un largo en cartera sale tal cual (es un cierre)', () => {
    const price = liveOrderWirePrice(
      snapshot({ openPositions: [{ ticker: 'SPY', side: 'long', quantity: 1 }] }),
      request({ side: 'sell', type: 'market', quantity: 1 }),
      context(),
    );
    expect(price).toBeNull();
  });

  it('sin referencia no hay tope y la guarda lo rechaza después', () => {
    expect(
      liveOrderWirePrice(
        shortSnapshot(),
        request({ side: 'sell', type: 'market', quantity: 1 }),
        context({ requestedPrice: null }),
      ),
    ).toBeNull();
    expect(
      liveOrderBlockReason(
        shortSnapshot(),
        request({ side: 'sell', type: 'market', quantity: 1 }),
        context({ requestedPrice: null, entryStopPrice: 52 }),
      ),
    ).toContain('importe');
  });
});

describe('guarda de órdenes live — requisitos propios del corto', () => {
  const blocked = (patch: Partial<LiveOrderSnapshot> = {}): LiveOrderSnapshot =>
    shortSnapshot({
      shortRequirementsBlockReason:
        'Falta la declaración «Revisión legal y fiscal específica de las ventas en corto».',
      ...patch,
    });

  it('toda entrada en corto se rechaza con «[corto-requisitos]» aunque los límites estén confirmados', () => {
    const reason = liveOrderBlockReason(
      blocked(),
      request({ side: 'sell', type: 'market', quantity: 1 }),
      shortContext(),
    );
    expect(reason).toMatch(/^\[corto-requisitos\] /);
    expect(reason).toContain('Revisión legal y fiscal específica');
  });

  it('el bloqueo se aplica antes que cualquier otra puerta del corto', () => {
    // Ni cuenta shortable ni nocional ajustado importan: primero los
    // requisitos propios del corto.
    const reason = liveOrderBlockReason(
      blocked({ accountShorting: false, asset: { shortable: false, easyToBorrow: false } }),
      request({ side: 'sell', type: 'market', quantity: 10 }),
      shortContext({ requestedPrice: 20, entryStopPrice: 21.5 }),
    );
    expect(reason).toMatch(/^\[corto-requisitos\] /);
  });

  it('con los requisitos cumplidos el corto pasa a las puertas habituales', () => {
    expect(
      liveOrderBlockReason(
        shortSnapshot(),
        request({ side: 'sell', type: 'limit', limitPrice: 50, quantity: 1 }),
        shortContext(),
      ),
    ).toBeNull();
  });

  it('una recompra de un corto abierto sigue pasando aunque falten requisitos', () => {
    const state = blocked({
      openPositions: [{ ticker: 'SPY', side: 'short', quantity: 1 }],
    });
    expect(
      liveOrderBlockReason(state, request({ side: 'buy', type: 'market', quantity: 1 }), {
        leg: 'salida',
        requestedPrice: 55,
      }),
    ).toBeNull();
  });

  it('la pata de protección OCO de un corto sigue pasando aunque falten requisitos', () => {
    // El stop de compra de la OCO se envía con pata 'salida' (es el
    // cierre del corto, no una entrada).
    const state = blocked({
      openPositions: [{ ticker: 'SPY', side: 'short', quantity: 1 }],
    });
    expect(
      liveOrderBlockReason(
        state,
        request({ side: 'buy', type: 'stop', quantity: 1, stopPrice: 52 }),
        { leg: 'salida', requestedPrice: 52 },
      ),
    ).toBeNull();
  });

  it('una entrada en largo no se ve afectada por el bloqueo del corto', () => {
    expect(
      liveOrderBlockReason(
        blocked(),
        request({ side: 'buy', type: 'market', quantity: 1 }),
        context(),
      ),
    ).toBeNull();
  });
});

describe('liveOrderBlockReason — divisas', () => {
  it.each([
    [
      'entrada en largo',
      request({ ticker: 'EURUSD', quantity: 50 }),
      context({ requestedPrice: 1.09 }),
    ],
    [
      'entrada en corto',
      request({ ticker: 'GBPUSD', side: 'sell', type: 'stop', stopPrice: 1.27, quantity: 50 }),
      shortContext({ requestedPrice: 1.27, entryStopPrice: 1.3 }),
    ],
    [
      'pata de salida',
      request({ ticker: 'eurusd', side: 'sell', type: 'oco', limitPrice: 1.2, stopPrice: 1.05 }),
      context({ leg: 'salida', requestedPrice: 1.2 }),
    ],
  ])('una orden de divisas (%s) no sale nunca con dinero real', (_label, order, ctx) => {
    // Con todo en regla para operar (modo activo, límites y corto habilitados).
    const reason = liveOrderBlockReason(shortSnapshot(), order, ctx);
    expect(reason).toBe(FX_BROKER_REJECTION_MESSAGE);
    expect(reason).toContain(
      'el bróker conectado no opera divisas: se opera solo en la cartera simulada',
    );
  });

  it('una acción con el mismo snapshot sigue pasando (el bloqueo es solo de divisas)', () => {
    expect(liveOrderBlockReason(snapshot(), request({ quantity: 1 }), context())).toBeNull();
  });
});
