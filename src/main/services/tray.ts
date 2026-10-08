import { existsSync } from 'node:fs';

import { app, Menu, nativeImage, Tray } from 'electron';
import type { MenuItemConstructorOptions, NativeImage } from 'electron';

import { AUTOSTART_HIDDEN_ARG, isLinuxAutostartEnabled, setLinuxAutostart } from '../autostart';
import { resourcePath } from '../resources';
import type { AgentsState, ConnectivityState } from '../../shared/ipc';
import { showMainWindow } from '../window';
import type { ServiceContext } from './index';

/**
 * Bandeja del sistema y modo segundo plano.
 *
 * - Icono y tooltip por estado: en línea, sin conexión o pausado (en macOS
 *   plantilla monocroma `*-Template.png`; en Windows/Linux color).
 * - Menú: Abrir, Pausar/Reanudar agentes (alterna), Iniciar con el sistema
 *   (casilla) y Salir.
 * - Al cerrar la ventana se oculta y la app sigue residente; en macOS se
 *   oculta también el Dock. Solo se sale con 'Salir' de la bandeja o Cmd+Q
 *   (`before-quit` pone el flag `quitting` que deja pasar el cierre real).
 * - Inicio automático: `app.setLoginItemSettings` en macOS (el arranque oculto
 *   se detecta con `wasOpenedAtLogin`) y Windows (`--hidden`), y .desktop en
 *   `~/.config/autostart` en Linux.
 *
 * Si la bandeja del sistema no está disponible (p. ej. Linux sin
 * appindicator) el servicio degrada: no instala el cierre-a-bandeja y
 * `window-all-closed` recupera el comportamiento clásico.
 */
export interface TrayService {
  /** Redibuja icono, tooltip y menú según el estado actual. */
  refresh(): void;
  /** true si el Tray del sistema está operativo en esta sesión. */
  isActive(): boolean;
  /** true desde que el usuario pidió salir (bandeja, Cmd+Q o quit()). */
  isQuitting(): boolean;
  destroy(): void;
}

export type TrayVisualState = 'online' | 'offline' | 'paused';

/** Tooltips fijados por la guía de diseño (el icono nunca es la única señal). */
const TOOLTIPS: Record<TrayVisualState, string> = {
  online: 'Tradia — En línea',
  offline: 'Tradia — Sin conexión',
  paused: 'Tradia — Agentes en pausa',
};

/**
 * Precedencia del estado visual: la pausa manda sobre la conexión, y un estado
 * 'checking' o desconocido se muestra como en línea (optimista).
 */
export function resolveTrayVisualState(
  agents: AgentsState | undefined,
  connectivity: ConnectivityState | undefined,
): TrayVisualState {
  if (agents?.paused) return 'paused';
  if (connectivity?.status === 'offline') return 'offline';
  return 'online';
}

/** Icono temporal (disco de color semántico) si faltan los PNG de diseño. */
function placeholderIcon(state: TrayVisualState): NativeImage {
  const size = 16;
  const rgb: Record<TrayVisualState, [number, number, number]> = {
    online: [0x12, 0x6b, 0x4b],
    offline: [0xa3, 0x3b, 0x18],
    paused: [0x76, 0x55, 0x00],
  };
  const [r, g, b] = rgb[state];
  const buffer = Buffer.alloc(size * size * 4);
  const center = size / 2;
  const radius = size / 2 - 1;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (Math.hypot(x + 0.5 - center, y + 0.5 - center) > radius) continue;
      const offset = (y * size + x) * 4;
      // createFromBitmap espera BGRA; alfa 255 → no hay que premultiplicar.
      buffer[offset] = b;
      buffer[offset + 1] = g;
      buffer[offset + 2] = r;
      buffer[offset + 3] = 0xff;
    }
  }
  return nativeImage.createFromBitmap(buffer, { width: size, height: size });
}

function loadTrayIcon(state: TrayVisualState): NativeImage {
  const fileName =
    process.platform === 'darwin' ? `tray-${state}-Template.png` : `tray-${state}.png`;
  const file = resourcePath('tray', fileName);
  if (existsSync(file)) {
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) {
      if (process.platform === 'darwin') image.setTemplateImage(true);
      return image;
    }
  }
  console.warn(`[tray] icono no disponible en ${file}; se usa un marcador temporal`);
  return placeholderIcon(state);
}

/** Aplica el inicio automático del SO según la plataforma. */
export function applyOsAutostart(enabled: boolean): void {
  if (process.platform === 'linux') {
    setLinuxAutostart(enabled, {
      home: app.getPath('home'),
      configHome: process.env.XDG_CONFIG_HOME || undefined,
      execPath: process.execPath,
    });
    return;
  }
  if (process.platform === 'darwin') {
    // En macOS no hay "arrancar oculto": la app detecta wasOpenedAtLogin en el
    // arranque y se queda solo en la bandeja.
    app.setLoginItemSettings({ openAtLogin: enabled });
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: [AUTOSTART_HIDDEN_ARG],
  });
}

/** Lee el estado real del inicio automático en el SO (para la casilla). */
export function readOsAutostart(): boolean {
  try {
    if (process.platform === 'linux') {
      return isLinuxAutostartEnabled({
        home: app.getPath('home'),
        configHome: process.env.XDG_CONFIG_HOME || undefined,
      });
    }
    return app.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
}

export function registerTray(ctx: ServiceContext): TrayService {
  let quitting = false;
  let tray: Tray | null = null;
  let unsubscribe: (() => void) | null = null;

  // Cmd+Q (macOS), Ctrl+Q y cualquier quit() pasan por aquí antes del cierre.
  app.on('before-quit', () => {
    quitting = true;
  });

  const visualState = (): TrayVisualState =>
    resolveTrayVisualState(
      ctx.services.scheduler?.getState(),
      ctx.services.connectivity?.getState(),
    );

  const setAutostart = (enabled: boolean): void => {
    try {
      applyOsAutostart(enabled);
    } catch (error: unknown) {
      console.error('[tray] no se pudo aplicar el inicio automático', error);
    }
    ctx.services.settings?.set({ autostart: enabled });
    service.refresh();
  };

  const buildMenu = (): Menu => {
    const agents = ctx.services.scheduler?.getState();
    const template: MenuItemConstructorOptions[] = [
      { label: 'Abrir', click: () => showMainWindow() },
      {
        label: agents?.paused ? 'Reanudar agentes' : 'Pausar agentes',
        click: () => {
          if (ctx.services.scheduler?.getState().paused) {
            ctx.services.scheduler.resume();
          } else {
            ctx.services.scheduler?.pause();
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Iniciar con el sistema',
        type: 'checkbox',
        checked: readOsAutostart(),
        click: (item) => setAutostart(item.checked),
      },
      { type: 'separator' },
      {
        label: 'Salir',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ];
    return Menu.buildFromTemplate(template);
  };

  const service: TrayService = {
    refresh: () => {
      if (!tray) return;
      const state = visualState();
      tray.setImage(loadTrayIcon(state));
      tray.setToolTip(TOOLTIPS[state]);
      tray.setContextMenu(buildMenu());
    },
    isActive: () => tray !== null,
    isQuitting: () => quitting,
    destroy: () => {
      unsubscribe?.();
      unsubscribe = null;
      tray?.destroy();
      tray = null;
    },
  };

  // Estado inicial del inicio automático: la app es la fuente de verdad.
  const storedAutostart = ctx.services.settings?.get().autostart ?? false;
  if (storedAutostart !== readOsAutostart()) {
    try {
      applyOsAutostart(storedAutostart);
    } catch (error: unknown) {
      console.error('[tray] no se pudo aplicar el inicio automático al arrancar', error);
    }
  }

  try {
    tray = new Tray(loadTrayIcon(visualState()));
    service.refresh();
  } catch (error: unknown) {
    // p. ej. Linux sin appindicator: la app sigue pero sin bandeja residente.
    console.error('[tray] la bandeja del sistema no está disponible', error);
    tray = null;
  }

  if (tray) {
    // Cerrar la ventana la oculta; la app solo sale vía 'Salir' o Cmd+Q.
    app.on('browser-window-created', (_event, window) => {
      window.on('close', (event) => {
        if (quitting) return;
        event.preventDefault();
        window.hide();
        if (process.platform === 'darwin') app.dock?.hide();
      });
    });

    // La bandeja se repinta cuando los agentes cambian (pausa/reanudación);
    // connectivity llama a refresh() al cambiar el estado de la conexión.
    unsubscribe = ctx.services.scheduler?.onChanged(() => service.refresh()) ?? null;
  }

  return service;
}
