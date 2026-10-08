import type { WebPreferences } from 'electron';

/**
 * webPreferences de seguridad de la ventana principal.
 *
 * Mantener como constante exportada para que la prueba
 * `src/main/security.test.ts` pueda verificarla sin lanzar Electron.
 */
export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  spellcheck: false,
} satisfies Partial<WebPreferences>;

export function buildWebPreferences(preloadPath: string): WebPreferences {
  return {
    ...SECURE_WEB_PREFERENCES,
    preload: preloadPath,
  };
}
