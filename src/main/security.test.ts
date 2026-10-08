import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildWebPreferences, SECURE_WEB_PREFERENCES } from './security';

describe('webPreferences de seguridad', () => {
  it('aisla el renderer de Node', () => {
    expect(SECURE_WEB_PREFERENCES.contextIsolation).toBe(true);
    expect(SECURE_WEB_PREFERENCES.nodeIntegration).toBe(false);
    expect(SECURE_WEB_PREFERENCES.nodeIntegrationInWorker).toBe(false);
    expect(SECURE_WEB_PREFERENCES.sandbox).toBe(true);
  });

  it('mantiene la seguridad web activada', () => {
    expect(SECURE_WEB_PREFERENCES.webSecurity).toBe(true);
    expect(SECURE_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false);
  });

  it('inyecta la ruta del preload sin tocar las flags', () => {
    const prefs = buildWebPreferences('/ruta/preload.js');
    expect(prefs.preload).toBe('/ruta/preload.js');
    expect(prefs.sandbox).toBe(true);
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
  });

  it('pasa los argumentos extra al process.argv del preload', () => {
    const prefs = buildWebPreferences('/ruta/preload.js', ['--tradia-e2e']);
    expect(prefs.additionalArguments).toEqual(['--tradia-e2e']);
    expect(buildWebPreferences('/ruta/preload.js').additionalArguments).toEqual([]);
  });
});

describe('CSP del renderer', () => {
  const html = readFileSync(join(__dirname, '../renderer/index.html'), 'utf8');
  const cspMatch = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  const csp = cspMatch?.[1] ?? '';

  it('declara una política Content-Security-Policy', () => {
    expect(cspMatch, 'index.html debe declarar la meta CSP').not.toBeNull();
  });

  it('solo permite scripts y recursos propios', () => {
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  it('bloquea objetos, frames y formularios externos', () => {
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });
});
