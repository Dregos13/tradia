/**
 * Repositorio del dominio broker — Fase 5.
 *
 * Único punto de escritura/lectura de las tablas de la migración 010:
 * `broker_orders`, `reconcile_runs`, `reconcile_discrepancies` y
 * `deviation_alerts`. Las columnas usan el español de la migración; la
 * superficie expone los tipos en inglés de `shared/broker.ts`.
 *
 * Reglas de negocio:
 * - Idempotencia: `client_order_id` es UNIQUE. Insertar un id ya
 *   existente devuelve la fila guardada con `inserted: false` en lugar de
 *   lanzar (la misma señal nunca crea dos órdenes).
 * - Las discrepancias de la conciliación quedan 'abierta' hasta que una
 *   ejecución limpia las marca 'resuelta' (`resolveOpenDiscrepancies`).
 * - `deviation_alerts` es UNIQUE por (estrategia, periodo, inicio):
 *   recalcular el informe nunca duplica una alerta.
 */
import type Database from 'better-sqlite3';

import {
  BROKER_ORDERS_MAX_LIMIT,
  type BrokerOrder,
  type BrokerOrderLeg,
  type BrokerOrdersQuery,
  type BrokerOrderSide,
  type BrokerOrderStatus,
  type BrokerOrderType,
  type DeviationAlert,
  type DeviationPeriod,
  type ReconcileDiscrepancy,
  type ReconcileDiscrepancyType,
  type ReconcileRun,
  type ReconcileRunResult,
  type ReconcileTrigger,
} from '../../shared/broker';

// ---------------------------------------------------------------------------
// Filas crudas de SQLite
// ---------------------------------------------------------------------------

interface BrokerOrderRow {
  id: number;
  client_order_id: string;
  broker_order_id: string | null;
  senal_id: number | null;
  estrategia_id: number | null;
  pata: BrokerOrderLeg | null;
  ticker: string;
  tipo: BrokerOrderType;
  lado: BrokerOrderSide;
  cantidad: number;
  cantidad_ejecutada: number;
  precio_limite: number | null;
  precio_stop: number | null;
  precio_pedido: number | null;
  precio_ejecutado: number | null;
  pedida_en: string;
  ejecutada_en: string | null;
  slippage_pb: number | null;
  estado: BrokerOrderStatus;
  intentos: number;
  motivo_rechazo: string | null;
  oco_group_id: string | null;
  creado_en: string;
  actualizado_en: string;
}

interface ReconcileRunRow {
  id: number;
  origen: ReconcileTrigger;
  iniciada_en: string;
  terminada_en: string | null;
  resultado: ReconcileRunResult | null;
  posiciones_app: number;
  posiciones_broker: number;
  ordenes_app: number;
  ordenes_broker: number;
  discrepancias: number;
  error: string | null;
}

interface ReconcileDiscrepancyRow {
  id: number;
  run_id: number;
  tipo: ReconcileDiscrepancyType;
  ticker: string | null;
  detalle: string;
  valor_app: string | null;
  valor_broker: string | null;
  estado: 'abierta' | 'resuelta';
  creada_en: string;
  resuelta_en: string | null;
}

interface DeviationAlertRow {
  id: number;
  estrategia_id: number;
  estrategia_nombre: string;
  periodo: DeviationPeriod;
  inicio: string;
  fin: string;
  esperado_pct: number;
  real_pct: number;
  desviacion_pp: number;
  slippage_pb: number | null;
  margen_pp: number;
  margen_slippage_pb: number;
  journal_id: number | null;
  creada_en: string;
}

// ---------------------------------------------------------------------------
// Tipos de entrada
// ---------------------------------------------------------------------------

/** Lo que el gestor de órdenes persiste por cada orden enviada. */
export interface NewBrokerOrder {
  clientOrderId: string;
  brokerOrderId?: string | null;
  signalId?: number | null;
  strategyId?: number | null;
  leg?: BrokerOrderLeg | null;
  ticker: string;
  type: BrokerOrderType;
  side: BrokerOrderSide;
  quantity: number;
  filledQuantity?: number;
  limitPrice?: number | null;
  stopPrice?: number | null;
  /** Precio de referencia del pedido para el slippage. */
  requestedPrice?: number | null;
  executedPrice?: number | null;
  /** Hora pedida (ISO 8601). */
  requestedAt: string;
  executedAt?: string | null;
  slippageBps?: number | null;
  status?: BrokerOrderStatus;
  attempts?: number;
  rejectReason?: string | null;
  ocoGroupId?: string | null;
}

/** Campos que puede cambiar una orden tras su creación. */
export interface BrokerOrderPatch {
  brokerOrderId?: string | null;
  filledQuantity?: number;
  requestedPrice?: number | null;
  executedPrice?: number | null;
  executedAt?: string | null;
  slippageBps?: number | null;
  status?: BrokerOrderStatus;
  attempts?: number;
  rejectReason?: string | null;
  ocoGroupId?: string | null;
}

export interface InsertOrderResult {
  order: BrokerOrder;
  /** false si ya existía una orden con ese client_order_id (idempotencia). */
  inserted: boolean;
}

export interface NewReconcileDiscrepancy {
  runId: number;
  type: ReconcileDiscrepancyType;
  ticker?: string | null;
  detail: string;
  appValue?: string | null;
  brokerValue?: string | null;
}

export interface ReconcileRunPatch {
  finishedAt?: string | null;
  result?: ReconcileRunResult | null;
  positionsApp?: number;
  positionsBroker?: number;
  ordersApp?: number;
  ordersBroker?: number;
  discrepancies?: number;
  error?: string | null;
}

export interface NewDeviationAlert {
  strategyId: number;
  strategyName: string;
  period: DeviationPeriod;
  desde: string;
  hasta: string;
  expectedReturnPct: number;
  realReturnPct: number;
  deviationPp: number;
  avgSlippageBps?: number | null;
  marginPp: number;
  maxSlippageBps: number;
  journalId?: number | null;
}

export interface InsertDeviationAlertResult {
  alert: DeviationAlert;
  /** false si ya existía alerta de esa estrategia en ese periodo. */
  inserted: boolean;
}

export interface DeviationAlertsQuery {
  period?: DeviationPeriod;
  strategyId?: number;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Mapeadores
// ---------------------------------------------------------------------------

function toBrokerOrder(row: BrokerOrderRow): BrokerOrder {
  return {
    id: row.id,
    clientOrderId: row.client_order_id,
    brokerOrderId: row.broker_order_id,
    signalId: row.senal_id,
    strategyId: row.estrategia_id,
    leg: row.pata,
    ticker: row.ticker,
    type: row.tipo,
    side: row.lado,
    quantity: row.cantidad,
    filledQuantity: row.cantidad_ejecutada,
    limitPrice: row.precio_limite,
    stopPrice: row.precio_stop,
    ocoGroupId: row.oco_group_id,
    execution: {
      requestedAt: row.pedida_en,
      requestedPrice: row.precio_pedido,
      executedAt: row.ejecutada_en,
      executedPrice: row.precio_ejecutado,
      slippageBps: row.slippage_pb,
    },
    status: row.estado,
    attempts: row.intentos,
    rejectReason: row.motivo_rechazo,
    createdAt: row.creado_en,
    updatedAt: row.actualizado_en,
  };
}

function toReconcileRun(row: ReconcileRunRow): ReconcileRun {
  return {
    id: row.id,
    trigger: row.origen,
    startedAt: row.iniciada_en,
    finishedAt: row.terminada_en,
    result: row.resultado,
    positionsApp: row.posiciones_app,
    positionsBroker: row.posiciones_broker,
    ordersApp: row.ordenes_app,
    ordersBroker: row.ordenes_broker,
    discrepancies: row.discrepancias,
    error: row.error,
  };
}

function toDiscrepancy(row: ReconcileDiscrepancyRow): ReconcileDiscrepancy {
  return {
    id: row.id,
    runId: row.run_id,
    type: row.tipo,
    ticker: row.ticker,
    detail: row.detalle,
    appValue: row.valor_app,
    brokerValue: row.valor_broker,
    status: row.estado,
    createdAt: row.creada_en,
    resolvedAt: row.resuelta_en,
  };
}

function toDeviationAlert(row: DeviationAlertRow): DeviationAlert {
  return {
    id: row.id,
    strategyId: row.estrategia_id,
    strategyName: row.estrategia_nombre,
    period: row.periodo,
    desde: row.inicio,
    hasta: row.fin,
    expectedReturnPct: row.esperado_pct,
    realReturnPct: row.real_pct,
    deviationPp: row.desviacion_pp,
    avgSlippageBps: row.slippage_pb,
    marginPp: row.margen_pp,
    maxSlippageBps: row.margen_slippage_pb,
    journalId: row.journal_id,
    createdAt: row.creada_en,
  };
}

// ---------------------------------------------------------------------------
// Repositorio
// ---------------------------------------------------------------------------

export interface BrokerRepository {
  /**
   * Inserta la orden; si el client_order_id ya existe devuelve la fila
   * guardada con `inserted: false` (la misma señal no crea dos órdenes).
   */
  insertOrder(input: NewBrokerOrder): InsertOrderResult;
  /** Orden por id local; null si no existe. */
  getOrder(id: number): BrokerOrder | null;
  /** Orden por su id idempotente; null si no existe. */
  getOrderByClientId(clientOrderId: string): BrokerOrder | null;
  /** Actualiza la orden y su `actualizado_en`. Lanza si no existe. */
  updateOrder(id: number, patch: BrokerOrderPatch, updatedAt: string): BrokerOrder;
  /** Órdenes con los filtros del contrato, más recientes primero. */
  listOrders(query?: BrokerOrdersQuery): BrokerOrder[];

  /** Abre una ejecución de conciliación (en curso hasta finishReconcileRun). */
  startReconcileRun(trigger: ReconcileTrigger, startedAt: string): ReconcileRun;
  /** Cierra la ejecución con su resultado y los conteos leídos. */
  finishReconcileRun(runId: number, patch: ReconcileRunPatch): ReconcileRun;
  /** Última ejecución de conciliación; null si nunca hubo. */
  getLastReconcileRun(): ReconcileRun | null;
  /** Ejecuciones de conciliación, más recientes primero. */
  listReconcileRuns(limit?: number): ReconcileRun[];

  /** Anota un descuadre de la ejecución; nace 'abierta'. */
  insertDiscrepancy(input: NewReconcileDiscrepancy): ReconcileDiscrepancy;
  /** Descuadres de una ejecución concreta. */
  listRunDiscrepancies(runId: number): ReconcileDiscrepancy[];
  /** Descuadres aún abiertos, más antiguos primero. */
  listOpenDiscrepancies(): ReconcileDiscrepancy[];
  /** Marca 'resuelta' toda discrepancia abierta; devuelve cuántas cerró. */
  resolveOpenDiscrepancies(resolvedAt: string): number;

  /**
   * Anota la alerta de un periodo fuera de margen; UNIQUE por (estrategia,
   * periodo, inicio): recalcular devuelve la existente con `inserted: false`.
   */
  insertDeviationAlert(input: NewDeviationAlert): InsertDeviationAlertResult;
  /** Alertas de desviación con filtros, más recientes primero. */
  listDeviationAlerts(query?: DeviationAlertsQuery): DeviationAlert[];
}

const ORDER_COLUMNS = `id, client_order_id, broker_order_id, senal_id, estrategia_id,
  pata, ticker, tipo, lado, cantidad, cantidad_ejecutada, precio_limite, precio_stop,
  precio_pedido, precio_ejecutado, pedida_en, ejecutada_en, slippage_pb, estado,
  intentos, motivo_rechazo, oco_group_id, creado_en, actualizado_en`;

const RUN_COLUMNS = `id, origen, iniciada_en, terminada_en, resultado, posiciones_app,
  posiciones_broker, ordenes_app, ordenes_broker, discrepancias, error`;

const DISCREPANCY_COLUMNS = `id, run_id, tipo, ticker, detalle, valor_app, valor_broker,
  estado, creada_en, resuelta_en`;

const ALERT_COLUMNS = `id, estrategia_id, estrategia_nombre, periodo, inicio, fin,
  esperado_pct, real_pct, desviacion_pp, slippage_pb, margen_pp, margen_slippage_pb,
  journal_id, creada_en`;

export function createBrokerRepository(db: Database.Database): BrokerRepository {
  const insertOrderStmt = db.prepare(
    `INSERT INTO broker_orders (
       client_order_id, broker_order_id, senal_id, estrategia_id, pata, ticker,
       tipo, lado, cantidad, cantidad_ejecutada, precio_limite, precio_stop,
       precio_pedido, precio_ejecutado, pedida_en, ejecutada_en, slippage_pb,
       estado, intentos, motivo_rechazo, oco_group_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectOrderById = db.prepare(`SELECT ${ORDER_COLUMNS} FROM broker_orders WHERE id = ?`);
  const selectOrderByClientId = db.prepare(
    `SELECT ${ORDER_COLUMNS} FROM broker_orders WHERE client_order_id = ?`,
  );

  const getOrderRowById = (id: number): BrokerOrderRow | null =>
    (selectOrderById.get(id) as BrokerOrderRow | undefined) ?? null;

  const getOrderRowByClientId = (clientOrderId: string): BrokerOrderRow | null =>
    (selectOrderByClientId.get(clientOrderId) as BrokerOrderRow | undefined) ?? null;

  const insertRunStmt = db.prepare(
    `INSERT INTO reconcile_runs (origen, iniciada_en) VALUES (?, ?)`,
  );
  const selectRunById = db.prepare(`SELECT ${RUN_COLUMNS} FROM reconcile_runs WHERE id = ?`);

  const insertDiscrepancyStmt = db.prepare(
    `INSERT INTO reconcile_discrepancies (run_id, tipo, ticker, detalle, valor_app, valor_broker)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const insertAlertStmt = db.prepare(
    `INSERT INTO deviation_alerts (
       estrategia_id, estrategia_nombre, periodo, inicio, fin, esperado_pct,
       real_pct, desviacion_pp, slippage_pb, margen_pp, margen_slippage_pb, journal_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectAlertByKey = db.prepare(
    `SELECT ${ALERT_COLUMNS} FROM deviation_alerts
     WHERE estrategia_id = ? AND periodo = ? AND inicio = ?`,
  );

  const repo: BrokerRepository = {
    insertOrder: (input) => {
      let row: BrokerOrderRow | null = null;
      try {
        const result = insertOrderStmt.run(
          input.clientOrderId,
          input.brokerOrderId ?? null,
          input.signalId ?? null,
          input.strategyId ?? null,
          input.leg ?? null,
          input.ticker.trim().toUpperCase(),
          input.type,
          input.side,
          input.quantity,
          input.filledQuantity ?? 0,
          input.limitPrice ?? null,
          input.stopPrice ?? null,
          input.requestedPrice ?? null,
          input.executedPrice ?? null,
          input.requestedAt,
          input.executedAt ?? null,
          input.slippageBps ?? null,
          input.status ?? 'pendiente',
          input.attempts ?? 0,
          input.rejectReason ?? null,
          input.ocoGroupId ?? null,
        );
        row = getOrderRowById(Number(result.lastInsertRowid));
      } catch (error: unknown) {
        // UNIQUE client_order_id: el envío ya quedó registrado.
        const code = (error as { code?: string }).code;
        if (code !== 'SQLITE_CONSTRAINT_UNIQUE' && code !== 'SQLITE_CONSTRAINT') throw error;
      }
      if (row === null) {
        const existing = getOrderRowByClientId(input.clientOrderId);
        if (existing === null) throw new Error('broker_orders: inserción fallida sin fila previa');
        return { order: toBrokerOrder(existing), inserted: false };
      }
      return { order: toBrokerOrder(row), inserted: true };
    },

    getOrder: (id) => {
      const row = Number.isInteger(id) && id > 0 ? getOrderRowById(id) : null;
      return row === null ? null : toBrokerOrder(row);
    },

    getOrderByClientId: (clientOrderId) => {
      const row = getOrderRowByClientId(clientOrderId);
      return row === null ? null : toBrokerOrder(row);
    },

    updateOrder: (id, patch, updatedAt) => {
      const fields: string[] = ['actualizado_en = ?'];
      const params: unknown[] = [updatedAt];
      const set = (column: string, value: unknown): void => {
        fields.push(`${column} = ?`);
        params.push(value);
      };
      if ('brokerOrderId' in patch) set('broker_order_id', patch.brokerOrderId);
      if ('filledQuantity' in patch) set('cantidad_ejecutada', patch.filledQuantity);
      if ('requestedPrice' in patch) set('precio_pedido', patch.requestedPrice);
      if ('executedPrice' in patch) set('precio_ejecutado', patch.executedPrice);
      if ('executedAt' in patch) set('ejecutada_en', patch.executedAt);
      if ('slippageBps' in patch) set('slippage_pb', patch.slippageBps);
      if ('status' in patch) set('estado', patch.status);
      if ('attempts' in patch) set('intentos', patch.attempts);
      if ('rejectReason' in patch) set('motivo_rechazo', patch.rejectReason);
      if ('ocoGroupId' in patch) set('oco_group_id', patch.ocoGroupId);
      params.push(id);
      db.prepare(`UPDATE broker_orders SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      const row = getOrderRowById(id);
      if (row === null) throw new Error(`broker_orders: la orden ${id} no existe`);
      return toBrokerOrder(row);
    },

    listOrders: (query = {}) => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (query.status !== undefined) {
        clauses.push('estado = ?');
        params.push(query.status);
      }
      if (query.strategyId !== undefined) {
        clauses.push('estrategia_id = ?');
        params.push(query.strategyId);
      }
      if (query.ticker !== undefined) {
        clauses.push('ticker = ?');
        params.push(query.ticker.trim().toUpperCase());
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.min(query.limit ?? BROKER_ORDERS_MAX_LIMIT, BROKER_ORDERS_MAX_LIMIT);
      const offset = query.offset ?? 0;
      const rows = db
        .prepare(
          `SELECT ${ORDER_COLUMNS} FROM broker_orders ${where}
           ORDER BY creado_en DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset) as BrokerOrderRow[];
      return rows.map(toBrokerOrder);
    },

    startReconcileRun: (trigger, startedAt) => {
      const result = insertRunStmt.run(trigger, startedAt);
      const row = selectRunById.get(Number(result.lastInsertRowid)) as ReconcileRunRow;
      return toReconcileRun(row);
    },

    finishReconcileRun: (runId, patch) => {
      const fields: string[] = [];
      const params: unknown[] = [];
      const set = (column: string, value: unknown): void => {
        fields.push(`${column} = ?`);
        params.push(value);
      };
      if ('finishedAt' in patch) set('terminada_en', patch.finishedAt);
      if ('result' in patch) set('resultado', patch.result);
      if ('positionsApp' in patch) set('posiciones_app', patch.positionsApp);
      if ('positionsBroker' in patch) set('posiciones_broker', patch.positionsBroker);
      if ('ordersApp' in patch) set('ordenes_app', patch.ordersApp);
      if ('ordersBroker' in patch) set('ordenes_broker', patch.ordersBroker);
      if ('discrepancies' in patch) set('discrepancias', patch.discrepancies);
      if ('error' in patch) set('error', patch.error);
      if (fields.length > 0) {
        params.push(runId);
        db.prepare(`UPDATE reconcile_runs SET ${fields.join(', ')} WHERE id = ?`).run(...params);
      }
      const row = selectRunById.get(runId) as ReconcileRunRow | undefined;
      if (row === undefined) throw new Error(`reconcile_runs: la ejecución ${runId} no existe`);
      return toReconcileRun(row);
    },

    getLastReconcileRun: () => {
      const row = db
        .prepare(`SELECT ${RUN_COLUMNS} FROM reconcile_runs ORDER BY id DESC LIMIT 1`)
        .get() as ReconcileRunRow | undefined;
      return row === undefined ? null : toReconcileRun(row);
    },

    listReconcileRuns: (limit = 50) => {
      const rows = db
        .prepare(`SELECT ${RUN_COLUMNS} FROM reconcile_runs ORDER BY id DESC LIMIT ?`)
        .all(Math.max(1, Math.floor(limit))) as ReconcileRunRow[];
      return rows.map(toReconcileRun);
    },

    insertDiscrepancy: (input) => {
      const result = insertDiscrepancyStmt.run(
        input.runId,
        input.type,
        input.ticker ?? null,
        input.detail,
        input.appValue ?? null,
        input.brokerValue ?? null,
      );
      const row = db
        .prepare(`SELECT ${DISCREPANCY_COLUMNS} FROM reconcile_discrepancies WHERE id = ?`)
        .get(Number(result.lastInsertRowid)) as ReconcileDiscrepancyRow;
      return toDiscrepancy(row);
    },

    listRunDiscrepancies: (runId) => {
      const rows = db
        .prepare(
          `SELECT ${DISCREPANCY_COLUMNS} FROM reconcile_discrepancies
           WHERE run_id = ? ORDER BY id`,
        )
        .all(runId) as ReconcileDiscrepancyRow[];
      return rows.map(toDiscrepancy);
    },

    listOpenDiscrepancies: () => {
      const rows = db
        .prepare(
          `SELECT ${DISCREPANCY_COLUMNS} FROM reconcile_discrepancies
           WHERE estado = 'abierta' ORDER BY id`,
        )
        .all() as ReconcileDiscrepancyRow[];
      return rows.map(toDiscrepancy);
    },

    resolveOpenDiscrepancies: (resolvedAt) => {
      const result = db
        .prepare(
          `UPDATE reconcile_discrepancies SET estado = 'resuelta', resuelta_en = ?
           WHERE estado = 'abierta'`,
        )
        .run(resolvedAt);
      return Number(result.changes);
    },

    insertDeviationAlert: (input) => {
      let row: DeviationAlertRow | null = null;
      try {
        const result = insertAlertStmt.run(
          input.strategyId,
          input.strategyName,
          input.period,
          input.desde,
          input.hasta,
          input.expectedReturnPct,
          input.realReturnPct,
          input.deviationPp,
          input.avgSlippageBps ?? null,
          input.marginPp,
          input.maxSlippageBps,
          input.journalId ?? null,
        );
        row = db
          .prepare(`SELECT ${ALERT_COLUMNS} FROM deviation_alerts WHERE id = ?`)
          .get(Number(result.lastInsertRowid)) as DeviationAlertRow;
      } catch (error: unknown) {
        const code = (error as { code?: string }).code;
        if (code !== 'SQLITE_CONSTRAINT_UNIQUE' && code !== 'SQLITE_CONSTRAINT') throw error;
      }
      if (row === null) {
        const existing = selectAlertByKey.get(
          input.strategyId,
          input.period,
          input.desde,
        ) as DeviationAlertRow | undefined;
        if (existing === undefined) {
          throw new Error('deviation_alerts: inserción fallida sin fila previa');
        }
        return { alert: toDeviationAlert(existing), inserted: false };
      }
      return { alert: toDeviationAlert(row), inserted: true };
    },

    listDeviationAlerts: (query = {}) => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (query.period !== undefined) {
        clauses.push('periodo = ?');
        params.push(query.period);
      }
      if (query.strategyId !== undefined) {
        clauses.push('estrategia_id = ?');
        params.push(query.strategyId);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = Math.max(1, Math.floor(query.limit ?? 200));
      const rows = db
        .prepare(
          `SELECT ${ALERT_COLUMNS} FROM deviation_alerts ${where}
           ORDER BY inicio DESC, id DESC LIMIT ?`,
        )
        .all(...params, limit) as DeviationAlertRow[];
      return rows.map(toDeviationAlert);
    },
  };

  return repo;
}
