/**
 * Motores CLI de IA para el análisis de titulares — misión «Mejoras en
 * Tradia» (el desplegable de Ajustes deja elegir la suscripción que el
 * usuario ya tiene instalada y con sesión iniciada).
 *
 * UN solo adaptador parametrizado por especificación (`CliEngineSpec`)
 * cubre las cuatro CLI soportadas —Claude Code (`claude`), OpenAI Codex
 * (`codex`), Google Antigravity (`agy`) y GitHub Copilot (`copilot`)—,
 * así cada motor hereda las mismas garantías de seguridad:
 *
 * - `spawn` SIN shell y argumentos fijos por motor: el titular viaja por
 *   stdin cercado como dato no fiable (en `agy`, dentro de un mensaje
 *   NDJSON `user`), nunca en la línea de comandos, así una instrucción
 *   inyectada no puede alterar los flags ni habilitar herramientas. Cada
 *   spec desactiva las suyas: `--tools '' --setting-sources ''
 *   --strict-mcp-config` en Claude Code, `--sandbox read-only
 *   --ignore-user-config --ignore-rules` en Codex, `--sandbox` en
 *   Antigravity (los permisos que piden revisión quedan denegados en
 *   headless) y ningún `--allow-tool` en Copilot.
 * - Localización por motor: la ruta personalizada de Ajustes
 *   (`newsLlm.cliPath.<motor>`, con la heredada `newsLlm.cliPath`
 *   alimentando a Claude Code), el ejecutable en PATH y las ubicaciones
 *   habituales (nvm, Homebrew, `~/.local/bin`, npm global, instalación
 *   nativa). Una ruta configurada inválida NO cae a la autodetección.
 *   En Windows se prefiere el `.exe` nativo; un shim `.cmd`/`.bat` de
 *   npm se ejecuta vía el `cli.js` del paquete con ELECTRON_RUN_AS_NODE
 *   o, en último caso, por la shell —los argumentos son siempre los
 *   fijos de la spec— (Node ≥ 18.20.2 / 20.12.2 lanza EINVAL sin shell).
 * - Salidas acotadas: stdout y stderr comparten el tope de 1 MiB; la
 *   CLI que lo supera se mata (SIGKILL) sin esperar al timeout.
 * - cwd neutro: el proceso corre en el temporal del sistema, no en el
 *   directorio de la app ni en el proyecto del usuario.
 * - Concurrencia 1 por motor: las llamadas se encolan en serie.
 * - Timeout con kill: la CLI no puede bloquear la cola de análisis.
 * - Entorno mínimo: solo las variables que la CLI necesita para
 *   encontrar su sesión y ejecutarse; jamás se reenvían
 *   `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GITHUB_TOKEN` ni otras
 *   claves, así la llamada siempre corre por la sesión de la
 *   suscripción y nunca se factura una API por accidente.
 * - Tope diario en TITULARES (`usage.usedToday`, compartido entre
 *   motores): solo un análisis correcto lo descuenta.
 * - `ping()` (`ai:test-llm`): distingue «CLI no encontrada», «sesión no
 *   iniciada» y éxito con latencia, sin consumir el tope.
 * - La respuesta siempre se valida con `parseNewsAnalysisOutput`: el
 *   éxito lo decide el esquema de salida, no lo que la CLI autoinforme.
 *
 * Los flags de cada spec están verificados contra la documentación del
 * fabricante (Claude Code `-p --output-format json`; Codex `exec --json`
 * con el prompt por stdin vía `-`; Antigravity `--input-format
 * stream-json --output-format stream-json`; Copilot `-s` con el prompt
 * por stdin).
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import type { NewsCliEngine } from '../../../shared/ipc';
import { buildUserContent, parseNewsAnalysisOutput, SYSTEM_PROMPT } from './prompt';
import {
  NewsLlmError,
  truncateExternal,
  type NewsAnalysisInput,
  type NewsAnalysisResult,
  type NewsHeadlineAnalyzer,
  type NewsLlmUsage,
  type NewsLlmUsageStore,
} from './types';

/** Timeout por llamada a la CLI (una pasada con la suscripción puede tardar). */
export const CLI_ENGINE_TIMEOUT_MS = 120_000;
/** Tope de salida capturada por stream (la respuesta JSON es pequeña). */
export const CLI_ENGINE_STDOUT_MAX_BYTES = 1_048_576;
/** Mismo tope para stderr: un flood por error no bloquea la cola. */
export const CLI_ENGINE_STDERR_MAX_BYTES = 1_048_576;

/**
 * Textos que delatan una sesión sin iniciar en cualquier CLI. Los
 * patrones específicos de cada motor van en `spec.authPatterns`.
 */
const BASE_AUTH_PATTERN =
  /not logged in|logged out|\/login|log in|unauthorized|unauthenticated|authentication|oauth|sesion no iniciada|inicia sesion/i;

/**
 * Variables que las CLI sí necesitan: sesión (HOME/USERPROFILE y los de
 * Windows), resolución de programas (PATH/PATHEXT), codificación y
 * temporales. Todo lo demás —claves de API incluidas— no sale del
 * proceso principal.
 */
const CHILD_ENV_ALLOWLIST = [
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'PATH',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TMPDIR',
  'TMP',
  'TEMP',
  'TERM',
  'SHELL',
  'SYSTEMROOT',
  'WINDIR',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
] as const;

type JsonObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Especificación de un motor CLI
// ---------------------------------------------------------------------------

/** Cómo se encontró el ejecutable (para diagnóstico y registros). */
export type CliEngineSource = 'config' | 'path' | 'known';

export interface CliEngineResolution {
  /** Ruta del ejecutable localizado; null si no hay ninguno utilizable. */
  path: string | null;
  source: CliEngineSource | null;
  /** true si la ruta de Ajustes existe pero no es un fichero ejecutable. */
  configuredInvalid: boolean;
}

/** Especificación de un motor CLI: todo lo que lo distingue de los demás. */
export interface CliEngineSpec {
  /** Identificador persistido en ajustes ('suscripcion-claude'…). */
  id: NewsCliEngine;
  /** Nombre visible del motor ('Claude Code', 'OpenAI Codex'…). */
  label: string;
  /** Nombre corto para «Suscripción de X recuperada» y afines. */
  shortName: string;
  /** Nombre base del ejecutable ('claude', 'codex', 'agy', 'copilot'). */
  cliName: string;
  /** Etiqueta persistida como `modelo` en news_analysis. */
  modelLabel: string;
  /** Texto de instalación para «CLI no encontrada» ('instala Claude Code'). */
  installHint: string;
  /** Paso de inicio de sesión para «sesión no iniciada». */
  loginHint: string;
  /** Timeout por llamada; por defecto CLI_ENGINE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Nombres del ejecutable por plataforma (Windows añade .exe/.cmd/.bat). */
  fileNames: (platform: NodeJS.Platform) => readonly string[];
  /**
   * Ubicaciones habituales del ejecutable fuera del PATH (Electron
   * hereda un PATH corto). Recibe el entorno, la plataforma y un
   * `listDir` inyectable para las rutas por versión (nvm).
   */
  knownCandidates: (
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform,
    listDir: (path: string) => string[],
  ) => string[];
  /**
   * Argumentos fijos de cada ejecución (modo headless de una pasada y
   * sin herramientas). NUNCA llevan datos del titular: eso viaja por
   * stdin, así una inyección no puede alterar la línea de comandos.
   */
  args: readonly string[];
  /**
   * Contenido que se escribe en stdin con el prompt ya construido; por
   * defecto el texto tal cual. Antigravity lo envuelve en un mensaje
   * NDJSON `user` (su modo stream-json).
   */
  stdinPayload?: (prompt: string) => string;
  /**
   * Saca el texto del modelo de la salida capturada (sobre JSON de
   * claude, eventos JSONL de codex, resultado stream-json de agy o texto
   * plano de copilot). Devolver stdout tal cual delega la validación al
   * esquema (`parseNewsAnalysisOutput`). `isAuth` clasifica un detalle
   * como «sesión no iniciada». Puede lanzar NewsLlmError.
   */
  extractText: (stdout: string, isAuth: (text: string) => boolean) => string;
  /** Patrones extra de «sesión no iniciada» propios de la CLI. */
  authPatterns?: readonly RegExp[];
  /**
   * En Windows, candidatos de `cli.js` del paquete npm junto al shim
   * `.cmd`/`.bat` (rutas relativas a su directorio): lanzarlos con el
   * runtime del proceso (ELECTRON_RUN_AS_NODE) evita la shell.
   */
  windowsCliJs?: readonly string[];
}

// ---------------------------------------------------------------------------
// Localización del ejecutable
// ---------------------------------------------------------------------------

const defaultIsExecutableFile =
  (platform: NodeJS.Platform) =>
  (path: string): boolean => {
    try {
      if (!statSync(path).isFile()) return false;
      // En Windows no hay bit de ejecución: basta con que el fichero exista.
      if (platform === 'win32') return true;
      accessSync(path, fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

const defaultListDir = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

/** Nombres del ejecutable según plataforma (Windows añade .exe/.cmd/.bat). */
const cliFileNames =
  (name: string) =>
  (platform: NodeJS.Platform): readonly string[] =>
    // En Windows primero el binario nativo: el .cmd de npm no se puede
    // lanzar sin shell (Node ≥ 18.20.2/20.12.2 lanza EINVAL).
    platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];

/** Una instalación por versión de Node en nvm; la más reciente primero. */
const nvmCandidates = (
  home: string,
  name: string,
  listDir: (path: string) => string[],
): string[] => {
  const nvmDir = join(home, '.nvm/versions/node');
  return listDir(nvmDir)
    .sort()
    .reverse()
    .map((version) => join(nvmDir, version, 'bin', name));
};

/**
 * Ubicaciones habituales fuera del PATH, iguales para todas las CLI
 * instaladas por npm/Homebrew, más los extras propios de cada motor
 * (p. ej. `~/.claude/local/claude`), que se calculan con el HOME de la
 * llamada.
 */
const standardKnownCandidates =
  (name: string, extras: (home: string) => string[] = () => []): CliEngineSpec['knownCandidates'] =>
  (env, platform, listDir) => {
    const names = cliFileNames(name)(platform);
    const home = env.HOME ?? env.USERPROFILE ?? '';
    if (platform === 'win32') {
      const candidates: string[] = [];
      if (home) {
        // Instalación nativa: un .exe real, sin shim de npm.
        candidates.push(join(home, '.local', 'bin', `${name}.exe`));
      }
      const appData = env.APPDATA ?? env.LOCALAPPDATA;
      if (appData) {
        for (const fileName of names) candidates.push(join(appData, 'npm', fileName));
      }
      return candidates;
    }
    const candidates: string[] = [];
    // Homebrew: Apple Silicon e Intel.
    candidates.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`);
    if (home) {
      candidates.push(join(home, '.local/bin', name));
      candidates.push(...extras(home));
      candidates.push(join(home, '.npm-global/bin', name));
      candidates.push(...nvmCandidates(home, name, listDir));
    }
    return candidates;
  };

export interface CliEngineResolveDeps {
  /** Ruta configurada en Ajustes para este motor; null/undefined = autodetección. */
  configured?: string | null;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isExecutableFile?: (path: string) => boolean;
  listDir?: (path: string) => string[];
}

/**
 * Resuelve qué ejecutable lanzar para un motor: la ruta configurada (si
 * es un fichero ejecutable), la del PATH o las ubicaciones habituales.
 * Una ruta configurada inválida NO cae a la autodetección —el usuario
 * pidió esa— y queda marcada (`configuredInvalid`) para que la prueba lo
 * explique.
 */
export function resolveCliExecutable(
  spec: CliEngineSpec,
  deps: CliEngineResolveDeps = {},
): CliEngineResolution {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const isExecutableFile = deps.isExecutableFile ?? defaultIsExecutableFile(platform);
  const listDir = deps.listDir ?? defaultListDir;

  const configured = deps.configured?.trim();
  if (configured) {
    return isExecutableFile(configured)
      ? { path: configured, source: 'config', configuredInvalid: false }
      : { path: null, source: null, configuredInvalid: true };
  }

  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of spec.fileNames(platform)) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) {
        return { path: candidate, source: 'path', configuredInvalid: false };
      }
    }
  }
  for (const candidate of spec.knownCandidates(env, platform, listDir)) {
    if (isExecutableFile(candidate)) {
      return { path: candidate, source: 'known', configuredInvalid: false };
    }
  }
  return { path: null, source: null, configuredInvalid: false };
}

// ---------------------------------------------------------------------------
// Extracción de la respuesta por motor
// ---------------------------------------------------------------------------

/**
 * Sobre JSON de `claude -p --output-format json` ({type:'result',
 * result:'…'}). Si la salida no es un sobre —una CLI vieja podría
 * imprimir el texto a secas— se devuelve tal cual para que el mismo
 * validador decida.
 */
const extractClaudeText = (stdout: string, auth: (detail: string) => boolean): string => {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  const obj = envelope as JsonObject;
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return stdout;
  if (obj['is_error'] === true) {
    const detail =
      typeof obj['result'] === 'string'
        ? obj['result']
        : JSON.stringify(obj['errors'] ?? obj['subtype'] ?? '');
    if (auth(detail)) {
      throw new NewsLlmError('auth', 'sesión no iniciada');
    }
    throw new NewsLlmError('server', `la CLI devolvió un error: ${truncateExternal(detail)}`);
  }
  const subtype = obj['subtype'];
  if (typeof subtype === 'string' && subtype !== 'success') {
    throw new NewsLlmError('server', `la CLI terminó con «${truncateExternal(subtype, 60)}»`);
  }
  if (typeof obj['result'] === 'string') return obj['result'];
  return stdout;
};

/**
 * Eventos JSONL de `codex exec --json`: el texto del modelo llega en los
 * `item.completed` con `item.type === 'agent_message'`. Un evento
 * `error`/`turn.failed` (o un resultado marcado como error) aborta. Sin
 * eventos reconocibles se devuelve stdout y el esquema decide.
 */
const extractCodexText = (stdout: string, auth: (detail: string) => boolean): string => {
  const messages: string[] = [];
  let failure: string | null = null;
  let sawJsonl = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const obj = event as JsonObject;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue;
    sawJsonl = true;
    const type = obj['type'];
    if (type === 'error' || type === 'turn.failed') {
      const detail =
        typeof obj['message'] === 'string'
          ? obj['message']
          : JSON.stringify(obj['error'] ?? obj['msg'] ?? type);
      failure = detail;
      continue;
    }
    const item = obj['item'] as JsonObject | undefined;
    if (
      type === 'item.completed' &&
      item &&
      typeof item === 'object' &&
      item['type'] === 'agent_message' &&
      typeof item['text'] === 'string'
    ) {
      messages.push(item['text']);
    }
    // Variante: respuesta final directa ({type:'result', response:'…'}).
    if (type === 'result' && typeof obj['response'] === 'string') {
      messages.push(obj['response']);
    }
  }
  if (failure !== null) {
    if (auth(failure)) throw new NewsLlmError('auth', 'sesión no iniciada');
    throw new NewsLlmError('server', `la CLI devolvió un error: ${truncateExternal(failure)}`);
  }
  if (messages.length > 0) return messages[messages.length - 1]!;
  return sawJsonl ? '' : stdout;
};

/**
 * Evento `result` de `agy --output-format stream-json` (una línea NDJSON
 * por evento; el último es {event:'result', result:{status, response}}).
 * Un `status` distinto de 'SUCCESS' aborta con su `error`. Sin evento
 * result —una versión vieja podría imprimir texto plano— se devuelve
 * stdout.
 */
const extractAntigravityText = (stdout: string, auth: (detail: string) => boolean): string => {
  let result: JsonObject | null = null;
  let sawJsonl = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const obj = event as JsonObject;
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) continue;
    sawJsonl = true;
    if (obj['event'] === 'result' && typeof obj['result'] === 'object' && obj['result'] !== null) {
      result = obj['result'] as JsonObject;
    }
  }
  if (!result) return sawJsonl ? '' : stdout;
  const status = typeof result['status'] === 'string' ? result['status'] : '';
  if (status === 'SUCCESS' && typeof result['response'] === 'string') {
    return result['response'];
  }
  const detail =
    typeof result['error'] === 'string'
      ? result['error']
      : typeof result['response'] === 'string' && result['response']
        ? result['response']
        : status || 'ERROR';
  if (auth(detail)) throw new NewsLlmError('auth', 'sesión no iniciada');
  throw new NewsLlmError('server', `la CLI devolvió un error: ${truncateExternal(detail)}`);
};

/** Copilot con `-s` imprime solo la respuesta del agente en stdout. */
const extractPlainText = (stdout: string): string => stdout;

// ---------------------------------------------------------------------------
// Las cuatro especificaciones
// ---------------------------------------------------------------------------

export const CLI_ENGINE_SPECS: Record<NewsCliEngine, CliEngineSpec> = {
  'suscripcion-claude': {
    id: 'suscripcion-claude',
    label: 'Claude Code',
    shortName: 'Claude',
    cliName: 'claude',
    modelLabel: 'claude-code-cli',
    installHint: 'instala Claude Code o revisa el PATH',
    loginHint: 'ejecuta claude y después /login',
    fileNames: cliFileNames('claude'),
    // Instalación nativa (`claude install`) además de las estándar.
    knownCandidates: standardKnownCandidates('claude', (home) => [
      join(home, '.claude/local/claude'),
    ]),
    args: [
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--allowedTools',
      '',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
    ],
    extractText: extractClaudeText,
    windowsCliJs: [join('node_modules', '@anthropic-ai', 'claude-code', 'cli.js')],
  },
  'suscripcion-codex': {
    id: 'suscripcion-codex',
    label: 'OpenAI Codex',
    shortName: 'Codex',
    cliName: 'codex',
    modelLabel: 'codex-cli',
    installHint: 'instala Codex CLI o revisa el PATH',
    loginHint: 'ejecuta «codex login» en un terminal',
    fileNames: cliFileNames('codex'),
    knownCandidates: standardKnownCandidates('codex'),
    // `codex exec`: una pasada no interactiva en sandbox de solo lectura,
    // sin repo git (cwd neutro), sin config del usuario ni reglas de
    // proyecto, sin persistir sesión y con eventos JSONL en stdout; `-`
    // lee el prompt por stdin.
    args: [
      'exec',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '--ephemeral',
      '--color',
      'never',
      '--json',
      '-',
    ],
    extractText: extractCodexText,
    authPatterns: [/\blogin\b/i, /sign.?in/i, /not authenticated/i],
    windowsCliJs: [
      join('node_modules', '@openai', 'codex', 'bin', 'codex.js'),
      join('node_modules', '@openai', 'codex', 'cli.js'),
    ],
  },
  'suscripcion-antigravity': {
    id: 'suscripcion-antigravity',
    label: 'Google Antigravity',
    shortName: 'Antigravity',
    cliName: 'agy',
    modelLabel: 'antigravity-cli',
    installHint: 'instala Antigravity CLI o revisa el PATH',
    loginHint: 'abre «agy» en un terminal e inicia sesión',
    fileNames: cliFileNames('agy'),
    knownCandidates: standardKnownCandidates('agy'),
    // Una pasada con el prompt como mensaje `user` NDJSON por stdin y el
    // resultado como evento `result` por stdout; `--sandbox` restringe
    // las herramientas de terminal (en headless las que piden revisión
    // quedan denegadas por política; los slash commands del stream se
    // rechazan solos con un result ERROR).
    args: ['--input-format', 'stream-json', '--output-format', 'stream-json', '--sandbox'],
    stdinPayload: (prompt) =>
      `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
    extractText: extractAntigravityText,
    authPatterns: [/authentication required/i, /\blogin\b/i, /sign.?in/i],
  },
  'suscripcion-copilot': {
    id: 'suscripcion-copilot',
    label: 'GitHub Copilot',
    shortName: 'Copilot',
    cliName: 'copilot',
    modelLabel: 'copilot-cli',
    installHint: 'instala Copilot CLI o revisa el PATH',
    loginHint: 'ejecuta «copilot» en un terminal e inicia sesión',
    fileNames: cliFileNames('copilot'),
    knownCandidates: standardKnownCandidates('copilot'),
    // El prompt entra por stdin (modo programático sin `-p`): `-s` deja
    // solo la respuesta del agente en stdout y `--no-ask-user` evita que
    // una petición de permiso de herramienta bloquee la llamada.
    args: ['-s', '--no-ask-user'],
    extractText: extractPlainText,
    authPatterns: [/\blogin\b/i, /sign.?in/i, /not authenticated/i],
    windowsCliJs: [
      join('node_modules', '@github', 'copilot', 'cli.js'),
      join('node_modules', '@github', 'copilot', 'dist', 'index.js'),
    ],
  },
};

// ---------------------------------------------------------------------------
// Ejecución controlada de la CLI
// ---------------------------------------------------------------------------

interface CliRunResult {
  stdout: string;
  stderr: string;
  /** Código de salida; null si la mató una señal (p. ej. el timeout). */
  code: number | null;
}

export interface CliEngineDeps {
  /** spawn inyectable; por defecto el de `node:child_process`. */
  spawnFn?: typeof spawn;
  /** Ruta configurada en Ajustes; null = autodetección en cada llamada. */
  cliPath?: () => string | null;
  /** Entorno base del proceso principal (por defecto `process.env`). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isExecutableFile?: (path: string) => boolean;
  listDir?: (path: string) => string[];
  /** Contadores del tope diario (compartidos entre motores). */
  usage: NewsLlmUsageStore;
  /** Tope diario en titulares (lector perezoso de ajustes). */
  dailyCap: () => number;
  now?: () => number;
  timeoutMs?: number;
  /** Directorio de trabajo neutro del hijo (por defecto el temporal del SO). */
  tmpDir?: () => string;
}

export interface CliEngineAnalyzer extends NewsHeadlineAnalyzer {
  /** true si hay un ejecutable localizable (configurado, PATH o conocido). */
  available(): boolean;
  /**
   * Prueba la CLI con un mensaje mínimo (no descuenta el tope diario).
   * Falla con 'CLI no encontrada', 'sesión no iniciada' o el motivo.
   */
  ping(): Promise<number>;
}

export function createCliEngineAnalyzer(
  spec: CliEngineSpec,
  deps: CliEngineDeps,
): CliEngineAnalyzer {
  const spawnFn = deps.spawnFn ?? spawn;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? spec.timeoutMs ?? CLI_ENGINE_TIMEOUT_MS;
  const isExecutableFile = deps.isExecutableFile ?? defaultIsExecutableFile(platform);
  const listDir = deps.listDir ?? defaultListDir;
  const authPatterns = [BASE_AUTH_PATTERN, ...(spec.authPatterns ?? [])];
  const isAuthText = (text: string): boolean => authPatterns.some((p) => p.test(text));

  const isoDay = (): string => new Date(now()).toISOString().slice(0, 10);
  const isoMonth = (): string => isoDay().slice(0, 7);

  const resolve = (): CliEngineResolution =>
    resolveCliExecutable(spec, {
      configured: deps.cliPath?.() ?? null,
      env,
      platform,
      isExecutableFile,
      listDir,
    });

  const available = (): boolean => resolve().path !== null;

  const childEnv = (): NodeJS.ProcessEnv => {
    const child: NodeJS.ProcessEnv = {};
    for (const key of CHILD_ENV_ALLOWLIST) {
      const value = env[key];
      if (typeof value === 'string' && value.length > 0) child[key] = value;
    }
    return child;
  };

  /**
   * Plan de ejecución para `cliPath`. En Windows un shim `.cmd`/`.bat`
   * no se puede lanzar directo (Node ≥ 18.20.2/20.12.2 lanza EINVAL sin
   * shell): si el shim es el de npm, se ejecuta el `cli.js` del paquete
   * con el runtime del proceso (ELECTRON_RUN_AS_NODE convierte el
   * binario Electron en Node); si no, última vía `shell: true` —los
   * argumentos son siempre los fijos de la spec—. En el resto de
   * plataformas el ejecutable va directo.
   */
  const spawnPlan = (
    cliPath: string,
  ): { command: string; args: string[]; options: SpawnOptions } => {
    const base: SpawnOptions = {
      env: childEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // cwd neutro: ni el directorio de la app ni el del usuario, así la
      // CLI no descubre ajustes de proyecto por ubicación.
      cwd: deps.tmpDir?.() ?? tmpdir(),
    };
    if (platform === 'win32' && /\.(?:cmd|bat)$/i.test(cliPath)) {
      const cliDir = dirname(cliPath);
      for (const rel of spec.windowsCliJs ?? []) {
        const cliJs = join(cliDir, rel);
        if (isExecutableFile(cliJs)) {
          return {
            command: process.execPath,
            args: [cliJs, ...spec.args],
            options: {
              ...base,
              env: { ...childEnv(), ELECTRON_RUN_AS_NODE: '1' },
            },
          };
        }
      }
      return { command: cliPath, args: [...spec.args], options: { ...base, shell: true } };
    }
    return { command: cliPath, args: [...spec.args], options: base };
  };

  /**
   * Una ejecución de la CLI con el prompt por stdin (o dentro del
   * mensaje NDJSON que la spec indique). Rechaza con NewsLlmError
   * clasificado; nunca deja el proceso colgado.
   */
  const runOnce = (cliPath: string, prompt: string): Promise<CliRunResult> =>
    new Promise<CliRunResult>((resolvePromise, reject) => {
      let child: ChildProcess;
      try {
        const plan = spawnPlan(cliPath);
        child = spawnFn(plan.command, plan.args, plan.options);
      } catch (error) {
        reject(
          new NewsLlmError(
            'network',
            `no se pudo ejecutar la CLI: ${truncateExternal((error as Error)?.message ?? String(error))}`,
          ),
        );
        return;
      }

      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const kill = (): void => {
        try {
          child.kill('SIGKILL');
        } catch {
          // El proceso ya había muerto: nada que hacer.
        }
      };
      const timer = setTimeout(() => {
        kill();
        finish(() => reject(new NewsLlmError('timeout', `la CLI no respondió en ${timeoutMs} ms`)));
      }, timeoutMs);

      child.on('error', (error) => {
        finish(() =>
          reject(
            new NewsLlmError(
              'network',
              `no se pudo ejecutar la CLI: ${truncateExternal(error.message)}`,
            ),
          ),
        );
      });
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout += chunk;
        if (stdout.length > CLI_ENGINE_STDOUT_MAX_BYTES) {
          kill();
          finish(() => reject(new NewsLlmError('bad-data', 'la salida de la CLI supera el tope')));
        }
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk;
        if (stderr.length > CLI_ENGINE_STDERR_MAX_BYTES) {
          kill();
          finish(() =>
            reject(new NewsLlmError('bad-data', 'la salida de error de la CLI supera el tope')),
          );
        }
      });
      child.on('close', (code) => {
        finish(() => resolvePromise({ stdout, stderr, code }));
      });
      // Si el proceso muere antes de leer, stdin puede dar EPIPE: es
      // esperable y ya lo cubre el cierre con código de error.
      child.stdin?.on('error', () => undefined);
      try {
        child.stdin?.write(spec.stdinPayload ? spec.stdinPayload(prompt) : prompt);
        child.stdin?.end();
      } catch {
        // El cierre del proceso resolverá con su código.
      }
    });

  /** Una salida distinta de 0 (o sobre la que no se pudo ejecutar) se clasifica. */
  const classifyRunFailure = (run: CliRunResult): NewsLlmError => {
    const combined = `${run.stderr}\n${run.stdout}`;
    if (isAuthText(combined)) {
      return new NewsLlmError('auth', `sesión no iniciada: ${spec.loginHint} y vuelve a probar`);
    }
    // Cuota de la suscripción agotada (límite de uso, créditos…): no es
    // un error genérico, el usuario puede esperar o cambiar de motor.
    if (/rate.?limit|usage limit|too many requests|quota|cuota/i.test(combined)) {
      const detail = truncateExternal((run.stderr || run.stdout).trim());
      return new NewsLlmError(
        'rate-limit',
        `la suscripción alcanzó su límite de uso${detail ? `: ${detail}` : ''}`,
      );
    }
    const detail = truncateExternal((run.stderr || run.stdout).trim());
    return new NewsLlmError(
      'server',
      `la CLI terminó con código ${run.code ?? 'desconocido'}${detail ? `: ${detail}` : ''}`,
    );
  };

  /** Envuelve el texto extraído aplicando la clasificación de autenticación. */
  const extractText = (stdout: string): string => spec.extractText(stdout, isAuthText);

  // -- Cola en serie (concurrencia 1) ----------------------------------------

  let tail: Promise<void> = Promise.resolve();
  const enqueue = <T>(job: () => Promise<T>): Promise<T> => {
    const next = tail.then(job, job);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  /**
   * Tope diario en titulares: se comprueba ANTES de llamar a la CLI y
   * solo descuenta un análisis correcto.
   */
  const checkDailyCap = (): NewsLlmUsage => {
    const usage = deps.usage.load();
    const day = isoDay();
    const month = isoMonth();
    const current: NewsLlmUsage = {
      day,
      usedToday: usage.day === day ? usage.usedToday : 0,
      month,
      spentMonthEur: usage.month === month ? usage.spentMonthEur : 0,
    };
    const cap = deps.dailyCap();
    if (current.usedToday >= cap) {
      throw new NewsLlmError(
        'quota',
        `tope diario alcanzado (${current.usedToday}/${cap} titulares): se usa análisis local`,
      );
    }
    return current;
  };

  const missingCliError = (resolution: CliEngineResolution): NewsLlmError =>
    new NewsLlmError(
      'network',
      resolution.configuredInvalid
        ? 'CLI no encontrada: la ruta configurada en Ajustes no existe o no es ejecutable'
        : `CLI no encontrada: ${spec.installHint}`,
    );

  const analyze = (input: NewsAnalysisInput): Promise<NewsAnalysisResult> =>
    enqueue(async () => {
      const usage = checkDailyCap();
      const resolution = resolve();
      if (!resolution.path) throw missingCliError(resolution);
      // El titular solo viaja por stdin, cercado como dato no fiable:
      // los argumentos del proceso son siempre los de la spec.
      const prompt = `${SYSTEM_PROMPT}\n\n${buildUserContent(input)}`;
      const run = await runOnce(resolution.path, prompt);
      if (run.code !== 0) throw classifyRunFailure(run);
      const text = extractText(run.stdout);
      const result = parseNewsAnalysisOutput(text, input.candidateTickers ?? []);
      // Solo un análisis correcto descuenta el tope diario.
      deps.usage.save({ ...usage, usedToday: usage.usedToday + 1 });
      return result;
    });

  const ping = (): Promise<number> =>
    enqueue(async () => {
      const resolution = resolve();
      if (!resolution.path) throw missingCliError(resolution);
      const started = now();
      const run = await runOnce(resolution.path, 'Responde únicamente con esta palabra: OK');
      if (run.code !== 0) throw classifyRunFailure(run);
      // Una respuesta de éxito con texto no vacío prueba que la sesión responde.
      const text = extractText(run.stdout);
      if (text.trim().length === 0) {
        throw new NewsLlmError('bad-data', 'la CLI respondió pero no con el formato esperado');
      }
      return Math.max(0, now() - started);
    });

  return {
    analyzer: 'suscripcion',
    model: spec.modelLabel,
    analyze,
    ping,
    available,
  };
}

// ---------------------------------------------------------------------------
// Registro de motores para el servicio y el registro IPC
// ---------------------------------------------------------------------------

/** Manillar de un motor para el servicio: analizador + diagnóstico de ruta. */
export interface CliEngineHandle {
  analyzer: CliEngineAnalyzer;
  available(): boolean;
  /** Resolución vigente (ruta y origen) para la autodetección de Ajustes. */
  resolve(): CliEngineResolution;
}

/**
 * Crea el manillar de un motor. La resolución se repite en cada llamada
 * (la ruta puede cambiar en Ajustes); `cliPath` es un lector perezoso de
 * la ruta personalizada de ESE motor.
 */
export function createCliEngineHandle(engine: NewsCliEngine, deps: CliEngineDeps): CliEngineHandle {
  const spec = CLI_ENGINE_SPECS[engine];
  const analyzer = createCliEngineAnalyzer(spec, deps);
  return {
    analyzer,
    available: () => analyzer.available(),
    resolve: () =>
      resolveCliExecutable(spec, {
        configured: deps.cliPath?.() ?? null,
        env: deps.env,
        platform: deps.platform,
        isExecutableFile: deps.isExecutableFile,
        listDir: deps.listDir,
      }),
  };
}
