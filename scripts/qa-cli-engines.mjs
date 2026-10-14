/**
 * Comprobación manual del desplegable de motores CLI de Ajustes ›
 * Análisis de noticias (no se ejecuta en CI): la misma detección y
 * `ping()` que hace `ai:test-llm`, lanzada desde la terminal contra las
 * CLI REALES instaladas en el equipo (claude, codex, agy, copilot).
 *
 * Empaqueta `src/main/ai/news/cliEngines.ts` con esbuild (ya en
 * node_modules vía vite) y, por cada motor, resuelve su ejecutable como
 * lo haría el servicio —ruta configurada opcional por entorno
 * TRADIA_CLI_PATH_<MOTOR>, PATH y ubicaciones conocidas— y le envía un
 * mensaje mínimo por stdin. No imprime titulares ni credenciales: solo
 * el resultado clasificado (ok + latencia, CLI no encontrada, sesión no
 * iniciada u otro fallo).
 *
 * Uso:
 *   node scripts/qa-cli-engines.mjs                # todos los motores
 *   node scripts/qa-cli-engines.mjs codex          # solo uno
 *   TRADIA_CLI_PATH_codex=/ruta/codex node scripts/qa-cli-engines.mjs
 *
 * Salida: 0 si todas las CLI localizadas responden, 1 si alguna falla,
 * 2 si no se localiza ninguna (mensaje de uso).
 */
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const ENGINES = /** @type {const} */ ([
  'suscripcion-claude',
  'suscripcion-codex',
  'suscripcion-antigravity',
  'suscripcion-copilot',
]);
const SHORT = {
  'suscripcion-claude': 'claude',
  'suscripcion-codex': 'codex',
  'suscripcion-antigravity': 'agy',
  'suscripcion-copilot': 'copilot',
};

const arg = process.argv[2];
const engines = arg ? ENGINES.filter((id) => id === arg || SHORT[id] === arg) : [...ENGINES];
if (engines.length === 0) {
  console.error(
    `Motor desconocido «${arg}». Válidos: ${ENGINES.map((id) => SHORT[id]).join(', ')}.`,
  );
  process.exit(2);
}

const outDir = mkdtempSync(join(tmpdir(), 'tradia-qa-cli-engines-'));
const bundle = join(outDir, 'cli-engines.mjs');
execFileSync(
  resolve('node_modules/.bin/esbuild'),
  [
    'src/main/ai/news/cliEngines.ts',
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--packages=external',
    '--log-level=warning',
    `--outfile=${bundle}`,
  ],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);

const { CLI_ENGINE_SPECS, createCliEngineAnalyzer } = await import(pathToFileURL(bundle).href);

// El ping no consume el tope, pero el adaptador pide el almacén igual.
const usage = {
  load: () => ({ day: '', usedToday: 0, month: '', spentMonthEur: 0 }),
  save: () => undefined,
};

let located = 0;
let failures = 0;
for (const id of engines) {
  const spec = CLI_ENGINE_SPECS[id];
  const envPath = process.env[`TRADIA_CLI_PATH_${SHORT[id]}`] ?? null;
  const analyzer = createCliEngineAnalyzer(spec, {
    cliPath: () => envPath,
    usage,
    dailyCap: () => 0,
  });
  if (!analyzer.available()) {
    console.log(`· ${spec.label} (${spec.cliName}): CLI no encontrada — ${spec.installHint}`);
    continue;
  }
  located += 1;
  try {
    const ms = await analyzer.ping();
    console.log(`✓ ${spec.label}: sesión correcta (${ms} ms)`);
  } catch (error) {
    failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.log(`✗ ${spec.label}: ${message}`);
  }
}

if (located === 0) {
  console.error(
    'No se localizó ninguna CLI. Instala alguna o indica su ruta con TRADIA_CLI_PATH_<motor>.',
  );
  process.exit(2);
}
process.exit(failures > 0 ? 1 : 0);
