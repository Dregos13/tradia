/**
 * Evaluación del análisis de noticias sobre el conjunto etiquetado
 * `__fixtures__/headlines.labeled.json`.
 *
 * La usan `local.test.ts` (umbrales del analizador local en `npm test`) y
 * `scripts/eval-news-llm.mjs` (medición del LLM real con la clave del
 * usuario, `npm run eval:news-llm`).
 *
 * Métricas documentadas (el «está hecha cuando» de la tarea):
 * - Acierto en el ACTIVO: fracción de titulares cuyo análisis incluye el
 *   ticker esperado. Umbral exigido: `NEWS_EVAL_MIN_ASSET_ACCURACY`.
 * - Acierto en el SENTIMIENTO: fracción de titulares cuyo sentimiento
 *   para el activo esperado coincide con la etiqueta; un activo no
 *   encontrado cuenta como fallo de sentimiento. Umbral exigido:
 *   `NEWS_EVAL_MIN_SENTIMENT_ACCURACY`.
 */
import type { NewsSentiment } from '../../../shared/ai';
import type { NewsHeadlineAnalyzer } from './types';

/** Umbral mínimo documentado del analizador local sobre el conjunto. */
export const NEWS_EVAL_MIN_ASSET_ACCURACY = 0.9;
export const NEWS_EVAL_MIN_SENTIMENT_ACCURACY = 0.7;

/** Una entrada del conjunto etiquetado. */
export interface LabeledHeadline {
  /** Titular tal como llegaría de una fuente (puede incluir inyecciones). */
  title: string;
  /** Resumen/cuerpo opcional de la fuente. */
  summary?: string | null;
  /** Ticker esperado. */
  asset: string;
  /** Sentimiento esperado para ese activo. */
  sentiment: NewsSentiment;
}

export interface NewsEvalRow {
  index: number;
  title: string;
  expectedAsset: string;
  expectedSentiment: NewsSentiment;
  gotTickers: string[];
  gotSentiment: NewsSentiment | null;
  assetHit: boolean;
  sentimentHit: boolean;
}

export interface NewsEvalReport {
  total: number;
  assetHits: number;
  /** assetHits / total — umbral ≥ NEWS_EVAL_MIN_ASSET_ACCURACY. */
  assetAccuracy: number;
  sentimentHits: number;
  /** sentimentHits / total — umbral ≥ NEWS_EVAL_MIN_SENTIMENT_ACCURACY. */
  sentimentAccuracy: number;
  /** Filas falladas (activo o sentimiento), para revisar el conjunto. */
  failures: NewsEvalRow[];
  rows: NewsEvalRow[];
}

/**
 * Ejecuta el analizador sobre cada titular SIN candidatos: el analizador
 * debe detectar el activo del propio texto (es lo que mide el acierto).
 */
export async function evaluateNewsAnalyzer(
  analyzer: NewsHeadlineAnalyzer,
  labeled: readonly LabeledHeadline[],
  onError?: (index: number, error: unknown) => void,
): Promise<NewsEvalReport> {
  const rows: NewsEvalRow[] = [];
  for (const [index, entry] of labeled.entries()) {
    const expectedAsset = entry.asset.trim().toUpperCase();
    let gotTickers: string[] = [];
    let gotSentiment: NewsSentiment | null = null;
    try {
      const result = await analyzer.analyze({
        title: entry.title,
        summary: entry.summary ?? null,
      });
      gotTickers = result.assets.map((a) => a.ticker);
      gotSentiment = result.assets.find((a) => a.ticker === expectedAsset)?.sentiment ?? null;
    } catch (error) {
      onError?.(index, error);
    }
    const assetHit = gotTickers.includes(expectedAsset);
    const sentimentHit = assetHit && gotSentiment === entry.sentiment;
    rows.push({
      index,
      title: entry.title,
      expectedAsset,
      expectedSentiment: entry.sentiment,
      gotTickers,
      gotSentiment,
      assetHit,
      sentimentHit,
    });
  }
  const total = rows.length;
  const assetHits = rows.filter((r) => r.assetHit).length;
  const sentimentHits = rows.filter((r) => r.sentimentHit).length;
  return {
    total,
    assetHits,
    assetAccuracy: total === 0 ? 0 : assetHits / total,
    sentimentHits,
    sentimentAccuracy: total === 0 ? 0 : sentimentHits / total,
    failures: rows.filter((r) => !r.assetHit || !r.sentimentHit),
    rows,
  };
}
