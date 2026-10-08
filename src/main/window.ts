import { join } from 'node:path';

import { BrowserWindow } from 'electron';

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
    webPreferences: buildWebPreferences(join(__dirname, '../preload/index.js')),
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
