import { expect, test, type Page } from '@playwright/test';
import {
  capturePhaseScreenshot,
  closePhaseApp,
  launchPhaseApp,
  openPage,
  relaunchPhaseApp,
  watchTickers,
  type LocalRoute,
  type PhaseApp,
} from '../e2e/phase-6-7.helpers';
import { makeLog } from './qa.helpers';

// QA exploratorio · Perfil A «Profesional independiente que organiza varios proyectos».
const { note, step } = makeLog('perfil-a');
const shot = async (page: Page, name: string, target?: Parameters<typeof capturePhaseScreenshot>[2]) => {
  if ((await page.locator('.main').count()) === 0) {
    await page.screenshot({ path: `docs/qa/capturas/qa-continuacion-a-${name}.png` });
    return;
  }
  await capturePhaseScreenshot(page, `qa-continuacion-a-${name}.png`, target).catch(() =>
    page.screenshot({ path: `docs/qa/capturas/qa-continuacion-a-${name}.png` }),
  );
};
const tour = (page: Page) => page.getByRole('dialog', { name: /^Paso \d+ de 10\./ });

const LONG = 'Apple and Microsoft extend partnership '.repeat(6).trim();
const feeds: LocalRoute = (request, response) => {
  const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (path !== '/agencia') return false;
  const published = new Date().toUTCString();
  const items = [
    { id: 'qa-aapl', title: 'Apple beats estimates as iPhone sales surge' },
    { id: 'qa-long', title: LONG },
  ]
    .map(
      ({ id, title }) =>
        `<item><title>${title}</title><link>https://example.test/${id}</link><guid>${id}</guid><pubDate>${published}</pubDate></item>`,
    )
    .join('');
  response.writeHead(200, { 'content-type': 'application/rss+xml; charset=utf-8' });
  response.end(
    `<?xml version="1.0"?><rss version="2.0"><channel><title>QA</title><link>https://example.test</link><description>x</description>${items}</channel></rss>`,
  );
  return true;
};

let ctx: PhaseApp | undefined;
test.afterAll(async () => closePhaseApp(ctx));

test('perfil A', async () => {
  ctx = await launchPhaseApp('qa-cont-a', { onboarding: 'manual', route: feeds });
  let page = ctx.page;

  await step('1. Primer arranque: aviso de riesgo antes que el tour', async () => {
    await expect(page.getByRole('heading', { name: 'Antes de empezar' })).toBeVisible({ timeout: 30_000 });
    note('tour visible antes de aceptar', await tour(page).count());
    await shot(page, 'aviso-riesgo');
    // Solo teclado.
    for (let i = 0; i < 12; i++) {
      const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.slice(0, 40) ?? '');
      if (/He leído/.test(focused) || (await page.getByLabel('He leído y acepto').evaluate((el) => el === document.activeElement))) break;
      await page.keyboard.press('Tab');
    }
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(tour(page)).toBeVisible({ timeout: 15_000 });
    note('título paso 1', await tour(page).getByRole('heading', { level: 2 }).innerText());
    note('foco al abrir', await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.textContent?.slice(0, 60)}`));
    await shot(page, 'tour-paso-1');
  });

  await step('2. Tour con teclado hasta el paso 4 y pausa con Esc', async () => {
    const d = tour(page);
    await d.getByRole('button', { name: 'Empezar' }).focus();
    await page.keyboard.press('Enter');
    for (let n = 2; n <= 4; n++) {
      const title = await d.getByRole('heading', { level: 2 }).innerText();
      const hash = await page.evaluate(() => location.hash);
      note(`paso ${n}`, { title, hash, text: (await d.innerText()).slice(0, 260) });
      await shot(page, `tour-paso-${n}`);
      if (n < 4) await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    note('anuncio pausa', await page.getByRole('status').filter({ hasText: 'Tour en pausa' }).innerText().catch(() => 'sin anuncio'));
    note('foco tras pausa', await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.textContent?.slice(0, 60)}`));
  });

  await step('3. Inicio: «Primeros pasos» y retomar', async () => {
    await openPage(page, 'Inicio', 'Estado del sistema');
    const first = page.getByRole('region', { name: 'Primeros pasos' });
    note('primeros pasos', await first.innerText());
    await shot(page, 'primeros-pasos', first);
  });

  await step('4. Reabrir la app: el tour vuelve en el paso 4 y el aviso no reaparece', async () => {
    ctx = await relaunchPhaseApp(ctx!);
    page = ctx.page;
    await expect(tour(page)).toBeVisible({ timeout: 30_000 });
    note('aviso de riesgo tras relanzar', await page.getByRole('heading', { name: 'Antes de empezar' }).count());
    note('paso al relanzar', await tour(page).getByRole('heading', { level: 2 }).innerText());
    // Resto del tour con el ratón, revisando cada paso.
    for (let i = 0; i < 10; i++) {
      const d = tour(page);
      const title = await d.getByRole('heading', { level: 2 }).innerText();
      const hash = await page.evaluate(() => location.hash);
      const buttons = await d.getByRole('button').allInnerTexts();
      note('paso', { title, hash, buttons });
      if (/Paso (5|6|7|8|9|10) de 10/.test(title)) await shot(page, `tour-${title.match(/Paso (\d+)/)![1]}`);
      if (/Paso 10 de 10/.test(title)) break;
      await d.getByRole('button', { name: 'Siguiente' }).click();
    }
    // Paso 6: comprobar que la parada no se ha pulsado.
    await tour(page).getByRole('button', { name: 'Terminar y añadir claves' }).click();
    await expect(tour(page)).toHaveCount(0);
    note('foco final', await page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.id}`));
    note('kill switch', await page.evaluate(() => window.tradia.risk?.killSwitch?.().catch?.(() => null) ?? null).catch(() => 'n/d'));
    note('estado tour', await page.evaluate(() => window.tradia.settings.get().then((s: any) => ({ v: s.onboardingTourVersion, at: s.onboardingTourCompletedAt, step: s.onboardingTourStep }))));
    await shot(page, 'tour-terminado-ajustes');
  });

  await step('5. «Probar conexión» sin clave guardada y con clave', async () => {
    const providers = page.getByRole('region', { name: 'Proveedores de datos' });
    note('proveedores (inicio)', (await providers.innerText()).slice(0, 900));
    for (const name of ['Tiingo', 'FRED']) {
      const form = page.getByRole('form', { name: `Proveedor ${name}` });
      await form.getByRole('button', { name: 'Probar conexión' }).click();
      await expect(form.getByRole('button', { name: 'Probar conexión' })).toBeVisible({ timeout: 20_000 });
      note(`${name} sin clave guardada`, await form.innerText());
    }
    await shot(page, 'probar-conexion-inicial', providers);
    await page.evaluate(() => window.tradia.testing!.providers.simulateTest({ provider: 'tiingo', status: 'sin-clave' }));
    const tiingo = page.getByRole('form', { name: 'Proveedor Tiingo' });
    await tiingo.getByRole('button', { name: 'Probar conexión' }).click();
    await page.waitForTimeout(1000);
    note('Tiingo sin-clave', await tiingo.innerText());
    await tiingo.getByRole('button', { name: 'Añadir clave' }).click().catch(() => undefined);
    note('foco tras Añadir clave', await page.evaluate(() => document.activeElement?.id));
    await shot(page, 'probar-conexion-sin-clave', tiingo);
    for (const status of ['clave-rechazada', 'cuota', 'sin-red', 'error'] as const) {
      await page.evaluate((s) => window.tradia.testing!.providers.simulateTest({ provider: 'fred', status: s }), status);
      const fred = page.getByRole('form', { name: 'Proveedor FRED' });
      await fred.getByRole('button', { name: /Probar conexión|Probar de nuevo|Cambiar clave|Añadir clave/ }).first().click();
      await page.waitForTimeout(1000);
      note(`FRED ${status}`, await fred.innerText());
      if (status === 'error') await shot(page, 'probar-conexion-error', fred);
    }
    const result = await page.evaluate(() => window.tradia.providers.testConnection({ provider: 'tiingo' }));
    note('resultado IPC tiingo', result);
  });

  await step('6. Mercado: seguir cuatro activos', async () => {
    await watchTickers(page, ['SPY', 'QQQ', 'AAPL', 'MSFT']);
    note('frescura', await page.evaluate(() => window.tradia.dataStatus.freshness()));
    await openPage(page, 'Inicio', 'Estado del sistema');
    note('primeros pasos tras datos', await page.getByRole('region', { name: 'Primeros pasos' }).innerText().catch(() => 'no visible'));
    await shot(page, 'inicio-con-datos');
  });

  await step('7. IA: predicción vigente y ficha del modelo', async () => {
    await openPage(page, 'IA');
    const preds = page.getByRole('region', { name: 'Predicciones por activo' });
    const rows = await preds.getByRole('row').count();
    note('filas tabla vigente (con cabecera)', rows);
    note('tabla vigente', (await preds.innerText()).slice(0, 1200));
    note('histórico', await page.getByRole('region', { name: 'Histórico de predicciones' }).count());
    await shot(page, 'ia-prediccion-vigente', page.locator('#ai-predictions-title'));
    await preds.getByRole('button', { name: 'Ver ficha del modelo' }).first().click();
    await page.waitForTimeout(500);
    note('tras ver ficha', { hash: await page.evaluate(() => location.hash), h1: await page.getByRole('heading', { level: 1 }).innerText(), focus: await page.evaluate(() => document.activeElement?.id) });
    await page.screenshot({ path: 'docs/qa/capturas/qa-continuacion-a-ia-ficha-modelo.png' });
  });

  await step('8. Noticias: titular de agencia y titular largo', async () => {
    await page.evaluate(async (url) => {
      await window.tradia.sources.add({ name: 'Agencia QA', kind: 'rss', connector: 'rss', url, reliability: 'agencia' });
      await window.tradia.testing!.pollNewsNow();
    }, ctx!.url('/agencia'));
    await expect.poll(async () => (await page.evaluate(() => window.tradia.news.list({}))).filter((i) => i.title.startsWith('Apple')).length, { timeout: 30_000 }).toBeGreaterThan(0);
    await openPage(page, 'Noticias');
    const card = page.getByTestId('news-item').filter({ hasText: 'Apple beats' }).first();
    note('tarjeta', await card.innerText());
    const visible = await page.getByText('(abre en el navegador externo)').first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, clip: getComputedStyle(el).clip, pos: getComputedStyle(el).position };
    }).catch(() => 'no existe');
    note('sr-only navegador externo', visible);
    const long = page.getByTestId('news-item').filter({ hasText: 'extend partnership' }).first();
    note('largo overflow', await long.evaluate((el) => el.scrollWidth > el.clientWidth + 1).catch(() => 'n/d'));
    await shot(page, 'noticias', card);
  });

  await step('9. Datos desactualizados: proveedor caído y pasa un cierre', async () => {
    await page.evaluate(async () => {
      await window.tradia.testing!.simulateProviderFailure(true);
      await window.tradia.testing!.advanceMarketClock(24 * 3600 * 1000);
    });
    await expect.poll(async () => (await page.evaluate(() => window.tradia.dataStatus.freshness())).state, { timeout: 30_000 }).toBe('stale');
    note('resumen', await page.evaluate(() => window.tradia.dataStatus.freshness()));
    for (const [link, h] of [['Inicio', 'Estado del sistema'], ['Mercado', 'Mercado'], ['Macro', 'Macro'], ['IA', 'IA']] as const) {
      await openPage(page, link, h).catch((e) => note('nav', `${link}: ${(e as Error).message.slice(0, 80)}`));
      const banners = page.getByRole('region', { name: 'Estado de los datos' });
      note(`${link} franjas`, await banners.count());
      if (await banners.count()) note(`${link} franja`, await banners.first().innerText());
      note(`${link} textos desactualizado`, await page.getByText(/[Dd]esactualizad/).allInnerTexts());
      await shot(page, `desactualizado-${link.toLowerCase()}`);
    }
    // IA: régimen y predicción en pausa
    note('IA pausa', await page.getByText(/En pausa/).allInnerTexts());
    const banner = page.getByRole('region', { name: 'Estado de los datos' });
    await banner.getByRole('button', { name: 'Actualizar ahora' }).click();
    await page.waitForTimeout(3000);
    note('tras actualizar ahora (fallando)', await banner.innerText());
    await shot(page, 'desactualizado-reintento', banner);
    await banner.getByText('Ver detalles').click().catch(() => undefined);
    note('detalles', await banner.innerText());
    await shot(page, 'desactualizado-detalles', banner);
    await banner.getByRole('button', { name: 'Probar conexión' }).click();
    await page.waitForTimeout(500);
    note('Probar conexión lleva a', { hash: await page.evaluate(() => location.hash), focus: await page.evaluate(() => document.activeElement?.id ?? document.activeElement?.textContent) });
  });

  await step('10. Sin red y reconexión: se pone al día', async () => {
    await page.evaluate(() => window.tradia.testing!.simulateOffline(true));
    await page.waitForTimeout(1500);
    await openPage(page, 'Inicio', 'Estado del sistema');
    note('sin red franjas', await page.getByRole('region', { name: 'Estado de los datos' }).allInnerTexts());
    note('alertas sin conexión', await page.getByText(/Sin conexión/).allInnerTexts());
    await shot(page, 'sin-red');
    await page.evaluate(async () => {
      await window.tradia.testing!.simulateProviderFailure(false);
      await window.tradia.testing!.simulateOffline(false);
    });
    await expect.poll(async () => (await page.evaluate(() => window.tradia.dataStatus.freshness())).state, { timeout: 60_000 }).toBe('current');
    await page.waitForTimeout(1500);
    note('tras reconectar', await page.evaluate(() => window.tradia.dataStatus.freshness()));
    note('franjas tras reconectar', await page.getByRole('region', { name: 'Estado de los datos' }).count());
    await openPage(page, 'IA');
    note('IA pausa tras reconectar', await page.getByText(/En pausa/).allInnerTexts());
    note('predicciones sesiones', await page.evaluate(async () => [...new Set((await window.tradia.ai.predictions({ limit: 50 })).map((r) => r.sessionDate))].sort().slice(-3)));
    await shot(page, 'al-dia-ia');
  });

  await step('11. Dinero real: guardar límites, ir a Ajustes y volver', async () => {
    await openPage(page, 'Dinero real');
    await page.getByLabel('Capital total en real', { exact: true }).fill('300');
    await page.getByLabel('Máximo por orden', { exact: true }).fill('50');
    await page.getByLabel('Pérdida diaria máxima', { exact: true }).fill('5');
    await page.getByLabel('Posiciones abiertas simultáneas', { exact: true }).fill('1');
    await page.getByRole('button', { name: 'Guardar límites' }).click();
    await page.waitForTimeout(800);
    note('tras guardar', (await page.locator('section.live-activation').innerText()).slice(0, 600));
    await openPage(page, 'Ajustes');
    await openPage(page, 'Dinero real');
    note('capital tras volver', await page.getByLabel('Capital total en real', { exact: true }).inputValue());
    note('orden tras volver', await page.getByLabel('Máximo por orden', { exact: true }).inputValue());
    note('estado', await page.getByRole('status').filter({ hasText: 'Dinero real' }).allInnerTexts());
    await shot(page, 'dinero-real-limites-al-volver');
  });

  await step('13. Guardar una clave no la muestra nunca', async () => {
    await openPage(page, 'Ajustes');
    await page.getByLabel('Clave de API de FRED').fill('qa-clave-fred-abcdef');
    await page.getByRole('form', { name: 'Proveedor FRED' }).getByRole('button', { name: /Guardar clave de FRED/ }).click();
    await page.waitForTimeout(800);
    note('FRED tras guardar', await page.getByRole('form', { name: 'Proveedor FRED' }).innerText());
    note('clave visible en la página', (await page.locator('body').innerText()).includes('qa-clave-fred-abcdef'));
    note('valor del campo', await page.getByLabel('Clave de API de FRED').inputValue());
  });

  await step('12. Ajustes: «Ver el tour de nuevo»', async () => {
    await openPage(page, 'Ajustes');
    const help = page.getByRole('region', { name: 'Ayuda' });
    note('ayuda', await help.innerText());
    await help.getByRole('button', { name: 'Ver el tour de nuevo' }).click();
    await expect(tour(page)).toBeVisible();
    note('relanzado en', await tour(page).getByRole('heading', { level: 2 }).innerText());
    await shot(page, 'tour-relanzado');
    await tour(page).getByRole('button', { name: 'Saltar tour' }).click();
    note('anuncio', await page.getByRole('status').filter({ hasText: 'Tour' }).allInnerTexts());
    note('foco', await page.evaluate(() => document.activeElement?.textContent));
  });
});
