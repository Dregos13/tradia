import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Migraciones previas: lo que la 010 necesita (signals, journal_entries). */
const PHASE_0_4 = MIGRATIONS.filter((m) => m.version <= 9);
/** Hasta el dominio del broker inclusive: lo que cubre esta prueba. */
const PHASE_5 = MIGRATIONS.filter((m) => m.version <= 10);

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((row) => row.name);
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (row) => row.name,
  );
}

const INSERT_ORDER = `INSERT INTO broker_orders
    (client_order_id, broker_order_id, senal_id, estrategia_id, pata, ticker,
     tipo, lado, cantidad, cantidad_ejecutada, precio_limite, precio_stop,
     precio_pedido, precio_ejecutado, pedida_en, ejecutada_en, slippage_pb,
     estado, intentos, motivo_rechazo, oco_group_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const newOrder = {
  clientOrderId: 'tradia-1-entrada',
  brokerOrderId: 'sim-1',
  senalId: null as number | null,
  estrategiaId: 3,
  pata: 'entrada',
  ticker: 'AAPL',
  tipo: 'market',
  lado: 'buy',
  cantidad: 10,
  ejecutada: 10,
  limite: null as number | null,
  stop: null as number | null,
  pedido: 200,
  precioEjecutado: 200.1,
  pedidaEn: '2026-10-08T20:00:00.000Z',
  ejecutadaEn: '2026-10-08T20:00:01.000Z',
  slippage: 5,
  estado: 'ejecutada',
  intentos: 1,
  motivo: null as string | null,
  oco: null as string | null,
};

const insertOrder = (db: Database.Database, patch: Partial<typeof newOrder> = {}): void => {
  const o = { ...newOrder, ...patch };
  db.prepare(INSERT_ORDER).run(
    o.clientOrderId,
    o.brokerOrderId,
    o.senalId,
    o.estrategiaId,
    o.pata,
    o.ticker,
    o.tipo,
    o.lado,
    o.cantidad,
    o.ejecutada,
    o.limite,
    o.stop,
    o.pedido,
    o.precioEjecutado,
    o.pedidaEn,
    o.ejecutadaEn,
    o.slippage,
    o.estado,
    o.intentos,
    o.motivo,
    o.oco,
  );
};

describe('migración 010 · dominio del broker en modo paper', () => {
  it('sube sobre la fase anterior y crea las cuatro tablas', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_4);

    expect(migrate(db, PHASE_5)).toEqual([10]);
    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'broker_orders',
        'reconcile_runs',
        'reconcile_discrepancies',
        'deviation_alerts',
      ]),
    );
    expect(columnNames(db, 'broker_orders')).toEqual(
      expect.arrayContaining([
        'client_order_id',
        'broker_order_id',
        'senal_id',
        'estrategia_id',
        'pata',
        'tipo',
        'lado',
        'cantidad',
        'precio_pedido',
        'precio_ejecutado',
        'pedida_en',
        'ejecutada_en',
        'slippage_pb',
        'estado',
        'intentos',
        'motivo_rechazo',
        'oco_group_id',
      ]),
    );
    db.close();
  });

  it('aplica limpia sobre una base vacía', () => {
    const db = new Database(':memory:');
    expect(migrate(db, PHASE_5)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    db.close();
  });

  it('client_order_id es único: la misma señal no crea dos órdenes', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_5);
    insertOrder(db);
    expect(() => insertOrder(db)).toThrowError();
    // Otro client_order_id sí entra (pata distinta del plan).
    insertOrder(db, { clientOrderId: 'tradia-1-salida', tipo: 'oco', oco: 'oco-1', pata: 'salida' });
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM broker_orders').get() as { n: number }).n,
    ).toBe(2);
    db.close();
  });

  it('los CHECKs rechazan tipos, lados, estados y patas ajenos al contrato', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_5);
    expect(() => insertOrder(db, { clientOrderId: 'a', tipo: 'bracket' })).toThrowError();
    expect(() => insertOrder(db, { clientOrderId: 'b', lado: 'largo' })).toThrowError();
    expect(() => insertOrder(db, { clientOrderId: 'c', estado: 'abierta' })).toThrowError();
    expect(() => insertOrder(db, { clientOrderId: 'd', pata: 'objetivo' })).toThrowError();
    expect(() => insertOrder(db, { clientOrderId: 'e', cantidad: 0 })).toThrowError();
    expect(() =>
      insertOrder(db, { clientOrderId: 'f', cantidad: 10, ejecutada: 11 }),
    ).toThrowError();
    expect(() => insertOrder(db, { clientOrderId: 'g', intentos: -1 })).toThrowError();
    db.close();
  });

  it('senal_id queda a NULL al borrar la señal (la orden sobrevive)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, PHASE_5);
    db.prepare(
      `INSERT INTO signals
         (ticker, direccion, entrada, stop, objetivo, confianza, motivo, estrategias,
          datos_usados, decision, estado, vela_fecha)
       VALUES ('AAPL', 'largo', 200, 190, 220, 0.8, 'x', '[]', '{}', '{}', 'aprobada', '2026-10-08')`,
    ).run();
    const signalId = (db.prepare('SELECT id FROM signals').get() as { id: number }).id;
    insertOrder(db, { senalId: signalId });

    expect(() =>
      db
        .prepare('UPDATE broker_orders SET senal_id = 999 WHERE client_order_id = ?')
        .run('tradia-1-entrada'),
    ).toThrowError();
    db.prepare('DELETE FROM signals').run();
    const row = db
      .prepare('SELECT senal_id FROM broker_orders WHERE client_order_id = ?')
      .get('tradia-1-entrada') as { senal_id: number | null };
    expect(row.senal_id).toBeNull();
    db.close();
  });

  it('las discrepancias cuelgan del run y se borran con él', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, PHASE_5);
    db.prepare(
      `INSERT INTO reconcile_runs (origen, iniciada_en, terminada_en, resultado, discrepancias)
       VALUES ('manual', '2026-10-08T21:00:00.000Z', '2026-10-08T21:00:01.000Z', 'descuadre', 1)`,
    ).run();
    const runId = (db.prepare('SELECT id FROM reconcile_runs').get() as { id: number }).id;
    db.prepare(
      `INSERT INTO reconcile_discrepancies (run_id, tipo, ticker, detalle, valor_app, valor_broker)
       VALUES (?, 'posicion-cantidad', 'AAPL', 'descuadre de prueba', '10 uds', '8 uds')`,
    ).run(runId);
    expect(() =>
      db
        .prepare(
          `INSERT INTO reconcile_discrepancies (run_id, tipo, detalle) VALUES (?, 'tipo-ajeno', 'x')`,
        )
        .run(runId),
    ).toThrowError();
    db.prepare('DELETE FROM reconcile_runs').run();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM reconcile_discrepancies').get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });

  it('deviation_alerts no duplica la alerta de una estrategia en un periodo', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_5);
    const insert = db.prepare(
      `INSERT INTO deviation_alerts
         (estrategia_id, estrategia_nombre, periodo, inicio, fin, esperado_pct, real_pct,
          desviacion_pp, slippage_pb, margen_pp, margen_slippage_pb)
       VALUES (1, 'Cruce', 'semanal', '2026-10-05', '2026-10-11', 1.5, -2.0, -3.5, 12, 2, 10)`,
    );
    insert.run();
    // Otra semana o el mensual sí entran; la misma no.
    expect(() => insert.run()).toThrowError();
    db.prepare(
      `INSERT INTO deviation_alerts
         (estrategia_id, estrategia_nombre, periodo, inicio, fin, esperado_pct, real_pct,
          desviacion_pp, slippage_pb, margen_pp, margen_slippage_pb)
       VALUES (1, 'Cruce', 'mensual', '2026-10-01', '2026-10-31', 6, -2.5, -8.5, 12, 2, 10)`,
    ).run();
    db.close();
  });

  it('revertir la 010 solo retira sus tablas y conserva lo anterior', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, PHASE_5);
    insertOrder(db);
    db.prepare(
      `INSERT INTO reconcile_runs (origen, iniciada_en) VALUES ('programada', '2026-10-08T21:00:00.000Z')`,
    ).run();
    db.prepare(
      `INSERT INTO signals
         (ticker, direccion, entrada, stop, objetivo, confianza, motivo, estrategias,
          datos_usados, decision, estado, vela_fecha)
       VALUES ('AAPL', 'largo', 200, 190, 220, 0.8, 'x', '[]', '{}', '{}', 'aprobada', '2026-10-08')`,
    ).run();

    expect(rollbackLast(db, PHASE_5)).toBe(10);
    const names = tableNames(db);
    for (const table of [
      'broker_orders',
      'reconcile_runs',
      'reconcile_discrepancies',
      'deviation_alerts',
    ]) {
      expect(names).not.toContain(table);
    }
    // Las señales de la fase 4 sobreviven a la reversión.
    expect((db.prepare('SELECT COUNT(*) AS n FROM signals').get() as { n: number }).n).toBe(1);
    db.close();
  });
});
