/**
 * Prueba de humo del dinero real (fase 7) — compra fraccionaria de
 * mercado por 1 USD nocional en SPY, espera de la ejecución, venta de
 * cierre y conciliación, con cada paso en el Diario y el resultado
 * persistido en `live_mode.prueba_humo`.
 *
 * `createLiveSmokeTest` es testeable sin Electron: el adaptador live
 * (real o el servidor falso de las pruebas), el repositorio de
 * `broker_orders_live`, la guarda de techos, el precio de referencia, la
 * conciliación, la suspensión del modo y los relojes llegan inyectados.
 *
 * Reglas de negocio:
 * - No se lanza sin el modo real 'activo' (la lista se reevalúa antes),
 *   con la parada inactiva, con conexión, con la cuenta conectada y con
 *   un precio de referencia RECIENTE para dimensionar la fracción (su
 *   cierre debe ser de una sesión cercana a la última esperada, margen
 *   `LIVE_SMOKE_REFERENCE_MAX_AGE_DAYS` días; un dato desfasado no sirve
 *   para mover dinero real). Esos rechazos lanzan `LiveSmokeError` ANTES
 *   de tocar la red; no suspenden el modo.
 * - La compra pasa la guarda de techos (`liveOrderBlockReason`) como una
 *   orden suelta: un límite por orden o de capital por debajo de 1 USD
 *   la bloquea antes del broker y queda en el Diario. Sale a la red como
 *   limitada con tope —min(techo por orden, referencia ×
 *   (1 + LIVE_SMOKE_MAX_SLIPPAGE_BPS))—, nunca de mercado a ciegas. La
 *   venta de cierre se evalúa como pata 'salida': una posición real
 *   abierta siempre debe poder cerrarse.
 * - La ejecución reportada se contrasta: si el nocional supera el mínimo
 *   con margen (`LIVE_SMOKE_NOTIONAL_TOLERANCE`) o el slippage frente a
 *   la referencia es absurdo (|pb| > `LIVE_SMOKE_MAX_SLIPPAGE_BPS`), la
 *   prueba falla —referencia y broker no cuadran— en vez de firmar que
 *   compra y vende de verdad.
 * - Las órdenes de la prueba quedan en `broker_orders_live` con su
 *   precio de referencia (para el slippage), el precio y la hora de
 *   ejecución, sin pata ni señal: cuentan para la conciliación y las
 *   posiciones, pero no son operaciones de estrategia (ni inflan la
 *   muestra del escalado ni el informe real vs backtest).
 * - Un fallo de ejecución o una conciliación con descuadres deja el
 *   resultado 'fallida-*' persistido con el paso fallido, lo anota en el
 *   Diario y suspende el modo real ('requisito-vencido'): tras una
 *   prueba fallida no se envían órdenes nuevas hasta revisarla.
 * - Una posición real abierta jamás se oculta: si la compra ejecutó y el
 *   cierre falló, el estado lo dice ('fallida-posicion-abierta').
 * - Solo una prueba en curso: la segunda llamada se rechaza ('en-curso').
 */
import {
  slippageBpsOf,
  type BrokerOrder,
  type BrokerOrderLeg,
  type ReconcileRun,
} from '../../shared/broker';
import type { JournalRecordInput } from '../../shared/journal';
import {
  LIVE_SMOKE_NOTIONAL_USD,
  LIVE_SMOKE_STEPS,
  LIVE_SMOKE_TICKER,
  type LiveChecklist,
  type LiveModeState,
  type LiveSmokeStep,
  type LiveSmokeTestResult,
} from '../../shared/live';
import { positionsFromOrders } from '../broker/reconcile';
import type { BrokerOrderPatch, BrokerRepository } from '../broker/repository';
import type { BrokerAdapter, BrokerOrderRequest, RemoteOrder } from '../broker/types';
import { lastExpectedSession } from '../market/calendar';
import type { LiveStore } from './service';

// ---------------------------------------------------------------------------
// Errores y contrato
// ---------------------------------------------------------------------------

export const LIVE_SMOKE_ERROR_CODES = [
  /** Ya hay una prueba en curso. */
  'en-curso',
  /** El modo real no está 'activo' (o la lista dejó de cumplirse). */
  'modo-no-activo',
  /** La parada de emergencia está activa. */
  'parada-emergencia',
  /** Sin conexión a internet. */
  'sin-conexion',
  /** No hay cuenta real conectada (adaptador ausente). */
  'sin-cuenta',
  /** Falta el precio de referencia para dimensionar la fracción. */
  'sin-precio',
  /** La referencia existe pero es de una sesión ya vieja (dato desfasado). */
  'precio-desfasado',
  /** La guarda de techos bloqueó la compra antes de la red. */
  'orden-bloqueada',
] as const;
export type LiveSmokeErrorCode = (typeof LIVE_SMOKE_ERROR_CODES)[number];

/** Rechazo ANTES de tocar el broker: el modo real no se suspende por ello. */
export class LiveSmokeError extends Error {
  readonly code: LiveSmokeErrorCode;

  constructor(code: LiveSmokeErrorCode, message: string) {
    super(message);
    this.name = 'LiveSmokeError';
    this.code = code;
  }
}

/** Fallo dentro de la prueba, con el paso que lo produjo. */
class SmokeStepError extends Error {
  readonly step: LiveSmokeStep;

  constructor(step: LiveSmokeStep, message: string) {
    super(message);
    this.name = 'SmokeStepError';
    this.step = step;
  }
}

export interface LiveSmokeDeps {
  /** Adaptador live conectado; null mientras no haya cuenta. */
  getAdapter(): BrokerAdapter | null;
  /** Repositorio de las órdenes reales (`broker_orders_live`). */
  repository: Pick<BrokerRepository, 'insertOrder' | 'updateOrder' | 'listOrders'>;
  /** Almacén del modo real (estado, `prueba_humo` y límites confirmados). */
  store: Pick<LiveStore, 'getMode' | 'getLimits' | 'setSmokeTest'>;
  /** Reevalúa la lista (suspende el modo si un requisito venció). */
  getChecklist(): Pick<LiveChecklist, 'allComplete'>;
  /**
   * Guarda de techos por orden ya construida (`liveOrderBlockReason`
   * sobre la exposición actual): devuelve el motivo del bloqueo o null.
   */
  checkOrderAllowed(
    request: BrokerOrderRequest,
    context: { leg: BrokerOrderLeg | null; requestedPrice: number | null },
  ): string | null;
  /**
   * Último cierre del ticker con la fecha de su vela; null si no hay
   * datos. La prueba exige una referencia reciente (sesión cercana a la
   * última esperada) antes de dimensionar nada.
   */
  referencePrice(
    ticker: string,
  ): { price: number; asOf: string } | null | Promise<{ price: number; asOf: string } | null>;
  /**
   * Reloj de mercado para juzgar la frescura de la referencia (el reloj
   * anclado con el que se ingieren las velas); por defecto `now`.
   */
  marketNow?(): number;
  /** Ejecuta una conciliación app ↔ broker real y la persiste. */
  reconcileNow(): Promise<ReconcileRun>;
  /** Descuadres abiertos tras la última conciliación. */
  openDiscrepancyCount(): number;
  /**
   * Suspende el modo real con el detalle dado (no-op si ya no está
   * 'activo'): equivale a `live.suspend('requisito-vencido', detail)`.
   */
  suspend(detail: string): void;
  /** Parada de emergencia activa (bloquea el lanzamiento). */
  isKillSwitchActive?(): boolean;
  /** Conexión a internet disponible (bloquea el lanzamiento). */
  isOnline?(): boolean;
  /** Entrada del diario automático (`journal.record`). */
  recordJournal?(input: JournalRecordInput): void;
  /** Aviso tras persistir (`live:changed` hacia las ventanas). */
  emitChanged?(): void;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** Espera máxima por la ejecución de una pata (ms); por defecto 20 s. */
  fillTimeoutMs?: number;
  /** Intervalo entre consultas de estado de la orden (ms); 500 ms. */
  pollIntervalMs?: number;
  logger?: { info?(m: string): void; warn?(m: string): void; error?(m: string): void };
}

export interface LiveSmokeTestService {
  /**
   * `live:smoke-test`: ejecuta la prueba completa y devuelve el resultado
   * persistido (también en `live:state.smokeTest`). Lanza
   * `LiveSmokeError` solo en los rechazos previos al primer envío.
   */
  run(request: { confirm: true }): Promise<LiveSmokeTestResult>;
}

// ---------------------------------------------------------------------------
// Constantes y utilidades
// ---------------------------------------------------------------------------

/** Espera por defecto a que una pata ejecute (ms). */
export const SMOKE_FILL_TIMEOUT_MS = 20_000;
/** Intervalo por defecto entre consultas al broker (ms). */
export const SMOKE_POLL_INTERVAL_MS = 500;
/**
 * Slippage máximo frente a la referencia (300 pb = 3 %). Acota además el
 * precio limit de la compra: el broker no puede rellenar por encima de
 * referencia × 1,03.
 */
export const LIVE_SMOKE_MAX_SLIPPAGE_BPS = 300;
/**
 * Margen sobre el mínimo (5 %): la prueba falla si la compra ejecutó más
 * de `LIVE_SMOKE_NOTIONAL_USD × (1 + 5 %)` de nocional.
 */
export const LIVE_SMOKE_NOTIONAL_TOLERANCE = 0.05;
/**
 * Días de margen sobre la última sesión esperada (reloj de mercado) para
 * que la referencia cuente como reciente: cubre un fin de semana largo
 * festivo; un cierre más viejo es dato desfasado y no se envía nada.
 */
export const LIVE_SMOKE_REFERENCE_MAX_AGE_DAYS = 4;

const STEP_LABELS: Record<LiveSmokeStep, string> = {
  'compra-enviada': 'compra enviada',
  'posicion-cerrada': 'posición cerrada',
  'conciliacion-ok': 'conciliación sin descuadres',
};

const MODE_LABELS: Record<Exclude<LiveModeState, 'activo'>, string> = {
  bloqueado: 'bloqueado por la lista de comprobación',
  listo: 'listo pero aún no activado',
  suspendido: 'suspendido',
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const fmtPrice = (value: number): string => value.toFixed(2).replace('.', ',');

const fmtQty = (value: number): string =>
  value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');

const fmtBps = (value: number): string => {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded > 0 ? '+' : ''}${String(rounded).replace('.', ',')} pb`;
};

export function createLiveSmokeTest(deps: LiveSmokeDeps): LiveSmokeTestService {
  const now = deps.now ?? (() => Date.now());
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fillTimeoutMs = Math.max(1_000, deps.fillTimeoutMs ?? SMOKE_FILL_TIMEOUT_MS);
  const pollIntervalMs = Math.max(50, deps.pollIntervalMs ?? SMOKE_POLL_INTERVAL_MS);
  const logger = deps.logger ?? console;
  const isoNow = (): string => new Date(now()).toISOString();

  let running: Promise<LiveSmokeTestResult> | null = null;

  const journal = (input: JournalRecordInput): void => {
    try {
      // La prueba de humo usa dinero real: todas sus entradas quedan
      // marcadas 'live' para que el Diario las rotule «Dinero real» y la
      // conciliación diaria no las cuente como operaciones simuladas.
      deps.recordJournal?.({ ...input, mode: 'live' });
    } catch (error: unknown) {
      logger.warn?.(`[live-humo] no se pudo escribir el Diario: ${errorMessage(error)}`);
    }
  };

  const update = (order: BrokerOrder, patch: BrokerOrderPatch): BrokerOrder =>
    deps.repository.updateOrder(order.id, patch, isoNow());

  /** Copia el estado que reporta el broker sobre la fila local. */
  const adoptRemote = (order: BrokerOrder, remote: RemoteOrder): BrokerOrder => {
    const patch: BrokerOrderPatch = {
      brokerOrderId: remote.brokerOrderId,
      status: remote.status,
      filledQuantity: remote.filledQuantity,
      ocoGroupId: remote.ocoGroupId,
    };
    if (remote.filledAt !== null || remote.filledAvgPrice !== null) {
      patch.executedAt = remote.filledAt;
      patch.executedPrice = remote.filledAvgPrice;
      patch.slippageBps = slippageBpsOf(
        remote.side,
        order.execution.requestedPrice ?? remote.limitPrice ?? remote.stopPrice,
        remote.filledAvgPrice,
      );
    }
    if (remote.status === 'rechazada' && patch.rejectReason === undefined) {
      patch.rejectReason = 'rechazada por el broker';
    }
    return update(order, patch);
  };

  /** Registra la orden local y la envía; devuelve la fila tras la respuesta. */
  const submit = async (
    adapter: BrokerAdapter,
    step: LiveSmokeStep,
    request: BrokerOrderRequest,
    referencePrice: number,
  ): Promise<BrokerOrder> => {
    const { order } = deps.repository.insertOrder({
      clientOrderId: request.clientOrderId,
      signalId: null,
      strategyId: null,
      leg: null,
      ticker: request.ticker,
      type: request.type,
      side: request.side,
      quantity: request.quantity,
      limitPrice: request.limitPrice ?? null,
      requestedPrice: referencePrice,
      requestedAt: isoNow(),
      status: 'pendiente',
      attempts: 1,
    });
    try {
      return adoptRemote(order, await adapter.submitOrder(request));
    } catch (error: unknown) {
      update(order, {
        status: 'rechazada',
        rejectReason: errorMessage(error),
        attempts: 1,
      });
      throw new SmokeStepError(step, errorMessage(error));
    }
  };

  /**
   * Espera la ejecución completa consultando al broker hasta 'ejecutada',
   * un estado terminal o el límite de espera, tras el cual intenta
   * cancelarla para no dejarla colgada. Lanza `SmokeStepError`.
   */
  const waitForFill = async (
    adapter: BrokerAdapter,
    step: LiveSmokeStep,
    initial: BrokerOrder,
  ): Promise<BrokerOrder> => {
    let current = initial;
    const deadline = now() + fillTimeoutMs;
    while (
      current.status === 'enviada' ||
      current.status === 'pendiente' ||
      current.status === 'parcial'
    ) {
      if (now() >= deadline) {
        // Una orden viva sin ejecutar no debe quedar colgada: se intenta
        // cancelar antes de declarar el paso fallido.
        if (current.brokerOrderId !== null) {
          try {
            current = adoptRemote(current, await adapter.cancelOrder(current.brokerOrderId));
          } catch (error: unknown) {
            logger.warn?.(
              `[live-humo] no se pudo cancelar ${current.clientOrderId}: ${errorMessage(error)}`,
            );
          }
        }
        throw new SmokeStepError(
          step,
          `el broker no ejecutó la orden ${current.clientOrderId} en ` +
            `${Math.round(fillTimeoutMs / 1000)} s (quedó ${current.status})`,
        );
      }
      await sleep(pollIntervalMs);
      try {
        const remote = await adapter.getOrderByClientId(current.clientOrderId);
        if (remote !== null) current = adoptRemote(current, remote);
      } catch (error: unknown) {
        // Una lectura fallida no es terminal: se reintenta hasta el límite.
        logger.warn?.(
          `[live-humo] no se pudo consultar ${current.clientOrderId}: ${errorMessage(error)}`,
        );
      }
    }
    if (current.status !== 'ejecutada') {
      throw new SmokeStepError(
        step,
        `la orden ${current.clientOrderId} quedó ${current.status}` +
          (current.rejectReason !== null ? `: ${current.rejectReason}` : ''),
      );
    }
    return current;
  };

  /** Posición abierta del ticker según las órdenes live registradas. */
  const openPositionQty = (): number =>
    positionsFromOrders(deps.repository.listOrders())
      .filter((position) => position.ticker === LIVE_SMOKE_TICKER)
      .reduce((sum, position) => sum + position.quantity, 0);

  const execute = async (): Promise<LiveSmokeTestResult> => {
    // La lista se reevalúa primero: si un requisito venció, esta llamada
    // ya suspendió el modo y el estado leído después ya no es 'activo'.
    deps.getChecklist();
    const mode = deps.store.getMode().estado;
    if (mode !== 'activo') {
      throw new LiveSmokeError(
        'modo-no-activo',
        `El modo real está ${MODE_LABELS[mode]}; la prueba de humo solo se lanza con el modo activo.`,
      );
    }
    if (deps.isKillSwitchActive?.() === true) {
      throw new LiveSmokeError(
        'parada-emergencia',
        'La parada de emergencia está activa; reanúdala antes de probar.',
      );
    }
    if (deps.isOnline?.() === false) {
      throw new LiveSmokeError(
        'sin-conexion',
        'Sin conexión a internet; la prueba de humo necesita llegar al broker.',
      );
    }
    const adapter = deps.getAdapter();
    if (adapter === null) {
      throw new LiveSmokeError(
        'sin-cuenta',
        'La cuenta real no está conectada; conecta las claves live antes de probar.',
      );
    }

    // Todo lo comprobable antes de la red se evalúa aquí: el precio de
    // referencia para dimensionar la fracción y la guarda de techos. Un
    // rechazo en este tramo no deja prueba 'en-curso' persistida.
    const reference = await deps.referencePrice(LIVE_SMOKE_TICKER);
    if (reference === null || !(reference.price > 0) || !Number.isFinite(reference.price)) {
      throw new LiveSmokeError(
        'sin-precio',
        `No hay precio de referencia reciente de ${LIVE_SMOKE_TICKER}; ` +
          'sin él no se puede dimensionar la fracción de 1 USD.',
      );
    }
    // La referencia debe ser de una sesión reciente: con un cierre
    // desfasado la fracción se dimensiona mal y la comparación con la
    // ejecución del broker queda sesgada.
    const marketNow = deps.marketNow ?? now;
    const lastSession = lastExpectedSession(marketNow());
    const asOfMs = Date.parse(`${reference.asOf}T00:00:00.000Z`);
    const referenceFresh =
      lastSession !== null &&
      Number.isFinite(asOfMs) &&
      asOfMs >=
        Date.parse(`${lastSession.date}T00:00:00.000Z`) -
          LIVE_SMOKE_REFERENCE_MAX_AGE_DAYS * 86_400_000;
    if (!referenceFresh) {
      throw new LiveSmokeError(
        'precio-desfasado',
        `El último cierre guardado de ${LIVE_SMOKE_TICKER} es del ${reference.asOf}: ` +
          'demasiado viejo para mover dinero real. Actualiza los datos de mercado.',
      );
    }
    const referencePrice = reference.price;
    // Fracción a la baja (6 decimales): el estimado nunca supera 1 USD.
    const quantity = Math.floor((LIVE_SMOKE_NOTIONAL_USD / referencePrice) * 1e6) / 1e6;
    if (!(quantity > 0)) {
      throw new LiveSmokeError(
        'sin-precio',
        `Con ${LIVE_SMOKE_TICKER} a ${fmtPrice(referencePrice)} USD la fracción de ` +
          '1 USD queda por debajo del mínimo representable.',
      );
    }
    const stamp = String(now());
    const buyRequest: BrokerOrderRequest = {
      clientOrderId: `tradia-humo-${stamp}-compra`,
      ticker: LIVE_SMOKE_TICKER,
      type: 'market',
      side: 'buy',
      quantity,
      timeInForce: 'day',
    };
    // La guarda de techos evalúa la compra como orden suelta: un techo
    // por debajo de 1 USD la frena aquí, antes de llegar a la red.
    const blocked = deps.checkOrderAllowed(buyRequest, {
      leg: null,
      requestedPrice: referencePrice,
    });
    if (blocked !== null) {
      journal({
        type: 'limite',
        ticker: LIVE_SMOKE_TICKER,
        result: 'alcanzado',
        reason: `Prueba de humo bloqueada antes de llegar al broker: ${blocked}.`,
        dataUsed: {
          clientOrderId: buyRequest.clientOrderId,
          notionalUsd: LIVE_SMOKE_NOTIONAL_USD,
          cantidad: quantity,
          precioReferencia: referencePrice,
        },
        errors: [blocked],
      });
      logger.warn?.(`[live-humo] compra bloqueada por techos: ${blocked}`);
      throw new LiveSmokeError('orden-bloqueada', blocked);
    }

    // La compra sale limitada con tope —min(techo por orden confirmado,
    // capital escrito, referencia × (1 + slippage máximo))—: ni un hueco
    // ni una referencia algo vieja pueden ejecutar por encima. Una
    // limitada no cruzable se cancela sola al vencer la espera.
    const limitsRow = deps.store.getLimits();
    const capUsd =
      limitsRow !== null && limitsRow.confirmados === 1
        ? Math.min(limitsRow.orden_usd, limitsRow.capital_usd)
        : null;
    const limitBound = Math.min(
      capUsd === null ? Number.POSITIVE_INFINITY : capUsd / quantity,
      referencePrice * (1 + LIVE_SMOKE_MAX_SLIPPAGE_BPS / 10_000),
    );
    const limitPrice = Math.floor(limitBound * 100) / 100;
    if (!(limitPrice > 0)) {
      throw new LiveSmokeError(
        'sin-precio',
        'No se pudo acotar el precio de la compra dentro de los techos escritos.',
      );
    }
    const buyOrder: BrokerOrderRequest = { ...buyRequest, type: 'limit', limitPrice };

    const result: LiveSmokeTestResult = {
      state: 'en-curso',
      steps: LIVE_SMOKE_STEPS.map((step) => ({ step, at: null })),
      ticker: LIVE_SMOKE_TICKER,
      notionalUsd: LIVE_SMOKE_NOTIONAL_USD,
      requestedPrice: null,
      // La referencia se conoce desde antes del envío: es contra ella
      // (no contra el límite de protección) contra lo que se mide el
      // slippage, y las tres superficies la ven igual.
      referencePrice,
      buyExecutedPrice: null,
      sellExecutedPrice: null,
      buyExecutedAt: null,
      sellExecutedAt: null,
      slippageBps: null,
      reconcileRunId: null,
      discrepancies: null,
      failedStep: null,
      error: null,
      startedAt: isoNow(),
      finishedAt: null,
    };
    const persist = (): void => {
      deps.store.setSmokeTest({
        pruebaHumo: JSON.stringify(result),
        actualizadoEn: isoNow(),
      });
      try {
        deps.emitChanged?.();
      } catch (error: unknown) {
        logger.warn?.(`[live-humo] el aviso de cambio falló: ${errorMessage(error)}`);
      }
    };
    const markStep = (step: LiveSmokeStep): void => {
      const row = result.steps.find((s) => s.step === step);
      if (row !== undefined) row.at = isoNow();
      persist();
    };
    persist();

    try {
      // -- Paso 1: compra limitada con tope por 1 USD nocional ----------
      const sent = await submit(adapter, 'compra-enviada', buyOrder, referencePrice);
      if (sent.status === 'rechazada' || sent.status === 'cancelada') {
        throw new SmokeStepError(
          'compra-enviada',
          `la orden ${sent.clientOrderId} quedó ${sent.status}` +
            (sent.rejectReason !== null ? `: ${sent.rejectReason}` : ''),
        );
      }
      // «Compra enviada» se marca al aceptarla el broker; la ejecución es
      // el subpaso siguiente y puede fallar por su cuenta.
      markStep('compra-enviada');
      const buy = await waitForFill(adapter, 'compra-enviada', sent);
      // Cordura del fill: un nocional por encima del mínimo con margen o
      // un slippage absurdo frente a la referencia delatan un dato
      // desfasado o una ejecución errónea — la prueba falla en vez de
      // firmar que «compra y vende de verdad».
      const buyExecuted = buy.execution.executedPrice;
      const buyNotional = buy.filledQuantity * (buyExecuted ?? 0);
      if (
        buyExecuted !== null &&
        buyNotional > LIVE_SMOKE_NOTIONAL_USD * (1 + LIVE_SMOKE_NOTIONAL_TOLERANCE)
      ) {
        throw new SmokeStepError(
          'compra-enviada',
          `la compra ejecutó ${fmtPrice(buyNotional)} USD de nocional (máximo ` +
            `${fmtPrice(LIVE_SMOKE_NOTIONAL_USD * (1 + LIVE_SMOKE_NOTIONAL_TOLERANCE))} USD): ` +
            'la referencia y el broker no cuadran',
        );
      }
      result.buyExecutedPrice = buyExecuted;
      result.buyExecutedAt = buy.execution.executedAt;
      result.slippageBps = buy.execution.slippageBps;
      if (
        result.slippageBps !== null &&
        Math.abs(result.slippageBps) > LIVE_SMOKE_MAX_SLIPPAGE_BPS
      ) {
        throw new SmokeStepError(
          'compra-enviada',
          `la compra ejecutó con slippage ${fmtBps(result.slippageBps)} frente a ` +
            `la referencia (máximo ${LIVE_SMOKE_MAX_SLIPPAGE_BPS} pb): ` +
            'la referencia y el broker no cuadran',
        );
      }
      result.requestedPrice = buy.limitPrice;
      persist();
      journal({
        type: 'resumen',
        ticker: LIVE_SMOKE_TICKER,
        result: 'completado',
        reason:
          `Prueba de humo · compra de ${fmtQty(buy.filledQuantity)} uds de ` +
          `${LIVE_SMOKE_TICKER} ejecutada a ${fmtPrice(buy.execution.executedPrice!)} USD ` +
          `(referencia ${fmtPrice(referencePrice)} USD, límite de protección ` +
          `${fmtPrice(buy.limitPrice ?? 0)} USD` +
          (result.slippageBps !== null ? `, slippage ${fmtBps(result.slippageBps)}` : '') +
          ').',
        dataUsed: {
          clientOrderId: buy.clientOrderId,
          brokerOrderId: buy.brokerOrderId,
          lado: 'buy',
          cantidad: buy.filledQuantity,
          precioReferencia: referencePrice,
          precioLimite: buy.limitPrice,
          precioEjecutado: buy.execution.executedPrice,
          slippageBps: result.slippageBps,
          notionalUsd: LIVE_SMOKE_NOTIONAL_USD,
          ejecutadaEn: buy.execution.executedAt,
        },
      });

      // -- Paso 2: venta de cierre de lo ejecutado ----------------------
      // La salida pasa la guarda como pata 'salida': cerrar una posición
      // real nunca queda atrapado por un techo ni por una suspensión.
      const sellRequest: BrokerOrderRequest = {
        clientOrderId: `tradia-humo-${stamp}-cierre`,
        ticker: LIVE_SMOKE_TICKER,
        type: 'market',
        side: 'sell',
        quantity: buy.filledQuantity,
        timeInForce: 'day',
      };
      const sellSent = await submit(adapter, 'posicion-cerrada', sellRequest, referencePrice);
      const sell = await waitForFill(adapter, 'posicion-cerrada', sellSent);
      markStep('posicion-cerrada');
      result.sellExecutedPrice = sell.execution.executedPrice;
      result.sellExecutedAt = sell.execution.executedAt;
      persist();
      journal({
        type: 'resumen',
        ticker: LIVE_SMOKE_TICKER,
        result: 'completado',
        reason:
          `Prueba de humo · posición cerrada: venta de ${fmtQty(sell.filledQuantity)} ` +
          `uds de ${LIVE_SMOKE_TICKER} a ${fmtPrice(sell.execution.executedPrice!)} USD.`,
        dataUsed: {
          clientOrderId: sell.clientOrderId,
          brokerOrderId: sell.brokerOrderId,
          lado: 'sell',
          cantidad: sell.filledQuantity,
          precioEjecutado: sell.execution.executedPrice,
          ejecutadaEn: sell.execution.executedAt,
        },
      });

      // -- Paso 3: conciliación app ↔ broker real -----------------------
      let run: ReconcileRun;
      try {
        run = await deps.reconcileNow();
      } catch (error: unknown) {
        throw new SmokeStepError('conciliacion-ok', errorMessage(error));
      }
      result.reconcileRunId = run.id;
      const openDiscrepancies = deps.openDiscrepancyCount();
      result.discrepancies = openDiscrepancies;
      if (run.result !== 'ok' || openDiscrepancies > 0) {
        throw new SmokeStepError(
          'conciliacion-ok',
          `la conciliación terminó con ${openDiscrepancies} ` +
            `${openDiscrepancies === 1 ? 'descuadre' : 'descuadres'} ` +
            `(ejecución ${run.id}: ${run.result})`,
        );
      }
      markStep('conciliacion-ok');

      result.state = 'cerrada-conciliada';
      result.finishedAt = isoNow();
      persist();
      const pnlUsd =
        buy.filledQuantity *
        ((sell.execution.executedPrice ?? 0) - (buy.execution.executedPrice ?? 0));
      const pnlResult = pnlUsd > 0.0005 ? 'ganancia' : pnlUsd < -0.0005 ? 'perdida' : 'empate';
      journal({
        type: 'operacion',
        ticker: LIVE_SMOKE_TICKER,
        result: pnlResult,
        reason:
          `Prueba de humo real completada: compra y cierre de ` +
          `${LIVE_SMOKE_NOTIONAL_USD} USD en ${LIVE_SMOKE_TICKER} conciliados ` +
          `sin descuadres (PnL ${pnlUsd >= 0 ? '+' : '−'}${fmtPrice(Math.abs(pnlUsd))} USD).`,
        dataUsed: {
          compraClientOrderId: buy.clientOrderId,
          cierreClientOrderId: sell.clientOrderId,
          precioReferencia: referencePrice,
          precioEjecutadoCompra: result.buyExecutedPrice,
          precioEjecutadoCierre: result.sellExecutedPrice,
          slippageBps: result.slippageBps,
          notionalUsd: LIVE_SMOKE_NOTIONAL_USD,
          pnlUsd,
          reconcileRunId: run.id,
          descuadres: 0,
        },
      });
      logger.info?.(
        `[live-humo] prueba cerrada y conciliada (${buy.clientOrderId} / ${sell.clientOrderId})`,
      );
      return result;
    } catch (error: unknown) {
      if (error instanceof LiveSmokeError) throw error;
      const step = error instanceof SmokeStepError ? error.step : 'compra-enviada';
      const message = errorMessage(error);
      result.failedStep = step;
      result.error = message;
      result.state = openPositionQty() > 0 ? 'fallida-posicion-abierta' : 'fallida-sin-posicion';
      result.finishedAt = isoNow();
      persist();
      journal({
        type: 'error',
        ticker: LIVE_SMOKE_TICKER,
        result: 'error',
        reason:
          `La prueba de humo de dinero real falló en «${STEP_LABELS[step]}»: ${message}` +
          (result.state === 'fallida-posicion-abierta'
            ? ' Queda una posición real abierta: revisa su cierre en Órdenes.'
            : ''),
        dataUsed: {
          pasoFallido: step,
          estado: result.state,
          notionalUsd: LIVE_SMOKE_NOTIONAL_USD,
        },
        errors: [message],
      });
      logger.warn?.(`[live-humo] prueba fallida en ${step}: ${message}`);
      // Una prueba fallida es evidencia de que el entorno real no responde
      // como debe: el modo real se suspende hasta revisarlo a mano.
      try {
        deps.suspend(`la prueba de humo falló en «${STEP_LABELS[step]}»: ${message}`);
      } catch (suspendError: unknown) {
        logger.warn?.(`[live-humo] no se pudo suspender el modo: ${errorMessage(suspendError)}`);
      }
      return result;
    }
  };

  return {
    run: (request) => {
      if (request.confirm !== true) {
        return Promise.reject(
          new LiveSmokeError(
            'modo-no-activo',
            'La prueba de humo con dinero real exige la confirmación explícita.',
          ),
        );
      }
      if (running !== null) {
        return Promise.reject(
          new LiveSmokeError('en-curso', 'Ya hay una prueba de humo en curso.'),
        );
      }
      running = execute().finally(() => {
        running = null;
      });
      return running;
    },
  };
}
