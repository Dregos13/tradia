import { app, BrowserWindow } from 'electron';

import { broadcast } from './broadcast';
import { initServices } from './services';
import { createMainWindow } from './window';

// Bloqueo de instancia única: la app es residente y no tiene sentido duplicarla.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.setName('Tradia');

  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });

  // Endurecimiento: sin window.open ni navegación fuera de la propia app.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      const devUrl = process.env.ELECTRON_RENDERER_URL;
      const allowed = url === devUrl || url.startsWith('file://');
      if (!allowed) event.preventDefault();
    });
  });

  app
    .whenReady()
    .then(() => {
      const services = initServices({ broadcast, services: {} });
      createMainWindow();

      app.on('will-quit', () => {
        services.storage.close();
      });

      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
      });
    })
    .catch((error: unknown) => {
      console.error('[tradia] error al iniciar la app', error);
      app.quit();
    });

  app.on('window-all-closed', () => {
    // La tarea «tray-background» cambiará esto por ocultar a la bandeja.
    if (process.platform !== 'darwin') app.quit();
  });
}
