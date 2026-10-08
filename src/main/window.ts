import { join } from 'node:path';

import { app, BrowserWindow } from 'electron';

import { E2E_FLAG_ARG, isE2eEnabled } from '../shared/ipc';
import { resourcePath } from './resources';
import { buildWebPreferences } from './security';

export function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'Tradia',
    // Icono de la ventana (Linux/Windows); en macOS manda el .icns del bundle.
    icon: resourcePath('icon.png'),
    webPreferences: buildWebPreferences(
      join(__dirname, '../preload/index.js'),
      // Los ganchos E2E solo se activan fuera de la app empaquetada; la
      // flag llega al preload por process.argv (ver src/shared/ipc.ts).
      isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E) ? [E2E_FLAG_ARG] : [],
    ),
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
}

/**
 * Abre la ventana principal si no existe, o la muestra y enfoca si estaba
 * oculta o minimizada. En macOS restaura además el icono del Dock, que la
 * bandeja oculta al cerrar la ventana.
 */
export function showMainWindow(): BrowserWindow {
  if (process.platform === 'darwin') app.dock?.show();
  const existing = BrowserWindow.getAllWindows()[0];
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return existing;
  }
  return createMainWindow();
}
