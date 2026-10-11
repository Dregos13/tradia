/**
 * Pruebas de la migración 013: el CHECK de `news_analysis.analizador`
 * se amplía con 'suscripcion' (CLI de Claude Code) recreando la tabla
 * sin perder filas; el down restaura el CHECK de la 011 rotulando las
 * filas de suscripción como 'llm' (ninguna fila se pierde).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { MIGRATIONS } from './index';
import { migrate, rollbackLast } from '../migrator';

/** Todo lo anterior a la 013: la base sobre la que se prueba el cambio. */
const PREV = MIGRATIONS.filter((m) => m.version <= 12);
const THROUGH_013 = MIGRATIONS.filter((m) => m.version <= 13);

function insertNewsItem(db: Database.Database): number {
  return Number(
    db
      .prepare(
        `INSERT INTO news_items (titulo, url, publicado, resumen, prioridad, confirmada, hash)
         VALUES ('Titular', NULL, '2026-10-10T10:00:00.000Z', NULL, 'activo', 1, 'h1')`,
      )
      .run().lastInsertRowid,
  );
}

const insertAnalysis = (db: Database.Database, newsId: number, analyzer: string): void => {
  db.prepare(
    `INSERT INTO news_analysis (noticia_id, ticker, resumen, sentimiento, analizador)
     VALUES (?, ?, 'resumen', 'positivo', ?)`,
  ).run(newsId, analyzer === 'local' ? 'AAPL' : analyzer === 'llm' ? 'MSFT' : 'NVDA', analyzer);
};

function analysisRows(db: Database.Database): { ticker: string; analizador: string }[] {
  return db.prepare('SELECT ticker, analizador FROM news_analysis ORDER BY id').all() as {
    ticker: string;
    analizador: string;
  }[];
}

describe('migración 013 · analizador suscripcion en news_analysis', () => {
  it('conserva las filas existentes y admite suscripcion sin admitir valores ajenos', () => {
    const db = new Database(':memory:');
    migrate(db, PREV);
    const newsId = insertNewsItem(db);
    insertAnalysis(db, newsId, 'local');
    insertAnalysis(db, newsId, 'llm');
    // Con la 011 'suscripcion' todavía se rechaza.
    expect(() => insertAnalysis(db, newsId, 'suscripcion')).toThrowError();

    expect(migrate(db, THROUGH_013)).toEqual([13]);
    const rows = analysisRows(db);
    expect(rows).toEqual([
      { ticker: 'AAPL', analizador: 'local' },
      { ticker: 'MSFT', analizador: 'llm' },
    ]);

    // 'suscripcion' ya entra; un valor fuera del contrato sigue fuera.
    insertAnalysis(db, newsId, 'suscripcion');
    expect(analysisRows(db).at(-1)).toEqual({ ticker: 'NVDA', analizador: 'suscripcion' });
    expect(() =>
      db
        .prepare(
          `INSERT INTO news_analysis (noticia_id, ticker, resumen, sentimiento, analizador)
           VALUES (?, 'JPM', 'resumen', 'positivo', 'humano')`,
        )
        .run(newsId),
    ).toThrowError();
    db.close();
  });

  it('el down restaura el CHECK de la 011 sin perder ninguna fila', () => {
    const db = new Database(':memory:');
    migrate(db, THROUGH_013);
    const newsId = insertNewsItem(db);
    insertAnalysis(db, newsId, 'local');
    insertAnalysis(db, newsId, 'suscripcion');

    expect(rollbackLast(db, THROUGH_013)).toBe(13);
    // Las tres filas sobreviven; la de suscripción queda rotulada 'llm'.
    const rows = analysisRows(db);
    expect(rows).toEqual([
      { ticker: 'AAPL', analizador: 'local' },
      { ticker: 'NVDA', analizador: 'llm' },
    ]);
    expect(() => insertAnalysis(db, newsId, 'suscripcion')).toThrowError();
    db.close();
  });
});
