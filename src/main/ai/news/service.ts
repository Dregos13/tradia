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
 *   (sin coste de API; exige `enabled` y un `claude` localizable) y
 *   'local' —y cualquier fallo de la suscripción— cae al léxico local
 *   con un aviso por clase de fallo. La API de pago ('llm') se retiró:
 *   un ajuste guardado con ella se migra a 'suscripcion' si hay CLI y a
 *   'local' si no, y la clave cifrada que quedara se borra.
 * - Estado del proveedor (`ai:news-status` + evento
 *   `ai:news-status-changed`): 'ok', 'cli-no-encontrada', 'sin-sesion',
 *   'tope-diario' o 'error', con el motivo y el paso para resolverlo. Al
 *   caer de 'ok' se envía UNA notificación del sistema (no una por
 *   titular) y otra cuando vuelve a 'ok'. Al arrancar (`start()`) se
 *   avisa una vez si la suscripción activada no encuentra la CLI.
 * - Persistencia: una fila por activo en `news_analysis`, solo para los
 *   tickers que aún no tienen análisis (UNIQUE noticia × ticker).
 * - Filtro de salida (en el servicio: vale con cualquier proveedor): un
 *   ticker devuelto por el analizador solo se persiste si está entre los
 *   activos ligados al titular o el propio texto lo menciona
 *   (`detectAssets` sobre el texto saneado), así una alucinación o
 *   inyección no atribuye sentimiento a un activo ajeno al titular.
 * - Ajustes (`ai:get-llm-settings`/`set-llm-settings`): el interruptor,
 *   el proveedor, la ruta de la CLI y el tope diario viven en `settings`.
 *
 * Nada aquí crea señales: el análisis solo informa al usuario y, en la
 * tarea de integración, ajusta la confianza por el motor de riesgo.
 */
import {
  IPC_CHANNELS,
  isNewsCliEngine,
  isNewsProvider,
  NEWS_CLI_ENGINES,
  NEWS_ENGINES,
  NEWS_LLM_DAILY_CAP_BOUNDS,
  NEWS_LLM_DAILY_CAP_DEFAULT,
  NEWS_LLM_SECRET_PROVIDER,
  type AiChangedEvent,
  type NewsAnalysis,
  type NewsAnalysisQuery,
  type NewsAnalyzer,
  type NewsCliEngine,
  type NewsEngine,
  type NewsEngineStatus,
  type NewsLlmSettings,
  type NewsLlmSettingsInput,
  type NewsLlmTestResult,
  type NewsStatus,
  type NewsSubscriptionState,
  type NotificationPayload,
} from '../../../shared/ipc';
import type { SecretsService } from '../../services/secrets';
import { CLI_ENGINE_SPECS, type CliEngineResolution } from './cliEngines';
import { detectAssets, stripInstructionSpans } from './local';
import type { NewsAnalysisRepository } from './repository';
import { isNewsLlmError, type KeyValueStore, type NewsHeadlineAnalyzer } from './types';

// ---------------------------------------------------------------------------
// Ajustes persistidos
// ---------------------------------------------------------------------------

/** Claves de `settings` donde viven los ajustes del análisis (sin secretos). */
export const NEWS_LLM_SETTINGS_KEYS = {
  enabled: 'newsLlm.enabled',
  provider: 'newsLlm.provider',
  /** Ruta heredada: la que Ajustes guardaba para Claude Code. */
  cliPath: 'newsLlm.cliPath',
  /** Motor CLI elegido ('suscripcion-claude'…); falta = Claude Code. */
  engine: 'newsLlm.engine',
  dailyCap: 'newsLlm.dailyCap',
} as const;

/** Clave por motor de la ruta personalizada ('newsLlm.cliPath.suscripcion-codex'…). */
export const engineCliPathKey = (engine: NewsCliEngine): string =>
  `${NEWS_LLM_SETTINGS_KEYS.cliPath}.${engine}`;

interface StoredLlmSettings {
  enabled: boolean;
  provider: NewsAnalyzer;
  /** Motor CLI elegido ('suscripcion-*'); solo relevante con 'suscripcion'. */
  engine: NewsCliEngine;
  dailyCap: number;
}

const clampInt = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.trunc(value)));

const readSettings = (
  store: KeyValueStore,
  detectedProvider: NewsAnalyzer,
  defaultEngine: NewsCliEngine,
): StoredLlmSettings => {
  const enabled = store.getValue(NEWS_LLM_SETTINGS_KEYS.enabled) === 'true';
  const storedProvider = store.getValue(NEWS_LLM_SETTINGS_KEYS.provider);
  // Un proveedor guardado elegible manda. Sin él se sugiere el detectado
  // ('suscripcion' con CLI, 'local' sin ella); un 'llm' heredado aún no
  // migrado se lee igual que su migración: detectado si estaba activado
  // y 'local' si no.
  const provider: NewsAnalyzer = isNewsProvider(storedProvider)
    ? storedProvider
    : storedProvider === 'llm' && !enabled
      ? 'local'
      : detectedProvider;
  // Motor guardado si es válido; si no, el primero detectado. Un ajuste
  // heredado sin motor equivale a Claude Code (es lo que era antes).
  const storedEngine = store.getValue(NEWS_LLM_SETTINGS_KEYS.engine);
  const engine: NewsCliEngine = isNewsCliEngine(storedEngine) ? storedEngine : defaultEngine;
  const rawCap = Number(store.getValue(NEWS_LLM_SETTINGS_KEYS.dailyCap));
  const dailyCap =
    Number.isFinite(rawCap) && rawCap > 0
      ? clampInt(rawCap, NEWS_LLM_DAILY_CAP_BOUNDS.min, NEWS_LLM_DAILY_CAP_BOUNDS.max)
      : NEWS_LLM_DAILY_CAP_DEFAULT;
  return { enabled, provider, engine, dailyCap };
};

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export interface NewsAiLogger {
  info?(message: string): void;
  warn(message: string): void;
  error?(message: string): void;
}

/** Manillar de un motor CLI: su analizador y la resolución de su ejecutable. */
export interface NewsCliEngineHandle {
  /** Analizador headless del motor; null si no está montado. */
  analyzer: (NewsHeadlineAnalyzer & { ping?(): Promise<number> }) | null;
  /** true si hay un ejecutable localizable (configurado, PATH o conocido). */
  available(): boolean;
  /** Resolución vigente (ruta y origen) para la autodetección de Ajustes. */
  resolve?(): CliEngineResolution;
}

export interface NewsAiServiceDeps {
  repo: NewsAnalysisRepository;
  /** Clasificador léxico local: siempre disponible y sin coste. */
  localAnalyzer: NewsHeadlineAnalyzer;
  /**
   * Manillares por motor del desplegable (`cliEngines.ts`): cada uno
   * ejecuta su CLI en headless seguro. `subscriptionAnalyzer` queda como
   * alias heredado de 'suscripcion-claude'.
   */
  cliEngines?: Partial<Record<NewsCliEngine, NewsCliEngineHandle>>;
  /**
   * Analizador por suscripción (CLI de Claude Code); null si no está
   * montado. `available()` dice si hay un `claude` localizable y `ping()`
   * lo comprueba de verdad («CLI no encontrada» / «sesión no iniciada»).
   * @deprecated Preferir `cliEngines['suscripcion-claude']`.
   */
  subscriptionAnalyzer?:
    (NewsHeadlineAnalyzer & { ping?(): Promise<number>; available?(): boolean }) | null;
  /** Analizador determinista del modo E2E. */
  simulatedAnalyzer?: NewsHeadlineAnalyzer | null;
  /** true con TRADIA_E2E: siempre el simulado, sin claves ni cuotas. */
  useSimulated?: boolean;
  /**
   * Almacén de claves cifradas; null si el llavero no está disponible.
   * Solo sirve para borrar la clave de la API retirada en la migración.
   */
  secrets?: Pick<SecretsService, 'hasKey' | 'deleteKey'> | null;
  /** Almacén de ajustes clave-valor (settings o memoria). */
  store: KeyValueStore;
  /** Contadores del tope diario ya montados por el adaptador (para `getLlmSettings`). */
  usage?: { load(): { day: string; usedToday: number; month: string; spentMonthEur: number } };
  /** Notificación del sistema al caer el análisis por suscripción y al recuperarse. */
  notify?: (payload: NotificationPayload) => void;
  broadcast?: (channel: string, payload: unknown) => void;
  now?: () => number;
  logger?: NewsAiLogger;
}

export interface NewsAiService {
  /** Análisis guardados para `ai:news-analysis`. */
  listAnalyses(query?: NewsAnalysisQuery): NewsAnalysis[];
  /** Estado vigente del proveedor para `ai:news-status`. */
  getNewsStatus(): Promise<NewsStatus>;
  getLlmSettings(): Promise<NewsLlmSettings>;
  setLlmSettings(input: NewsLlmSettingsInput): Promise<NewsLlmSettings>;
  /** «Probar conexión»: prueba la CLI sin consumir el tope diario. */
  testLlm(): Promise<NewsLlmTestResult>;
  /** Encola un titular del lector; los no confirmados se descartan aquí. */
  enqueueItem(item: { id: number; confirmed: boolean }): void;
  /** Titulares pendientes de procesar (diagnóstico/pruebas). */
  pendingCount(): number;
  /** Resuelve cuando la cola queda vacía (pruebas). */
  drain(): Promise<void>;
  /**
   * Evaluación del arranque (una vez por proceso): fija el estado base y,
   * si la suscripción guardada y activada no encuentra la CLI, emite
   * `ai:news-status-changed` y UNA notificación del sistema.
   */
  start(): Promise<void>;
}

const memoryStore = (): KeyValueStore => {
  const map = new Map<string, string>();
  return { getValue: (k) => map.get(k) ?? null, setValue: (k, v) => void map.set(k, v) };
};

/**
 * Texto seguro por estado (el paso de Ajustes del diseño): el motivo y
 * cómo resolverlo, sin detalles técnicos. Si el analizador da un mensaje
 * técnico va al registro (`warnFallback`), nunca a la interfaz ni a la
 * notificación.
 */
const STATUS_MESSAGES: Record<
  Exclude<NewsSubscriptionState, 'ok'>,
  (engine: NewsCliEngine) => string
> = {
  'cli-no-encontrada': (engine) =>
    `Instala ${CLI_ENGINE_SPECS[engine].label} y vuelve a abrir Tradia. Si ya está instalado, indica su ruta en este ajuste. Mientras tanto, se usa el analizador local.`,
  'sin-sesion': (engine) =>
    `Abre un terminal, ${CLI_ENGINE_SPECS[engine].loginHint}. Vuelve aquí y prueba de nuevo. Mientras tanto, se usa el analizador local.`,
  'tope-diario': () =>
    'Espera al próximo día o aumenta el máximo diario de titulares. Hasta entonces se usa el analizador local.',
  error: () =>
    'Comprueba la conexión y vuelve a probar. Mientras tanto, se usa el analizador local.',
};

/** Cuerpo de la notificación del sistema por motivo (textos del diseño). */
const NOTIFY_BODY: Record<
  Exclude<NewsSubscriptionState, 'ok'>,
  (engine: NewsCliEngine) => string
> = {
  'cli-no-encontrada': (engine) =>
    `No se encontró ${CLI_ENGINE_SPECS[engine].label}. Abre Ajustes › Análisis de noticias para resolverlo.`,
  'sin-sesion': (engine) =>
    `La sesión de ${CLI_ENGINE_SPECS[engine].label} no está iniciada. Abre Ajustes › Análisis de noticias para resolverlo.`,
  'tope-diario': () =>
    'Se alcanzó el máximo diario de titulares. Tradia usa el analizador local hasta el próximo día.',
  error: (engine) =>
    `${CLI_ENGINE_SPECS[engine].label} devolvió un error. Tradia usa el analizador local; abre Ajustes para volver a probar.`,
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

  // -- Motores CLI del desplegable ---------------------------------------------
  //
  // `cliEngines` lleva un manillar por motor (claude/codex/agy/copilot);
  // el dep heredado `subscriptionAnalyzer` equivale a 'suscripcion-claude'.

  const legacyHandle: NewsCliEngineHandle | null = deps.subscriptionAnalyzer
    ? {
        analyzer: deps.subscriptionAnalyzer,
        available: () => deps.subscriptionAnalyzer?.available?.() ?? false,
      }
    : null;

  const engineHandle = (engine: NewsCliEngine): NewsCliEngineHandle | null =>
    deps.cliEngines?.[engine] ?? (engine === 'suscripcion-claude' ? legacyHandle : null);

  const engineAvailable = (engine: NewsCliEngine): boolean =>
    engineHandle(engine)?.available() ?? false;

  /** ¿Hay alguna CLI localizable para el proveedor por suscripción? */
  const cliAvailable = (): boolean => NEWS_CLI_ENGINES.some((engine) => engineAvailable(engine));

  /** Motor por defecto sin nada guardado: el primero con CLI localizable. */
  const detectedEngine = (): NewsCliEngine =>
    NEWS_CLI_ENGINES.find((engine) => engineAvailable(engine)) ?? 'suscripcion-claude';

  /** Proveedor por defecto sin nada guardado: 'suscripcion' con CLI, 'local' sin ella. */
  const detectedProvider = (): NewsAnalyzer => (cliAvailable() ? 'suscripcion' : 'local');

  /**
   * Motor por defecto: con un proveedor ya guardado es Claude Code (un
   * ajuste heredado de «suscripción» siempre significó Claude); sin
   * proveedor guardado —instalación nueva—, el primer motor con CLI
   * localizable.
   */
  const defaultEngine = (): NewsCliEngine =>
    isNewsProvider(store.getValue(NEWS_LLM_SETTINGS_KEYS.provider)) ||
    store.getValue(NEWS_LLM_SETTINGS_KEYS.provider) === 'llm'
      ? 'suscripcion-claude'
      : detectedEngine();

  const readStored = (): StoredLlmSettings =>
    readSettings(store, detectedProvider(), defaultEngine());

  /** Ruta personalizada de un motor: su clave propia y, para Claude Code, la heredada. */
  const engineConfiguredPath = (engine: NewsCliEngine): string | null => {
    const own = store.getValue(engineCliPathKey(engine));
    const legacy =
      engine === 'suscripcion-claude' ? store.getValue(NEWS_LLM_SETTINGS_KEYS.cliPath) : null;
    const raw = own ?? legacy;
    return raw && raw.trim().length > 0 ? raw : null;
  };

  /** Motor que vería el desplegable: el guardado o el primero detectado. */
  const activeEngine = (): NewsCliEngine => readStored().engine;

  const engineStatus = (engine: NewsEngine): NewsEngineStatus => {
    if (engine === 'local') {
      return {
        id: 'local',
        label: 'Analizador local',
        cliName: null,
        available: true,
        resolvedPath: null,
        source: 'local',
        configuredPath: null,
        configuredInvalid: false,
      };
    }
    const spec = CLI_ENGINE_SPECS[engine];
    const handle = engineHandle(engine);
    const resolution: CliEngineResolution = handle?.resolve?.() ?? {
      path: null,
      source: null,
      configuredInvalid: engineConfiguredPath(engine) !== null,
    };
    return {
      id: engine,
      label: spec.label,
      cliName: spec.cliName,
      available: handle?.available() ?? false,
      resolvedPath: resolution.path,
      source: resolution.source,
      configuredPath: engineConfiguredPath(engine),
      configuredInvalid: resolution.configuredInvalid,
    };
  };

  // -- Migración del proveedor 'llm' retirado ---------------------------------
  //
  // Se ejecuta una vez por proceso, antes de leer ajustes o analizar: un
  // proveedor 'llm' guardado (la API de pago retirada) pasa a
  // 'suscripcion' si hay CLI localizable y a 'local' si no, y la clave
  // cifrada que quedara en secrets se borra — la API ya no existe.
  let migrated: Promise<void> | null = null;
  const ensureMigrated = (): Promise<void> =>
    (migrated ??= (async () => {
      if (secrets) {
        try {
          if (await secrets.hasKey(NEWS_LLM_SECRET_PROVIDER)) {
            await secrets.deleteKey(NEWS_LLM_SECRET_PROVIDER);
            logger.info?.('[news-ai] clave de la API de pago retirada borrada del llavero');
          }
        } catch (error) {
          logger.warn(`[news-ai] no se pudo borrar la clave de la API retirada: ${String(error)}`);
        }
      }
      if (store.getValue(NEWS_LLM_SETTINGS_KEYS.provider) === 'llm') {
        const enabled = store.getValue(NEWS_LLM_SETTINGS_KEYS.enabled) === 'true';
        const next = enabled ? detectedProvider() : 'local';
        store.setValue(NEWS_LLM_SETTINGS_KEYS.provider, next);
        store.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, String(next !== 'local'));
        logger.info?.(`[news-ai] proveedor 'llm' migrado a '${next}' (la API de pago se retiró)`);
      }
      // Migración suave de la ruta heredada: `newsLlm.cliPath` (que solo
      // existía para Claude Code) se copia a la clave por motor; la
      // lectura sigue admitiendo la antigua como respaldo.
      const legacyPath = store.getValue(NEWS_LLM_SETTINGS_KEYS.cliPath);
      if (
        legacyPath &&
        legacyPath.trim().length > 0 &&
        !store.getValue(engineCliPathKey('suscripcion-claude'))
      ) {
        store.setValue(engineCliPathKey('suscripcion-claude'), legacyPath);
        logger.info?.('[news-ai] ruta de la CLI heredada asignada al motor Claude Code');
      }
    })());

  // -- Estado del proveedor (ai:news-status) -----------------------------------
  //
  // `status` empieza en null. `start()` (lo llama `registerNewsAi` al
  // arrancar) lo fija a su estado base y, si el proveedor guardado es la
  // suscripción activada y no se encuentra la CLI, avisa con el evento y
  // UNA notificación: la app corre en segundo plano y es la única señal
  // que el usuario ve sin abrir la ventana. Después, cada transición
  // fuera de 'ok' emite el evento y UNA notificación, y la vuelta a 'ok'
  // emite otra. Sin `start()` (o si Ajustes se adelanta) la primera
  // evaluación fija el estado base sin notificar.

  let status: NewsStatus | null = null;

  const baselineStatus = (): NewsStatus => {
    const settings = readStored();
    const engine: NewsEngine = settings.provider === 'suscripcion' ? settings.engine : 'local';
    if (
      settings.provider === 'suscripcion' &&
      settings.enabled &&
      !engineAvailable(settings.engine)
    ) {
      return {
        provider: 'suscripcion',
        engine,
        state: 'cli-no-encontrada',
        since: isoNow(),
        message: STATUS_MESSAGES['cli-no-encontrada'](settings.engine),
      };
    }
    return { provider: settings.provider, engine, state: 'ok', since: isoNow(), message: null };
  };

  const notify = (payload: NotificationPayload): void => {
    try {
      deps.notify?.(payload);
    } catch (error) {
      logger.warn(`[news-ai] no se pudo enviar la notificación de estado: ${String(error)}`);
    }
  };

  const notifyFailure = (
    state: Exclude<NewsSubscriptionState, 'ok'>,
    engine: NewsCliEngine,
  ): void =>
    notify({
      level: 'alerta',
      title: 'Tradia usa el analizador local',
      body: NOTIFY_BODY[state](engine),
      navigateTo: 'ajustes',
    });

  /**
   * Fija el estado del proveedor y anuncia el cambio por
   * `ai:news-status-changed`. La notificación del sistema solo sale en
   * las transiciones 'ok' → fallo y fallo → 'ok' (una por transición,
   * nunca por titular). Con `silent` se actualiza el estado y el evento
   * pero no la notificación (cambios hechos a mano en Ajustes).
   */
  const setStatus = (
    provider: NewsAnalyzer,
    state: NewsSubscriptionState,
    message: string | null,
    options: { silent?: boolean } = {},
  ): void => {
    const engine: NewsEngine = provider === 'suscripcion' ? activeEngine() : 'local';
    const prev = status ?? baselineStatus();
    if (prev.state === state && prev.provider === provider && prev.engine === engine) {
      if (prev.message === message) return;
      status = { ...prev, message };
      deps.broadcast?.(IPC_CHANNELS.ai.newsStatusChanged, status);
      return;
    }
    status = { provider, engine, state, since: isoNow(), message };
    deps.broadcast?.(IPC_CHANNELS.ai.newsStatusChanged, status);
    if (options.silent) return;
    if (prev.state === 'ok' && state !== 'ok') {
      notifyFailure(state, activeEngine());
    } else if (prev.state !== 'ok' && state === 'ok') {
      const recovered = provider === 'suscripcion' ? CLI_ENGINE_SPECS[activeEngine()] : null;
      notify({
        level: 'info',
        title: `Suscripción de ${recovered?.shortName ?? 'IA'} recuperada`,
        body: `Tradia vuelve a analizar los nuevos titulares con ${recovered?.label ?? 'el analizador local'}.`,
        navigateTo: 'ajustes',
      });
    }
  };

  const markOk = (provider: NewsAnalyzer): void => setStatus(provider, 'ok', null);

  /** Clasifica el fallo del analizador en un estado con su texto seguro. */
  const stateFromError = (
    error: unknown,
    engine: NewsCliEngine,
  ): { state: NewsSubscriptionState; message: string } => {
    const state: NewsSubscriptionState = !isNewsLlmError(error)
      ? 'error'
      : error.kind === 'auth'
        ? 'sin-sesion'
        : error.kind === 'quota'
          ? 'tope-diario'
          : error.kind === 'network' && !engineAvailable(engine)
            ? 'cli-no-encontrada'
            : 'error';
    return { state, message: STATUS_MESSAGES[state](engine) };
  };

  const markFailure = (provider: NewsAnalyzer, error: unknown): void => {
    const engine = activeEngine();
    const { state, message } = stateFromError(error, engine);
    setStatus(provider, state, message);
  };

  /** Un aviso por clase de fallo por sesión: el registro no se inunda. */
  const warnedKinds = new Set<string>();
  const warnOnce = (kind: string, message: string): void => {
    if (warnedKinds.has(kind)) return;
    warnedKinds.add(kind);
    logger.warn(`[news-ai] ${message} — el titular se analiza con el clasificador local`);
  };

  const pickAnalyzer = async (): Promise<NewsHeadlineAnalyzer> => {
    if (deps.useSimulated && deps.simulatedAnalyzer) {
      markOk(readStored().provider);
      return deps.simulatedAnalyzer;
    }
    const settings = readStored();
    if (settings.provider === 'suscripcion' && settings.enabled) {
      const handle = engineHandle(settings.engine);
      if (handle?.analyzer && handle.available()) return handle.analyzer;
      setStatus(
        'suscripcion',
        'cli-no-encontrada',
        STATUS_MESSAGES['cli-no-encontrada'](settings.engine),
      );
      warnOnce(
        `sin-cli-${settings.engine}`,
        `el proveedor «Suscripción (${CLI_ENGINE_SPECS[settings.engine].label})» no encuentra la CLI en este equipo`,
      );
    } else {
      // 'local' (o suscripción desactivada): nada que vigilar.
      markOk(settings.provider);
    }
    return deps.localAnalyzer;
  };

  const warnFallback = (error: unknown): void => {
    const kind = isNewsLlmError(error) ? error.kind : 'desconocido';
    const detail = isNewsLlmError(error) ? error.message : 'error inesperado del analizador';
    warnOnce(kind, detail);
  };

  // -- Cola FIFO --------------------------------------------------------------

  const pending = new Set<number>();
  let running: Promise<void> | null = null;

  const processItem = async (id: number): Promise<void> => {
    await ensureMigrated();
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
    const cliChosen = chosen !== deps.localAnalyzer && chosen !== deps.simulatedAnalyzer;
    let used = chosen;
    let result;
    try {
      result = await chosen.analyze(input);
      if (cliChosen) markOk('suscripcion');
    } catch (error) {
      if (chosen === deps.localAnalyzer) {
        markFailure(readStored().provider, error);
        throw error;
      }
      warnFallback(error);
      markFailure(readStored().provider, error);
      used = deps.localAnalyzer;
      result = await deps.localAnalyzer.analyze(input);
    }

    // Filtro del resultado, a prueba de proveedor: solo se persiste un
    // ticker si el lector lo ligó al titular o el propio texto lo menciona
    // (el mismo detectAssets del clasificador local sobre el texto
    // saneado). Así ni una alucinación ni una inyección atribuye
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
    await ensureMigrated();
    const settings = readStored();
    const counters = usage.load();
    const today = isoNow().slice(0, 10);
    const month = today.slice(0, 7);
    const engine: NewsEngine = settings.provider === 'suscripcion' ? settings.engine : 'local';
    return {
      enabled: settings.provider !== 'local' && settings.enabled,
      provider: settings.provider,
      engine,
      // Autodetección por motor: el desplegable de Ajustes la muestra.
      engines: NEWS_ENGINES.map((id) => engineStatus(id)),
      cliPath: engine === 'local' ? null : engineConfiguredPath(engine),
      // Semántica heredada: «hay alguna CLI localizable en este equipo».
      // La disponibilidad por motor va en `engines`.
      cliAvailable: cliAvailable(),
      dailyCap: settings.dailyCap,
      // Campos de la API de pago retirada: se conservan en el contrato
      // mientras la interfaz se adapta, pero ya no gobiernan nada.
      monthlyBudgetEur: 0,
      hasKey: secrets ? await secrets.hasKey(NEWS_LLM_SECRET_PROVIDER).catch(() => false) : false,
      usedToday: counters.day === today ? counters.usedToday : 0,
      spentThisMonthEur: counters.month === month ? counters.spentMonthEur : 0,
    };
  };

  const setLlmSettings = async (input: NewsLlmSettingsInput): Promise<NewsLlmSettings> => {
    await ensureMigrated();
    // El proveedor y el interruptor van de la mano: 'local' es el LLM
    // desactivado; elegir 'suscripcion' lo activa salvo que el propio
    // patch fije `enabled` explícitamente. Un 'llm' que se cuelara aquí
    // (el validador del IPC ya lo rechaza) se ignora: la API se retiró.
    if (input.provider !== undefined && isNewsProvider(input.provider)) {
      store.setValue(NEWS_LLM_SETTINGS_KEYS.provider, input.provider);
      if (input.enabled === undefined) {
        store.setValue(
          NEWS_LLM_SETTINGS_KEYS.enabled,
          input.provider === 'local' ? 'false' : 'true',
        );
      }
    }
    // El motor del desplegable: un 'suscripcion-*' guarda el motor y
    // activa la suscripción; 'local' equivale a desactivar el LLM (se
    // conserva el motor guardado para volver a él sin reelegir).
    if (input.engine !== undefined) {
      if (input.engine === 'local') {
        store.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'local');
        if (input.enabled === undefined) {
          store.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, 'false');
        }
      } else {
        store.setValue(NEWS_LLM_SETTINGS_KEYS.engine, input.engine);
        store.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'suscripcion');
        if (input.enabled === undefined) {
          store.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, 'true');
        }
      }
    }
    if (input.enabled !== undefined) {
      store.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, input.enabled ? 'true' : 'false');
      // Activar a mano sin proveedor guardado elige el detectado: la
      // suscripción si hay CLI y, si no, el analizador local —que
      // equivale a desactivado, así el interruptor se baja con él.
      if (input.enabled && input.provider === undefined) {
        const stored = store.getValue(NEWS_LLM_SETTINGS_KEYS.provider);
        if (!isNewsProvider(stored) || stored === 'local') {
          const detected = detectedProvider();
          store.setValue(NEWS_LLM_SETTINGS_KEYS.provider, detected);
          if (detected === 'local') store.setValue(NEWS_LLM_SETTINGS_KEYS.enabled, 'false');
        }
      } else if (!input.enabled && input.provider === undefined) {
        store.setValue(NEWS_LLM_SETTINGS_KEYS.provider, 'local');
      }
    }
    if (input.cliPath !== undefined) {
      // La ruta se guarda por motor: el de esta misma llamada (si es una
      // CLI) o el activo. Para Claude Code se replica en la clave
      // heredada `newsLlm.cliPath`, que las versiones anteriores leen.
      const target: NewsCliEngine =
        input.engine !== undefined && input.engine !== 'local' ? input.engine : activeEngine();
      store.setValue(engineCliPathKey(target), input.cliPath ?? '');
      if (target === 'suscripcion-claude') {
        store.setValue(NEWS_LLM_SETTINGS_KEYS.cliPath, input.cliPath ?? '');
      }
    }
    if (input.dailyCap !== undefined) {
      store.setValue(
        NEWS_LLM_SETTINGS_KEYS.dailyCap,
        String(
          clampInt(input.dailyCap, NEWS_LLM_DAILY_CAP_BOUNDS.min, NEWS_LLM_DAILY_CAP_BOUNDS.max),
        ),
      );
    }
    // `monthlyBudgetEur` (campo retirado del contrato) se acepta y se
    // ignora: la API de pago ya no existe.
    // El cambio de proveedor reevalúa el estado sin notificar: fue el
    // propio usuario quien lo cambió en Ajustes.
    const saved = readStored();
    if (saved.provider === 'suscripcion' && saved.enabled && !engineAvailable(saved.engine)) {
      setStatus(
        'suscripcion',
        'cli-no-encontrada',
        STATUS_MESSAGES['cli-no-encontrada'](saved.engine),
        {
          silent: true,
        },
      );
    } else {
      setStatus(saved.provider, 'ok', null, { silent: true });
    }
    return getLlmSettings();
  };

  const testLlm = async (): Promise<NewsLlmTestResult> => {
    await ensureMigrated();
    const settings = readStored();
    if (settings.provider !== 'suscripcion') {
      markOk(settings.provider);
      return { ok: true, error: null, latencyMs: null };
    }
    const spec = CLI_ENGINE_SPECS[settings.engine];
    const handle = engineHandle(settings.engine);
    if (!handle?.analyzer?.ping || !handle.available()) {
      setStatus(
        'suscripcion',
        'cli-no-encontrada',
        STATUS_MESSAGES['cli-no-encontrada'](settings.engine),
      );
      return { ok: false, error: 'CLI no encontrada.', latencyMs: null };
    }
    try {
      const latencyMs = await handle.analyzer.ping();
      markOk('suscripcion');
      return { ok: true, error: null, latencyMs };
    } catch (error) {
      // El adaptador clasifica el motivo: 'CLI no encontrada',
      // 'sesión no iniciada', tope diario u otro fallo de la ejecución.
      markFailure('suscripcion', error);
      return {
        ok: false,
        error: isNewsLlmError(error)
          ? error.message
          : `No se pudo ejecutar la CLI de ${spec.shortName}.`,
        latencyMs: null,
      };
    }
  };

  const getNewsStatus = async (): Promise<NewsStatus> => {
    await ensureMigrated();
    status ??= baselineStatus();
    return { ...status };
  };

  let started: Promise<void> | null = null;
  const start = (): Promise<void> =>
    (started ??= (async () => {
      await ensureMigrated();
      // Ajustes u otra evaluación ya fijaron el estado: nada que anunciar.
      if (status !== null) return;
      status = baselineStatus();
      // En E2E se usa siempre el simulado: no hay CLI que vigilar.
      if (status.state === 'ok' || deps.useSimulated) return;
      deps.broadcast?.(IPC_CHANNELS.ai.newsStatusChanged, status);
      notifyFailure(status.state, status.engine === 'local' ? 'suscripcion-claude' : status.engine);
      logger.warn('[news-ai] arranque: la suscripción no encuentra la CLI del motor elegido');
    })());

  return {
    listAnalyses: (query) => deps.repo.list(query ?? {}),
    getNewsStatus,
    getLlmSettings,
    setLlmSettings,
    testLlm,
    enqueueItem,
    pendingCount: () => pending.size,
    drain: async () => {
      while (running) await running;
    },
    start,
  };
}
