import { expect, test, type Locator, type Page } from '@playwright/test';
import type { ProviderTestStatus } from '../src/shared/ipc';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
  type PhaseApp,
} from './phase-6-7.helpers';

/**
 * «Probar conexión» de Tiingo y FRED en Ajustes › Conectores de datos
 * (docs/diseno-tour-guiado.md, sección 3). En modo E2E el sondeo usa los
 * proveedores simulados; `providers.simulateTest` fuerza el resultado de
 * la próxima prueba (se consume una vez) para recorrer los seis estados
 * del contrato. La clave nunca debe volver: ni en el resultado, ni en la
 * pantalla, ni en el registro del proceso principal.
 */

const PROVIDERS = [
  { id: 'tiingo', name: 'Tiingo', account: 'https://www.tiingo.com/account/api/token' },
  { id: 'fred', name: 'FRED', account: 'https://fredaccount.stlouisfed.org/apikeys' },
] as const;
type Provider = (typeof PROVIDERS)[number];

/** Texto esperado de la línea de resultado para cada estado, salvo «Funciona». */
const EXPECTED: Record<Exclude<ProviderTestStatus, 'ok'>, (name: string) => RegExp> = {
  'sin-clave': (name) => new RegExp(`Sin clave\\s+Falta la clave de ${name}`),
  'clave-rechazada': (name) => new RegExp(`Clave no válida\\s+La clave de ${name} no es válida`),
  cuota: (name) => new RegExp(`Límite alcanzado\\s+${name} no admite más consultas por ahora`),
  'sin-red': (name) =>
    new RegExp(`Sin conexión\\s+Tradia no puede contactar con ${name} sin internet`),
  error: (name) => new RegExp(`No responde\\s+${name} no responde`),
};
const ACTION: Record<ProviderTestStatus, string> = {
  ok: 'Actualizar datos ahora',
  'sin-clave': 'Añadir clave',
  'clave-rechazada': 'Revisar la clave',
  cuota: 'Probar conexión',
  'sin-red': 'Probar conexión',
  error: 'Probar conexión',
};

let context: PhaseApp | undefined;
let mainLog: string[] = [];

test.beforeEach(async () => {
  context = await launchPhaseApp('tradia-providers-e2e');
  mainLog = [];
  const child = context.app.process();
  child.stdout?.on('data', (chunk: Buffer) => mainLog.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => mainLog.push(chunk.toString()));
});

test.afterEach(async () => {
  await closePhaseApp(context);
  context = undefined;
});

const providerForm = (page: Page, provider: Provider) =>
  page.getByRole('form', { name: `Proveedor ${provider.name}` });

/** «Probar conexión» lleva su resultado como descripción accesible. */
const testButton = (form: Locator) =>
  form.getByRole('button', { name: /^(Probar conexión|Comprobando…)$/ });

async function armNext(page: Page, provider: Provider, status: ProviderTestStatus) {
  const armed = await page.evaluate(
    (request) => window.tradia.testing!.providers.simulateTest(request),
    { provider: provider.id, status },
  );
  expect(armed).toEqual({ provider: provider.id, armed: status });
}

async function openProviders(page: Page): Promise<void> {
  await openPage(page, 'Ajustes');
  const section = page.getByRole('region', { name: 'Conectores de datos' });
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();
}

/** Pulsa «Probar conexión» y espera a que deje de probar. */
async function runTest(form: Locator): Promise<void> {
  const button = testButton(form);
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toHaveText('Probar conexión', { timeout: 15_000 });
}

async function expectConnected(page: Page, provider: Provider): Promise<void> {
  const form = providerForm(page, provider);
  const description = await testButton(form).evaluate(
    (element) => document.getElementById(element.getAttribute('aria-describedby')!)!.innerText,
  );
  expect(description).toMatch(
    new RegExp(`Funciona\\s+${provider.name} responde y sus datos están disponibles`),
  );
  await expect(form.getByText('Última comprobación', { exact: true })).toBeVisible();
  await expect(form.locator('.connector-meta')).toContainText(/hoy a las/);
  await expect(form.getByRole('button', { name: ACTION.ok })).toBeVisible();
}

for (const provider of PROVIDERS) {
  test.describe('Profesional independiente que organiza varios proyectos', () => {
    test(`${provider.name}: «Probar conexión» recorre los seis estados con su motivo y su acción`, async () => {
      test.setTimeout(120_000);
      const { page } = context!;
      await openProviders(page);
      const form = providerForm(page, provider);
      await expect(testButton(form)).toHaveAccessibleDescription(
        'Sin comprobar Aún no has comprobado la conexión.',
      );

      // Sin gancho armado: el sondeo simulado responde con su último dato real.
      await runTest(form);
      await expectConnected(page, provider);
      const direct = await page.evaluate(
        (id) => window.tradia.providers.testConnection({ provider: id }),
        provider.id,
      );
      expect(direct).toMatchObject({ provider: provider.id, status: 'ok' });
      expect(direct.latestDataDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const providerStatus = await page.evaluate(
        async (key) => (await window.tradia.dataStatus.get()).find((entry) => entry.key === key),
        `provider:${provider.id}`,
      );
      expect(providerStatus?.state).toBe('fiable');
      // Conector que funciona: una sola acción en «Siguiente paso»; «Probar conexión» queda aparte.
      const next = form.locator('.connector-next');
      await expect(next.getByRole('button')).toHaveText(['Actualizar datos ahora']);
      await expect(next.getByRole('button', { name: 'Probar conexión' })).toHaveCount(0);
      await expect(testButton(form)).toBeVisible();
      await capturePhaseScreenshot(
        page,
        `continuacion-probar-conexion-${provider.id}-conectado.png`,
        form,
      );

      for (const status of ['sin-clave', 'clave-rechazada', 'cuota', 'sin-red', 'error'] as const) {
        await armNext(page, provider, status);
        await runTest(form);
        const description = await testButton(form).evaluate(
          (element) =>
            document.getElementById(element.getAttribute('aria-describedby')!)!.innerText,
        );
        expect(description, `estado ${status}`).toMatch(EXPECTED[status](provider.name));
        await expect(form.getByRole('button', { name: ACTION[status], exact: true })).toBeVisible();
        if (status === 'sin-clave' || status === 'clave-rechazada') {
          await form.getByRole('button', { name: ACTION[status], exact: true }).click();
          await expect(form.getByLabel(`Clave de API de ${provider.name}`)).toBeFocused();
        }
        if (status === 'clave-rechazada') {
          await expect(form.getByLabel(`Clave de API de ${provider.name}`)).toBeFocused();
          const account = form.getByRole('link', {
            name: `Abrir mi cuenta de ${provider.name} (abre en el navegador)`,
          });
          await expect(account).toHaveAttribute('href', provider.account);
          // El aviso «(abre en el navegador)» es solo para lector de pantalla.
          await expect(account).toHaveText(
            `Abrir mi cuenta de ${provider.name} (abre en el navegador)`,
          );
          const hint = account.getByText('(abre en el navegador)');
          const box = await hint.boundingBox();
          expect(box === null || (box.width <= 1 && box.height <= 1)).toBe(true);
          await capturePhaseScreenshot(
            page,
            `continuacion-probar-conexion-${provider.id}-clave-rechazada.png`,
            form,
          );
        }
        if (status === 'cuota' || status === 'sin-red' || status === 'error') {
          // «Probar conexión» repite la prueba: el gancho ya se consumió.
          await form.getByRole('button', { name: 'Probar conexión', exact: true }).click();
          await expect(testButton(form)).toHaveText('Probar conexión', { timeout: 15_000 });
          await expectConnected(page, provider);
        }
      }
    });
  });
}

test.describe('Responsable de equipo que revisa entregas', () => {
  test('la clave nunca vuelve, sin red real da «Sin red» y los enlaces llevan al botón del proveedor', async () => {
    test.setTimeout(120_000);
    const { page } = context!;
    const secrets = {
      tiingo: 'tiingo-E2E-clave-secreta-7731',
      fred: 'fred-E2E-clave-secreta-4410',
    };
    await openProviders(page);

    for (const provider of PROVIDERS) {
      const form = providerForm(page, provider);
      await form.getByText(`Cambiar clave de ${provider.name}`, { exact: true }).click();
      await expect(form.getByText('Sin clave guardada', { exact: true })).toBeVisible();
      await form.getByLabel(`Clave de API de ${provider.name}`).fill(secrets[provider.id]);
      await form.getByRole('button', { name: `Guardar clave de ${provider.name}` }).click();
      await expect(form.getByText('Guardada y cifrada', { exact: true })).toBeVisible();
      await expect(form.getByLabel(`Clave de API de ${provider.name}`)).toHaveValue('');
      await runTest(form);
      await expectConnected(page, provider);
      await armNext(page, provider, 'clave-rechazada');
      await runTest(form);
      await expect(testButton(form)).toHaveAccessibleDescription(/^Clave no válida /);

      // Guardar otra clave borra el resultado anterior y no prueba sola.
      await form.getByLabel(`Clave de API de ${provider.name}`).fill(`${secrets[provider.id]}-b`);
      await form.getByRole('button', { name: `Guardar clave de ${provider.name}` }).click();
      await expect(testButton(form)).toHaveAccessibleDescription(
        'Sin comprobar Aún no has comprobado la conexión.',
      );
    }

    // Ni el resultado por IPC, ni la pantalla, ni data-status, ni el registro la contienen.
    const results = await page.evaluate(async () => [
      await window.tradia.providers.testConnection({ provider: 'tiingo' }),
      await window.tradia.providers.testConnection({ provider: 'fred' }),
    ]);
    const exposed = JSON.stringify({
      results,
      status: await page.evaluate(() => window.tradia.dataStatus.get()),
      html: await page.content(),
      log: mainLog.join(''),
    });
    for (const secret of Object.values(secrets)) {
      expect(exposed).not.toContain(secret);
      expect(exposed).not.toContain(secret.slice(0, 12));
      expect(exposed).not.toContain(secret.slice(-8));
    }

    // Sin red de verdad (sin gancho): la prueba corta en local con «Sin red».
    await page.evaluate(() => window.tradia.testing!.simulateOffline(true));
    const tiingo = providerForm(page, PROVIDERS[0]);
    await runTest(tiingo);
    await expect(testButton(tiingo)).toHaveAccessibleDescription(EXPECTED['sin-red']('Tiingo'));
    await capturePhaseScreenshot(page, 'continuacion-probar-conexion-sin-red.png', tiingo);
    await page.evaluate(() => window.tradia.testing!.simulateOffline(false));
    await tiingo.getByRole('button', { name: 'Probar conexión', exact: true }).click();
    await expect(testButton(tiingo)).toHaveText('Probar conexión', { timeout: 15_000 });
    await expectConnected(page, PROVIDERS[0]);

    // Enlaces profundos de las franjas: foco en el control del proveedor.
    await openPage(page, 'Inicio', 'Estado del sistema');
    await page.evaluate(() => {
      window.location.hash = 'ajustes?provider=fred&focus=test';
    });
    await expect(testButton(providerForm(page, PROVIDERS[1]))).toBeFocused({ timeout: 10_000 });
    await page.evaluate(() => {
      window.location.hash = 'ajustes?provider=tiingo&focus=key';
    });
    await expect(page.getByLabel('Clave de API de Tiingo')).toBeFocused({ timeout: 10_000 });

    // La validación del gancho rechaza estados fuera del contrato.
    await expect(
      page.evaluate(() =>
        window.tradia.testing!.providers.simulateTest({
          provider: 'tiingo',
          status: 'caido' as never,
        }),
      ),
    ).rejects.toThrow(/estado del contrato/);
  });
});

test('las tarjetas de Conectores se leen en ambos temas, ventanas estrechas y zoom al 200 %', async () => {
  const { page, app } = context!;
  await openProviders(page);
  const tiingo = providerForm(page, PROVIDERS[0]);
  await runTest(tiingo);
  await expectConnected(page, PROVIDERS[0]);
  await armNext(page, PROVIDERS[1], 'clave-rechazada');
  const fred = providerForm(page, PROVIDERS[1]);
  await runTest(fred);
  await expect(fred.getByLabel('Clave de API de FRED')).toBeFocused();
  for (const [width, theme, zoom] of [
    [1280, 'light', 1],
    [760, 'light', 1],
    [640, 'dark', 1],
    [1280, 'dark', 2],
  ] as const) {
    await page.setViewportSize({ width, height: 800 });
    await app.evaluate(
      ({ nativeTheme, BrowserWindow }, settings) => {
        nativeTheme.themeSource = settings.theme;
        BrowserWindow.getAllWindows()[0]!.webContents.setZoomFactor(settings.zoom);
      },
      { theme, zoom },
    );
    await page.emulateMedia({ colorScheme: theme });
    for (const form of [tiingo, fred]) {
      await expect(form.getByText('Última comprobación', { exact: true })).toBeVisible();
      const metrics = await form.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const button = element.querySelector('button')!.getBoundingClientRect();
        return {
          width: rect.width,
          scrollWidth: element.scrollWidth,
          height: button.height,
          controlWidth: button.width,
        };
      });
      expect(metrics.scrollWidth).toBeLessThanOrEqual(Math.ceil(metrics.width));
      expect(metrics.height).toBeGreaterThanOrEqual(44);
      expect(metrics.controlWidth).toBeGreaterThanOrEqual(44);
    }
    await tiingo.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/tradia-connectors-${width}-${theme}-${zoom}.png` });
  }
  const review = fred.getByRole('button', { name: 'Revisar la clave' });
  await review.focus();
  await page.keyboard.press('Enter');
  await expect(fred.getByLabel('Clave de API de FRED')).toBeFocused();
});
