#!/usr/bin/env node
/**
 * CLI falsa genérica para las pruebas de `cliEngines.ts`
 * (`cliEngines.test.ts`). Es un proceso de verdad: el adaptador la
 * ejecuta con `spawn` sin shell, igual que a las CLI reales (claude,
 * codex, agy, copilot). El mismo fixture sirve para cualquier motor:
 * la prueba controla exactamente lo que imprime.
 *
 * Se comporta según `${TMPDIR}/tradia-fake-cli-engine.json` (lo escribe
 * la prueba antes de cada escenario):
 *
 *   { "mode": "ok", "stdout": "<salida>", "stderr": "<salida>",
 *     "code": 0, "recordTo": "<ruta>" }
 *
 * - `ok` (por defecto): imprime cfg.stdout por stdout y cfg.stderr por
 *   stderr, y termina con cfg.code (0 por defecto).
 * - `text`: imprime texto que no es JSON por stdout.
 * - `noauth`: mensaje de sesión no iniciada por stderr y código 1 (el
 *   texto se puede personalizar con cfg.stderr).
 * - `fail`: error genérico por stderr y código 2.
 * - `hang`: no responde nunca (lo mata el timeout del adaptador).
 *
 * Cada invocación se anota en `recordTo` (o
 * `${TMPDIR}/tradia-fake-cli-engine-calls.jsonl`) como una línea JSON
 * con los argumentos, el prompt por stdin y las variables de entorno con
 * nombre de secreto, para que la prueba compruebe que los argumentos no
 * cambian con el titular y que las claves no se reenvían.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setInterval } from 'node:timers';

const base = process.env.TMPDIR || tmpdir();
const configPath = join(base, 'tradia-fake-cli-engine.json');
let config = {};
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {
  // Sin configuración: modo 'ok' por defecto.
}
const mode = typeof config.mode === 'string' ? config.mode : 'ok';
const recordTo = config.recordTo ?? join(base, 'tradia-fake-cli-engine-calls.jsonl');
const stdout = typeof config.stdout === 'string' ? config.stdout : 'OK';
const stderr = typeof config.stderr === 'string' ? config.stderr : '';
const code = typeof config.code === 'number' ? config.code : 0;

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdin += chunk;
});
process.stdin.on('end', () => {
  try {
    appendFileSync(
      recordTo,
      JSON.stringify({
        argv: process.argv.slice(2),
        stdin,
        secretEnvKeys: Object.keys(process.env).filter((key) =>
          /(KEY|TOKEN|SECRET|AUTH)/i.test(key),
        ),
      }) + '\n',
    );
  } catch {
    // Si no se puede registrar, el escenario sigue: el test lo verá vacío.
  }

  if (mode === 'hang') {
    // Nunca responde: el adaptador debe matarlo al vencer el timeout.
    setInterval(() => undefined, 60_000);
    return;
  }
  if (mode === 'noauth') {
    process.stderr.write(stderr || 'Error: not logged in — inicia sesión antes de continuar\n');
    process.exit(1);
  }
  if (mode === 'fail') {
    process.stderr.write(stderr || 'Error: fallo genérico de la CLI\n');
    process.exit(2);
  }
  if (mode === 'text') {
    process.stdout.write('esto no es json ni sobre\n');
    process.exit(0);
  }
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
});
