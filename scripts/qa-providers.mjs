/**
 * Comprobación manual de «Probar conexión» de los proveedores de datos
 * (no se ejecuta en CI): la misma llamada mínima que hace la app con
 * `providers:test-connection`, lanzada desde la terminal.
 *
 * Empaqueta `src/main/providers/tester.ts` con esbuild (ya en node_modules
 * vía vite) y usa los adaptadores REALES de Tiingo y FRED contra sus APIs:
 * última cotización de SPY y observación más reciente de VIXCLS. El
 * resultado es el `ProviderTestResult` del contrato (estado, mensaje,
 * fecha del último dato y latencia). La clave se lee del entorno y no se
 * imprime jamás: ni en la salida ni en los errores.
 *
 * Uso (una o las dos claves):
 *   TIINGO_API_KEY=… FRED_API_KEY=… npm run qa:providers
 *   node scripts/qa-providers.mjs
 *
 * Salida: 0 si todos los proveedores con clave responden 'ok', 1 si alguno
 * falla, 2 si falta toda clave (mensaje de uso).
 */
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const KEYS = {
  tiingo: process.env.TIINGO_API_KEY ?? process.env['TIINGO-API-KEY'],
  fred: process.env.FRED_API_KEY ?? process.env['FRED-API-KEY'],
};

const requested = Object.entries(KEYS).filter(([, key]) => key);
if (requested.length === 0) {
  console.error('Faltan las claves de los proveedores de datos. Uso:');
  console.error('  TIINGO_API_KEY=… FRED_API_KEY=… npm run qa:providers');
  console.error('Basta una de las dos; cada una prueba solo su proveedor.');
  process.exit(2);
}

const outDir = mkdtempSync(join(tmpdir(), 'tradia-qa-providers-'));
const bundle = join(outDir, 'provider-tester.mjs');
execFileSync(
  resolve('node_modules/.bin/esbuild'),
  [
    'src/main/providers/tester.ts',
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--log-level=warning',
    `--outfile=${bundle}`,
  ],
  { stdio: 'inherit' },
);
const { createProviderProbes, testProviderConnection } = await import(pathToFileURL(bundle).href);

const probes = createProviderProbes({
  fetch: globalThis.fetch,
  getApiKey: async (provider) => KEYS[provider] ?? null,
});

const line = (label, value) => console.log(`  ${String(label).padEnd(18)} ${value}`);
let failures = 0;

for (const [provider] of requested) {
  console.log(`\n${provider === 'tiingo' ? 'Tiingo' : 'FRED'} — petición mínima real:`);
  const result = await testProviderConnection(provider, {
    probe: probes[provider],
  });
  line('estado', result.status);
  line('mensaje', result.message);
  if (result.latestDataDate !== null) line('último dato', result.latestDataDate);
  if (result.latencyMs !== null) line('latencia', `${result.latencyMs} ms`);
  // La clave nunca se imprime: solo el estado del contrato.
  if (result.status !== 'ok') failures += 1;
}

if (failures > 0) {
  console.log('\nResultado: algún proveedor no respondió como se esperaba.');
  process.exitCode = 1;
} else {
  console.log('\nResultado: todos los proveedores con clave respondieron correctamente.');
}
