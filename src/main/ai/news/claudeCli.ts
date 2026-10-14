/**
 * Adaptador de la CLI de Claude Code para el análisis de titulares —
 * la suscripción del usuario, sin coste de API (continuación de la
 * fase 6-7).
 *
 * Desde la misión «Mejoras en Tradia» Claude Code es UNO de los motores
 * del desplegable de Ajustes: toda la maquinaria vive en `cliEngines.ts`
 * (un adaptador único parametrizado por especificación, compartido con
 * Codex, Antigravity y Copilot). Este módulo conserva la superficie
 * pública de siempre —constantes, tipos, `resolveClaudeCli` y
 * `createClaudeCliAnalyzer`— como fachada sobre la spec
 * 'suscripcion-claude'.
 *
 * Garantías (idénticas para todos los motores):
 * - `spawn` SIN shell con argumentos fijos (una pasada `-p`, JSON, sin
 *   herramientas —`--tools ''` retira TODO el conjunto—, sin ajustes de
 *   usuario ni proyecto y MCP estricto vacío); el titular viaja por
 *   stdin cercado como dato no fiable, así una instrucción inyectada
 *   nunca cambia los argumentos ni habilita herramientas.
 * - Localización: `cliPath` de Ajustes, `claude` en PATH y rutas típicas
 *   (nvm, Homebrew, instalación nativa, npm global en Windows). En
 *   Windows se prefiere el `claude.exe` nativo; un `claude.cmd` de npm
 *   se ejecuta vía el `cli.js` del paquete con el runtime del proceso
 *   (ELECTRON_RUN_AS_NODE) o, en último caso, por la shell.
 * - Salidas acotadas (1 MiB por stream, SIGKILL al superarlo), cwd
 *   neutro en el temporal del sistema, concurrencia 1, timeout con kill
 *   y entorno por lista blanca sin claves: la llamada siempre corre por
 *   la sesión de la suscripción, nunca por una API facturable.
 * - Tope diario en titulares (solo un análisis correcto lo descuenta) y
 *   `ping()` («CLI no encontrada» / «sesión no iniciada» / éxito).
 */
import {
  CLI_ENGINE_SPECS,
  CLI_ENGINE_STDERR_MAX_BYTES,
  CLI_ENGINE_STDOUT_MAX_BYTES,
  CLI_ENGINE_TIMEOUT_MS,
  createCliEngineAnalyzer,
  resolveCliExecutable,
  type CliEngineAnalyzer,
  type CliEngineDeps,
  type CliEngineResolution,
  type CliEngineResolveDeps,
  type CliEngineSource,
} from './cliEngines';

/** Spec de Claude Code dentro del registro unificado de motores. */
const CLAUDE_SPEC = CLI_ENGINE_SPECS['suscripcion-claude'];

/** Timeout por llamada a la CLI (una pasada con la suscripción puede tardar). */
export const CLAUDE_CLI_TIMEOUT_MS = CLI_ENGINE_TIMEOUT_MS;
/** Tope de salida capturada por stream (la respuesta JSON es pequeña). */
export const CLAUDE_CLI_STDOUT_MAX_BYTES = CLI_ENGINE_STDOUT_MAX_BYTES;
/** Mismo tope para stderr: un flood por error no bloquea la cola. */
export const CLAUDE_CLI_STDERR_MAX_BYTES = CLI_ENGINE_STDERR_MAX_BYTES;
/** Etiqueta persistida como `modelo` en news_analysis. */
export const CLAUDE_CLI_MODEL_LABEL = CLAUDE_SPEC.modelLabel;

/**
 * Argumentos fijos de cada ejecución: una sola pasada en JSON y sin
 * herramientas ni MCP. NUNCA llevan datos del titular: eso viaja por
 * stdin, así una inyección no puede alterar la línea de comandos.
 */
export const CLAUDE_CLI_ARGS = CLAUDE_SPEC.args;

// ---------------------------------------------------------------------------
// Localización de la CLI
// ---------------------------------------------------------------------------

/** Cómo se encontró `claude` (para diagnóstico y registros). */
export type ClaudeCliSource = CliEngineSource;
export type ClaudeCliResolution = CliEngineResolution;
export type ClaudeCliResolveDeps = CliEngineResolveDeps;

/**
 * Resuelve qué `claude` ejecutar: la ruta configurada (si es un fichero
 * ejecutable), la del PATH o las ubicaciones habituales. Una ruta
 * configurada inválida NO cae a la autodetección —el usuario pidió esa—
 * y queda marcada (`configuredInvalid`) para que la prueba lo explique.
 */
export function resolveClaudeCli(deps: ClaudeCliResolveDeps = {}): ClaudeCliResolution {
  return resolveCliExecutable(CLAUDE_SPEC, deps);
}

// ---------------------------------------------------------------------------
// Analizador
// ---------------------------------------------------------------------------

export type ClaudeCliAnalyzerDeps = CliEngineDeps;
export type ClaudeCliAnalyzer = CliEngineAnalyzer;

export function createClaudeCliAnalyzer(deps: ClaudeCliAnalyzerDeps): ClaudeCliAnalyzer {
  return createCliEngineAnalyzer(CLAUDE_SPEC, deps);
}
