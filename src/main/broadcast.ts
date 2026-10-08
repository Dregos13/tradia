import { BrowserWindow } from 'electron';

/** Envía un evento IPC a todas las ventanas abiertas (renderer). */
export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}
