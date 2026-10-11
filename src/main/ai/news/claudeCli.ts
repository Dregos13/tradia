/**
 * Adaptador de la CLI de Claude Code para el análisis de titulares —
 * la suscripción del usuario, sin coste de API (continuación de la
 * fase 6-7).
 *
 * Ejecuta el binario `claude` con `spawn` SIN shell, en modo una sola
 * pasada (`-p`, `--output-format json`) y sin herramientas
 * (`--allowedTools ''` más un MCP estricto vacío): el titular viaja por
 * stdin cercado como dato no fiable con el MISMO prompt que la API
 * (`SYSTEM_PROMPT` + `buildUserContent` de `anthropic.ts`), así una
 * instrucción inyectada nunca cambia los argumentos del proceso ni
 * habilita herramientas. La respuesta se valida con el mismo esquema
 * (`parseNewsAnalysisOutput`) y cualquier fallo la anota el servicio
 * para caer al analizador léxico local.
 *
 * Garantías:
 * - Localización: `cliPath` de Ajustes, `claude` en PATH y rutas
 *   típicas (nvm, Homebrew, instalación nativa, npm global en Windows).
 * - Concurrencia 1: las llamadas se encolan en serie (la suscripción y
 *   la sesión de la CLI no admiten ráfagas).
 * - Timeout con kill: la CLI no puede bloquear la cola de análisis.
 * - Entorno mínimo: solo las variables que la CLI necesita para
 *   encontrar su sesión y ejecutarse; jamás se reenvían
 *   `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` ni otras claves, así la
 *   llamada siempre corre por la sesión de la suscripción y nunca se
 *   factura una API por accidente.
 * - Tope diario en TITULARES (`usage.usedToday`, compartido con la
 *   API): solo un análisis correcto lo descuenta.
 * - `ping()` (`ai:test-llm`): distingue «CLI no encontrada», «sesión no
 *   iniciada» y éxito, sin consumir el tope.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants as fsConstants, readdirSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import {
  buildUserContent,
  parseNewsAnalysisOutput,
  SYSTEM_PROMPT,
} from './anthropic';
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
export const CLAUDE_CLI_TIMEOUT_MS = 120_000;
/** Tope de salida capturada por stream (la respuesta JSON es pequeña). */
export const CLAUDE_CLI_STDOUT_MAX_BYTES = 1_048_576;
/** Etiqueta persistida como `modelo` en news_analysis. */
export const CLAUDE_CLI_MODEL_LABEL = 'claude-code-cli';

/**
 * Argumentos fijos de cada ejecución: una sola pasada en JSON y sin
 * herramientas ni MCP. NUNCA llevan datos del titular: eso viaja por
 * stdin, así una inyección no puede alterar la línea de comandos.
 */
export const CLAUDE_CLI_ARGS = [
  '-p',
  '--output-format',
  'json',
  '--allowedTools',
  '',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}',
] as const;

/** Textos que delatan una sesión de la CLI sin iniciar. */
const AUTH_PATTERN =
  /not logged in|logged out|\/login|log in|unauthorized|unauthenticated|authentication|oauth|sesion no iniciada|inicia sesion/i;

/**
 * Variables que la CLI sí necesita: sesión (HOME/USERPROFILE y el de
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

// ---------------------------------------------------------------------------
// Localización de la CLI
// ---------------------------------------------------------------------------

/** Cómo se encontró `claude` (para diagnóstico y registros). */
export type ClaudeCliSource = 'config' | 'path' | 'known';

export interface ClaudeCliResolution {
  /** Ruta absoluta del ejecutable; null si no hay ninguna localizable. */
  path: string | null;
  source: ClaudeCliSource | null;
  /** true si Ajustes guardó una ruta que no es un fichero ejecutable. */
  configuredInvalid: boolean;
}

export interface ClaudeCliResolveDeps {
  /** Ruta de Ajustes (`newsLlm.cliPath`); null/vacío = autodetección. */
  configured?: string | null;
  /** Entorno base (por defecto `process.env`). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** ¿Es un fichero ejecutable? (por defecto fs real). */
  isExecutableFile?: (path: string) => boolean;
  /** Lista un directorio o [] (por defecto fs real). */
  listDir?: (path: string) => string[];
}

const defaultIsExecutableFile = (platform: NodeJS.Platform) => (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, fsConstants.X_OK);
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

/** Nombres del ejecutable según plataforma (Windows añade .cmd/.exe). */
const cliFileNames = (platform: NodeJS.Platform): readonly string[] =>
  platform === 'win32' ? ['claude.cmd', 'claude.exe', 'claude.bat', 'claude'] : ['claude'];

/** Ubicaciones habituales de `claude` fuera del PATH (Electron hereda un PATH corto). */
function knownCliCandidates(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  listDir: (path: string) => string[],
): string[] {
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const candidates: string[] = [];
  if (platform === 'win32') {
    const appData = env.APPDATA ?? env.LOCALAPPDATA;
    if (appData) {
      for (const name of cliFileNames(platform)) candidates.push(join(appData, 'npm', name));
    }
    return candidates;
  }
  // Homebrew: Apple Silicon e Intel.
  candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude');
  if (home) {
    // Instalación nativa (`claude install`) y npm con prefijo de usuario.
    candidates.push(
      join(home, '.local/bin/claude'),
      join(home, '.claude/local/claude'),
      join(home, '.npm-global/bin/claude'),
    );
    // nvm: una instalación por versión de Node; la más reciente primero.
    const nvmDir = join(home, '.nvm/versions/node');
    for (const version of listDir(nvmDir).sort().reverse()) {
      candidates.push(join(nvmDir, version, 'bin/claude'));
    }
  }
  return candidates;
}

/**
 * Resuelve qué `claude` ejecutar: la ruta configurada (si es un fichero
 * ejecutable), la del PATH o las ubicaciones habituales. Una ruta
 * configurada inválida NO cae a la autodetección —el usuario pidió esa—
 * y queda marcada (`configuredInvalid`) para que la prueba lo explique.
 */
export function resolveClaudeCli(deps: ClaudeCliResolveDeps = {}): ClaudeCliResolution {
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
    for (const name of cliFileNames(platform)) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate)) {
        return { path: candidate, source: 'path', configuredInvalid: false };
      }
    }
  }
  for (const candidate of knownCliCandidates(env, platform, listDir)) {
    if (isExecutableFile(candidate)) {
      return { path: candidate, source: 'known', configuredInvalid: false };
    }
  }
  return { path: null, source: null, configuredInvalid: false };
}

// ---------------------------------------------------------------------------
// Ejecución controlada de la CLI
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

interface CliRunResult {
  stdout: string;
  stderr: string;
  /** Código de salida; null si la mató una señal (p. ej. el timeout). */
  code: number | null;
}

export interface ClaudeCliAnalyzerDeps {
  /** spawn inyectable; por defecto el de `node:child_process`. */
  spawnFn?: typeof spawn;
  /** Ruta configurada en Ajustes; null = autodetección en cada llamada. */
  cliPath?: () => string | null;
  /** Entorno base del proceso principal (por defecto `process.env`). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  isExecutableFile?: (path: string) => boolean;
  listDir?: (path: string) => string[];
  /** Contadores del tope diario (compartidos con la API). */
  usage: NewsLlmUsageStore;
  /** Tope diario en titulares (lector perezoso de ajustes). */
  dailyCap: () => number;
  now?: () => number;
  timeoutMs?: number;
}

export interface ClaudeCliAnalyzer extends NewsHeadlineAnalyzer {
  /** true si hay un `claude` localizable (configurado, PATH o conocido). */
  available(): boolean;
  /**
   * Prueba la CLI con un mensaje mínimo (no descuenta el tope diario).
   * Falla con 'CLI no encontrada', 'sesión no iniciada' o el motivo.
   */
  ping(): Promise<number>;
}

export function createClaudeCliAnalyzer(deps: ClaudeCliAnalyzerDeps): ClaudeCliAnalyzer {
  const spawnFn = deps.spawnFn ?? spawn;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? CLAUDE_CLI_TIMEOUT_MS;
  const isExecutableFile = deps.isExecutableFile ?? defaultIsExecutableFile(platform);
  const listDir = deps.listDir ?? defaultListDir;

  const isoDay = (): string => new Date(now()).toISOString().slice(0, 10);
  const isoMonth = (): string => isoDay().slice(0, 7);

  const resolve = (): ClaudeCliResolution =>
    resolveClaudeCli({
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
   * Una ejecución de `claude` con prompt por stdin. Rechaza con
   * NewsLlmError clasificado; nunca deja el proceso colgado.
   */
  const runOnce = (cliPath: string, prompt: string): Promise<CliRunResult> =>
    new Promise<CliRunResult>((resolvePromise, reject) => {
      let child: ChildProcess;
      try {
        child = spawnFn(cliPath, [...CLAUDE_CLI_ARGS], {
          env: childEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
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
        finish(() =>
          reject(
            new NewsLlmError('timeout', `la CLI no respondió en ${timeoutMs} ms`),
          ),
        );
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
        if (stdout.length > CLAUDE_CLI_STDOUT_MAX_BYTES) {
          kill();
          finish(() =>
            reject(new NewsLlmError('bad-data', 'la salida de la CLI supera el tope')),
          );
        }
      });
      child.stderr?.on('data', (chunk: Buffer | string) => {
        stderr += chunk;
      });
      child.on('close', (code) => {
        finish(() => resolvePromise({ stdout, stderr, code }));
      });
      // Si el proceso muere antes de leer, stdin puede dar EPIPE: es
      // esperable y ya lo cubre el cierre con código de error.
      child.stdin?.on('error', () => undefined);
      try {
        child.stdin?.write(prompt);
        child.stdin?.end();
      } catch {
        // El cierre del proceso resolverá con su código.
      }
    });

  /** Una salida distinta de 0 (o sobre la que no se pudo ejecutar) se clasifica. */
  const classifyRunFailure = (run: CliRunResult): NewsLlmError => {
    const combined = `${run.stderr}\n${run.stdout}`;
    if (AUTH_PATTERN.test(combined)) {
      return new NewsLlmError(
        'auth',
        'sesión no iniciada: ejecuta «claude» en un terminal, completa /login y vuelve a probar',
      );
    }
    const detail = truncateExternal((run.stderr || run.stdout).trim());
    return new NewsLlmError(
      'server',
      `la CLI terminó con código ${run.code ?? 'desconocido'}${detail ? `: ${detail}` : ''}`,
    );
  };

  /**
   * Saca el texto del modelo del sobre JSON de `claude -p
   * --output-format json` ({type:'result', result:'…'}). Si la salida
   * no es un sobre —una CLI vieja podría imprimir el texto a secas— se
   * devuelve tal cual para que el mismo validador de la API decida.
   */
  const extractResultText = (stdout: string): string => {
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
      if (AUTH_PATTERN.test(detail)) {
        throw new NewsLlmError(
          'auth',
          'sesión no iniciada: ejecuta «claude» en un terminal, completa /login y vuelve a probar',
        );
      }
      throw new NewsLlmError('server', `la CLI devolvió un error: ${truncateExternal(detail)}`);
    }
    const subtype = obj['subtype'];
    if (typeof subtype === 'string' && subtype !== 'success') {
      throw new NewsLlmError(
        'server',
        `la CLI terminó con «${truncateExternal(subtype, 60)}»`,
      );
    }
    if (typeof obj['result'] === 'string') return obj['result'];
    return stdout;
  };

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
   * solo descuenta un análisis correcto (misma regla que la API).
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

  const missingCliError = (resolution: ClaudeCliResolution): NewsLlmError =>
    new NewsLlmError(
      'network',
      resolution.configuredInvalid
        ? 'CLI no encontrada: la ruta configurada en Ajustes no existe o no es ejecutable'
        : 'CLI no encontrada: instala Claude Code o revisa el PATH',
    );

  const analyze = (input: NewsAnalysisInput): Promise<NewsAnalysisResult> =>
    enqueue(async () => {
      const usage = checkDailyCap();
      const resolution = resolve();
      if (!resolution.path) throw missingCliError(resolution);
      // El titular solo viaja por stdin, cercado como dato no fiable:
      // los argumentos del proceso son siempre CLAUDE_CLI_ARGS.
      const prompt = `${SYSTEM_PROMPT}\n\n${buildUserContent(input)}`;
      const run = await runOnce(resolution.path, prompt);
      if (run.code !== 0) throw classifyRunFailure(run);
      const text = extractResultText(run.stdout);
      const result = parseNewsAnalysisOutput(text, input.candidateTickers ?? [], null);
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
      // Un sobre de éxito con resultado no vacío prueba que la sesión responde.
      const text = extractResultText(run.stdout);
      if (text.trim().length === 0) {
        throw new NewsLlmError('bad-data', 'la CLI respondió pero no con el formato esperado');
      }
      return Math.max(0, now() - started);
    });

  return {
    analyzer: 'suscripcion',
    model: CLAUDE_CLI_MODEL_LABEL,
    analyze,
    ping,
    available,
  };
}
