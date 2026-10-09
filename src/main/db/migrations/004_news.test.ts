import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Migraciones de las fases 0-1, antes de noticias y calendario. */
const PHASE_0_1 = MIGRATIONS.filter((m) => m.version <= 3);
/** Hasta noticias inclusive: lo que cubre esta prueba. */
const PHASE_1B = MIGRATIONS.filter((m) => m.version <= 4);

function tableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name",
    )
    .all() as { name: string }[];
  return rows.map((row) => row.name);
}

const INSERT_SOURCE =
  "INSERT INTO news_sources (nombre, tipo, conector, url, fiabilidad) VALUES ('Reuters', 'rss', 'rss', 'https://feeds.test/rss', 'agencia')";

describe('migración 004 · noticias, fuentes y calendario', () => {
  it('sube sobre una base de la fase 0-1 sin perder datos existentes', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_0_1);

    db.prepare(
      "INSERT INTO watchlist (ticker, alta, orden) VALUES ('AAPL', '2026-10-08T00:00:00Z', 0)",
    ).run();
    db.prepare(
      "INSERT INTO noticias (fuente, url, titulo, publicado, hash) VALUES ('rss', 'https://ejemplo.test/n', 't', '2026-10-07', 'h1')",
    ).run();
    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('autostart', 'true', '2026-10-08T00:00:00Z')",
    ).run();

    // Solo la migración 004 queda pendiente en esta prueba.
    expect(migrate(db, PHASE_1B)).toEqual([4]);

    expect((db.prepare('SELECT COUNT(*) AS n FROM watchlist').get() as { n: number }).n).toBe(1);
    expect(
      (db.prepare('SELECT titulo AS t FROM noticias WHERE hash = ?').get('h1') as { t: string }).t,
    ).toBe('t');
    expect(
      (db.prepare("SELECT value AS v FROM settings WHERE key = 'autostart'").get() as { v: string })
        .v,
    ).toBe('true');

    expect(tableNames(db)).toEqual(
      expect.arrayContaining([
        'news_sources',
        'news_items',
        'news_item_sources',
        'news_item_assets',
        'calendar_events',
        'notification_log',
      ]),
    );
    db.close();
  });

  it('exige catálogos válidos: tipo, fiabilidad, prioridad, impacto y estado', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS);

    // Tipo y fiabilidad fuera del catálogo quedan rechazados.
    expect(() =>
      db
        .prepare(
          "INSERT INTO news_sources (nombre, tipo, conector, fiabilidad) VALUES ('x', 'blog', 'rss', 'agencia')",
        )
        .run(),
    ).toThrowError();
    expect(() =>
      db
        .prepare(
          "INSERT INTO news_sources (nombre, tipo, conector, fiabilidad) VALUES ('x', 'rss', 'rss', 'blog')",
        )
        .run(),
    ).toThrowError();
    // Intervalo por debajo del mínimo y último estado desconocido, también.
    expect(() =>
      db
        .prepare(
          "INSERT INTO news_sources (nombre, tipo, conector, fiabilidad, intervalo_segundos) VALUES ('x', 'rss', 'rss', 'agencia', 10)",
        )
        .run(),
    ).toThrowError();
    expect(() =>
      db
        .prepare(
          "INSERT INTO news_sources (nombre, tipo, conector, fiabilidad, ultimo_estado) VALUES ('x', 'rss', 'rss', 'agencia', 'caida')",
        )
        .run(),
    ).toThrowError();

    // Prioridad e impacto fuera de la sección 6 quedan rechazados.
    expect(() =>
      db
        .prepare(
          "INSERT INTO news_items (titulo, publicado, prioridad, hash) VALUES ('t', '2026-10-08T10:00:00Z', 'urgente', 'h1')",
        )
        .run(),
    ).toThrowError();
    expect(() =>
      db
        .prepare(
          "INSERT INTO calendar_events (tipo, titulo, fecha_utc, impacto, origen, clave) VALUES ('fomc', 't', '2026-10-08T18:00:00Z', 'brutal', 'oficial', 'k1')",
        )
        .run(),
    ).toThrowError();
    expect(() =>
      db
        .prepare(
          "INSERT INTO calendar_events (tipo, titulo, fecha_utc, impacto, origen, clave) VALUES ('subasta', 't', '2026-10-08T18:00:00Z', 'medio', 'oficial', 'k1')",
        )
        .run(),
    ).toThrowError();

    // Inserts válidos sí pasan.
    db.prepare(INSERT_SOURCE).run();
    db.prepare(
      "INSERT INTO news_items (titulo, publicado, prioridad, confirmada, hash) VALUES ('t', '2026-10-08T10:00:00Z', 'maxima', 1, 'h1')",
    ).run();
    db.prepare(
      "INSERT INTO calendar_events (tipo, titulo, fecha_utc, impacto, pais, origen, clave) VALUES ('nfp', 'Nóminas no agrícolas', '2026-11-06T13:30:00Z', 'alto', 'US', 'regla', 'nfp:2026-11')",
    ).run();
    db.close();
  });

  it('deduplica por hash y junta varias fuentes en una misma noticia', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS);
    db.prepare(INSERT_SOURCE).run();
    db.prepare(
      "INSERT INTO news_sources (nombre, tipo, conector, fiabilidad) VALUES ('Fed', 'oficial', 'fed', 'oficial')",
    ).run();

    const insertItem = db.prepare(
      "INSERT INTO news_items (titulo, url, publicado, prioridad, hash) VALUES ('t', 'https://ejemplo.test/n', '2026-10-08T10:00:00Z', 'media', 'h1')",
    );
    insertItem.run();
    // El mismo titular con el mismo hash no se inserta dos veces.
    expect(() => insertItem.run()).toThrowError();

    // Pero ambas fuentes quedan enlazadas a la misma noticia.
    db.prepare(
      "INSERT INTO news_item_sources (item_id, source_id, visto_en) VALUES (1, 1, '2026-10-08T10:05:00Z')",
    ).run();
    db.prepare(
      "INSERT INTO news_item_sources (item_id, source_id, visto_en) VALUES (1, 2, '2026-10-08T10:07:00Z')",
    ).run();
    // La misma pareja noticia-fuente no se repite.
    expect(() =>
      db
        .prepare(
          "INSERT INTO news_item_sources (item_id, source_id, visto_en) VALUES (1, 1, '2026-10-08T10:09:00Z')",
        )
        .run(),
    ).toThrowError();

    // El mismo activo relacionado no se duplica para una noticia.
    db.prepare("INSERT INTO news_item_assets (item_id, ticker) VALUES (1, 'SPY')").run();
    expect(() =>
      db.prepare("INSERT INTO news_item_assets (item_id, ticker) VALUES (1, 'SPY')").run(),
    ).toThrowError();
    db.close();
  });

  it('impide repetir avisos con la clave única del registro de notificaciones', () => {
    const db = new Database(':memory:');
    migrate(db, MIGRATIONS);
    const insert = db.prepare(
      "INSERT INTO notification_log (clave, tipo, ref_id, nivel, enviado_en) VALUES ('evento-previo:1', 'evento-previo', 1, 'alerta', '2026-10-08T10:00:00Z')",
    );
    insert.run();
    expect(() => insert.run()).toThrowError();

    // Tipos y niveles fuera del catálogo quedan rechazados.
    expect(() =>
      db
        .prepare(
          "INSERT INTO notification_log (clave, tipo, nivel, enviado_en) VALUES ('k2', 'digest', 'info', '2026-10-08T10:00:00Z')",
        )
        .run(),
    ).toThrowError();
    expect(() =>
      db
        .prepare(
          "INSERT INTO notification_log (clave, tipo, nivel, enviado_en) VALUES ('k3', 'noticia-critica', 'suave', '2026-10-08T10:00:00Z')",
        )
        .run(),
    ).toThrowError();
    db.close();
  });

  it('cascada: borrar una fuente o una noticia elimina sus enlaces', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrate(db, MIGRATIONS);
    db.prepare(INSERT_SOURCE).run();
    db.prepare(
      "INSERT INTO news_items (titulo, publicado, prioridad, hash) VALUES ('t', '2026-10-08T10:00:00Z', 'media', 'h1')",
    ).run();
    db.prepare(
      "INSERT INTO news_item_sources (item_id, source_id, visto_en) VALUES (1, 1, '2026-10-08T10:05:00Z')",
    ).run();
    db.prepare("INSERT INTO news_item_assets (item_id, ticker) VALUES (1, 'AAPL')").run();

    // Quitar la fuente borra su enlace pero la noticia permanece en el feed.
    db.prepare('DELETE FROM news_sources WHERE id = 1').run();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM news_item_sources').get() as { n: number }).n,
    ).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM news_items').get() as { n: number }).n).toBe(1);

    // Borrar la noticia elimina sus enlaces restantes.
    db.prepare('DELETE FROM news_items WHERE id = 1').run();
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM news_item_assets').get() as { n: number }).n,
    ).toBe(0);
    db.close();
  });

  it('revertir la 004 solo elimina las tablas de noticias y calendario', () => {
    const db = new Database(':memory:');
    migrate(db, PHASE_1B);
    db.prepare(
      "INSERT INTO news_sources (nombre, tipo, conector, fiabilidad) VALUES ('Fed', 'oficial', 'fed', 'oficial')",
    ).run();

    expect(rollbackLast(db, MIGRATIONS)).toBe(4);
    const tables = tableNames(db);
    expect(tables).not.toContain('news_sources');
    expect(tables).not.toContain('news_items');
    expect(tables).not.toContain('calendar_events');
    expect(tables).not.toContain('notification_log');
    // La fase 0-1 queda intacta.
    expect(tables).toContain('watchlist');
    expect(tables).toContain('noticias');
    db.close();
  });
});
