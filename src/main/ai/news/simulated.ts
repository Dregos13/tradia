/**
 * Analizador de noticias simulado y DETERMINISTA para el modo E2E
 * (`isE2eEnabled`: TRADIA_E2E en una app sin empaquetar).
 *
 * Reutiliza el clasificador léxico local (puro y sin azar) para el
 * sentimiento y el resumen, así el resultado es siempre el mismo ante el
 * mismo titular y las pruebas E2E son reproducibles. La etiqueta que se
 * persiste (`analyzer`/`model`) se elige al construirlo: 'llm' para que el
 * E2E vea el método «LLM · claude-haiku-4-5-20251001» del diseño sin gastar
 * llamadas reales, o 'local' para probar el camino sin coste.
 *
 * Nunca llama a la red ni crea señales.
 */
import { NEWS_LLM_MODEL } from '../../../shared/ipc';
import { createLocalNewsAnalyzer } from './local';
import type { NewsAnalysisResult, NewsHeadlineAnalyzer } from './types';

export interface SimulatedNewsAnalyzerOptions {
  /** Etiqueta persistida en news_analysis; 'local' por defecto. */
  analyzer?: 'llm' | 'local';
}

export function createSimulatedNewsAnalyzer(
  options: SimulatedNewsAnalyzerOptions = {},
): NewsHeadlineAnalyzer {
  const inner = createLocalNewsAnalyzer();
  const analyzer = options.analyzer ?? 'local';
  return {
    analyzer,
    model: analyzer === 'llm' ? NEWS_LLM_MODEL : null,
    analyze: async (input): Promise<NewsAnalysisResult> => inner.analyze(input),
  };
}
