/**
 * Evaluación del análisis de noticias con LLM sobre el conjunto
 * etiquetado (`src/main/ai/news/__fixtures__/headlines.labeled.json`).
 *
 * Empaqueta el analizador elegido con esbuild (ya en node_modules vía
 * vite) y lo ejecuta sobre el mismo `evaluateNewsAnalyzer` que las
 * pruebas: misma ruta de código que la app. Mide acierto en activo y
 * sentimiento y uso del día frente al tope configurado.
 *
 * Uso:
 *   npm run eval:news-llm -- --provider local          sin coste ni clave
 *   npm run eval:news-llm -- --provider suscripcion    CLI de Claude Code
 *
 * 'suscripcion' usa el `claude` local con la sesión de la suscripción
 * (sin clave de API; CLAUDE_CLI_PATH fija la ruta si no está en PATH).
 * NEWS_LLM_DAILY_CAP (200) acota la evaluación. La API de pago se
 * retiró: ya no hay proveedor 'api' ni clave de Anthropic.
 */
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const PROVIDERS = ['local', 'suscripcion'];

const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
};

const provider = argValue('--provider') ?? 'local';
if (!PROVIDERS.includes(provider)) {
  console.error(`Proveedor desconocido «${provider}». Uso:`);
  console.error('  npm run eval:news-llm -- --provider suscripcion|local');
  process.exit(2);
}

const dailyCap = Math.max(1, Number(process.env.NEWS_LLM_DAILY_CAP ?? 200) || 200);

const entry = { local: 'local.ts', suscripcion: 'claudeCli.ts' }[provider];

const outDir = mkdtempSync(join(tmpdir(), 'tradia-eval-news-'));
execFileSync(
  resolve('node_modules/.bin/esbuild'),
  [
    `src/main/ai/news/${entry}`,
    'src/main/ai/news/eval.ts',
    'src/main/ai/news/types.ts',
    '--bundle',
    '--format=esm',
    '--platform=node',
    '--log-level=warning',
    `--outdir=${outDir}`,
  ],
  { stdio: 'inherit' },
);

const { evaluateNewsAnalyzer, NEWS_EVAL_MIN_ASSET_ACCURACY, NEWS_EVAL_MIN_SENTIMENT_ACCURACY } =
  await import(pathToFileURL(join(outDir, 'eval.js')).href);
const { createMemoryUsageStore } = await import(pathToFileURL(join(outDir, 'types.js')).href);

const bundle = await import(pathToFileURL(join(outDir, entry.replace(/\.ts$/, '.js'))).href);

const usage = createMemoryUsageStore();
const analyzer =
  provider === 'local'
    ? bundle.createLocalNewsAnalyzer()
    : bundle.createClaudeCliAnalyzer({
        cliPath: () => process.env.CLAUDE_CLI_PATH ?? null,
        usage,
        dailyCap: () => dailyCap,
      });

const fixture = JSON.parse(
  readFileSync('src/main/ai/news/__fixtures__/headlines.labeled.json', 'utf8'),
);
const labeled = fixture.headlines;

const LABEL = {
  local: 'analizador léxico local',
  suscripcion: 'CLI de Claude Code (suscripción)',
}[provider];
console.log(`Evaluación del análisis de noticias con ${LABEL} — ${labeled.length} titulares.`);
console.log(`Tope diario: ${dailyCap}\n`);

let fatal = null;
const report = await evaluateNewsAnalyzer(analyzer, labeled, (index, error) => {
  if (fatal === null && error?.kind && error.kind !== 'bad-data') {
    fatal = error;
  }
  console.error(`  fallo en #${index + 1}: ${error?.message ?? error}`);
});

if (fatal && report.sentimentHits === 0 && report.assetHits === 0) {
  console.error(`\nLa evaluación no pudo ejecutarse: ${fatal.message}`);
  process.exitCode = 1;
} else {
  const pct = (x) => `${(x * 100).toFixed(1)} %`;
  console.log('Resultados');
  console.log(`  Titulares evaluados     ${report.total}`);
  console.log(
    `  Acierto en activo       ${report.assetHits}/${report.total} = ${pct(report.assetAccuracy)} (umbral ${pct(NEWS_EVAL_MIN_ASSET_ACCURACY)})`,
  );
  console.log(
    `  Acierto en sentimiento  ${report.sentimentHits}/${report.total} = ${pct(report.sentimentAccuracy)} (umbral ${pct(NEWS_EVAL_MIN_SENTIMENT_ACCURACY)})`,
  );
  console.log(
    `\nTitulares analizados por el proveedor: ${usage.current.usedToday} de ${dailyCap} (sin coste de API).`,
  );
  if (report.failures.length > 0) {
    console.log(`\nFallos (${report.failures.length}):`);
    for (const f of report.failures) {
      console.log(
        `  #${f.index + 1} esperado ${f.expectedAsset}/${f.expectedSentiment} · obtuvo ${f.gotTickers.join(',') || '—'}/${f.gotSentiment ?? '—'}\n    ${f.title}`,
      );
    }
  }
  const pass =
    report.assetAccuracy >= NEWS_EVAL_MIN_ASSET_ACCURACY &&
    report.sentimentAccuracy >= NEWS_EVAL_MIN_SENTIMENT_ACCURACY;
  console.log(`\n${pass ? 'SUPERA' : 'NO SUPERA'} los umbrales documentados.`);
  process.exitCode = pass ? 0 : 1;
}
