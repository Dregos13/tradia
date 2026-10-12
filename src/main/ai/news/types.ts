/**
 * Tipos del análisis de noticias con IA — fase 6.
 *
 * Un `NewsHeadlineAnalyzer` toma un titular CONFIRMADO y devuelve, por
 * activo, un resumen de una o dos frases y un sentimiento ('positivo',
 * 'negativo', 'neutro' o 'mixto'). Implementaciones: el adaptador de la
 * API de Anthropic Messages (`anthropic.ts`), el clasificador léxico
 * local (`local.ts`) y el simulado determinista para E2E (`simulated.ts`).
 *
 * Regla del dominio: un análisis nunca crea una señal. La interfaz no
 * expone nada que produzca señales ni órdenes; el sentimiento solo puede
 * confirmar o rebajar la confianza de una señal existente en el motor de
 * señales, y siempre a través de `risk:submit-signal`.
 */
import type { NewsAnalyzer, NewsSentiment } from '../../../shared/ai';

/**
 * Entrada del análisis. `title` y `summary` son texto NO CONFIABLE que
 * viene de internet: los adaptadores deben tratarlo como dato (delimitado
 * en el prompt del LLM; jamás ejecutado ni obedecido).
 */
export interface NewsAnalysisInput {
  /** Titular de la noticia (dato no fiable). */
  title: string;
  /** Resumen/cuerpo si la fuente lo trae (dato no fiable); puede faltar. */
  summary?: string | null;
  /**
   * Tickers ya ligados al titular por el lector (`news_item_assets`).
   * Cuando hay candidatos el análisis se limita a ellos; sin candidatos
   * el analizador detecta los activos del propio texto.
   */
  candidateTickers?: readonly string[];
}

/** Análisis de un activo concreto: resumen breve + sentimiento. */
export interface AssetSentiment {
  /** Ticker en mayúsculas al que se refiere el resultado. */
  ticker: string;
  /** Resumen de una o dos frases atribuido al sistema (nunca al titular). */
  summary: string;
  sentiment: NewsSentiment;
}

/** Resultado completo de un titular: una entrada por activo afectado. */
export interface NewsAnalysisResult {
  assets: AssetSentiment[];
}

/**
 * Analizador de titulares confirmados. `analyzer` y `model` son lo que se
 * persiste en `news_analysis` ('llm' + nombre del modelo, o 'local').
 * Nunca crea señales: solo describe la noticia por activo.
 */
export interface NewsHeadlineAnalyzer {
  readonly analyzer: NewsAnalyzer;
  /** Modelo exacto (p. ej. 'claude-haiku-4-5-20251001'); null si es local. */
  readonly model: string | null;
  analyze(input: NewsAnalysisInput): Promise<NewsAnalysisResult>;
}

// ---------------------------------------------------------------------------
// Errores del adaptador LLM
// ---------------------------------------------------------------------------

/** Clases de fallo del adaptador de Anthropic (misma idea que BrokerError). */
export const NEWS_LLM_ERROR_KINDS = [
  'auth', // 401/403: clave rechazada
  'rate-limit', // 429 tras reintentos (con retryAfterMs si llega)
  'server', // 5xx tras reintentos
  'network', // fallo de transporte tras reintentos
  'timeout', // tiempo de espera tras reintentos
  'bad-data', // respuesta que no valida el esquema de salida
  'no-key', // no hay clave guardada en secrets
  'quota', // tope diario o presupuesto mensual agotado (local fallback)
] as const;
export type NewsLlmErrorKind = (typeof NEWS_LLM_ERROR_KINDS)[number];

/**
 * Error del adaptador LLM. El mensaje nunca contiene la clave ni datos del
 * titular: cualquier texto externo se sanea con `redact` antes de llegar
 * aquí o al registro.
 */
export class NewsLlmError extends Error {
  readonly kind: NewsLlmErrorKind;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    kind: NewsLlmErrorKind,
    message: string,
    details: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(`LLM de noticias: ${message}`);
    this.name = 'NewsLlmError';
    this.kind = kind;
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }
}

export function isNewsLlmError(error: unknown): error is NewsLlmError {
  return error instanceof NewsLlmError;
}

// ---------------------------------------------------------------------------
// Contadores de uso del LLM (tope diario y presupuesto mensual)
// ---------------------------------------------------------------------------

/**
 * Contadores persistidos del gasto del LLM. `day`/`month` fijan la ventana
 * ('YYYY-MM-DD' y 'YYYY-MM'): al cambiar, el contador correspondiente se
 * reinicia. `usedToday` cuenta titulares analizados con el LLM hoy y
 * `spentMonthEur` acumula el coste estimado del mes en euros.
 */
export interface NewsLlmUsage {
  day: string;
  usedToday: number;
  month: string;
  spentMonthEur: number;
}

/** Almacén de contadores de uso (sobre `settings` en producción). */
export interface NewsLlmUsageStore {
  load(): NewsLlmUsage;
  save(usage: NewsLlmUsage): void;
}

/** Contadores en memoria (pruebas y modo degradado sin almacén). */
export function createMemoryUsageStore(): NewsLlmUsageStore & { current: NewsLlmUsage } {
  const state: { current: NewsLlmUsage } = {
    current: { day: '', usedToday: 0, month: '', spentMonthEur: 0 },
  };
  return {
    get current() {
      return state.current;
    },
    load: () => ({ ...state.current }),
    save: (usage) => {
      state.current = { ...usage };
    },
  };
}

// ---------------------------------------------------------------------------
// Utilidades compartidas
// ---------------------------------------------------------------------------

/** Almacén clave-valor mínimo (settings.getValue/setValue o memoria). */
export interface KeyValueStore {
  getValue(key: string): string | null;
  setValue(key: string, value: string): void;
}

/** Quita la clave de cualquier texto externo antes de meterlo en un error. */
export function redactSecret(text: string, apiKey: string | null): string {
  if (!apiKey) return text;
  return text.split(apiKey).join('***');
}

/** Recorta un texto externo para no hinchar mensajes de error ni registros. */
export function truncateExternal(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
