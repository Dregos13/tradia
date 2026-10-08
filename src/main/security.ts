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

/**
 * `additionalArguments` se añade a `process.argv` del renderer: así el
 * preload recibe flags del proceso principal (p. ej. `E2E_FLAG_ARG`).
 */
export function buildWebPreferences(
  preloadPath: string,
  additionalArguments: string[] = [],
): WebPreferences {
  return {
    ...SECURE_WEB_PREFERENCES,
    preload: preloadPath,
    additionalArguments,
  };
}
