import { join } from 'node:path';

import { app } from 'electron';

/**
 * Resuelve la ruta de un recurso de `resources/` (empaquetado como
 * extraResources en electron-builder.yml).
 * En producción vive en `process.resourcesPath/resources`; en desarrollo y en
 * pruebas, en la raíz del proyecto.
 */
export function resourcePath(...segments: string[]): string {
  const base = app.isPackaged
    ? join(process.resourcesPath, 'resources')
    : join(app.getAppPath(), 'resources');
  return join(base, ...segments);
}
