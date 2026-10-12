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
 * - Elección de analizador por titular según el proveedor (`provider`):
 *   simulado en E2E; 'suscripcion' usa la CLI de Claude Code del equipo
 *   (sin coste de API; exige `enabled` y un `claude` localizable); 'llm'
 *   usa la API de Anthropic solo con `enabled` + clave guardada +
 *   presupuesto mensual > 0; 'local' —y cualquier fallo o proveedor no
 *   disponible— cae al léxico local con un aviso por clase de fallo.
 * - Persistencia: una fila por activo en `news_analysis`, solo para los
 *   tickers que aún no tienen análisis (UNIQUE noticia × ticker), con el
 *   método que lo produjo ('llm' + modelo o 'local').
 * - Filtro de salida (en el servicio: vale con cualquier proveedor): un
 *   ticker devuelto por el analizador solo se persiste si está entre los
 *   activos ligados al titular o el propio texto lo menciona
 *   (`detectAssets` sobre el texto saneado), así una alucinación o
 *   inyección no atribuye sentimiento a un activo ajeno al titular.
 * - Ajustes del LLM (`ai:get-llm-settings`/`set-llm-settings`): el
 *   interruptor, el tope diario y el presupuesto viven en `settings`; la
 *   clave vive en `secrets` y solo se expone `hasKey`.
 *
 * Nada aquí crea señales: el análisis solo informa al usuario y, en la
 * tarea de integración, ajusta la confianza por el motor de riesgo.
 */
import {
  IPC_CHANNELS,
  NEWS_ANALYZERS,
  NEWS_LLM_DAILY_CAP_BOUNDS,
  NEWS_LLM_DAILY_CAP_DEFAULT,
  NEWS_LLM_MONTHLY_BUDGET_BOUNDS,
  NEWS_LLM_SECRET_PROVIDER,
  type AiChangedEvent,
  type NewsAnalysis,
  type NewsAnalysisQuery,
  type NewsAnalyzer,
  type NewsLlmSettings,
  type NewsLlmSettingsInput,
  type NewsLlmTestResult,
} from '../../../shared/ipc';
import type { SecretsService } from '../../services/secrets';
import { detectAssets, stripInstructionSpans } from './local';
import type { NewsAnalysisRepository } from './repository';
import { isNewsLlmError, type KeyValueStore, type NewsHeadlineAnalyzer } from './types';

// ---------------------------------------------------------------------------
// Ajustes persistidos
// ---------------------------------------------------------------------------

/** Claves de `settings` donde viven los ajustes del LLM (sin secretos). */
export const NEWS_LLM_SETTINGS_KEYS = {
  enabled: 'newsLlm.enabled',
  provider: 'newsLlm.provider',
  cliPath: 'newsLlm.cliPath',
  dailyCap: 'newsLlm.dailyCap',
  monthlyBudgetEur: 'newsLlm.monthlyBudgetEur',
} as const;

interface StoredLlmSettings {
  enabled: boolean;
  provider: NewsAnalyzer;
  cliPath: string | null;
  dailyCap: number;
  monthlyBudgetEur: number;
}

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(value)));

const isStoredProvider = (value: string | null): value is NewsAnalyzer =>
  value !== null && (NEWS_ANALYZERS as readonly string[]).includes(value);

const readSettings = (store: KeyValueStore, detectedProvider: NewsAnalyzer): StoredLlmSettings => {
  const enabled = store.getValue(NEWS_LLM_SETTINGS_KEYS.enabled) === 'true';
  const storedProvider = store.getValue(NEWS_LLM_SETTINGS_KEYS.provider);
  // Sin proveedor guardado se deriva del interruptor heredado: quien tenía
  // el LLM activado sigue con la API ('llm'); el resto arranca con el
  // proveedor detectado —'suscripcion' si hay CLI de Claude Code
  // localizable, 'local' si no—.
  const provider: NewsAnalyzer = isStoredProvider(storedProvider)
    ? storedProvider
    : enabled
      ? 'llm'
      : detectedProvider;
  const cliPath = store.getValue(NEWS_LLM_SETTINGS_KEYS.cliPath) || null;
  const rawCap = Number(store.getValue(NEWS_LLM_SETTINGS_KEYS.dailyCap));
  const dailyCap =
    Number.isFinite(rawCap) && rawCap > 0
      ? clampInt(rawCap, NEWS_LLM_DAILY_CAP_BOUNDS.min, NEWS_LLM_DAILY_CAP_BOUNDS.max)
      : NEWS_LLM_DAILY_CAP_DEFAULT;
  const rawBudget = Number(store.getValue(NEWS_LLM_SETTINGS_KEYS.monthlyBudgetEur));
  const monthlyBudgetEur =
    Number.isFinite(rawBudget) && rawBudget > 0
      ? Math.min(rawBudget, NEWS_LLM_MONTHLY_BUDGET_BOUNDS.max)
      : 0;
  return { enabled, provider, cliPath, dailyCap, monthlyBudgetEur };
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
  /**
   * Analizador por suscripción (CLI de Claude Code); null si no está
   * montado. `available()` dice si hay un `claude` localizable y `ping()`
   * lo comprueba de verdad («CLI no encontrada» / «sesión no iniciada»).
   */
  subscriptionAnalyzer?:
    (NewsHeadlineAnalyzer & { ping?(): Promise<number>; available?(): boolean }) | null;
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

  /** ¿Hay un `claude` localizable para el proveedor por suscripción? */
  const cliAvailable = (): boolean => deps.subscriptionAnalyzer?.available?.() ?? false;

  /** Proveedor por defecto sin nada guardado: 'suscripcion' con CLI, 'local' sin ella. */
  const detectedProvider = (): NewsAnalyzer => (cliAvailable() ? 'suscripcion' : 'local');

  const readStored = (): StoredLlmSettings => readSettings(store, detectedProvider());

  /**
   * El LLM de la API solo corre si: está elegido y activado, hay clave
   * guardada y hay gasto autorizado (presupuesto > 0). El tope diario y
   * el gasto acumulado los vigila además el propio adaptador ('quota').
   */
  const llmConfigured = async (settings: StoredLlmSettings): Promise<boolean> => {
    if (!settings.enabled || settings.provider !== 'llm' || settings.monthlyBudgetEur <= 0) {
      return false;
    }
    return hasKey();
  };

  /** Un aviso por clase de fallo por sesión: el registro no se inunda. */
  const warnedKinds = new Set<string>();
  const warnOnce = (kind: string, message: string): void => {
    if (warnedKinds.has(kind)) return;
    warnedKinds.add(kind);
    logger.warn(`[news-ai] ${message} — el titular se analiza con el clasificador local`);
  };

  const pickAnalyzer = async (): Promise<NewsHeadlineAnalyzer> => {
    if (deps.useSimulated && deps.simulatedAnalyzer) return deps.simulatedAnalyzer;
    const settings = readStored();
    if (settings.provider === 'suscripcion' && settings.enabled) {
      if (deps.subscriptionAnalyzer && cliAvailable()) return deps.subscriptionAnalyzer;
      warnOnce(
        'sin-cli',
        'el proveedor «Suscripción (Claude Code)» no encuentra la CLI en este equipo',
      );
    }
    if (deps.llmAnalyzer && (await llmConfigured(settings))) return deps.llmAnalyzer;
    return deps.localAnalyzer;
  };

  const warnFallback = (error: unknown): void => {
    const kind = isNewsLlmError(error) ? error.kind : 'desconocido';
    const detail = isNewsLlmError(error) ? error.message : 'error inesperado del analizador LLM';
    warnOnce(kind, detail);
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

    // Filtro del resultado, a prueba de proveedor: solo se persiste un
    // ticker si el lector lo ligó al titular o el propio texto lo menciona
    // (el mismo detectAssets del clasificador local sobre el texto
    // saneado). Así ni una alucinación ni una inyección atribuyen
    // sentimiento a un activo que el titular no nombra.
    const linked = new Set(item.assets.map((ticker) => ticker.trim().toUpperCase()));
    const mentioned = new Set(
      detectAssets(stripInstructionSpans(`${item.title} ${item.summary ?? ''}`)),
    );

    let wrote = false;
    for (const asset of result.assets) {
      const ticker = asset.ticker.trim().toUpperCase();
      if (analyzed.has(ticker)) continue;
      if (!linked.has(ticker) && !mentioned.has(ticker)) continue;
      deps.repo.insertAnalysis({
        newsItemId: id,
        ticker,
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
    const settings = readStored();
    const counters = usage.load();
    const today = isoNow().slice(0, 10);
    const month = today.slice(0, 7);
    return {
      enabled: settings.provider !== 'local' && settings.enabled,
      provider: settings.provider,
      cliPath: settings.cliPath,
      // Detección real de la CLI de Claude Code en este equipo.
      cliAvailable: cliAvailable(),
      dailyCap: settings.dailyCap,
      monthlyBudgetEur: settings.monthlyBudgetEur,
      hasKey: await hasKey(),
      usedToday: counters.day === today ? counters.usedToday : 0,
      spentThisMonthEur: counters.month === month ? counters.spentMonthEur : 0,
    };
  };

  const setLlmSettings = async (input: NewsLlmSettingsInput): Promise<NewsLlmSettings> => {
    // El proveedor y el interruptor van de la mano: 'local' es el LLM
    // desactivado; elegir 'llm' o 'suscripcion' lo activa salvo que el
    // propio patch fije `enabled` explícitamente.
    if (input.provider !== undefined) {
      store.setValue(NEWS_LLM_SETTINGS_KEYS.provider, input.provider);
      if (input.enabled === undefined) {
        store.setValue(
          NEWS_LLM_SETTINGS_KEYS.enabled,
          input.provider === 'local' ? 'false' : 'true',
        );
      }
    }
    if (input.enabled !== undefined) {
      store.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, input.enabled ? 'true' : 'false');
      // Activar a mano sin proveedor guardado elige el detectado: la
      // suscripción si hay CLI y, si no, la API (el único LLM que queda).
      if (input.enabled && input.provider === undefined) {
        const stored = store.getValue(NEWS_LLM_SETTINGS_KEYS.provider);
        if (!isStoredProvider(stored) || stored === 'local') {
          store.setValue(
            NEWS_LLM_SETTINGS_KEYS.provider,
            detectedProvider() === 'suscripcion' ? 'suscripcion' : 'llm',
          );
        }
      } else if (!input.enabled && input.provider === undefined) {
        store.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'local');
      }
    }
    if (input.cliPath !== undefined) {
      store.setValue(NEWS_LLM_SETTINGS_KEYS.cliPath, input.cliPath ?? '');
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
    const { provider } = readStored();
    if (provider === 'local') {
      return {
        ok: true,
        error: null,
        latencyMs: null,
      };
    }
    if (provider === 'suscripcion') {
      const cli = deps.subscriptionAnalyzer;
      if (!cli?.ping) {
        return { ok: false, error: 'CLI no encontrada.', latencyMs: null };
      }
      try {
        const latencyMs = await cli.ping();
        return { ok: true, error: null, latencyMs };
      } catch (error) {
        // El adaptador clasifica el motivo: 'CLI no encontrada',
        // 'sesión no iniciada' u otro fallo de la ejecución.
        return {
          ok: false,
          error: isNewsLlmError(error) ? error.message : 'No se pudo ejecutar la CLI de Claude.',
          latencyMs: null,
        };
      }
    }
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
