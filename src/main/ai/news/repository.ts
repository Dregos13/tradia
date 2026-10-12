/**
 * Persistencia del análisis de noticias — tabla `news_analysis`
 * (migración 011) y lectura del titular (`news_items`, migración 004).
 *
 * Una fila por noticia × activo (`UNIQUE (noticia_id, ticker)`): el
 * servicio solo inserta los activos que aún no tienen análisis, así una
 * reclasificación posterior no repite llamadas al LLM.
 *
 * El listado cruza siempre con `news_items`: solo devuelve análisis de
 * titulares confirmados EN EL MOMENTO de la lectura, así un titular
 * desconfirmado después de analizarse deja de influir en las señales y
 * de mostrarse en el feed sin borrar la fila.
 */
import type Database from 'better-sqlite3';

import {
  NEWS_ANALYSIS_MAX_LIMIT,
  type NewsAnalysis,
  type NewsAnalysisQuery,
  type NewsAnalyzer,
  type NewsSentiment,
} from '../../../shared/ipc';

/** Lo mínimo que la cola necesita del titular en disco (relee `confirmada`). */
export interface NewsAnalysisItemRow {
  id: number;
  title: string;
  summary: string | null;
  confirmed: boolean;
  assets: string[];
}

export interface NewsAnalysisInsert {
  newsItemId: number;
  ticker: string;
  summary: string;
  sentiment: NewsSentiment;
  analyzer: NewsAnalyzer;
  /** Modelo exacto del proveedor ('claude-code-cli' en suscripción) o null en 'local'. */
  model: string | null;
  analyzedAt: string;
}

export interface NewsAnalysisRepository {
  /** Titular fresco por id; null si ya no existe. */
  getNewsItem(id: number): NewsAnalysisItemRow | null;
  /** Tickers del titular que ya tienen análisis guardado. */
  analyzedTickers(newsItemId: number): string[];
  /** Inserta (o sustituye) el análisis de noticia × activo. */
  insertAnalysis(input: NewsAnalysisInsert): void;
  /**
   * Feed de `ai:news-analysis` (y del ajuste de señales), más reciente
   * primero. Solo titulares confirmados al leer: un análisis cuyo titular
   * se desconfirma deja de salir sin borrarse.
   */
  list(query?: NewsAnalysisQuery): NewsAnalysis[];
}

interface AnalysisRow {
  id: number;
  noticia_id: number;
  ticker: string;
  resumen: string;
  sentimiento: NewsSentiment;
  analizador: NewsAnalyzer;
  modelo: string | null;
  analizado_en: string;
  /** `news_items.publicado` del titular unido (frescura del análisis). */
  publicado: string;
}

const toNewsAnalysis = (row: AnalysisRow): NewsAnalysis => ({
  id: row.id,
  newsItemId: row.noticia_id,
  ticker: row.ticker,
  summary: row.resumen,
  sentiment: row.sentimiento,
  analyzer: row.analizador,
  model: row.modelo,
  analyzedAt: row.analizado_en,
  publishedAt: row.publicado,
});

export function createNewsAnalysisRepository(db: Database.Database): NewsAnalysisRepository {
  const itemStmt = db.prepare(
    'SELECT id, titulo, resumen, confirmada FROM news_items WHERE id = ?',
  );
  const itemAssetsStmt = db.prepare(
    'SELECT ticker FROM news_item_assets WHERE item_id = ? ORDER BY ticker',
  );
  const analyzedStmt = db.prepare(
    'SELECT ticker FROM news_analysis WHERE noticia_id = ? ORDER BY ticker',
  );
  const insertStmt = db.prepare(`
    INSERT INTO news_analysis (noticia_id, ticker, resumen, sentimiento, analizador, modelo, analizado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (noticia_id, ticker)
    DO UPDATE SET resumen = excluded.resumen,
                  sentimiento = excluded.sentimiento,
                  analizador = excluded.analizador,
                  modelo = excluded.modelo,
                  analizado_en = excluded.analizado_en
  `);

  return {
    getNewsItem: (id) => {
      const row = itemStmt.get(id) as
        { id: number; titulo: string; resumen: string | null; confirmada: number } | undefined;
      if (!row) return null;
      return {
        id: row.id,
        title: row.titulo,
        summary: row.resumen,
        confirmed: row.confirmada === 1,
        assets: (itemAssetsStmt.all(id) as { ticker: string }[]).map((a) => a.ticker),
      };
    },

    analyzedTickers: (newsItemId) =>
      (analyzedStmt.all(newsItemId) as { ticker: string }[]).map((a) => a.ticker),

    insertAnalysis: (input) => {
      insertStmt.run(
        input.newsItemId,
        input.ticker,
        input.summary,
        input.sentiment,
        input.analyzer,
        input.model,
        input.analyzedAt,
      );
    },

    list: (query = {}) => {
      // Cruza con news_items: la confirmación se evalúa al leer, así una
      // desconfirmación posterior al análisis retira su influencia al
      // momento (motor de señales y feed leen por aquí).
      const conditions: string[] = ['ni.confirmada = 1'];
      const params: unknown[] = [];
      if (query.newsItemId !== undefined) {
        conditions.push('na.noticia_id = ?');
        params.push(query.newsItemId);
      }
      if (query.ticker !== undefined) {
        conditions.push('na.ticker = ?');
        params.push(query.ticker.trim().toUpperCase());
      }
      const limit = query.limit ?? NEWS_ANALYSIS_MAX_LIMIT;
      const rows = db
        .prepare(
          `SELECT na.*, ni.publicado FROM news_analysis na
           JOIN news_items ni ON ni.id = na.noticia_id
           WHERE ${conditions.join(' AND ')}
           ORDER BY na.analizado_en DESC, na.id DESC LIMIT ?`,
        )
        .all(...params, limit) as AnalysisRow[];
      return rows.map(toNewsAnalysis);
    },
  };
}
