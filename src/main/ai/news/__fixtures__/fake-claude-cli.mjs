#!/usr/bin/env node
/**
 * CLI falsa de Claude Code para las pruebas de `claudeCli.ts`
 * (`claudeCli.test.ts`). Es un proceso de verdad: el adaptador la
 * ejecuta con `spawn` sin shell, igual que al `claude` real.
 *
 * Se comporta según `${TMPDIR}/tradia-fake-claude.json` (lo escribe la
 * prueba antes de cada escenario):
 *
 *   { "mode": "ok", "result": "<texto del modelo>", "recordTo": "<ruta>" }
 *
 * - `ok` (por defecto): imprime el sobre JSON de `claude -p
 *   --output-format json` con `result` = cfg.result.
 * - `text`: imprime texto que no es JSON (salida rota).
 * - `envelope-error`: sobre con `is_error: true` y código 1.
 * - `noauth`: mensaje de sesión no iniciada por stderr y código 1.
 * - `fail`: error genérico por stderr y código 2.
 * - `hang`: no responde nunca (lo mata el timeout del adaptador).
 *
 * Cada invocación se anota en `recordTo` (o
 * `${TMPDIR}/tradia-fake-claude-calls.jsonl`) como una línea JSON con
 * los argumentos, el prompt por stdin y las variables de entorno con
 * nombre de secreto, para que la prueba compruebe que los argumentos
 * no cambian con el titular y que las claves no se reenvían.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setInterval } from 'node:timers';

const base = process.env.TMPDIR || tmpdir();
const configPath = join(base, 'tradia-fake-claude.json');
let config = {};
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
} catch {
  // Sin configuración: modo 'ok' por defecto.
}
const mode = typeof config.mode === 'string' ? config.mode : 'ok';
const recordTo = config.recordTo ?? join(base, 'tradia-fake-claude-calls.jsonl');
const result =
  typeof config.result === 'string'
    ? config.result
    : '{"assets":[{"ticker":"AAPL","summary":"Resumen falso de la CLI.","sentiment":"positivo"}]}';

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
    // Sin registro: la prueba no lo pidió.
  }

  switch (mode) {
    case 'text':
      process.stdout.write('esto no es JSON en absoluto\n');
      process.exit(0);
      break;
    case 'envelope-error':
      process.stdout.write(
        JSON.stringify({
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          result: 'algo fue mal dentro de la CLI',
        }),
      );
      process.exit(1);
      break;
    case 'noauth':
      process.stderr.write('Not logged in. Please run /login to authenticate.\n');
      process.exit(1);
      break;
    case 'fail':
      process.stderr.write('boom: error genérico de la CLI\n');
      process.exit(2);
      break;
    case 'hang':
      // Nunca responde: el timeout del adaptador debe matar el proceso.
      setInterval(() => undefined, 60_000);
      break;
    default:
      process.stdout.write(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'fake-session',
          duration_ms: 1,
          result,
        }),
      );
      process.exit(0);
  }
});
