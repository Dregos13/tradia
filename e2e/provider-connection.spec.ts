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
 * «Probar conexión» de Tiingo y FRED en Ajustes › Proveedores de datos
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

/** Texto esperado de la línea de resultado para cada estado, salvo «Conectado». */
const EXPECTED: Record<Exclude<ProviderTestStatus, 'ok'>, (name: string) => RegExp> = {
  'sin-clave': (name) =>
    new RegExp(`^Sin clave · Falta la clave de ${name}\\. Pégala arriba y pulsa «Guardar clave de ${name}»\\.$`),
  'clave-rechazada': (name) =>
    new RegExp(
      `^Clave rechazada · ${name} ha rechazado la clave\\. Comprueba que la has copiado entera o genera una nueva en tu cuenta\\.$`,
    ),
  cuota: (name) =>
    new RegExp(
      `^Cuota agotada · Has agotado la cuota de peticiones de ${name}\\. Se renueva sola; vuelve a probar más tarde\\.$`,
    ),
  'sin-red': () =>
    /^Sin red · No hay conexión a internet\. Tradia volverá a intentarlo al recuperar la red\.$/,
  error: (name) =>
    new RegExp(
      `^Error del proveedor · ${name} no ha respondido como esperábamos: El proveedor no respondió como se esperaba\\.+ Vuelve a probar; si se repite, revisa el estado del servicio\\.$`,
    ),
};

/** Acción que ofrece cada estado bajo la línea de resultado. */
const ACTION: Record<ProviderTestStatus, string> = {
  ok: 'Actualizar datos ahora',
  'sin-clave': 'Añadir clave',
  'clave-rechazada': 'Cambiar clave',
  cuota: 'Probar de nuevo',
  'sin-red': 'Probar de nuevo',
  error: 'Probar de nuevo',
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
  form.getByRole('button', { name: /^(Probar conexión|Probando…)$/ });

async function armNext(page: Page, provider: Provider, status: ProviderTestStatus) {
  const armed = await page.evaluate(
    (request) => window.tradia.testing!.providers.simulateTest(request),
    { provider: provider.id, status },
  );
  expect(armed).toEqual({ provider: provider.id, armed: status });
}

async function openProviders(page: Page): Promise<void> {
  await openPage(page, 'Ajustes');
  const section = page.getByRole('region', { name: 'Proveedores de datos' });
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
    /^Conectado · Conectado\. Último dato disponible: \d{1,2} [a-z]+\.? \d{4}\. Comprobado hoy a las \d{2}:\d{2} \(\d+ ms\)\.$/,
  );
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
        'Sin probar · Aún no has probado la conexión.',
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
          // «Probar de nuevo» repite la prueba: el gancho ya se consumió.
          await form.getByRole('button', { name: 'Probar de nuevo', exact: true }).click();
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
    const secrets = { tiingo: 'tiingo-E2E-clave-secreta-7731', fred: 'fred-E2E-clave-secreta-4410' };
    await openProviders(page);

    for (const provider of PROVIDERS) {
      const form = providerForm(page, provider);
      await expect(form.getByText('Sin clave guardada', { exact: true })).toBeVisible();
      await form.getByLabel(`Clave de API de ${provider.name}`).fill(secrets[provider.id]);
      await form.getByRole('button', { name: `Guardar clave de ${provider.name}` }).click();
      await expect(form.getByText('Guardada y cifrada', { exact: true })).toBeVisible();
      await expect(form.getByLabel(`Clave de API de ${provider.name}`)).toHaveValue('');
      await runTest(form);
      await expectConnected(page, provider);
      await armNext(page, provider, 'clave-rechazada');
      await runTest(form);
      await expect(testButton(form)).toHaveAccessibleDescription(/^Clave rechazada · /);

      // Guardar otra clave borra el resultado anterior y no prueba sola.
      await form.getByLabel(`Clave de API de ${provider.name}`).fill(`${secrets[provider.id]}-b`);
      await form.getByRole('button', { name: `Guardar clave de ${provider.name}` }).click();
      await expect(testButton(form)).toHaveAccessibleDescription(
        'Sin probar · Aún no has probado la conexión.',
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
    await expect(testButton(tiingo)).toHaveAccessibleDescription(
      EXPECTED['sin-red']('Tiingo'),
    );
    await capturePhaseScreenshot(page, 'continuacion-probar-conexion-sin-red.png', tiingo);
    await page.evaluate(() => window.tradia.testing!.simulateOffline(false));
    await tiingo.getByRole('button', { name: 'Probar de nuevo', exact: true }).click();
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
