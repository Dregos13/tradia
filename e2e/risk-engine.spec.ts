import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import type { KillSwitchCause, SignalIntent } from '../src/shared/ipc';

const projectRoot = resolve('.');

async function launchTradia(userData: string, endpoint: string) {
  return electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    cwd: projectRoot,
    env: {
      ...process.env,
      TRADIA_E2E: '1',
      TRADIA_E2E_USER_DATA: userData,
      TRADIA_CONNECTIVITY_URLS: JSON.stringify([endpoint, endpoint]),
    },
  });
}

async function acceptRisk(page: Page) {
  await page.getByLabel('He leído y acepto').check();
  await page.getByRole('button', { name: 'Continuar', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Estado del sistema' })).toBeVisible();
}

async function openRiskPage(page: Page) {
  await page.getByRole('link', { name: 'Riesgo', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Control de riesgo' })).toBeVisible();
}

/** Rellena el probador de señales de la pantalla «Riesgo» y lo envía. */
async function submitTesterSignal(
  page: Page,
  signal: { ticker: string; entry: string; stop?: string; target?: string; confidence: string },
) {
  await page.locator('#signal-ticker').fill(signal.ticker);
  await page.locator('#signal-entry').fill(signal.entry);
  await page.locator('#signal-stop').fill(signal.stop ?? '');
  await page.locator('#signal-target').fill(signal.target ?? '');
  await page.locator('#signal-confidence').fill(signal.confidence);
  await page.getByRole('button', { name: 'Evaluar señal' }).click();
}

const e2eSignal = (patch: Partial<SignalIntent> = {}): SignalIntent => ({
  ticker: 'AAPL',
  direction: 'largo',
  entry: 100,
  stop: 95,
  target: 115,
  confidence: 0.7,
  origin: 'e2e',
  ...patch,
});

test.describe('Motor de riesgo (fase 3)', () => {
  let app: ElectronApplication;
  let userData: string;
  let connectivityServer: Server;

  test.beforeEach(async () => {
    userData = mkdtempSync(join(tmpdir(), 'tradia-risk-e2e-'));
    connectivityServer = createServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    await new Promise<void>((resolveListen, reject) => {
      connectivityServer.once('error', reject);
      connectivityServer.listen(0, '127.0.0.1', resolveListen);
    });
    const { port } = connectivityServer.address() as AddressInfo;
    app = await launchTradia(userData, `http://127.0.0.1:${port}/health`);
  });

  test.afterEach(async () => {
    await app.close();
    await new Promise<void>((resolveClose, reject) => {
      connectivityServer.close((error) => (error ? reject(error) : resolveClose()));
    });
    rmSync(userData, { recursive: true, force: true });
  });

  test('la pantalla valida límites en línea y registra cada veto del probador', async () => {
    const page = await app.firstWindow();
    await acceptRisk(page);
    await openRiskPage(page);

    // Valores prudentes por defecto y apalancamiento fijo de solo lectura.
    await expect(page.locator('#limit-riskPerTradePct')).toHaveValue('0.5');
    await expect(page.locator('#limit-minRewardRiskRatio')).toHaveValue('2');
    await expect(page.locator('#limit-maxLeverage')).toHaveValue('1');
    await expect(page.locator('#limit-maxLeverage')).toHaveAttribute('readonly', '');

    // Fuera de los márgenes duros: error en línea y guardado bloqueado.
    await page.locator('#limit-riskPerTradePct').fill('3');
    await expect(page.locator('#error-riskPerTradePct')).toContainText(
      'Introduce un valor entre 0,5 y 2',
    );
    await page.locator('#limit-minRewardRiskRatio').fill('1,5');
    await expect(page.locator('#error-minRewardRiskRatio')).toContainText(
      'Introduce un valor entre 2 y 10',
    );
    await expect(page.getByRole('button', { name: 'Guardar límites' })).toBeDisabled();
    await page.getByRole('button', { name: 'Restablecer valores prudentes' }).click();
    await expect(page.locator('#limit-riskPerTradePct')).toHaveValue('0.5');
    await expect(page.locator('#error-riskPerTradePct')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Guardar límites' })).toBeEnabled();

    // Una señal sin stop queda vetada y aparece en el registro con su motivo.
    const decision = page.locator('.risk-decision');
    const vetoTable = page.locator('.risk-table-wrap table');
    await submitTesterSignal(page, {
      ticker: 'AAPL',
      entry: '100',
      target: '115',
      confidence: '0.7',
    });
    await expect(decision).toContainText('Vetada');
    await expect(decision).toContainText('La señal no tiene stop de protección');
    await expect(decision).toContainText('STOP_MISSING');
    await expect(vetoTable).toContainText('STOP_MISSING');
    await expect(vetoTable).toContainText('La señal no tiene stop de protección');
    await expect(vetoTable).toContainText('AAPL');

    // Y otra con beneficio/riesgo 1:1, también con regla y motivo legibles.
    await submitTesterSignal(page, {
      ticker: 'AAPL',
      entry: '100',
      stop: '95',
      target: '105',
      confidence: '0.7',
    });
    await expect(decision).toContainText('Beneficio/riesgo por debajo del mínimo');
    await expect(decision).toContainText('RR_TOO_LOW');
    await expect(vetoTable).toContainText('RR_TOO_LOW');
    await expect(vetoTable).toContainText('Beneficio/riesgo por debajo del mínimo');
    await expect(page.getByRole('status').filter({ hasText: 'registros' })).toContainText(
      '2 registros',
    );
  });

  test('la parada detiene señales al instante y solo reanuda con confirmación', async () => {
    const page = await app.firstWindow();
    await acceptRisk(page);
    await openRiskPage(page);

    await page.getByRole('button', { name: 'Parada', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Parada activa', exact: true })).toBeVisible();
    const banner = page.locator('.risk-stop-banner');
    await expect(banner).toContainText('Parada activa: Parada manual');

    // Cualquier señal queda vetada con el motivo «Parada activa».
    await submitTesterSignal(page, {
      ticker: 'AAPL',
      entry: '100',
      stop: '95',
      target: '115',
      confidence: '0.7',
    });
    await expect(page.locator('.risk-decision')).toContainText('Vetada');
    await expect(page.locator('.risk-decision')).toContainText('Parada activa');
    await expect(page.locator('.risk-decision')).toContainText('KILL_SWITCH_ACTIVE');
    await expect(page.locator('.risk-table-wrap table')).toContainText('KILL_SWITCH_ACTIVE');

    // La reanudación exige el diálogo de confirmación; cancelar la mantiene.
    await banner.getByRole('button', { name: 'Reanudar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirmar reanudación' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Mantener parada' }).click();
    await expect(banner).toBeVisible();
    await page.getByRole('button', { name: 'Parada activa', exact: true }).click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Confirmar y reanudar' }).click();
    await expect(banner).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Parada', exact: true })).toBeVisible();

    // Reanudada: el motor vuelve a evaluar sin el veto de parada.
    const resumed = await page.evaluate(() =>
      window.tradia.risk.submitSignal({
        ticker: 'AAPL',
        direction: 'largo',
        entry: 100,
        stop: 95,
        target: 115,
        confidence: 0.7,
        origin: 'e2e',
      }),
    );
    expect(resumed.reasons.map((r) => r.code)).not.toContain('KILL_SWITCH_ACTIVE');
    expect((await page.evaluate(() => window.tradia.risk.getKillSwitch())).active).toBe(false);
  });

  test('cada causa automática activa la parada con su notificación crítica', async () => {
    const page = await app.firstWindow();
    await acceptRisk(page);

    // Captura las notificaciones nativas que emite el proceso principal.
    await app.evaluate(({ Notification }) => {
      const state = globalThis as typeof globalThis & {
        __tradiaNotificationCalls?: Array<{ title: string; body: string }>;
      };
      state.__tradiaNotificationCalls = [];
      Object.defineProperty(Notification, 'isSupported', {
        configurable: true,
        value: () => true,
      });
      Notification.prototype.show = function (this: Notification) {
        state.__tradiaNotificationCalls?.push({ title: this.title, body: this.body });
      };
    });

    const causes: KillSwitchCause[] = [
      'perdida-anomala',
      'dato-anomalo',
      'sin-conexion',
      'modelo-erratico',
    ];
    for (const cause of causes) {
      const state = await page.evaluate((c) => window.tradia.testing!.risk.simulateCause(c), cause);
      expect(state).toMatchObject({ active: true, cause, actor: 'automatico' });
      await expect(page.locator('.risk-stop-banner')).toBeVisible();

      const decision = await page.evaluate((s) => window.tradia.risk.submitSignal(s), e2eSignal());
      expect(decision.status).toBe('vetada');
      expect(decision.reasons[0]?.code).toBe('KILL_SWITCH_ACTIVE');
      expect(decision.reasons[0]?.message).toBe('Parada activa');

      await page.evaluate(() => window.tradia.risk.resumeKillSwitch({ confirm: true }));
      await expect(page.locator('.risk-stop-banner')).toHaveCount(0);
    }

    // Una notificación crítica por activación, apuntando a la pantalla Riesgo.
    await expect
      .poll(() =>
        app.evaluate(() => {
          const state = globalThis as typeof globalThis & {
            __tradiaNotificationCalls?: Array<{ title: string; body: string }>;
          };
          return (
            state.__tradiaNotificationCalls?.filter(
              (n) => n.title === 'Tradia ha activado la parada',
            ).length ?? 0
          );
        }),
      )
      .toBe(causes.length);
  });

  test('un evento de alto impacto activa el modo cautela y bloquea la señal', async () => {
    const page = await app.firstWindow();
    await acceptRisk(page);

    // Barras simuladas de AAPL: la señal limpia pasa el límite de liquidez.
    await page.evaluate(() => window.tradia.watchlist.add('AAPL'));
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.tradia.market.getBars({ ticker: 'AAPL' }))).bars.length,
        { timeout: 30_000 },
      )
      .toBeGreaterThan(0);

    await openRiskPage(page);
    const decision = page.locator('.risk-decision');
    const cautionBanner = page.locator('.risk-caution');

    // Sin cautela la señal limpia sale aprobada (tamaño por distancia al stop).
    const before = await page.evaluate(() => window.tradia.risk.getCaution());
    await submitTesterSignal(page, {
      ticker: 'AAPL',
      entry: '100',
      stop: '95',
      target: '115',
      confidence: '0.7',
    });
    if (before.active) {
      // Entorno ya en cautela (festivo, apertura…): la señal no sale limpia.
      await expect(decision).not.toContainText('Aprobada');
    } else {
      await expect(decision).toContainText('Aprobada');
      await expect(decision).toContainText('100 unidades');
    }

    // Evento de alto impacto ahora: bloquea las entradas nuevas.
    const caution = await page.evaluate(() =>
      window.tradia.testing!.risk.simulateCalendarEvent({
        kind: 'ipc',
        title: 'IPC EE. UU. (E2E)',
        dateUtc: new Date().toISOString(),
        impact: 'alto',
      }),
    );
    expect(caution.active).toBe(true);
    expect(caution.effect).toBe('bloquear');
    if (before.effect !== 'bloquear') {
      // Sin otro bloqueo previo gana el evento inyectado por precedencia.
      expect(caution.cause).toBe('alto-impacto');
      expect(caution.eventTitle).toBe('IPC EE. UU. (E2E)');
      await expect(cautionBanner).toContainText('IPC EE. UU. (E2E)');
    }
    await expect(cautionBanner).toContainText('Modo cautela activo');

    // La misma señal queda vetada con «Modo cautela» y el evento que lo causa.
    await submitTesterSignal(page, {
      ticker: 'AAPL',
      entry: '100',
      stop: '95',
      target: '115',
      confidence: '0.7',
    });
    await expect(decision).toContainText('Vetada');
    await expect(decision).toContainText('Modo cautela');
    await expect(decision).toContainText('CAUTION_MODE');
    await expect(page.locator('.risk-table-wrap table')).toContainText('CAUTION_MODE');
  });
});
