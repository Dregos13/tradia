import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Inicio automático con el sistema operativo.
 *
 * - macOS y Windows se resuelven con `app.setLoginItemSettings` en
 *   `services/tray.ts` (necesitan `app`, que aquí no se importa para que el
 *   módulo siga siendo puro y testeable).
 * - Linux no tiene API en Electron: se escribe un archivo .desktop en
 *   `$XDG_CONFIG_HOME/autostart` (o `~/.config/autostart`).
 *
 * En los tres sistemas la app arranca oculta en la bandeja: macOS usa
 * `openAsHidden`, Windows y Linux pasan el argumento `--hidden`.
 */

/** Argumento con el que la app arranca solo en la bandeja (sin ventana). */
export const AUTOSTART_HIDDEN_ARG = '--hidden';

export const APP_DISPLAY_NAME = 'Tradia';
export const LINUX_DESKTOP_FILENAME = 'tradia.desktop';

export interface LinuxAutostartPaths {
  /** Directorio home del usuario (app.getPath('home')). */
  home: string;
  /** $XDG_CONFIG_HOME si está definido; si no, `<home>/.config`. */
  configHome?: string;
}

export function linuxAutostartDir(paths: LinuxAutostartPaths): string {
  const configHome = paths.configHome || join(paths.home, '.config');
  return join(configHome, 'autostart');
}

export function linuxAutostartFile(paths: LinuxAutostartPaths): string {
  return join(linuxAutostartDir(paths), LINUX_DESKTOP_FILENAME);
}

/**
 * Escapa un ejecutable para la línea `Exec=` de un .desktop (freedesktop):
 * siempre entrecomillado, con `\` y `"` protegidos.
 */
export function quoteDesktopExec(execPath: string): string {
  return `"${execPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface DesktopEntryOptions {
  /** Ruta del ejecutable (process.execPath). */
  execPath: string;
  /** Argumentos de arranque; por defecto [--hidden]. */
  args?: string[];
  name?: string;
  comment?: string;
}

/** Genera el contenido del archivo .desktop de autostart para Linux. */
export function buildDesktopEntry(options: DesktopEntryOptions): string {
  const args = options.args ?? [AUTOSTART_HIDDEN_ARG];
  const exec = [quoteDesktopExec(options.execPath), ...args].join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${options.name ?? APP_DISPLAY_NAME}`,
    `Comment=${options.comment ?? 'Tradia — agentes de trading (señales y paper trading)'}`,
    `Exec=${exec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

export interface LinuxAutostartOptions extends LinuxAutostartPaths {
  execPath: string;
}

/** Devuelve true si el archivo .desktop de autostart existe. */
export function isLinuxAutostartEnabled(paths: LinuxAutostartPaths): boolean {
  return existsSync(linuxAutostartFile(paths));
}

/**
 * Activa o desactiva el inicio automático en Linux escribiendo o borrando el
 * .desktop de autostart. Devuelve true si el estado final es el pedido.
 */
export function setLinuxAutostart(enabled: boolean, options: LinuxAutostartOptions): boolean {
  const file = linuxAutostartFile(options);
  try {
    if (enabled) {
      mkdirSync(linuxAutostartDir(options), { recursive: true });
      writeFileSync(file, buildDesktopEntry({ execPath: options.execPath }), 'utf8');
    } else {
      rmSync(file, { force: true });
    }
    return isLinuxAutostartEnabled(options) === enabled;
  } catch (error: unknown) {
    console.error(`[autostart] no se pudo actualizar ${file}`, error);
    return false;
  }
}
