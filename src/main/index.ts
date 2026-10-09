import { app, shell } from 'electron';

import { isE2eEnabled } from '../shared/ipc';
import { AUTOSTART_HIDDEN_ARG } from './autostart';
import { broadcast } from './broadcast';
import { initServices, type MainServices } from './services';
import { installMainLogger } from './services/logger';
import { showMainWindow } from './window';

// Playwright runs each Electron instance with an isolated data directory.
// La app empaquetada ignora la variable: es un gancho de prueba.
if (isE2eEnabled(app.isPackaged, process.env.TRADIA_E2E) && process.env.TRADIA_E2E_USER_DATA) {
  app.setPath('userData', process.env.TRADIA_E2E_USER_DATA);
}

// Registro rotado en userData/logs (fase 4): captura los console.* del
// proceso principal sin perder la salida de consola en desarrollo.
installMainLogger();

// Bloqueo de instancia única: la app es residente y no tiene sentido duplicarla.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.setName('Tradia');

  let services: MainServices | null = null;

  app.on('second-instance', () => {
    // La instancia residente muestra su ventana al reintentar abrir la app.
    if (app.isReady()) showMainWindow();
  });

  // Endurecimiento: sin window.open ni navegación fuera de la propia app.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => undefined);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      const devUrl = process.env.ELECTRON_RENDERER_URL;
      const allowed = url === devUrl || url.startsWith('file://');
      if (!allowed) event.preventDefault();
    });
  });

  app
    .whenReady()
    .then(() => {
      services = initServices({ broadcast, services: {} });

      // Arranque en segundo plano: con --hidden (login item de Windows/Linux)
      // o lanzada por el inicio de sesión en macOS, la app se queda en bandeja.
      const startedHidden =
        process.argv.includes(AUTOSTART_HIDDEN_ARG) ||
        (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin);
      if (!startedHidden) showMainWindow();

      app.on('activate', () => showMainWindow());

      app.on('will-quit', () => {
        // Fase 4: la rutina y el motor se paran antes que sus servicios
        // base (diario, canales, copias) y estos antes que el resto.
        services?.routine.stop();
        services?.signals.stop();
        services?.delivery.stop();
        services?.backup.stop();
        services?.journal.stop();
        services?.alerts.stop();
        services?.calendar.stop();
        services?.poller.stop();
        services?.market.stop();
        services?.macro.stop();
        services?.health.stop();
        services?.killSwitch.stop();
        services?.risk.stop();
        services?.scheduler.stop();
        services?.tray.destroy();
        services?.storage.close();
      });
    })
    .catch((error: unknown) => {
      console.error('[tradia] error al iniciar la app', error);
      app.quit();
    });

  app.on('window-all-closed', () => {
    // Con bandeja activa la app es residente y cerrar ventanas no la termina;
    // sin bandeja disponible se recupera el cierre clásico fuera de macOS.
    if (services?.tray.isActive() !== true && process.platform !== 'darwin') {
      app.quit();
    }
  });
}
