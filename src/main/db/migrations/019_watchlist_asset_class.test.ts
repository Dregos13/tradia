import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { createMarketRepository } from '../../market/repository';
import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Esquema anterior: la lista de seguimiento sin tipo de activo. */
const PHASE_0_18 = MIGRATIONS.filter((m) => m.version <= 18);
/** Incluye la 019: columna asset_class en watchlist. */
const ALL = MIGRATIONS.filter((m) => m.version <= 19);

/** Base «de antes»: tres activos, sus velas y su estado, escritos con SQL directo. */
const seedLegacy = (db: Database.Database): void => {
  const insertItem = db.prepare('INSERT INTO watchlist (ticker, alta, orden) VALUES (?, ?, ?)');
  insertItem.run('SPY', '2026-01-02T10:00:00.000Z', 0);
  insertItem.run('AAPL', '2026-01-03T10:00:00.000Z', 1);
  // Un activo sin cobertura guardado por la versión anterior.
  insertItem.run('EUR', '2026-10-01T10:00:00.000Z', 2);

  const batch = db
    .prepare(
      `INSERT INTO data_batches (version, hash, proveedor, ambito, ticker, desde, hasta, recibido_en)
       VALUES (1, 'h', 'tiingo', 'bars', ?, '2026-10-05', '2026-10-07', '2026-10-08T00:00:00.000Z')`,
    )
    .run('SPY').lastInsertRowid;
  const insertBar = db.prepare(
    `INSERT INTO bars (ticker, fecha, fuente, lote_id, open, high, low, close, volume, adj_close)
     VALUES (?, ?, 'tiingo', ?, 10, 11, 9, 10.5, 1000, 10.4)`,
  );
  for (const ticker of ['SPY', 'AAPL']) {
    for (const fecha of ['2026-10-05', '2026-10-06', '2026-10-07']) {
      insertBar.run(ticker, fecha, batch);
    }
  }
  db.prepare(
    `INSERT INTO data_status (clave, estado, ultimo_ok, fallos_seguidos, motivo, actualizado_en)
     VALUES ('ticker:EUR', 'sin-cobertura', NULL, 0, 'sin datos', '2026-10-08T00:00:00.000Z')`,
  ).run();
};

const snapshot = (db: Database.Database) => ({
  bars: db.prepare('SELECT * FROM bars ORDER BY id').all(),
  batches: db.prepare('SELECT * FROM data_batches ORDER BY id').all(),
  status: db.prepare('SELECT * FROM data_status ORDER BY clave').all(),
});

describe('migración 019 · tipo de activo en la lista de seguimiento', () => {
  it('una base existente migra con todos sus activos en equity y sin perder velas', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_18);
    seedLegacy(db);
    const before = snapshot(db);

    expect(migrate(db, ALL)).toEqual([19]);

    const rows = db
      .prepare('SELECT ticker, alta, orden, asset_class FROM watchlist ORDER BY orden')
      .all();
    expect(rows).toEqual([
      { ticker: 'SPY', alta: '2026-01-02T10:00:00.000Z', orden: 0, asset_class: 'equity' },
      { ticker: 'AAPL', alta: '2026-01-03T10:00:00.000Z', orden: 1, asset_class: 'equity' },
      { ticker: 'EUR', alta: '2026-10-01T10:00:00.000Z', orden: 2, asset_class: 'equity' },
    ]);
    // Velas, lotes y estados quedan idénticos.
    expect(snapshot(db)).toEqual(before);
    expect(before.bars).toHaveLength(6);

    // El repositorio expone el tipo en cada activo.
    const repo = createMarketRepository(db);
    expect(repo.listWatchlist().map((item) => [item.ticker, item.assetClass])).toEqual([
      ['SPY', 'equity'],
      ['AAPL', 'equity'],
      ['EUR', 'equity'],
    ]);
    db.close();
  });

  it('el CHECK solo admite equity y fx, y una fila nueva sin tipo queda equity', () => {
    const db = new Database(':memory:');
    migrate(db, ALL);
    db.prepare(
      "INSERT INTO watchlist (ticker, alta, orden) VALUES ('MSFT', '2026-10-08T00:00:00Z', 0)",
    ).run();
    db.prepare(
      "INSERT INTO watchlist (ticker, alta, orden, asset_class) VALUES ('EURUSD', '2026-10-08T00:00:00Z', 1, 'fx')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO watchlist (ticker, alta, orden, asset_class) VALUES ('BTC', '2026-10-08T00:00:00Z', 2, 'crypto')",
        )
        .run(),
    ).toThrowError();
    expect(() =>
      db
        .prepare(
          "INSERT INTO watchlist (ticker, alta, orden, asset_class) VALUES ('X', '2026-10-08T00:00:00Z', 2, NULL)",
        )
        .run(),
    ).toThrowError();
    expect(db.prepare('SELECT ticker, asset_class FROM watchlist ORDER BY orden').all()).toEqual([
      { ticker: 'MSFT', asset_class: 'equity' },
      { ticker: 'EURUSD', asset_class: 'fx' },
    ]);
    db.close();
  });

  it('es reversible: al volver atrás conserva los activos, también los pares, y sus velas', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_18);
    seedLegacy(db);
    migrate(db, ALL);
    db.prepare(
      "INSERT INTO watchlist (ticker, alta, orden, asset_class) VALUES ('EURUSD', '2026-10-08T00:00:00Z', 3, 'fx')",
    ).run();
    const before = snapshot(db);

    expect(rollbackLast(db, ALL)).toBe(19);

    const cols = db.prepare("SELECT name FROM pragma_table_info('watchlist')").all() as {
      name: string;
    }[];
    expect(cols.map((c) => c.name)).toEqual(['ticker', 'alta', 'orden']);
    expect(
      (db.prepare('SELECT ticker FROM watchlist ORDER BY orden').all() as { ticker: string }[]).map(
        (r) => r.ticker,
      ),
    ).toEqual(['SPY', 'AAPL', 'EUR', 'EURUSD']);
    expect(snapshot(db)).toEqual(before);

    // Y se puede volver a subir: las filas quedan 'equity' de nuevo.
    expect(migrate(db, ALL)).toEqual([19]);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM watchlist WHERE asset_class = 'equity'").get(),
    ).toEqual({ n: 4 });
    db.close();
  });
});
