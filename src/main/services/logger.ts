import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

import { app } from 'electron';

import { LOG_DIR_NAME, LOG_MAX_FILE_BYTES, LOG_MAX_FILES } from '../../shared/journal';

/**
 * Registro del proceso principal en `userData/logs` con rotación por
 * tamaño (fase 4).
 *
 * `createMainLogger` escribe líneas `ISO [NIVEL] mensaje` en
 * `tradia.log`; cuando el archivo supera `LOG_MAX_FILE_BYTES` (5 MB) rota
 * a `tradia.1.log`…`tradia.4.log` y se queda con `LOG_MAX_FILES` (5)
 * archivos en total. `installConsoleCapture` sustituye los `console.*`
 * del proceso principal: cada llamada se escribe en el archivo y sigue
 * llegando a la consola original, así la salida de desarrollo no se
 * pierde.
 *
 * Los secretos se ocultan antes de escribir: parámetros sensibles de
 * consulta (`token=`, `api_key=`, `key=`, `password=`…), pares JSON,
 * cabeceras `Bearer`, tokens de bot de Telegram y cualquier valor exacto
 * aportado por `options.secrets` (p. ej. las claves del almacén de
 * secretos) se sustituyen por `***`.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const REDACTED = '***';

/** Campos cuyo valor se oculta en pares `campo=valor` y `"campo":"valor"`. */
const SENSITIVE_FIELD =
  'api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|secret|client[_-]?secret|' +
  'password|passwd|pwd|authorization|auth[_-]?token|sig|signature|key';

/** `token=abc123` en URLs, query strings y pares sueltos. */
const KV_PATTERN = new RegExp(`\\b(${SENSITIVE_FIELD})=([^\\s&"'\\\\]+)`, 'gi');
/** `"token": "abc"` / `'token': 'abc'` en JSON y objetos inspeccionados. */
const JSON_PATTERN = new RegExp(`(["'])(${SENSITIVE_FIELD})(\\1\\s*:\\s*["'])([^"']*)(["'])`, 'gi');
/** Cabeceras `Authorization: Bearer …` ya formateadas. */
const BEARER_PATTERN = /\bBearer\s+[^\s"',}]+/gi;
/** Token del bot de Telegram dentro de `…/bot<id>:<token>/…`. */
const TELEGRAM_BOT_PATTERN = /\bbot\d{5,}:[A-Za-z0-9_-]{10,}\b/g;

/**
 * Oculta secretos en un texto de registro. `extraSecrets` son valores
 * exactos (claves de API, contraseñas SMTP) que se sustituyen donde
 * aparezcan; se ignoran los de menos de 6 caracteres para no censurar
 * palabras comunes.
 */
export function redactLogText(text: string, extraSecrets: Iterable<string> = []): string {
  let out = text
    .replace(JSON_PATTERN, `$1$2$3${REDACTED}$5`)
    .replace(KV_PATTERN, `$1=${REDACTED}`)
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(TELEGRAM_BOT_PATTERN, 'bot***');
  for (const secret of extraSecrets) {
    if (typeof secret === 'string' && secret.length >= 6) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out;
}

export interface LoggerOptions {
  /** Carpeta de registros; por defecto `userData/logs`. */
  dir?: string;
  /** Base del nombre de archivo; por defecto 'tradia'. */
  baseName?: string;
  /** Tamaño máximo por archivo antes de rotar; por defecto 5 MB. */
  maxFileBytes?: number;
  /** Archivos totales conservados (actual + rotados); por defecto 5. */
  maxFiles?: number;
  /** Reloj inyectable para pruebas. */
  now?: () => Date;
  /** Valores secretos exactos a ocultar, evaluados en cada línea. */
  secrets?: () => Iterable<string>;
}

export interface MainLogger {
  /** Carpeta donde se escriben los registros. */
  readonly dir: string;
  /** Archivo de registro actual (`tradia.log`). */
  readonly filePath: string;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  /**
   * Sustituye `console.debug/log/info/warn/error` por una versión que
   * escribe en el archivo y llama a la consola original (la salida de
   * desarrollo no se pierde). Devuelve una función que la restaura.
   */
  installConsoleCapture(): () => void;
}

/** Carpeta de registros de la app (`userData/logs`). */
export function getLogDir(userDataPath?: string): string {
  return join(userDataPath ?? app.getPath('userData'), LOG_DIR_NAME);
}

export function createMainLogger(options: LoggerOptions = {}): MainLogger {
  const dir = options.dir ?? getLogDir();
  const baseName = options.baseName ?? 'tradia';
  const maxFileBytes = options.maxFileBytes ?? LOG_MAX_FILE_BYTES;
  const maxFiles = Math.max(1, options.maxFiles ?? LOG_MAX_FILES);
  const now = options.now ?? (() => new Date());
  const extraSecrets = options.secrets;

  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${baseName}.log`);
  let currentBytes = existsSync(filePath) ? statSync(filePath).size : 0;
  let restoreConsole: (() => void) | null = null;

  const rotatedPath = (index: number): string => join(dir, `${baseName}.${index}.log`);

  const rotate = (): void => {
    if (maxFiles <= 1) {
      unlinkSync(filePath);
    } else {
      const oldest = rotatedPath(maxFiles - 1);
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = maxFiles - 2; i >= 1; i--) {
        const from = rotatedPath(i);
        if (existsSync(from)) renameSync(from, rotatedPath(i + 1));
      }
      renameSync(filePath, rotatedPath(1));
    }
    currentBytes = 0;
  };

  const write = (level: LogLevel, args: unknown[]): void => {
    let text: string;
    try {
      text = format(...(args as [unknown, ...unknown[]]));
    } catch {
      text = args.map(String).join(' ');
    }
    const line = `${now().toISOString()} [${level}] ${redactLogText(text, extraSecrets?.())}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    try {
      if (currentBytes > 0 && currentBytes + bytes > maxFileBytes) rotate();
      appendFileSync(filePath, line);
      currentBytes += bytes;
    } catch {
      // El registro nunca debe tumbar el proceso principal: si el disco
      // falla, la línea solo sobrevive por la consola original.
    }
  };

  return {
    dir,
    filePath,
    debug: (...args) => write('DEBUG', args),
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
    installConsoleCapture: () => {
      if (restoreConsole) return restoreConsole;
      type Method = 'debug' | 'log' | 'info' | 'warn' | 'error';
      const levels: Record<Method, LogLevel> = {
        debug: 'DEBUG',
        log: 'INFO',
        info: 'INFO',
        warn: 'WARN',
        error: 'ERROR',
      };
      const originals = {} as Record<Method, (...args: unknown[]) => void>;
      for (const method of Object.keys(levels) as Method[]) {
        originals[method] = console[method].bind(console);
        console[method] = (...args: unknown[]): void => {
          write(levels[method], args);
          originals[method](...args);
        };
      }
      restoreConsole = () => {
        for (const method of Object.keys(levels) as Method[]) {
          console[method] = originals[method];
        }
        restoreConsole = null;
      };
      return restoreConsole;
    },
  };
}

/**
 * Crea el registro en `userData/logs`, captura los `console.*` del
 * proceso principal y anota el arranque. Llamar una vez, al inicio de
 * `src/main/index.ts` (tras fijar `userData` en modo E2E).
 */
export function installMainLogger(options: LoggerOptions = {}): MainLogger {
  const logger = createMainLogger(options);
  logger.installConsoleCapture();
  logger.info('[logger] registro en disco iniciado');
  return logger;
}
