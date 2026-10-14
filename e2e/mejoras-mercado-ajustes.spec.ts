import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * E2E de las tres mejoras pedidas tras el feedback del usuario
 * («No puedo conectar Claude… debería dejarme elegir de un desplegable»
 * y «En Mercado debería poder añadir divisas, un buscador y un gráfico
 * de velas»):
 *
 * 1. Ajustes › Análisis de noticias: el desplegable de motor de IA, su
 *    autodetección de CLI y la prueba de conexión (`docs/diseno-mercado-ia.md`,
 *    sección 2).
 * 2. Mercado: el buscador accesible de activos (combobox) y la adición
 *    de EUR/USD a la lista de seguimiento (sección 3).
 * 3. El gráfico de velas: paneles conmutables de RSI/ATR, rangos
 *    temporales y ausencia de desbordamiento a 1280×800 y 1024×700
 *    (sección 4).
 *
 * La CLI falsa (`__fixtures__/fake-cli-engine.mjs`) es un proceso de
 * Node de verdad lanzado por el adaptador con `spawn`: se instala en un
 * directorio temporal propio y se antepone al PATH del proceso hijo de
 * Electron, igual que haría una instalación real de Claude Code.
 */

/**
 * Instala una CLI de Claude Code falsa pero real (un proceso Node con
 * shebang, lanzado por `spawn` igual que la de verdad): siempre
 * responde el sobre de éxito que espera el adaptador de Claude Code
 * (`{ type: 'result', subtype: 'success', is_error: false, result }`).
 * Equivale, con el mínimo imprescindible, al fixture de
 * `src/main/ai/news/__fixtures__/fake-cli-engine.mjs` usado por las
 * pruebas del adaptador, reescrito aquí porque Playwright no puede
 * compilar ese fichero (usa `import.meta` fuera de un módulo ES).
 */
function installFakeClaudeCli(binDir: string): string {
  mkdirSync(binDir, { recursive: true });
  const script = `#!/usr/bin/env node
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'OK',
  }));
  process.exit(0);
});
`;
  if (process.platform === 'win32') {
    const scriptPath = join(binDir, 'fake-claude-cli.mjs');
    writeFileSync(scriptPath, script);
    const cliPath = join(binDir, 'claude.cmd');
    writeFileSync(cliPath, `@echo off\r\n"${process.execPath}" "%~dp0fake-claude-cli.mjs" %*\r\n`);
    return cliPath;
  }
  const cliPath = join(binDir, 'claude');
  writeFileSync(cliPath, script);
  chmodSync(cliPath, 0o755);
  return cliPath;
}

/**
 * Directorio con un único `node` (enlace al binario real que ejecuta
 * esta batería): el directorio real de Node en este equipo de
 * desarrollo (gestionado con nvm) también aloja los paquetes globales
 * `claude`, `codex` y `copilot`, así que no vale como PATH «sin CLI
 * instalada». Aislar solo `node` evita arrastrarlos sin perder el
 * intérprete que necesita el shebang `#!/usr/bin/env node` de la CLI
 * falsa.
 */
function isolatedNodeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tradia-solo-node-'));
  const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
  symlinkSync(process.execPath, join(dir, nodeName));
  return dir;
}

/**
 * PATH mínimo y determinista (sin los directorios habituales de
 * instalación de CLI de este equipo de desarrollo): las pruebas que
 * comprueban «sin CLI instalada» no dependen de si quien ejecuta la
 * batería tiene Claude Code, Codex, Antigravity o Copilot en su propio
 * PATH. Conserva un `node` aislado (necesario para el shebang de la
 * CLI falsa) y las rutas básicas del sistema para que Electron pueda
 * arrancar sus procesos auxiliares.
 */
function minimalPath(nodeDir: string): string {
  return process.platform === 'win32'
    ? [nodeDir, 'C:\\Windows\\System32', 'C:\\Windows'].join(delimiter)
    : [nodeDir, '/usr/bin', '/bin'].join(delimiter);
}

/**
 * Además del PATH, la autodetección mira ubicaciones habituales bajo
 * `$HOME` (Homebrew, `~/.local/bin`, `~/.npm-global/bin`, cada versión
 * de `~/.nvm/versions/node/*‍/bin`…). Un HOME vacío y propio hace que
 * «sin CLI instalada» sea determinista también en un equipo de
 * desarrollo que sí tiene Claude Code, Codex, Antigravity o Copilot
 * instalados de verdad.
 */
function emptyHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'tradia-sin-cli-home-'));
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  return home;
}

let context: PhaseApp | undefined;

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

// ---------------------------------------------------------------------------
// Ajustes › Análisis de noticias: desplegable de IA
// ---------------------------------------------------------------------------

async function openAiSettings(page: Page): Promise<Locator> {
  await openPage(page, 'Ajustes');
  const section = page.getByRole('region', { name: 'Análisis de noticias' });
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();
  return section;
}

test.describe('Profesional independiente que organiza varios proyectos', () => {
  test('Ajustes: el desplegable ofrece las cinco opciones y actualiza textos y campos al cambiar', async () => {
    test.setTimeout(120_000);
    const home = emptyHome();
    const nodeDir = isolatedNodeDir();
    try {
      context = await launchPhaseApp('tradia-ajustes-ia', {
        env: { PATH: minimalPath(nodeDir), HOME: home, USERPROFILE: home },
      });
      const { page } = context;
      const section = await openAiSettings(page);
      const select = section.getByLabel('Motor de análisis de noticias');

      const optionLabels = await select.locator('option').allTextContents();
      expect(optionLabels).toEqual([
        'Claude Code (Suscripción en este equipo)',
        'OpenAI Codex (Suscripción de OpenAI)',
        'Google Antigravity (Suscripción de Google)',
        'GitHub Copilot (Suscripción de GitHub)',
        'Analizador local (Sin suscripción · En este equipo)',
      ]);

      // Perfil nuevo sin ninguna CLI en el PATH: autodetecta el analizador local.
      await expect(select).toHaveValue('local');
      await expect(
        section.getByText('Analizador local preparado · Sin suscripción externa'),
      ).toBeVisible();
      await expect(section.getByLabel(/Ruta de .* \(opcional\)/)).toHaveCount(0);
      await capturePhaseScreenshot(page, 'ajustes-ia-desplegable-local.png', section);

      // Elegir Codex: el texto, la ruta condicional y el límite diario cambian.
      await select.selectOption('suscripcion-codex');
      await expect(
        section.getByText(
          'Utiliza la sesión iniciada en OpenAI Codex CLI. El analizador procesa titulares con tu cuenta.',
        ),
      ).toBeVisible();
      const pathField = section.getByLabel('Ruta de OpenAI Codex (opcional)');
      await expect(pathField).toBeVisible();
      await expect(section.getByLabel('Máximo diario')).toBeVisible();
      await expect(
        section.getByText('No se encontró el comando codex en las rutas estándar.', {
          exact: false,
        }),
      ).toBeVisible();
      await capturePhaseScreenshot(page, 'ajustes-ia-desplegable-codex.png', section);

      // Elegir Google Antigravity: descripción propia y placeholder de ruta.
      await select.selectOption('suscripcion-antigravity');
      await expect(
        section.getByText(
          'Utiliza el entorno configurado de Google Antigravity CLI para el análisis de noticias.',
        ),
      ).toBeVisible();
      await expect(section.getByLabel('Ruta de Google Antigravity (opcional)')).toBeVisible();

      // Volver a Analizador local oculta de nuevo la ruta y el límite diario.
      await select.selectOption('local');
      await expect(section.getByLabel(/Ruta de .* \(opcional\)/)).toHaveCount(0);
      await expect(section.getByLabel('Máximo diario')).toHaveCount(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(nodeDir, { recursive: true, force: true });
    }
  });

  test('Ajustes: «Probar de nuevo» sin la CLI instalada explica qué pasó y qué hacer', async () => {
    test.setTimeout(120_000);
    const home = emptyHome();
    const nodeDir = isolatedNodeDir();
    try {
      context = await launchPhaseApp('tradia-ajustes-ia-sin-cli', {
        env: { PATH: minimalPath(nodeDir), HOME: home, USERPROFILE: home },
      });
      const { page } = context;
      const section = await openAiSettings(page);
      const select = section.getByLabel('Motor de análisis de noticias');

      await select.selectOption('suscripcion-claude');
      await expect(
        section.getByText('No se encontró el comando claude en las rutas estándar.', {
          exact: false,
        }),
      ).toBeVisible();

      await section.getByRole('button', { name: 'Probar de nuevo' }).click();
      await expect(section.getByRole('alert')).toContainText('CLI no encontrada', {
        timeout: 15_000,
      });
      // El aviso de abajo (SubscriptionNotice) todavía usa el texto
      // heredado y genérico de Claude Code en vez del texto por motor de
      // docs/diseno-mercado-ia.md (sección 2.4): ver hallazgo en el
      // informe de QA. Se deja constancia de ambos textos reales.
      await expect(page.getByRole('status', { name: 'Estado de la suscripción' })).toContainText(
        'Suscripción no disponible · CLI no encontrada',
      );
      await capturePhaseScreenshot(page, 'ajustes-ia-cli-no-encontrada.png', section);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(nodeDir, { recursive: true, force: true });
    }
  });
});

test.describe('Responsable de equipo que revisa entregas', () => {
  test('Ajustes: una CLI instalada se autodetecta en el desplegable y «Probar de nuevo» confirma la sesión', async () => {
    test.setTimeout(120_000);
    const fakeRoot = mkdtempSync(join(tmpdir(), 'tradia-fake-claude-'));
    const binDir = join(fakeRoot, 'bin');
    const nodeDir = isolatedNodeDir();
    try {
      const cliPath = installFakeClaudeCli(binDir);
      context = await launchPhaseApp('tradia-ajustes-ia-con-cli', {
        env: {
          // El hijo de Electron hereda este PATH: encuentra la CLI falsa
          // exactamente igual que encontraría una instalación real, y
          // solo ella (PATH mínimo + su directorio).
          PATH: `${binDir}${delimiter}${minimalPath(nodeDir)}`,
        },
      });
      const { page } = context;
      const section = await openAiSettings(page);
      const select = section.getByLabel('Motor de análisis de noticias');

      // Autodetección al abrir, sin que el usuario tenga que elegir nada.
      await expect(select).toHaveValue('suscripcion-claude');
      await expect(
        section.getByText(/Ejecutable detectado automáticamente: .*claude/),
      ).toBeVisible();
      await capturePhaseScreenshot(page, 'ajustes-ia-cli-detectada.png', section);

      await section.getByRole('button', { name: 'Probar de nuevo' }).click();
      await expect(section.getByText(/Suscripción disponible · Claude Code responde/)).toBeVisible({
        timeout: 15_000,
      });
      await capturePhaseScreenshot(page, 'ajustes-ia-conexion-correcta.png', section);
      expect(cliPath).toContain('claude');
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
      rmSync(nodeDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Mercado: buscador de activos y gráfico de velas con EUR/USD
// ---------------------------------------------------------------------------

async function addViaSearch(page: Page, query: string, resultName: RegExp): Promise<void> {
  const search = page.getByLabel('Buscar activo o divisa');
  await search.fill(query);
  const option = page.getByRole('option', { name: resultName });
  await expect(option).toBeVisible({ timeout: 10_000 });
  await option.getByRole('button', { name: '+ Añadir' }).click();
}

async function waitForCandles(page: Page, ticker: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          async (symbol) => (await window.tradia.market.getBars({ ticker: symbol })).bars.length,
          ticker,
        ),
      { timeout: 90_000 },
    )
    .toBeGreaterThan(0);
}

test.describe('Profesional independiente que organiza varios proyectos', () => {
  test('Mercado: el buscador encuentra EUR/USD y Apple, y los añade con un clic o el teclado', async () => {
    test.setTimeout(120_000);
    context = await launchPhaseApp('tradia-mercado-buscador');
    const { page } = context;
    await openPage(page, 'Mercado');
    await expect(page.getByText('Tu lista está vacía.')).toBeVisible();

    // Buscar «EUR» sugiere el par de divisas con su badge y lo añade.
    await addViaSearch(page, 'EUR', /EUR\/USD/);
    await expect(page.getByRole('status').filter({ hasText: 'EUR/USD se ha añadido' })).toBeVisible();
    await waitForCandles(page, 'EURUSD');
    await expect(page.getByRole('heading', { name: 'EUR/USD', level: 3 })).toBeVisible();
    await expect(page.getByText('Divisa Forex 24/5')).toBeVisible();
    await capturePhaseScreenshot(page, 'mercado-buscador-eurusd-anadido.png');

    // Buscar «Apple» y añadirla navegando con el teclado (flecha + Enter).
    // El puntero se aparta primero: si quedara sobre la primera
    // sugerencia, su `onMouseEnter` adelantaría el resaltado y la
    // primera flecha pasaría a la segunda opción en vez de a la mejor.
    const search = page.getByLabel('Buscar activo o divisa');
    await page.mouse.move(0, 0);
    await search.fill('Apple');
    const aaplOption = page.getByRole('option', { name: /AAPL/ });
    await expect(aaplOption).toBeVisible({ timeout: 10_000 });
    const aaplOptionId = await aaplOption.getAttribute('id');
    await search.press('ArrowDown');
    await expect(search).toHaveAttribute('aria-activedescendant', aaplOptionId!);
    await search.press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'AAPL se ha añadido' })).toBeVisible();

    // Ambos activos conviven en la lista; EUR/USD no se pausa ni se bloquea.
    const watch = page.getByRole('complementary', { name: 'Lista de seguimiento' });
    await expect(watch.getByRole('button', { name: 'EUR/USD', exact: true })).toBeVisible();
    await expect(watch.getByRole('button', { name: 'AAPL', exact: true })).toBeVisible();
    await expect(watch.getByText('Divisa', { exact: true })).toBeVisible();
  });

  test('Mercado: buscar un símbolo inexistente explica qué hacer sin romper el buscador', async () => {
    test.setTimeout(60_000);
    context = await launchPhaseApp('tradia-mercado-buscador-vacio');
    const { page } = context;
    await openPage(page, 'Mercado');
    const search = page.getByLabel('Buscar activo o divisa');
    // Con espacios no es un ticker directo añadible: solo cabe el estado
    // sin resultados (un «zzznoexiste» de un solo token sí lo sería).
    await search.fill('activo totalmente inventado');
    await expect(
      page.getByText(/No encontramos ningún activo para/, { exact: false }),
    ).toBeVisible({ timeout: 10_000 });
    await search.fill('');
    await expect(page.getByRole('listbox', { name: 'Sugerencias de activos' })).toHaveCount(0);
  });
});

test.describe('Responsable de equipo que revisa entregas', () => {
  test('Mercado: el gráfico de velas de EUR/USD alterna RSI/ATR, cambia de rango y no desborda a 1280×800 ni 1024×700', async () => {
    test.setTimeout(150_000);
    context = await launchPhaseApp('tradia-mercado-grafico');
    const { page, app } = context;
    await page.setViewportSize({ width: 1280, height: 800 });
    await openPage(page, 'Mercado');
    await addViaSearch(page, 'EUR', /EUR\/USD/);
    await waitForCandles(page, 'EURUSD');
    const chartCard = page.locator('.market-chart-card');
    await expect(chartCard).toBeVisible();
    const chart = page.getByRole('img', { name: /Velas diarias ajustadas de EUR\/USD/ });
    await expect(chart).toBeVisible();

    // Cotización de divisa a 4 decimales, como pide el diseño.
    await expect(page.locator('.market-close')).toHaveText(/^\d\,\d{4} EUR\/USD$/);

    // Paneles RSI/ATR conmutables: el nombre accesible del lienzo lo refleja.
    const rsiToggle = page.getByRole('button', { name: /Panel RSI 14/ });
    const atrToggle = page.getByRole('button', { name: /Panel ATR 14/ });
    await expect(rsiToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(atrToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(chart).toHaveAccessibleName(/panel RSI 14/);
    await expect(chart).toHaveAccessibleName(/panel ATR 14/);

    await rsiToggle.click();
    await expect(rsiToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(chart).not.toHaveAccessibleName(/panel RSI 14/);
    await expect(chart).toHaveAccessibleName(/panel ATR 14/);

    await atrToggle.click();
    await expect(atrToggle).toHaveAttribute('aria-pressed', 'false');
    await expect(chart).not.toHaveAccessibleName(/panel ATR 14/);
    await capturePhaseScreenshot(page, 'mercado-grafico-sin-paneles-1280.png', chartCard);

    // Vuelven a activarse para comprobar el tooltip OHLCV con ambos paneles.
    await rsiToggle.click();
    await atrToggle.click();
    await expect(rsiToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(atrToggle).toHaveAttribute('aria-pressed', 'true');

    // Cambio de rango temporal: el botón activo lleva aria-pressed.
    const ranges = page.getByRole('group', { name: 'Rango del gráfico' });
    await expect(ranges.getByRole('button', { name: '5A' })).toHaveAttribute('aria-pressed', 'true');
    await ranges.getByRole('button', { name: '1A' }).click();
    await expect(ranges.getByRole('button', { name: '1A' })).toHaveAttribute('aria-pressed', 'true');
    await expect(ranges.getByRole('button', { name: '5A' })).toHaveAttribute('aria-pressed', 'false');
    await ranges.getByRole('button', { name: '3A' }).click();
    await expect(ranges.getByRole('button', { name: '3A' })).toHaveAttribute('aria-pressed', 'true');

    // Tooltip/crosshair OHLCV: la barra de lectura muestra apertura/máximo/mínimo/cierre.
    const ohlcv = page.locator('.ohlcv-bar');
    await expect(ohlcv).toBeVisible();
    await expect(ohlcv).toContainText('Apertura:');
    await expect(ohlcv).toContainText('Máximo:');
    await expect(ohlcv).toContainText('Mínimo:');
    await expect(ohlcv).toContainText('Cierre:');

    await capturePhaseScreenshot(page, 'mercado-grafico-eurusd-1280x800.png', chartCard);
    const overflow1280 = await chartCard.evaluate(
      (el) => el.scrollWidth - el.clientWidth,
    );
    expect(overflow1280).toBeLessThanOrEqual(1);

    // Resolución compacta: el gráfico se adapta sin desbordamiento horizontal.
    await page.setViewportSize({ width: 1024, height: 700 });
    await expect(chartCard).toBeVisible();
    await capturePhaseScreenshot(page, 'mercado-grafico-eurusd-1024x700.png', chartCard);
    const overflow1024 = await chartCard.evaluate(
      (el) => el.scrollWidth - el.clientWidth,
    );
    expect(overflow1024).toBeLessThanOrEqual(1);
    const workspaceOverflow = await page
      .locator('.market-workspace')
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(workspaceOverflow).toBeLessThanOrEqual(1);

    expect(app).toBeTruthy();
  });
});
