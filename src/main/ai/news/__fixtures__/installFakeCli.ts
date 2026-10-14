/**
 * Helper de pruebas: instala la CLI falsa de Claude Code
 * (`fake-claude-cli.mjs`) en un directorio `bin` temporal imitando una
 * instalación real en el SO anfitrión, así las pruebas corren igual en
 * macOS, Linux y Windows:
 *
 * - POSIX: el ejecutable `claude` (el fixture lleva shebang
 *   `#!/usr/bin/env node`) con permiso de ejecución; el PATH del hijo
 *   debe incluir el directorio de `node` para que el shebang lo
 *   encuentre.
 * - Windows: el shim `claude.cmd` de npm (un batch que lanza `node`
 *   con el fixture) más el `node_modules/@anthropic-ai/claude-code/
 *   cli.js` del paquete junto al shim — la rama que `spawnPlan`
 *   prefiere, así no hace falta cmd.exe y los argumentos llegan
 *   intactos.
 *
 * Devuelve la ruta del ejecutable que la prueba debe usar como
 * `cliPath`.
 */
import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_CLAUDE_CLI_FIXTURE = fileURLToPath(
  new URL('./fake-claude-cli.mjs', import.meta.url),
);

export function installFakeClaudeCli(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const cliPath = join(binDir, 'claude.cmd');
    copyFileSync(FAKE_CLAUDE_CLI_FIXTURE, join(binDir, 'fake-claude-cli.mjs'));
    writeFileSync(cliPath, `@echo off\r\n"${process.execPath}" "%~dp0fake-claude-cli.mjs" %*\r\n`);
    const packageDir = join(binDir, 'node_modules', '@anthropic-ai', 'claude-code');
    mkdirSync(packageDir, { recursive: true });
    copyFileSync(FAKE_CLAUDE_CLI_FIXTURE, join(packageDir, 'cli.js'));
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ type: 'module' }));
    return cliPath;
  }
  const cliPath = join(binDir, 'claude');
  copyFileSync(FAKE_CLAUDE_CLI_FIXTURE, cliPath);
  chmodSync(cliPath, 0o755);
  return cliPath;
}

export const FAKE_CLI_ENGINE_FIXTURE = fileURLToPath(
  new URL('./fake-cli-engine.mjs', import.meta.url),
);

/**
 * Instala la CLI falsa genérica (`fake-cli-engine.mjs`) como `name` en
 * `binDir` — el mismo patrón que `installFakeClaudeCli` para cualquier
 * motor (codex, agy, copilot…): ejecutable con shebang en POSIX, shim
 * `.cmd` en Windows.
 */
export function installFakeCliEngine(binDir: string, name: string): string {
  mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const cliPath = join(binDir, `${name}.cmd`);
    copyFileSync(FAKE_CLI_ENGINE_FIXTURE, join(binDir, 'fake-cli-engine.mjs'));
    writeFileSync(cliPath, `@echo off\r\n"${process.execPath}" "%~dp0fake-cli-engine.mjs" %*\r\n`);
    return cliPath;
  }
  const cliPath = join(binDir, name);
  copyFileSync(FAKE_CLI_ENGINE_FIXTURE, cliPath);
  chmodSync(cliPath, 0o755);
  return cliPath;
}
