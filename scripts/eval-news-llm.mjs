/**
 * Evaluación del LLM de noticias sobre el conjunto etiquetado
 * (`src/main/ai/news/__fixtures__/headlines.labeled.json`).
 *
 * Empaqueta el adaptador REAL de Anthropic (`src/main/ai/news/anthropic.ts`)
 * con esbuild (ya en node_modules vía vite) y lo ejecuta contra la API de
 * Anthropic con la clave del usuario: misma ruta de código que la app.
 * Mide acierto en activo y sentimiento, coste estimado por titular y uso
 * del día frente al tope configurado.
 *
 * Uso (clave real de Anthropic):
 *   ANTHROPIC_API_KEY=sk-ant-… npm run eval:news-llm
 * Opcional: NEWS_LLM_DAILY_CAP (por defecto 200) y
 * NEWS_LLM_MONTHLY_BUDGET_EUR (por defecto 30) acotan la evaluación.
 */
import console from 'node:console';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Falta la clave de Anthropic. Uso:');
  console.error('  ANTHROPIC_API_KEY=sk-ant-… npm run eval:news-llm');
  process.exit(2);
}

const dailyCap = Math.max(1, Number(process.env.NEWS_LLM_DAILY_CAP ?? 200) || 200);
const monthlyBudget = Number(process.env.NEWS_LLM_MONTHLY_BUDGET_EUR ?? 30) || 30;

const outDir = mkdtempSync(join(tmpdir(), 'tradia-eval-news-'));
execFileSync(
  resolve('node_modules/.bin/esbuild'),
  [
    'src/main/ai/news/anthropic.ts',
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

const { createAnthropicNewsAnalyzer } = await import(
  pathToFileURL(join(outDir, 'anthropic.js')).href
);
const { evaluateNewsAnalyzer, NEWS_EVAL_MIN_ASSET_ACCURACY, NEWS_EVAL_MIN_SENTIMENT_ACCURACY } =
  await import(pathToFileURL(join(outDir, 'eval.js')).href);
const { createMemoryUsageStore } = await import(pathToFileURL(join(outDir, 'types.js')).href);

const fixture = JSON.parse(
  readFileSync('src/main/ai/news/__fixtures__/headlines.labeled.json', 'utf8'),
);
const labeled = fixture.headlines;

const usage = createMemoryUsageStore();
const analyzer = createAnthropicNewsAnalyzer({
  fetch: globalThis.fetch,
  getApiKey: async () => apiKey,
  usage,
  dailyCap: () => dailyCap,
  monthlyBudgetEur: () => monthlyBudget,
  logger: console,
});

console.log(`Evaluación del LLM de noticias — ${labeled.length} titulares etiquetados.`);
console.log(`Tope diario: ${dailyCap} · Presupuesto mensual: ${monthlyBudget} €\n`);

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
  const spent = usage.current.spentMonthEur;
  console.log(`\nUso y coste estimado (tarifas documentadas en anthropic.ts)`);
  console.log(`  Titulares hoy           ${usage.current.usedToday} de ${dailyCap}`);
  console.log(`  Gasto del mes           ${spent.toFixed(4)} € de ${monthlyBudget} €`);
  console.log(
    `  Coste por titular       ${(report.total > 0 ? spent / report.total : 0).toFixed(5)} €`,
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
