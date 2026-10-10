/**
 * Servicio de análisis de noticias — fase 6.
 *
 * `createNewsAiService` es el núcleo, con todo lo externo inyectado
 * (repositorio, analizadores, secrets, almacén de ajustes, broadcast):
 * las pruebas lo montan sin Electron ni red.
 *
 * - Cola FIFO en memoria: el lector entrega titulares por
 *   `enqueueItem` (lo cablea `registerNewsAi` con `poller.onItemsStored`)
 *   y la cola los procesa en orden, uno a uno. Un titular NO confirmado
 *   nunca se encola, y se relee `confirmada` en disco antes de analizar
 *   por si la reclasificación llegó después.
 * - Elección de analizador por titular: simulado en E2E; si no, LLM solo
 *   cuando `enabled` + clave guardada + presupuesto mensual > 0; si no,
 *   siempre el léxico local (sin coste). Cualquier error del LLM —'quota'
   *   incluida— cae al local con un aviso por clase de fallo.
 * - Persistencia: una fila por activo en `news_analysis`, solo para los
 *   tickers que aún no tienen análisis (UNIQUE noticia × ticker), con el
 *   método que lo produjo ('llm' + modelo o 'local').
 * - Ajustes del LLM (`ai:get-llm-settings`/`set-llm-settings`): el
 *   interruptor, el tope diario y el presupuesto viven en `settings`; la
 *   clave vive en `secrets` y solo se expone `hasKey`.
 *
 * Nada aquí crea señales: el análisis solo informa al usuario y, en la
 * tarea de integración, ajusta la confianza por el motor de riesgo.
 */
import {
  IPC_CHANNELS,
  NEWS_LLM_DAILY_CAP_BOUNDS,
  NEWS_LLM_DAILY_CAP_DEFAULT,
  NEWS_LLM_MONTHLY_BUDGET_BOUNDS,
  NEWS_LLM_SECRET_PROVIDER,
  type AiChangedEvent,
  type NewsAnalysis,
  type NewsAnalysisQuery,
  type NewsLlmSettings,
  type NewsLlmSettingsInput,
  type NewsLlmTestResult,
} from '../../../shared/ipc';
import type { SecretsService } from '../../services/secrets';
import type { NewsAnalysisRepository } from './repository';
import {
  isNewsLlmError,
  type KeyValueStore,
  type NewsHeadlineAnalyzer,
} from './types';

// ---------------------------------------------------------------------------
// Ajustes persistidos
// ---------------------------------------------------------------------------

/** Claves de `settings` donde viven los ajustes del LLM (sin secretos). */
export const NEWS_LLM_SETTINGS_KEYS = {
  enabled: 'newsLlm.enabled',
  dailyCap: 'newsLlm.dailyCap',
  monthlyBudgetEur: 'newsLlm.monthlyBudgetEur',
} as const;

interface StoredLlmSettings {
  enabled: boolean;
  dailyCap: number;
  monthlyBudgetEur: number;
}

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(value)));

const readSettings = (store: KeyValueStore): StoredLlmSettings => {
  const enabled = store.getValue(NEWS_LLM_SETTINGS_KEYS.enabled) === 'true';
  const rawCap = Number(store.getValue(NEWS_LLM_SETTINGS_KEYS.dailyCap));
  const dailyCap = Number.isFinite(rawCap) && rawCap > 0
    ? clampInt(rawCap, NEWS_LLM_DAILY_CAP_BOUNDS.min, NEWS_LLM_DAILY_CAP_BOUNDS.max)
    : NEWS_LLM_DAILY_CAP_DEFAULT;
  const rawBudget = Number(store.getValue(NEWS_LLM_SETTINGS_KEYS.monthlyBudgetEur));
  const monthlyBudgetEur = Number.isFinite(rawBudget) && rawBudget > 0
    ? Math.min(rawBudget, NEWS_LLM_MONTHLY_BUDGET_BOUNDS.max)
    : 0;
  return { enabled, dailyCap, monthlyBudgetEur };
};

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export interface NewsAiLogger {
  info?(message: string): void;
  warn(message: string): void;
  error?(message: string): void;
}

export interface NewsAiServiceDeps {
  repo: NewsAnalysisRepository;
  /** Clasificador léxico local: siempre disponible y sin coste. */
  localAnalyzer: NewsHeadlineAnalyzer;
  /** Adaptador LLM (Anthropic); null si no hay adaptador montado. */
  llmAnalyzer?: (NewsHeadlineAnalyzer & { ping?(): Promise<number> }) | null;
  /** Analizador determinista del modo E2E. */
  simulatedAnalyzer?: NewsHeadlineAnalyzer | null;
  /** true con TRADIA_E2E: siempre el simulado, sin claves ni cuotas. */
  useSimulated?: boolean;
  /** Almacén de claves cifradas; null si el llavero no está disponible. */
  secrets?: Pick<SecretsService, 'hasKey' | 'getKey'> | null;
  /** Almacén de ajustes clave-valor (settings o memoria). */
  store: KeyValueStore;
  /** Contadores del LLM ya montados por el adaptador (para `getLlmSettings`). */
  usage?: { load(): { day: string; usedToday: number; month: string; spentMonthEur: number } };
  broadcast?: (channel: string, payload: unknown) => void;
  now?: () => number;
  logger?: NewsAiLogger;
}

export interface NewsAiService {
  /** Análisis guardados para `ai:news-analysis`. */
  listAnalyses(query?: NewsAnalysisQuery): NewsAnalysis[];
  getLlmSettings(): Promise<NewsLlmSettings>;
  setLlmSettings(input: NewsLlmSettingsInput): Promise<NewsLlmSettings>;
  /** «Probar conexión»: no revela la clave ni consume el tope diario. */
  testLlm(): Promise<NewsLlmTestResult>;
  /** Encola un titular del lector; los no confirmados se descartan aquí. */
  enqueueItem(item: { id: number; confirmed: boolean }): void;
  /** Titulares pendientes de procesar (diagnóstico/pruebas). */
  pendingCount(): number;
  /** Resuelve cuando la cola queda vacía (pruebas). */
  drain(): Promise<void>;
}

const memoryStore = (): KeyValueStore => {
  const map = new Map<string, string>();
  return { getValue: (k) => map.get(k) ?? null, setValue: (k, v) => void map.set(k, v) };
};

export function createNewsAiService(deps: NewsAiServiceDeps): NewsAiService {
  const now = deps.now ?? (() => Date.now());
  const store = deps.store ?? memoryStore();
  const logger = deps.logger ?? console;
  const usage = deps.usage ?? {
    load: () => ({ day: '', usedToday: 0, month: '', spentMonthEur: 0 }),
  };

  const isoNow = (): string => new Date(now()).toISOString();
  const secrets = deps.secrets ?? null;

  const hasKey = async (): Promise<boolean> => {
    if (!secrets) return false;
    try {
      return await secrets.hasKey(NEWS_LLM_SECRET_PROVIDER);
    } catch {
      return false;
    }
  };

  /**
   * El LLM solo corre si: está activado, hay clave guardada y hay gasto
   * autorizado (presupuesto > 0). El tope diario y el gasto acumulado los
   * vigila además el propio adaptador ('quota').
   */
  const llmConfigured = async (): Promise<boolean> => {
    const settings = readSettings(store);
    if (!settings.enabled || settings.monthlyBudgetEur <= 0) return false;
    return hasKey();
  };

  const pickAnalyzer = async (): Promise<NewsHeadlineAnalyzer> => {
    if (deps.useSimulated && deps.simulatedAnalyzer) return deps.simulatedAnalyzer;
    if (deps.llmAnalyzer && (await llmConfigured())) return deps.llmAnalyzer;
    return deps.localAnalyzer;
  };

  /** Un aviso por clase de fallo por sesión: el registro no se inunda. */
  const warnedKinds = new Set<string>();
  const warnFallback = (error: unknown): void => {
    const kind = isNewsLlmError(error) ? error.kind : 'desconocido';
    if (warnedKinds.has(kind)) return;
    warnedKinds.add(kind);
    const detail = isNewsLlmError(error) ? error.message : 'error inesperado del analizador LLM';
    logger.warn(`[news-ai] ${detail} — el titular se analiza con el clasificador local`);
  };

  // -- Cola FIFO --------------------------------------------------------------

  const pending = new Set<number>();
  let running: Promise<void> | null = null;

  const processItem = async (id: number): Promise<void> => {
    // Se relee del disco: una reclasificación posterior puede haber quitado
    // la confirmación, y una noticia no confirmada nunca se analiza.
    const item = deps.repo.getNewsItem(id);
    if (!item || !item.confirmed) return;
    const analyzed = new Set(deps.repo.analyzedTickers(id));
    const candidates = item.assets.filter((ticker) => !analyzed.has(ticker));
    // Todos los activos ligados ya analizados: nada nuevo que aportar.
    if (item.assets.length > 0 && candidates.length === 0) return;

    const input = { title: item.title, summary: item.summary, candidateTickers: candidates };
    const chosen = await pickAnalyzer();
    let used = chosen;
    let result;
    try {
      result = await chosen.analyze(input);
    } catch (error) {
      if (chosen === deps.localAnalyzer) throw error;
      warnFallback(error);
      used = deps.localAnalyzer;
      result = await deps.localAnalyzer.analyze(input);
    }

    let wrote = false;
    for (const asset of result.assets) {
      if (analyzed.has(asset.ticker)) continue;
      if (candidates.length > 0 && !candidates.includes(asset.ticker)) continue;
      deps.repo.insertAnalysis({
        newsItemId: id,
        ticker: asset.ticker,
        summary: asset.summary,
        sentiment: asset.sentiment,
        analyzer: used.analyzer,
        model: used.model,
        analyzedAt: isoNow(),
      });
      wrote = true;
    }
    if (wrote) {
      const event: AiChangedEvent = { kind: 'noticias', at: isoNow() };
      deps.broadcast?.(IPC_CHANNELS.ai.changed, event);
    }
  };

  const runQueue = async (): Promise<void> => {
    // La cola puede crecer mientras se procesa (nuevas pasadas del lector):
    // drena hasta quedar vacía.
    while (pending.size > 0) {
      const id = pending.values().next().value!;
      pending.delete(id);
      try {
        await processItem(id);
      } catch (error) {
        // Ni un titular corrupto ni un fallo puntual detiene la cola.
        logger.error?.(`[news-ai] no se pudo analizar el titular ${id}: ${String(error)}`);
      }
    }
  };

  const enqueueItem = (item: { id: number; confirmed: boolean }): void => {
    // Barrera 1: una noticia no confirmada nunca entra en la cola.
    if (!item.confirmed) return;
    pending.add(item.id);
    running ??= runQueue().finally(() => {
      running = null;
    });
  };

  // -- Ajustes IPC ------------------------------------------------------------

  const getLlmSettings = async (): Promise<NewsLlmSettings> => {
    const settings = readSettings(store);
    const counters = usage.load();
    const today = isoNow().slice(0, 10);
    const month = today.slice(0, 7);
    return {
      enabled: settings.enabled,
      dailyCap: settings.dailyCap,
      monthlyBudgetEur: settings.monthlyBudgetEur,
      hasKey: await hasKey(),
      usedToday: counters.day === today ? counters.usedToday : 0,
      spentThisMonthEur: counters.month === month ? counters.spentMonthEur : 0,
    };
  };

  const setLlmSettings = async (input: NewsLlmSettingsInput): Promise<NewsLlmSettings> => {
    if (input.enabled !== undefined) {
      store.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, input.enabled ? 'true' : 'false');
    }
    if (input.dailyCap !== undefined) {
      store.setValue(
        NEWS_LLM_SETTINGS_KEYS.dailyCap,
        String(
          clampInt(input.dailyCap, NEWS_LLM_DAILY_CAP_BOUNDS.min, NEWS_LLM_DAILY_CAP_BOUNDS.max),
        ),
      );
    }
    if (input.monthlyBudgetEur !== undefined) {
      store.setValue(
        NEWS_LLM_SETTINGS_KEYS.monthlyBudgetEur,
        String(Math.min(input.monthlyBudgetEur, NEWS_LLM_MONTHLY_BUDGET_BOUNDS.max)),
      );
    }
    return getLlmSettings();
  };

  const testLlm = async (): Promise<NewsLlmTestResult> => {
    if (!secrets) {
      return { ok: false, error: 'El llavero del sistema no está disponible.', latencyMs: null };
    }
    if (!(await hasKey())) {
      return { ok: false, error: 'No hay una clave de Anthropic guardada.', latencyMs: null };
    }
    const ping = deps.llmAnalyzer?.ping;
    if (!ping) {
      return { ok: false, error: 'El analizador LLM no está disponible.', latencyMs: null };
    }
    try {
      const latencyMs = await ping.call(deps.llmAnalyzer);
      return { ok: true, error: null, latencyMs };
    } catch (error) {
      // El mensaje ya va saneado por el adaptador (la clave nunca aparece).
      return {
        ok: false,
        error: isNewsLlmError(error) ? error.message : 'No se pudo conectar con Anthropic.',
        latencyMs: null,
      };
    }
  };

  return {
    listAnalyses: (query) => deps.repo.list(query ?? {}),
    getLlmSettings,
    setLlmSettings,
    testLlm,
    enqueueItem,
    pendingCount: () => pending.size,
    drain: async () => {
      while (running) await running;
    },
  };
}
